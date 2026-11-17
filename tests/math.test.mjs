import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointSegmentDistance, collideCapsule, resolveCircle, moveCircle,
  rayVsAABB, rayVsCylinder, rayVsOBB, segmentBlocked, aabbOf,
} from '../shared/math.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('rayVsAABB：正面命中 t=4', () => {
  const t = rayVsAABB({ x: 0, y: 0.5, z: -5 }, { x: 0, y: 0, z: 1 },
    { x: -1, y: 0, z: -1 }, { x: 1, y: 1, z: 1 });
  near(t, 4);
});

test('rayVsAABB：侧向错过 / 起点在盒内返回 0', () => {
  assert.equal(rayVsAABB({ x: 2, y: 0.5, z: -5 }, { x: 0, y: 0, z: 1 },
    { x: -1, y: 0, z: -1 }, { x: 1, y: 1, z: 1 }), null);
  near(rayVsAABB({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 1 },
    { x: -1, y: 0, z: -1 }, { x: 1, y: 1, z: 1 }), 0);
});

test('rayVsAABB：平行轴在盒外 → null（slab 退化分支）', () => {
  assert.equal(rayVsAABB({ x: 0, y: 3, z: -5 }, { x: 0, y: 0, z: 1 },
    { x: -1, y: 0, z: -1 }, { x: 1, y: 1, z: 1 }), null);
});

test('rayVsCylinder：侧面命中 t=4', () => {
  const t = rayVsCylinder({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 },
    { x: 0, z: 0, r: 1, y0: 0, y1: 2 });
  near(t, 4);
});

test('rayVsCylinder：顶盖命中 t=3 / 侧向错过', () => {
  near(rayVsCylinder({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 },
    { x: 0, z: 0, r: 1, y0: 0, y1: 2 }), 3);
  assert.equal(rayVsCylinder({ x: 2, y: 1, z: -5 }, { x: 0, y: 0, z: 1 },
    { x: 0, z: 0, r: 1, y0: 0, y1: 2 }), null);
});

test('rayVsCylinder：高度区间外不算命中', () => {
  assert.equal(rayVsCylinder({ x: 0, y: 3, z: -5 }, { x: 0, y: 0, z: 1 },
    { x: 0, z: 0, r: 1, y0: 0, y1: 2 }), null);
});

test('rayVsOBB：45° 旋转盒，命中 t = 5-√2', () => {
  const t = rayVsOBB({ x: -5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 },
    { cx: 0, cz: 0, hx: 1, hz: 1, rot: Math.PI / 4, y0: 0, y1: 1 });
  near(t, 5 - Math.SQRT2, 1e-6);
});

test('rayVsOBB：rot=0 退化为 AABB', () => {
  const t = rayVsOBB({ x: -5, y: 0.5, z: 0 }, { x: 1, y: 0, z: 0 },
    { cx: 0, cz: 0, hx: 1, hz: 1, rot: 0, y0: 0, y1: 1 });
  near(t, 4);
});

test('pointSegmentDistance：垂足 / 端点 / 零长线段', () => {
  near(pointSegmentDistance({ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 1, z: 0 }), 1);
  near(pointSegmentDistance({ x: 3, z: 0 }, { x: -1, z: 0 }, { x: 1, z: 0 }), 2);
  near(pointSegmentDistance({ x: 3, z: 4 }, { x: 0, z: 0 }, { x: 0, z: 0 }), 5);
});

test('collideCapsule：圆心陷入墙内 → 沿法线推出到 r+halfThickness', () => {
  const w = { x: 0, z: 0, len: 4, ux: 1, uz: 0, nx: 0, nz: 1, halfThickness: 0.06 };
  const pos = { x: 0, z: 0.1 };
  collideCapsule(pos, 0.34, w);
  near(pos.z, 0.4);
  near(pos.x, 0);
});

test('collideCapsule：墙端点外不碰撞', () => {
  const w = { x: 0, z: 0, len: 4, ux: 1, uz: 0, nx: 0, nz: 1, halfThickness: 0.06 };
  const pos = { x: 5, z: 0.1 };
  collideCapsule(pos, 0.34, w);
  near(pos.x, 5);
  near(pos.z, 0.1);
});

const emptyCtx = (over = {}) => ({
  isPlayer: true, staticColliders: [], walls: [], foldWalls: [], clamp: 17.35, ...over,
});

test('resolveCircle：场地边界钳制 ±17.35-r', () => {
  const pos = { x: 20, z: -20 };
  resolveCircle(pos, 0.34, emptyCtx());
  near(pos.x, 17.01);
  near(pos.z, -17.01);
});

test('resolveCircle：平台对玩家豁免、对敌人阻挡', () => {
  const box = { x: 0, z: 0, hx: 1, hz: 1, y0: 0, y1: 1.5, platform: true };
  const p1 = { x: 0, z: 0 };
  resolveCircle(p1, 0.34, emptyCtx({ isPlayer: true, staticColliders: [box] }));
  near(p1.x, 0); near(p1.z, 0);
  const p2 = { x: 0, z: 0 };
  resolveCircle(p2, 0.38, emptyCtx({ isPlayer: false, staticColliders: [box] }));
  assert.ok(Math.abs(p2.x) >= 1.38 - 1e-6 || Math.abs(p2.z) >= 1.38 - 1e-6);
});

test('resolveCircle：死亡墙不参与碰撞', () => {
  const w = { x: 0, z: 0, len: 4, ux: 1, uz: 0, nx: 0, nz: 1, halfThickness: 0.06, dead: true };
  const pos = { x: 0, z: 0.1 };
  resolveCircle(pos, 0.34, emptyCtx({ walls: [w] }));
  near(pos.z, 0.1);
});

test('moveCircle：位移后推挤生效', () => {
  const box = { x: 2, z: 0, hx: 0.5, hz: 0.5, y0: 0, y1: 1.3 };
  const pos = { x: 0, z: 0 };
  moveCircle(pos, 1.6, 0, 0.34, emptyCtx({ staticColliders: [box] }));
  near(pos.x, 1.16);
});

test('segmentBlocked：穿盒阻挡 / 盒顶上方通过', () => {
  const box = aabbOf({ x: 0, z: 0, hx: 1, hz: 1, y0: 0, y1: 2 });
  assert.equal(segmentBlocked({ x: -5, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }, [box]), true);
  assert.equal(segmentBlocked({ x: -5, y: 3, z: 0 }, { x: 5, y: 3, z: 0 }, [box]), false);
  assert.equal(segmentBlocked({ x: -5, y: 1, z: 0 }, { x: -4, y: 1, z: 0 }, [box]), false);
});