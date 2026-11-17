import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import {
  PLAY_CLAMP, COVERS, BOUNDS, ANCHORS, FOLDS, SPAWNS, EXIT,
  foldLocal, groundHeightAt, foldWallBox, staticColliders, pickupList,
} from '../shared/world.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('场地：钳制 ±17.35，围墙 ±18', () => {
  assert.equal(PLAY_CLAMP, 17.35);
  assert.equal(BOUNDS.length, 4);
  assert.deepEqual(BOUNDS[0], { x: 0, z: -18, w: 36, d: 0.5, h: 2.8 });
});

test('八处掩体坐标与原型 buildWorld 一致', () => {
  assert.equal(COVERS.length, 8);
  assert.deepEqual(COVERS[0], { x: 0, z: 0, w: 4, d: 2, h: 1.3 });
  assert.deepEqual(COVERS[1], { x: -6, z: -4, w: 1.4, d: 5, h: 1.8 });
  assert.deepEqual(COVERS[7], { x: -12, z: 1, w: 1.2, d: 3, h: 1.25 });
});

test('锚点 A1(-11,-10) A2(10,1) A3(-3,9)，出口 (0,-15.6)', () => {
  assert.deepEqual(ANCHORS.map(a => [a.label, a.x, a.z]), [['A1', -11, -10], ['A2', 10, 1], ['A3', -3, 9]]);
  assert.deepEqual(EXIT, { x: 0, z: -15.6 });
});

test('出生点 4 个，主出生 (0,-13)', () => {
  assert.equal(SPAWNS.length, 4);
  assert.deepEqual(SPAWNS[0], { x: 0, z: -13 });
});

test('折页初始为坡道，位置与 CONFIG 一致', () => {
  assert.equal(FOLDS.length, 3);
  for (const f of FOLDS) assert.equal(f.state, 'ramp');
  assert.deepEqual([FOLDS[0].x, FOLDS[0].z], [8, -8]);
});

test('foldLocal：rotY=π/2 逆变换', () => {
  const f = { x: -9, z: 4, rotY: Math.PI / 2 };
  const { lx, lz } = foldLocal(f, -8, 6);
  near(lx, -2, 1e-9);
  near(lz, 1, 1e-9);
});

test('groundHeightAt：fold0 平台顶 1.5（世界点 (8,-11.2)）', () => {
  const folds = [{ x: 8, z: -8, rotY: Math.PI, state: 'ramp' }];
  near(groundHeightAt(8, -11.2, folds), 1.5, 1e-9);
});

test('groundHeightAt：坡道中点线性升高，墙形态坡道消失', () => {
  const ramp = [{ x: 8, z: -8, rotY: Math.PI, state: 'ramp' }];
  const wall = [{ x: 8, z: -8, rotY: Math.PI, state: 'wall' }];
  const zMid = -8 - CONFIG.folds.rampRun / 2;
  near(groundHeightAt(8, zMid, ramp), 0.75, 1e-9);
  near(groundHeightAt(8, zMid, wall), 0);
  near(groundHeightAt(8, -11.2, wall), 1.5, 1e-9); // 平台不随折页状态变化
});

test('groundHeightAt：开阔地面为 0', () => {
  near(groundHeightAt(0, -13, FOLDS), 0);
});

test('foldWallBox：len 3.9，法线垂直切向', () => {
  const w = foldWallBox(FOLDS[0]);
  assert.equal(w.len, 3.9);
  near(w.ux * w.nx + w.uz * w.nz, 0, 1e-9);
  assert.equal(w.halfThickness, 0.06);
});

test('staticColliders：8 掩体 + 4 围墙 + 3 平台，平台带豁免标记', () => {
  const list = staticColliders();
  assert.equal(list.length, 15);
  const platforms = list.filter(b => b.platform);
  assert.equal(platforms.length, 3);
  near(platforms[0].x, 8, 1e-9);
  near(platforms[0].z, -11.2, 1e-9);
  assert.equal(platforms[0].y1, 1.5);
});

test('pickupList：6 件，墨水 3 胶带 3，含 (0,10)', () => {
  const list = pickupList();
  assert.equal(list.length, 6);
  assert.equal(list.filter(p => p.ty === 'ink').length, 3);
  const tapes = list.filter(p => p.ty === 'tape');
  assert.equal(tapes.length, 3);
  assert.ok(tapes.some(p => p.x === 0 && p.z === 10));
  assert.equal(new Set(list.map(p => p.id)).size, 6);
});