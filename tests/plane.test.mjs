import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { applyShot, HITBOX } from '../shared/combat.mjs';

const ticks = (m, n, inputs = {}) => { for (let i = 0; i < n; i++) stepMatch(m, inputs); };
const wallAt = (m, x, z, len = 4) => {
  const w = { id: m.nextId++, x, z, len, ux: 1, uz: 0, nx: 0, nz: 1, halfThickness: CONFIG.wall.halfThickness, hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, dead: false };
  m.walls.push(w);
  return w;
};
function scene(pz = -8, ez = -10) {
  const m = createMatch({ seed: 5 });
  m.grace = 0;
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = pz;
  const e = createEnemy(m, 'plane', 10, ez);
  e.x = 10; e.z = ez;
  return { m, p, e };
}

test('纸飞机初始：30hp / 高度 2.4 / circle 态 / 动态 hitbox ±0.15', () => {
  const { e } = scene();
  assert.equal(e.hp, 30);
  assert.equal(e.armor, 0);
  assert.equal(e.y, 2.4);
  assert.equal(e.state, 'circle');
  assert.ok(e.circleCd >= 1 && e.circleCd <= 2);
  assert.equal(HITBOX.plane.dy, true);
  assert.equal(HITBOX.plane.r, 0.55);
});

test('环绕段：距离 >6m 时向玩家收拢', () => {
  const { m, p, e } = scene(2);
  const d0 = Math.hypot(e.x - p.pos.x, e.z - p.pos.z);
  ticks(m, 10);
  const d1 = Math.hypot(e.x - p.pos.x, e.z - p.pos.z);
  assert.ok(d1 < d0, `d0=${d0} d1=${d1}`);
  assert.ok(Math.abs(e.y - CONFIG.enemy.plane.height) <= 0.25 + 1e-9);
});

test('环绕冷却/距离双闸门：dist≥12 不进入瞄准；dist<12 且冷却结束进入 aim', () => {
  const { m, p, e } = scene(-10);
  p.pos.z = 2; // dist 12
  e.circleCd = 0;
  ticks(m, 1);
  assert.equal(e.state, 'circle');
  p.pos.z = -2; // dist 8
  ticks(m, 1);
  assert.equal(e.state, 'aim');
});

test('aim 0.6s → dive：俯冲方向在锁定瞬间指向玩家', () => {
  const { m, e } = scene();
  e.state = 'aim';
  e.telegraph = 0.55;
  ticks(m, 1);
  assert.equal(e.state, 'dive');
  assert.ok(Math.abs(e.diveDirX) < 1e-9);
  assert.ok(Math.abs(e.diveDirZ - 1) < 1e-9);
  assert.equal(e.diveY, 1.65 - 0.4);
  assert.ok(m.events.some(ev => ev.type === 'dive' && ev.data.id === e.id));
});

test('俯冲命中：接触 10 伤 → climb，只结算一次', () => {
  const { m, p, e } = scene();
  e.state = 'aim';
  e.telegraph = 0.55;
  ticks(m, 1);
  assert.equal(e.state, 'dive');
  ticks(m, 4);
  assert.equal(p.hp, 90);
  assert.ok(m.events.some(ev => ev.type === 'playerHit' && ev.data.dmg === 10));
  assert.equal(e.state, 'climb');
  ticks(m, 6);
  assert.equal(p.hp, 90);
});

test('俯冲 1.2s 未命中 → climb；climb 0.6s → circle 且冷却复位 2.2', () => {
  const { m, p, e } = scene();
  e.state = 'aim';
  e.telegraph = 0.55;
  ticks(m, 1);
  p.pos.x = 15; p.pos.z = 5;
  ticks(m, 24);
  assert.equal(e.state, 'climb');
  assert.equal(p.hp, 100);
  ticks(m, 12);
  assert.equal(e.state, 'circle');
  assert.equal(e.circleCd, CONFIG.enemy.plane.circleCd);
  assert.equal(e.y, CONFIG.enemy.plane.height);
});

test('无视墙体与掩体：隔墙俯冲仍命中，墙不受损', () => {
  const { m, p, e } = scene(-2);
  const w = wallAt(m, 10, -6);
  e.state = 'aim';
  e.telegraph = 0.55;
  ticks(m, 1);
  assert.equal(e.state, 'dive');
  for (let i = 0; i < 24 && e.state === 'dive'; i++) stepMatch(m, {});
  assert.equal(p.hp, 90);
  assert.equal(w.hp, CONFIG.wall.hp);
  assert.equal(w.dead, false);
});

test('减速仅作用于环绕段：位移 ×0.5', () => {
  const a = scene(2), b = scene(2);
  a.e.slow = 2;
  const ax = a.e.x, az = a.e.z, bx = b.e.x, bz = b.e.z;
  stepMatch(a.m, {});
  stepMatch(b.m, {});
  const da = Math.hypot(a.e.x - ax, a.e.z - az);
  const dbl = Math.hypot(b.e.x - bx, b.e.z - bz);
  assert.ok(Math.abs(da / dbl - CONFIG.enemy.slowFactor) < 1e-9, `da=${da} db=${dbl}`);
});

test('动态 hitbox：飞行高度命中 / 上方 0.4m 脱靶 / 俯冲低空命中', () => {
  const { m, p, e } = scene();
  const hit = applyShot(m, 0, { x: 10, y: 2.4, z: -13 }, { x: 0, y: 0, z: 1 });
  assert.equal(hit.kind, 'enemy');
  p.fireCd = 0;
  const miss = applyShot(m, 0, { x: 10, y: 2.8, z: -13 }, { x: 0, y: 0, z: 1 });
  assert.notEqual(miss.kind, 'enemy');
  e.y = 1.3;
  p.fireCd = 0;
  const low = applyShot(m, 0, { x: 10, y: 1.3, z: -13 }, { x: 0, y: 0, z: 1 });
  assert.equal(low.kind, 'enemy');
});

test('30hp：两发 24 伤击杀；确定性 300 步双跑逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 41 });
    m.grace = 0;
    const p = m.players[0];
    p.pos.x = 10; p.pos.z = -8;
    const e = createEnemy(m, 'plane', 10, -10);
    for (let i = 0; i < 300; i++) stepMatch(m, { 0: { f: i % 60 < 30 ? 1 : -1, r: 0.4, seq: i } });
    return m;
  };
  const m = run();
  const e = m.enemies[0];
  e.state = 'circle'; e.y = 2.4; e.x = 10; e.z = -10;
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = -8; p.fireCd = 0; p.ammo = 18; p.st = 0; p.hp = 100;
  applyShot(m, 0, { x: 10, y: 2.4, z: -13 }, { x: 0, y: 0, z: 1 });
  p.fireCd = 0;
  applyShot(m, 0, { x: 10, y: 2.4, z: -13 }, { x: 0, y: 0, z: 1 });
  assert.equal(e.dead, true);
  const det = () => {
    const mm = createMatch({ seed: 41 });
    mm.grace = 0;
    const pp = mm.players[0];
    pp.pos.x = 10; pp.pos.z = -8;
    createEnemy(mm, 'plane', 10, -10);
    for (let i = 0; i < 300; i++) stepMatch(mm, { 0: { f: i % 60 < 30 ? 1 : -1, r: 0.4, seq: i } });
    return JSON.stringify(snapshot(mm));
  };
  assert.equal(det(), det());
});