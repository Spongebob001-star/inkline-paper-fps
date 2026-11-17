import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createEnemy, stepEnemies } from '../shared/enemies.mjs';
import { applyShot, HITBOX } from '../shared/combat.mjs';

const DT = CONFIG.net.dt;
const ticks = (m, n, inputs = {}) => { for (let i = 0; i < n; i++) stepMatch(m, inputs); };
const wallAt = (m, x, z, len = 4) => {
  const w = { id: m.nextId++, x, z, len, ux: 1, uz: 0, nx: 0, nz: 1, halfThickness: CONFIG.wall.halfThickness, hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, dead: false };
  m.walls.push(w);
  return w;
};
// 开阔区：玩家 (10,4) 远离，敌人默认放 (10,-10)
function scene() {
  const m = createMatch({ seed: 5 });
  m.grace = 0;
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = 4;
  const e = createEnemy(m, 'eraser', 10, -10);
  e.x = 10; e.z = -10; e.attackCd = 0;
  return { m, p, e };
}

test('橡皮擦虫初始：90hp/0 甲/0.45 半径；模型包围盒核定 hitbox y1=0.87', () => {
  const { e } = scene();
  assert.equal(e.hp, 90);
  assert.equal(e.armor, 0);
  assert.equal(CONFIG.enemy.eraser.radius, 0.45);
  assert.equal(HITBOX.eraser.y1, 0.87);
  assert.equal(HITBOX.eraser.r, 0.45);
});

test('15m 内优先追玩家墙，而非玩家', () => {
  const { m, p, e } = scene();
  wallAt(m, 10, -14);
  p.pos.z = 4; // 玩家在反方向 14m
  const z0 = e.z;
  ticks(m, 20);
  assert.ok(e.z < z0, `z=${e.z}`);
});

test('1.15m 内每 1.2s 咬墙 35：120→85→50', () => {
  const { m, p, e } = scene();
  const w = wallAt(m, 10, -12);
  e.z = -11;
  ticks(m, 1);
  assert.equal(w.hp, 85);
  assert.equal(e.attackCd, CONFIG.enemy.eraser.biteCooldown);
  assert.ok(m.events.some(ev => ev.type === 'wallBite'));
  ticks(m, 24);
  assert.equal(w.hp, 50);
  assert.equal(p.hp, 100);
});

test('墙超过 15m 追不上：转而贴身追玩家', () => {
  const { m, p, e } = scene();
  wallAt(m, 10, -27); // 17m
  const z0 = e.z;
  ticks(m, 10);
  assert.ok(e.z > z0, `z=${e.z}`);
  assert.equal(p.hp, 100);
});

test('无墙贴身咬玩家 12/1.2s', () => {
  const { m, p, e } = scene();
  p.pos.z = -10;
  e.z = -9.2; // 距玩家 0.8 < 0.95
  ticks(m, 1);
  assert.equal(p.hp, 88);
  assert.equal(e.attackCd, CONFIG.enemy.eraser.biteCooldown);
  assert.ok(m.events.some(ev => ev.type === 'bite' && ev.data.playerId === 0));
  ticks(m, 24);
  assert.equal(p.hp, 76);
});

test('墙咬穿后移除并转火玩家', () => {
  const { m, e } = scene();
  const w = wallAt(m, 10, -12);
  e.z = -11;
  ticks(m, 100);
  assert.equal(w.dead, true);
  assert.ok(m.events.some(ev => ev.type === 'wallBreak' && ev.data.id === w.id));
  assert.ok(!m.walls.includes(w));
  assert.ok(e.z > -11, '墙死后向玩家方向移动 z=' + e.z);
});

test('减速 ×0.5 / 眩晕不动', () => {
  const mk = () => { const s = scene(); return s; };
  const a = mk(), b = mk();
  a.e.slow = 2;
  const za = a.e.z, zb = b.e.z;
  stepEnemies(a.m, DT);
  stepEnemies(b.m, DT);
  const da = Math.abs(a.e.z - za), dbl = Math.abs(b.e.z - zb);
  assert.ok(Math.abs(da / dbl - CONFIG.enemy.slowFactor) < 1e-9, `da=${da} db=${dbl}`);
  const c = mk();
  c.e.stun = 1;
  const zc = c.e.z;
  ticks(c.m, 10);
  assert.equal(c.e.z, zc);
});

test('射击命中：hitbox 内 4 发（24×4≥90）击杀，命中点上沿 y 1.2 脱靶', () => {
  const { m, e } = scene();
  const hit = applyShot(m, 0, { x: 10, y: 0.5, z: -13 }, { x: 0, y: 0, z: 1 });
  assert.equal(hit.kind, 'enemy');
  const miss = applyShot(m, 0, { x: 10, y: 1.2, z: -13 }, { x: 0, y: 0, z: 1 });
  assert.notEqual(miss.kind, 'enemy');
  const p = m.players[0];
  for (let i = 0; i < 4; i++) { p.fireCd = 0; applyShot(m, 0, { x: 10, y: 0.5, z: -11 }, { x: 0, y: 0, z: 1 }); }
  assert.equal(e.dead, true);
  assert.equal(m.kills, 1);
  assert.equal(p.stats.kills, 1);
});

test('确定性：擦除虫+玩家输入 200 步双跑逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 31 });
    const p = m.players[0];
    p.pos.x = 10; p.pos.z = 4;
    createEnemy(m, 'eraser', 10, -10);
    for (let i = 0; i < 200; i++) stepMatch(m, { 0: { f: i % 40 < 20 ? 1 : 0, r: 0.3, seq: i } });
    return JSON.stringify(snapshot(m));
  };
  assert.equal(run(), run());
});