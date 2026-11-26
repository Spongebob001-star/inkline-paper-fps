import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { staticColliders } from '../shared/world.mjs';
import {
  rng, createPlayer, createMatch, stepPlayer, stepMatch, applyFire, startReload, useInk, snapshot,
} from '../shared/sim.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const DT = CONFIG.net.dt;

function ctx(over = {}) {
  const m = createMatch();
  return {
    elapsed: 0,
    staticColliders: m.statics,
    walls: [],
    foldWalls: [],
    folds: m.folds,
    regenRate: CONFIG.ink.regenRate,
    ...over,
  };
}

test('createMatch 初始状态：hp100/ink100/ammo18/出生(0,-13)/240s/3 折页坡道/6 拾取/3 锚点', () => {
  const m = createMatch({ seed: 7 });
  const p = m.players[0];
  assert.equal(p.hp, 100);
  assert.equal(p.ink, 100);
  assert.equal(p.ammo, 18);
  assert.deepEqual([p.pos.x, p.pos.z], [0, -13]);
  assert.equal(p.pos.y, 1.65);
  assert.equal(m.timeLeft, 240);
  assert.equal(m.phase, 'anchors');
  assert.equal(m.folds.length, 3);
  assert.ok(m.folds.every(f => f.state === 'ramp'));
  assert.equal(m.pickups.length, 6);
  assert.equal(m.anchors.length, 3);
});

test('步行稳态速度 4.8 / 冲刺 7.0', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  for (let i = 0; i < 40; i++) { c.elapsed += DT; stepPlayer(p, { f: 1 }, DT, c); }
  near(Math.hypot(p.velX, p.velZ), 4.8, 0.02);
  const q = createPlayer(1, { x: 0, z: -13 });
  for (let i = 0; i < 40; i++) { c.elapsed += DT; stepPlayer(q, { f: 1, sprint: true }, DT, c); }
  near(Math.hypot(q.velX, q.velZ), 7, 0.03);
});

test('斜向输入归一：对角移动不快于直线', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  for (let i = 0; i < 40; i++) { c.elapsed += DT; stepPlayer(p, { f: 1, r: 1 }, DT, c); }
  near(Math.hypot(p.velX, p.velZ), 4.8, 0.02);
});

test('跳跃：离地 → 顶点约 0.95–1.02m（可跃过 0.95m 音浪）→ 落回地面', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  stepPlayer(p, { jump: true }, DT, c);
  assert.equal(p.grounded, false);
  let apex = 0;
  for (let i = 0; i < 40; i++) {
    c.elapsed += DT;
    stepPlayer(p, {}, DT, c);
    apex = Math.max(apex, p.pos.y - 1.65);
    if (p.grounded && i > 5) break;
  }
  assert.ok(apex >= 0.95 && apex < 1.02, `apex=${apex}`);
  assert.equal(p.grounded, true);
  near(p.pos.y, 1.65);
});

test('空中不可二段跳', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  stepPlayer(p, { jump: true }, DT, c);
  const v1 = p.velY;
  stepPlayer(p, { jump: true }, DT, c);
  near(p.velY, v1 - 20 * DT);
});

test('重力 20：空中每步 velY 减 1（dt=0.05）', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  p.pos.y = 5; p.grounded = false; p.velY = 0;
  stepPlayer(p, {}, DT, c);
  near(p.velY, -1);
});

test('步高 0.55：平台侧面不可瞬移上去（位置回滚）', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 10.5, z: -11.2 });
  for (let i = 0; i < 20; i++) { c.elapsed += DT; stepPlayer(p, { r: -1 }, DT, c); }
  assert.ok(p.pos.x > 9.59, `x=${p.pos.x}`);
  near(p.pos.y, 1.65);
});

test('坡道可走上平台：fold0 坡道北行 → 站顶 y=3.15', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 8, z: -8 });
  for (let i = 0; i < 20; i++) { c.elapsed += DT; stepPlayer(p, { f: 1 }, DT, c); }
  assert.equal(p.grounded, true);
  near(p.pos.y, 3.15, 1e-9);
});

