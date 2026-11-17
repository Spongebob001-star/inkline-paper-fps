import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot, drainEvents } from '../shared/sim.mjs';
import { createEnemy, stepEnemies } from '../shared/enemies.mjs';

const DT = CONFIG.net.dt;
const ticks = (m, n, inputs = {}) => { for (let i = 0; i < n; i++) stepMatch(m, inputs); };

function makeWall(match, x, z, len = 4, rot = 0) {
  const ux = Math.cos(rot), uz = -Math.sin(rot);
  const w = {
    id: match.nextId++, x, z, len, ux, uz, nx: -uz, nz: ux,
    halfThickness: CONFIG.wall.halfThickness,
    hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, dead: false,
  };
  match.walls.push(w);
  return w;
}

test('涂改灵初始：48hp/24 甲，种子化随机可复现', () => {
  const a = createMatch({ seed: 5 });
  const b = createMatch({ seed: 5 });
  const ea = createEnemy(a, 'crane', -13, 4);
  const eb = createEnemy(b, 'crane', -13, 4);
  assert.equal(ea.hp, 48);
  assert.equal(ea.armor, 24);
  assert.equal(ea.attackCd, eb.attackCd);
  assert.equal(ea.strafe, eb.strafe);
});

test('4s 保护期内不蓄力', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5, { attackCd: 0 });
  ticks(m, 79); // 3.95s，grace 仍 >0
  assert.equal(e.telegraph, 0);
  assert.equal(m.projectiles.length, 0);
});

test('保护期后：0.5s 余冷却 + 0.55s 蓄力 → 发射墨弹 → 1.65s 冷却', () => {
  const m = createMatch();
  m.players[0].pos.x = 10; // x=10 开阔走廊，侧移时视线不被折页平台挡
  const e = createEnemy(m, 'crane', 10, -5, { attackCd: 0 });
  ticks(m, 80); // grace 结束
  assert.ok(m.grace < 1e-9);
  let firedAt = -1;
  for (let i = 0; i < 40; i++) {
    stepMatch(m, {});
    if (m.projectiles.length) { firedAt = i; break; }
  }
  assert.ok(firedAt >= 18 && firedAt <= 21, `firedAt=${firedAt}`); // (0.5+0.55)/0.05 ≈ 21
  assert.equal(e.attackCd, 1.65);
  const pr = m.projectiles[0];
  const speed = Math.hypot(pr.vx, pr.vy, pr.vz);
  assert.ok(Math.abs(speed - 9) < 1e-9);
  assert.equal(pr.damage, 8);
});

test('蓄力期移速 ×0.32', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5, { attackCd: 0 });
  m.grace = 0;
  e.telegraph = 0.1;
  const x0 = e.x, z0 = e.z;
  stepEnemies(m, DT);
  const moved = Math.hypot(e.x - x0, e.z - z0);
  assert.ok(moved > 0 && moved <= 2.25 * 0.32 * DT + 1e-9, `moved=${moved}`);
});

test('减速 debuff：移速 ×0.5', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5);
  m.grace = 0;
  e.slow = 2;
  e.attackCd = 5; // 不蓄力，纯追近
  const x0 = e.x, z0 = e.z;
  stepEnemies(m, DT);
  const moved = Math.hypot(e.x - x0, e.z - z0);
  assert.ok(Math.abs(moved - 2.25 * 0.5 * DT) < 1e-9, `moved=${moved}`);
});

test('眩晕 1s：不移动不蓄力', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5, { attackCd: 0 });
  m.grace = 0;
  e.stun = 1;
  const z0 = e.z;
  ticks(m, 10);
  assert.equal(e.z, z0);
  assert.equal(e.telegraph, 0);
  assert.equal(m.projectiles.length, 0);
});

test('视线被玩家墙挡：靠近后拆墙 18/次', () => {
  const m = createMatch();
  const w = makeWall(m, 0, -9);
  const e = createEnemy(m, 'crane', 0, -5, { attackCd: 0 });
  m.grace = 0;
  e.losTimer = 0;
  ticks(m, 200); // 10s：接近 + 蓄力 + 拆墙循环
  assert.ok(w.hp < 120, `wall hp=${w.hp}`);
  assert.equal((120 - w.hp) % 18, 0);
  assert.equal(m.projectiles.length, 0); // 视线被挡不射玩家
});

test('固定障碍绕行：不穿过中心掩体', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, 5);
  m.grace = 0;
  e.attackCd = 99; // 只移动不攻击
  ticks(m, 200);
  // 掩体 (0,0) 4×2：敌人不应进入其内部
  assert.ok(!(Math.abs(e.x) < 2 && Math.abs(e.z) < 1), `e=(${e.x},${e.z})`);
});

test('增援落地动画 0.35s：期间不攻击', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5, { spawnAnim: true, attackCd: 0 });
  m.grace = 0;
  assert.equal(e.spawnT, 0);
  ticks(m, 6); // 0.3s
  assert.ok(e.spawnT < 1);
  assert.equal(e.telegraph, 0);
  ticks(m, 2);
  assert.equal(e.spawnT, 1);
});

test('同屏上限与死亡清理：dead 敌人移出数组', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5);
  e.dead = true;
  stepEnemies(m, DT);
  assert.equal(m.enemies.length, 0);
});

test('确定性：带敌人 300 步双跑快照逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 777 });
    createEnemy(m, 'crane', -13, 4, { spawnAnim: true });
    createEnemy(m, 'crane', 12, 11);
    for (let i = 0; i < 300; i++) {
      stepMatch(m, { 0: { f: i % 50 < 25 ? 1 : 0, r: 0.2, seq: i } });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});

test('快照含敌人/弹丸短键字段', () => {
  const m = createMatch();
  createEnemy(m, 'crane', 0, -5);
  stepMatch(m, {});
  const s = snapshot(m);
  assert.equal(s.enemies.length, 1);
  assert.equal(s.enemies[0].type, 'crane');
  assert.equal(s.enemies[0].armor, 24);
  assert.ok(Array.isArray(s.projectiles));
});