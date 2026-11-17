// 世界静态数据 + 地形采样，自原型 buildWorld/groundHeightAt 移植。
// 纯数据与纯函数；房主模拟与客户端渲染共用同一份坐标。
import CONFIG from './config.mjs';

export const PLAY_CLAMP = 17.35;

// 规格 §3.14 八处掩体（与原型一致）
export const COVERS = [
  { x: 0, z: 0, w: 4, d: 2, h: 1.3 },
  { x: -6, z: -4, w: 1.4, d: 5, h: 1.8 },
  { x: 6, z: -5, w: 4, d: 1.2, h: 1.1 },
  { x: 7, z: 6, w: 1.4, d: 4.5, h: 1.8 },
  { x: -8, z: 7, w: 3, d: 1.2, h: 1.1 },
  { x: 0, z: 12, w: 3.2, d: 1.2, h: 1.4 },
  { x: 12, z: -1, w: 1.4, d: 3.2, h: 1.5 },
  { x: -12, z: 1, w: 1.2, d: 3, h: 1.25 },
];

export const BOUNDS = [
  { x: 0, z: -18, w: 36, d: 0.5, h: 2.8 },
  { x: 0, z: 18, w: 36, d: 0.5, h: 2.8 },
  { x: -18, z: 0, w: 0.5, d: 36, h: 2.8 },
  { x: 18, z: 0, w: 0.5, d: 36, h: 2.8 },
];

export const ANCHORS = [
  { i: 0, x: -11, z: -10, label: 'A1' },
  { i: 1, x: 10, z: 1, label: 'A2' },
  { i: 2, x: -3, z: 9, label: 'A3' },
];

export const FOLDS = CONFIG.folds.positions.map((p, i) => ({ id: i, x: p.x, z: p.z, rotY: p.rotY, state: 'ramp' }));

// 规格 §3.15：出生点 (0,-13) 起，面向北（-z）
export const SPAWNS = [
  { x: 0, z: -13 },
  { x: -3, z: -13 },
  { x: 3, z: -13 },
  { x: -6, z: -13 },
];

export const EXIT = { x: 0, z: -15.6 };

export function foldLocal(f, x, z) {
  const dx = x - f.x, dz = z - f.z;
  const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

// folds: [{x, z, rotY, state}]，state ∈ 'ramp' | 'wall'（平台为固定静态体，不随状态变化）
export function groundHeightAt(x, z, folds) {
  const F = CONFIG.folds;
  let h = 0;
  for (const f of folds) {
    const { lx, lz } = foldLocal(f, x, z);
    if (Math.abs(lx) <= F.platformSize / 2 && lz >= 1.6 && lz <= 4.8) {
      h = Math.max(h, F.platformHeight);
    } else if (f.state === 'ramp' && Math.abs(lx) <= 1.95 && lz >= 0 && lz <= F.rampRun) {
      h = Math.max(h, F.platformHeight * (lz / F.rampRun));
    }
  }
  return h;
}

// 折页墙形态的碰撞胶囊（len 3.9，沿 rotY 切向）
export function foldWallBox(f) {
  const ux = Math.cos(f.rotY), uz = -Math.sin(f.rotY);
  return {
    x: f.x, z: f.z,
    len: CONFIG.folds.wallLen,
    ux, uz,
    nx: -uz, nz: ux,
    halfThickness: CONFIG.folds.halfThickness,
  };
}

// 静态碰撞体：掩体 + 边界 + 折页平台（platform:true 时玩家豁免，仅敌人/弹丸受阻）
export function staticColliders() {
  const list = [];
  for (const b of [...COVERS, ...BOUNDS]) {
    list.push({ x: b.x, z: b.z, hx: b.w / 2, hz: b.d / 2, y0: 0, y1: b.h });
  }
  for (const f of FOLDS) {
    const px = f.x + Math.sin(f.rotY) * CONFIG.folds.platformSize;
    const pz = f.z + Math.cos(f.rotY) * CONFIG.folds.platformSize;
    list.push({
      x: px, z: pz,
      hx: CONFIG.folds.platformSize / 2, hz: CONFIG.folds.platformSize / 2,
      y0: 0, y1: CONFIG.folds.platformHeight,
      platform: true,
    });
  }
  return list;
}

export function pickupList() {
  const list = [];
  let id = 0;
  for (const p of CONFIG.pickups.ink) list.push({ id: id++, ty: 'ink', x: p.x, z: p.z });
  for (const p of CONFIG.pickups.tape) list.push({ id: id++, ty: 'tape', x: p.x, z: p.z });
  return list;
}