test('回墨：耗墨后 0.8s 延迟，10/s；抱团 15/s', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  p.ink = 50; p.lastSkill = 0.02;
  for (let i = 0; i < 20; i++) { c.elapsed += DT; stepPlayer(p, {}, DT, c); }
  near(p.ink, 52, 1e-9);
  const g = ctx({ regenRate: CONFIG.ink.regenRateGroup });
  const q = createPlayer(1, { x: 0, z: -13 });
  q.ink = 50; q.lastSkill = 0.02;
  for (let i = 0; i < 20; i++) { g.elapsed += DT; stepPlayer(q, {}, DT, g); }
  near(q.ink, 53, 1e-9);
});

test('回墨上限 100', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  p.ink = 99.9; p.lastSkill = -10;
  for (let i = 0; i < 10; i++) { c.elapsed += DT; stepPlayer(p, {}, DT, c); }
  assert.equal(p.ink, 100);
});

test('射速 0.14s：连发第二发被冷却拒绝', () => {
  const p = createPlayer(0, { x: 0, z: -13 });
  assert.equal(applyFire(p), 'fired');
  assert.equal(p.ammo, 17);
  assert.equal(applyFire(p), 'cooldown');
  const c = ctx();
  for (let i = 0; i < 3; i++) { c.elapsed += DT; stepPlayer(p, {}, DT, c); }
  assert.equal(applyFire(p), 'fired');
  assert.equal(p.ammo, 16);
});

test('换弹 1.25s：打空自动换弹，期间拒射，结束满匣', () => {
  const p = createPlayer(0, { x: 0, z: -13 });
  p.ammo = 1;
  assert.equal(applyFire(p), 'fired');
  assert.equal(p.ammo, 0);
  near(p.reload, 1.25);
  assert.equal(applyFire(p), 'cooldown');
  const c = ctx();
  for (let i = 0; i < 25; i++) { c.elapsed += DT; stepPlayer(p, {}, DT, c); }
  assert.equal(p.reload, 0);
  assert.equal(p.ammo, 18);
});

test('满匣拒绝换弹', () => {
  const p = createPlayer(0, { x: 0, z: -13 });
  assert.equal(startReload(p), false);
});

test('useInk：不足拒绝不扣墨；成功扣墨并重置回墨延迟', () => {
  const p = createPlayer(0, { x: 0, z: -13 });
  p.ink = 30;
  assert.equal(useInk(p, 36, 5), false);
  assert.equal(p.ink, 30);
  assert.equal(useInk(p, 28, 5), true);
  assert.equal(p.ink, 2);
  assert.equal(p.lastSkill, 5);
});

test('stepMatch：tick/elapsed/timeLeft 推进 + ack 记录', () => {
  const m = createMatch();
  stepMatch(m, { 0: { f: 1, seq: 42 } });
  assert.equal(m.tick, 1);
  near(m.elapsed, 0.05);
  near(m.timeLeft, 239.95);
  assert.equal(m.ack[0], 42);
  const s = snapshot(m);
  assert.equal(s.m, 'snapshot');
  assert.equal(s.tick, 1);
  assert.equal(s.ack, 42);
  assert.equal(s.players[0].ammo, 18);
});

test('确定性：同种子同输入 200 步，快照逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 20261116 });
    for (let i = 0; i < 200; i++) {
      const input = {
        f: i % 40 < 20 ? 1 : 0,
        r: i % 60 < 30 ? 0.5 : -0.5,
        sprint: i % 80 < 40,
        jump: i === 10 || i === 90,
        seq: i,
      };
      stepMatch(m, { 0: input });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});

test('rng：同种子同序列，值域 [0,1)', () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('边界钳制：走出场地被挡在 ±17.01', () => {
  const c = ctx();
  const p = createPlayer(0, { x: 0, z: -13 });
  for (let i = 0; i < 200; i++) { c.elapsed += DT; stepPlayer(p, { f: 1 }, DT, c); }
  assert.ok(p.pos.z >= -17.01 - 1e-9, `z=${p.pos.z}`);
});