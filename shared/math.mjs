// 纯数学：无 DOM / THREE / Node 依赖。
// 碰撞推挤自原型 src/game.js §5 原样移植（全局变量改为 ctx 参数）；
// 解析射线为新增，替代原型对 THREE.Raycaster 的依赖（房主权威命中/LOS 共用）。

export function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  if (!l2) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function collideCapsule(pos, r, w) {
  const dx = pos.x - w.x, dz = pos.z - w.z;
  const along = dx * w.ux + dz * w.uz;
  const side = dx * w.nx + dz * w.nz;
  const ht = w.halfThickness;
  const ca = Math.max(-w.len / 2, Math.min(w.len / 2, along));
  const cs = Math.max(-ht, Math.min(ht, side));
  const qx = w.x + w.ux * ca + w.nx * cs;
  const qz = w.z + w.uz * ca + w.nz * cs;
  const ox = pos.x - qx, oz = pos.z - qz, d2 = ox * ox + oz * oz;
  if (d2 > 0 && d2 < r * r) {
    const d = Math.sqrt(d2), push = (r - d) / d;
    pos.x += ox * push;
    pos.z += oz * push;
  } else if (Math.abs(along) < w.len / 2 && Math.abs(side) < ht + r) {
    const s = Math.sign(side || 1), push = ht + r - Math.abs(side);
    pos.x += w.nx * s * push;
    pos.z += w.nz * s * push;
  }
}

// ctx: { isPlayer, staticColliders, walls, foldWalls, clamp }
export function resolveCircle(pos, r, ctx) {
  const c = ctx.clamp;
  pos.x = Math.max(-c + r, Math.min(c - r, pos.x));
  pos.z = Math.max(-c + r, Math.min(c - r, pos.z));
  for (const b of ctx.staticColliders) {
    if (b.platform && ctx.isPlayer) continue;
    const cx = Math.max(b.x - b.hx, Math.min(b.x + b.hx, pos.x));
    const cz = Math.max(b.z - b.hz, Math.min(b.z + b.hz, pos.z));
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 > 0 && d2 < r * r) {
      const d = Math.sqrt(d2), push = (r - d) / d;
      pos.x += dx * push;
      pos.z += dz * push;
    } else if (Math.abs(pos.x - b.x) < b.hx && Math.abs(pos.z - b.z) < b.hz) {
      const px = b.hx - Math.abs(pos.x - b.x), pz = b.hz - Math.abs(pos.z - b.z);
      if (px < pz) pos.x = b.x + Math.sign(pos.x - b.x || 1) * (b.hx + r);
      else pos.z = b.z + Math.sign(pos.z - b.z || 1) * (b.hz + r);
    }
  }
  for (const w of ctx.walls) {
    if (w.dead) continue;
    collideCapsule(pos, r, w);
  }
  for (const w of ctx.foldWalls) collideCapsule(pos, r, w);
}

export function moveCircle(pos, dx, dz, r, ctx) {
  pos.x += dx;
  pos.z += dz;
  resolveCircle(pos, r, ctx);
}

export function rayVsAABB(o, d, min, max) {
  let tmin = 0, tmax = Infinity;
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < min[k] || o[k] > max[k]) return null;
    } else {
      let t1 = (min[k] - o[k]) / d[k], t2 = (max[k] - o[k]) / d[k];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// 竖直圆柱 c: {x, z, r, y0, y1}；返回最近非负 t 或 null
export function rayVsCylinder(o, d, c) {
  const ox = o.x - c.x, oz = o.z - c.z;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (ox * d.x + oz * d.z);
  const cc = ox * ox + oz * oz - c.r * c.r;
  let best = null;
  const consider = (t) => {
    if (t < 0) return;
    const y = o.y + d.y * t;
    if (y >= c.y0 && y <= c.y1 && (best === null || t < best)) best = t;
  };
  if (a > 1e-12) {
    const disc = b * b - 4 * a * cc;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      consider((-b - sq) / (2 * a));
      consider((-b + sq) / (2 * a));
    }
  }
  if (Math.abs(d.y) > 1e-9) {
    for (const py of [c.y0, c.y1]) {
      const t = (py - o.y) / d.y;
      if (t < 0) continue;
      const px = ox + d.x * t, pz = oz + d.z * t;
      if (px * px + pz * pz <= c.r * c.r && (best === null || t < best)) best = t;
    }
  }
  return best;
}

// 绕 Y 旋转的水平盒 b: {cx, cz, hx, hz, rot, y0, y1}；rot 约定与 world.foldLocal 一致
export function rayVsOBB(o, d, b) {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const lx = o.x - b.cx, lz = o.z - b.cz;
  const lo = { x: lx * c - lz * s, y: o.y, z: lx * s + lz * c };
  const ld = { x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c };
  return rayVsAABB(lo, ld, { x: -b.hx, y: b.y0, z: -b.hz }, { x: b.hx, y: b.y1, z: b.hz });
}

export function aabbOf(b) {
  return {
    min: { x: b.x - b.hx, y: b.y0, z: b.z - b.hz },
    max: { x: b.x + b.hx, y: b.y1, z: b.z + b.hz },
  };
}

// a→b 线段是否被任一 AABB 阻挡（端点容差 2cm）
export function segmentBlocked(a, b, boxes) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 0.001) return false;
  d.x /= len; d.y /= len; d.z /= len;
  for (const box of boxes) {
    const { min, max } = box.min ? box : aabbOf(box);
    const t = rayVsAABB(a, d, min, max);
    if (t !== null && t > 0.02 && t < len - 0.02) return true;
  }
  return false;
}