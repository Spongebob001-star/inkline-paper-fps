import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { groundHeightAt, foldLocal, FOLDS } from '../shared/world.mjs';
import { applyFold, stepFolds, foldAngle, nearestFold } from '../shared/folds.mjs';
import { losBlocker } from '../shared/combat.mjs';
import { createRuntime } from '../host/runtime.mjs';

const mk = () => createMatch({ seed: 5 });
const near = (m, x, z) => { const p = m.players[0]; p.pos.x = x; p.pos.z = z; p.pos.y = 1.65; return p; };
// fold0 (8,-8) rotY=π：局部 (lx,lz) → 世界 (8-lx, -8-lz)
const w0 = (lx, lz) => ({ x: 8 - lx, z: -8 - lz });

test('初始三折角：ramp / animT 1 / fromAngle 坡角 / 无折页墙', () => {
  const m = mk();
  assert.equal(m.folds.length, 3);
  for (const f of m.folds) {
    assert.equal(f.state, 'ramp');
    assert.equal(f.animT, 1);
    assert.equal(f.fromAngle, CONFIG.folds.rampAngle);
  }
  assert.equal(m.foldWalls.length, 0);
});

test('距离闸门：7m 拒绝 far；2.2m 边界允许；切换全局事件', () => {
  const m = mk();
  const r0 = applyFold(m, 0, 2);
  assert.equal(r0.ok, false);
  assert.equal(r0.reason, 'far');
  near(m, 0, -6 + CONFIG.folds.interactRadius);
  const r = applyFold(m, 0, 2);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'wall');
  assert.equal(m.folds[2].state, 'wall');
  assert.equal(m.folds[2].animT, 0);
  const ev = m.events.find(e => e.type === 'fold');
  assert.equal(ev.data.id, 2);
  assert.equal(ev.data.state, 'wall');
  assert.equal(ev.data.owner, 0);
});

test('动画 0.4s 内不可重复触发；8  tick 后 animT=1 可再切回', () => {
  const m = mk();
  near(m, -2.2, -6);
  applyFold(m, 0, 2);
  assert.equal(applyFold(m, 0, 2).reason, 'anim');
  for (let i = 0; i < 4; i++) stepMatch(m, {});
  assert.equal(m.folds[2].animT, 0.5);
  assert.equal(applyFold(m, 0, 2).reason, 'anim');
  for (let i = 0; i < 4; i++) stepMatch(m, {});
  assert.equal(m.folds[2].animT, 1);
  assert.equal(applyFold(m, 0, 2).state, 'ramp');
});

test('铰链角 smoothstep：动画中点为起止角中值，端点收敛', () => {
  const m = mk();
  near(m, -2.2, -6);
  applyFold(m, 0, 2);
  const f = m.folds[2];
  stepFolds(m, CONFIG.folds.toggleTime / 2);
  assert.ok(Math.abs(foldAngle(f) - CONFIG.folds.rampAngle / 2) < 1e-9);
  stepFolds(m, CONFIG.folds.toggleTime / 2);
  assert.equal(foldAngle(f), 0);
  applyFold(m, 0, 2);
  stepFolds(m, CONFIG.folds.toggleTime);
  assert.equal(foldAngle(f), CONFIG.folds.rampAngle);
});

test('groundHeightAt 全采样：坡道线性 / 折起归零 / 平台恒 1.5', () => {
  const m = mk();
  const mid = w0(0, CONFIG.folds.rampRun / 2);
  const plat = w0(0, CONFIG.folds.platformSize);
  assert.ok(Math.abs(groundHeightAt(mid.x, mid.z, m.folds) - CONFIG.folds.platformHeight / 2) < 1e-9);
  assert.equal(groundHeightAt(plat.x, plat.z, m.folds), CONFIG.folds.platformHeight);
  near(m, 8, -5.8);
  applyFold(m, 0, 0);
  assert.equal(groundHeightAt(mid.x, mid.z, m.folds), 0);
  assert.equal(groundHeightAt(plat.x, plat.z, m.folds), CONFIG.folds.platformHeight);
  const side = w0(1.7, 3.2);
  assert.equal(groundHeightAt(side.x, side.z, m.folds), 0);
});

test('坡道可走上 1.5m 平台（步高逐级 <0.55）', () => {
  const m = mk();
  const p = near(m, 8, -6.5);
  p.yaw = 0;
  for (let i = 0; i < 22; i++) stepMatch(m, { 0: { f: 1 } });
  assert.ok(p.pos.z < -9.6 && p.pos.z > -12.8, 'z=' + p.pos.z);
  assert.ok(Math.abs(p.pos.y - (CONFIG.folds.platformHeight + CONFIG.player.eyeHeight)) < 1e-6, 'y=' + p.pos.y);
});

test('纸墙态封地面通道：碰撞阻挡 + 视线遮挡 + foldWalls 同步', () => {
  const m = mk();
  near(m, 8, -5.8);
  applyFold(m, 0, 0);
  stepMatch(m, {});
  assert.equal(m.foldWalls.length, 1);
  assert.equal(m.foldWalls[0].len, CONFIG.folds.wallLen);
  const b = losBlocker(m, { x: 8, y: 1, z: -6 }, { x: 8, y: 1, z: -10 });
  assert.ok(b, '折页墙应遮挡视线');
  const p = near(m, 8, -6.5);
  p.yaw = 0;
  for (let i = 0; i < 40; i++) stepMatch(m, { 0: { f: 1 } });
  assert.ok(p.pos.z > -7.7 && p.pos.z < -7.0, 'z=' + p.pos.z);
  assert.equal(p.pos.y, CONFIG.player.eyeHeight);
  applyFold(m, 0, 0);
  stepMatch(m, {});
  assert.equal(m.foldWalls.length, 0);
});

test('步高 >0.55 视为墙：平台侧向直上被回退', () => {
  const m = mk();
  const side = w0(1.7, 3.2);
  const p = near(m, side.x, side.z);
  p.yaw = -Math.PI / 2;
  for (let i = 0; i < 20; i++) stepMatch(m, { 0: { f: 1 } });
  assert.ok(Math.abs(p.pos.x - side.x) < 1e-6, 'x=' + p.pos.x);
  assert.equal(p.pos.y, CONFIG.player.eyeHeight);
});

test('敌人不上折纸：y 恒 0 且从不进入平台 footprint；平台阻挡敌人', () => {
  const m = mk();
  const p = near(m, 8, -11.2);
  p.pos.y = CONFIG.folds.platformHeight + CONFIG.player.eyeHeight;
  const e = createEnemy(m, 'crane', 8, -14.5);
  for (let i = 0; i < 60; i++) {
    stepMatch(m, {});
    assert.equal(e.y, 0);
    const { lx, lz } = foldLocal(m.folds[0], e.x, e.z);
    assert.ok(!(Math.abs(lx) <= 1.6 && lz >= 1.6 && lz <= 4.8), 'tick ' + i);
  }
});

test('nearestFold 选最近折角；任何玩家都可切换', () => {
  const m = createMatch({ seed: 5, playerIds: [0, 1] });
  const p1 = m.players[1];
  p1.pos.x = 0; p1.pos.z = -4;
  const n = nearestFold(m, p1);
  assert.equal(n.fold.id, 2);
  assert.ok(Math.abs(n.dist - 2) < 1e-9);
  assert.equal(applyFold(m, 1, 2).ok, true);
  assert.equal(m.folds[2].state, 'wall');
});

test('runtime.action fold 入口 + 快照 folds 状态/动画；同种子可复现', () => {
  const rt = createRuntime({ seed: 7 });
  const p = rt.match.players[0];
  p.pos.x = -2.2; p.pos.z = -6;
  assert.equal(rt.action(0, { m: 'fold', foldId: 2 }).ok, true);
  const s0 = rt.snapshot();
  assert.equal(s0.folds[2].state, 'wall');
  assert.equal(s0.folds[2].anim, 0);
  const runs = [];
  for (let k = 0; k < 2; k++) {
    const m = createMatch({ seed: 7 });
    const pp = m.players[0];
    pp.pos.x = -2.2; pp.pos.z = -6;
    applyFold(m, 0, 2);
    for (let i = 0; i < 20; i++) stepMatch(m, { 0: { f: 1, seq: i } });
    runs.push(JSON.stringify(snapshot(m)));
  }
  assert.equal(runs[0], runs[1]);
  assert.equal(FOLDS.length, 3);
});