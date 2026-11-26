// 生成 Boss 奶龙低模 src/models/bs.json（T8.3 提前打磨）。
// 基座 tools/model-base.json 由 D6 资产的融球身/头 + 奶白肚 + 双腿提取；
// 本脚本重做眼/瞳/高光/眼睑/嘴/腮红/手臂/手/脚/爪，并校验 ≤4000 面、≤100KB。
// 用法：
//   node tools/gen-boss.mjs --extract   # 从当前 src/models/bs.json 提取基座
//   node tools/gen-boss.mjs [--out f] [--preview]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = path.join(ROOT, 'src/models/bs.json');
const BASE = path.join(ROOT, 'tools/model-base.json');

const BODY = 'F8CB4A';   // 规格 §6.4 身体色
const BELLY = 'F4E9D2';
const LIMB = '7A6A55';   // 手/脚
const EYE = '3E9B4F';
const PUPIL = '20242A';
const MOUTH = '4A4438';
const WHITE = 'FFFFFF';
const BLUSH = 'F2A0A0';

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function readModel(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const verts = [];
  for (let i = 0; i < j.pos.length; i += 3) verts.push([j.pos[i] / 1000, j.pos[i + 1] / 1000, j.pos[i + 2] / 1000]);
  return { name: j.name, sm: j.sm, verts, cols: j.col.slice(), tris: j.idx.slice() };
}

function components(m) {
  const n = m.verts.length;
  const par = Array.from({ length: n }, (_, i) => i);
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let t = 0; t < m.tris.length; t += 3) {
    const a = find(m.tris[t]), b = find(m.tris[t + 1]), c = find(m.tris[t + 2]);
    par[b] = a; par[find(c)] = a;
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const out = [];
  for (const ids of groups.values()) {
    const set = new Set(ids);
    const tris = [];
    for (let t = 0; t < m.tris.length; t += 3) {
      if (set.has(m.tris[t]) && set.has(m.tris[t + 1]) && set.has(m.tris[t + 2])) tris.push(t);
    }
    let cx = 0, cy = 0, cz = 0;
    for (const i of ids) { cx += m.verts[i][0]; cy += m.verts[i][1]; cz += m.verts[i][2]; }
    out.push({ ids, tris, c: [cx / ids.length, cy / ids.length, cz / ids.length], color: m.cols[ids[0]] });
  }
  return out;
}

function extractBase() {
  const m = readModel(ASSET);
  const comps = components(m).sort((a, b) => b.ids.length - a.ids.length);
  const core = comps[0];
  const belly = comps.find(c => c.color === BELLY);
  const legs = comps.filter(c => c.color === 'F6C544' && c.c[1] < 0.9 && Math.abs(c.c[0]) > 0.1);
  if (!core || !belly || legs.length !== 2) throw new Error('基座提取失败：核心/肚皮/腿数量不符');
  const keep = [core, belly, ...legs];
  const map = new Map();
  const verts = [], cols = [], tris = [];
  for (const comp of keep) {
    const local = new Map();
    for (const i of comp.ids) {
      local.set(i, verts.length);
      verts.push(m.verts[i]);
      cols.push(m.cols[i]);
    }
    for (const t of comp.tris) tris.push(local.get(m.tris[t]), local.get(m.tris[t + 1]), local.get(m.tris[t + 2]));
    map.set(comp, local);
  }
  const pos = [];
  for (const v of verts) pos.push(Math.round(v[0] * 1000), Math.round(v[1] * 1000), Math.round(v[2] * 1000));
  fs.writeFileSync(BASE, JSON.stringify({ name: 'bs-base', sm: 1, pos, col: cols, idx: tris }));
  console.log(`基座已写出 ${path.relative(ROOT, BASE)}：${verts.length} 顶点 / ${tris.length / 3} 面`);
}

function part() { return { verts: [], tris: [] }; }

function fixWinding(g) {
  let vol = 0;
  for (let t = 0; t < g.tris.length; t += 3) {
    const a = g.verts[g.tris[t]], b = g.verts[g.tris[t + 1]], c = g.verts[g.tris[t + 2]];
    vol += dot(a, cross(b, c)) / 6;
  }
  if (vol < 0) {
    for (let t = 0; t < g.tris.length; t += 3) {
      const tmp = g.tris[t + 1]; g.tris[t + 1] = g.tris[t + 2]; g.tris[t + 2] = tmp;
    }
  }
}

function ellipsoid(c, r, { lon = 10, lat = 6, rotZ = 0 } = {}) {
  const g = part();
  const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
  const push = (x, y, z) => {
    const rx = x * cosZ - y * sinZ, ry = x * sinZ + y * cosZ;
    g.verts.push([c[0] + rx, c[1] + ry, c[2] + z]);
    return g.verts.length - 1;
  };
  const top = push(0, r[1], 0);
  const rings = [];
  for (let i = 1; i < lat; i++) {
    const phi = (Math.PI * i) / lat;
    const row = [];
    for (let j = 0; j < lon; j++) {
      const th = (2 * Math.PI * j) / lon;
      row.push(push(r[0] * Math.sin(phi) * Math.cos(th), r[1] * Math.cos(phi), r[2] * Math.sin(phi) * Math.sin(th)));
    }
    rings.push(row);
  }
  const bot = push(0, -r[1], 0);
  for (let j = 0; j < lon; j++) g.tris.push(top, rings[0][j], rings[0][(j + 1) % lon]);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < lon; j++) {
      const a = rings[i][j], b = rings[i][(j + 1) % lon], c2 = rings[i + 1][(j + 1) % lon], d = rings[i + 1][j];
      g.tris.push(a, b, c2, a, c2, d);
    }
  }
  const last = rings[rings.length - 1];
  for (let j = 0; j < lon; j++) g.tris.push(bot, last[(j + 1) % lon], last[j]);
  fixWinding(g);
  return g;
}

function tube(points, radii, { sides = 8, caps = true } = {}) {
  const g = part();
  const n = points.length;
  const tangents = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    return norm(sub(b, a));
  });
  const up = [0, 1, 0];
  const rings = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const ref = Math.abs(dot(t, up)) > 0.92 ? [0, 0, 1] : up;
    const n1 = norm(cross(t, ref));
    const n2 = norm(cross(t, n1));
    const row = [];
    for (let j = 0; j < sides; j++) {
      const a = (2 * Math.PI * j) / sides;
      const p = add(points[i], add(mul(n1, Math.cos(a) * radii[i]), mul(n2, Math.sin(a) * radii[i])));
      g.verts.push(p);
      row.push(g.verts.length - 1);
    }
    rings.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = rings[i][j], b = rings[i][(j + 1) % sides], c = rings[i + 1][(j + 1) % sides], d = rings[i + 1][j];
      g.tris.push(a, b, c, a, c, d);
    }
  }
  if (caps) {
    for (const [i, sign] of [[0, -1], [n - 1, 1]]) {
      g.verts.push(add(points[i], mul(tangents[i], sign * radii[i] * 0.6)));
      const c = g.verts.length - 1;
      for (let j = 0; j < sides; j++) {
        if (sign > 0) g.tris.push(rings[i][j], rings[i][(j + 1) % sides], c);
        else g.tris.push(rings[i][(j + 1) % sides], rings[i][j], c);
      }
    }
  }
  fixWinding(g);
  return g;
}

function cone(base, tip, radius, sides = 4) {
  const g = part();
  const ax = norm(sub(tip, base));
  const ref = Math.abs(dot(ax, [0, 1, 0])) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const n1 = norm(cross(ax, ref));
  const n2 = norm(cross(ax, n1));
  const ring = [];
  for (let j = 0; j < sides; j++) {
    const a = (2 * Math.PI * j) / sides;
    ring.push(g.verts.length);
    g.verts.push(add(base, add(mul(n1, Math.cos(a) * radius), mul(n2, Math.sin(a) * radius))));
  }
  g.verts.push(base);
  const bc = g.verts.length - 1;
  g.verts.push(tip);
  const ti = g.verts.length - 1;
  for (let j = 0; j < sides; j++) {
    g.tris.push(ring[j], ring[(j + 1) % sides], ti);
    g.tris.push(ring[(j + 1) % sides], ring[j], bc);
  }
  fixWinding(g);
  return g;
}

function patch(cx, cy, rx, ry, rotZ, core, { seg = 10, rings = 2, offset = 0.006 } = {}) {
  const g = part();
  const at = (r, a) => {
    const u = rx * r * Math.cos(a), v = ry * r * Math.sin(a);
    const x = cx + u * Math.cos(rotZ) - v * Math.sin(rotZ);
    const y = cy + u * Math.sin(rotZ) + v * Math.cos(rotZ);
    return [x, y, surfaceRay(core, x, y) + offset];
  };
  g.verts.push(at(0, 0));
  const ringsIdx = [];
  for (let k = 1; k <= rings; k++) {
    const row = [];
    for (let j = 0; j < seg; j++) {
      g.verts.push(at(k / rings, (2 * Math.PI * j) / seg));
      row.push(g.verts.length - 1);
    }
    ringsIdx.push(row);
  }
  for (let j = 0; j < seg; j++) g.tris.push(0, ringsIdx[0][j], ringsIdx[0][(j + 1) % seg]);
  for (let k = 0; k < rings - 1; k++) {
    for (let j = 0; j < seg; j++) {
      const a = ringsIdx[k][j], b = ringsIdx[k][(j + 1) % seg];
      const c = ringsIdx[k + 1][(j + 1) % seg], d = ringsIdx[k + 1][j];
      g.tris.push(a, b, c, a, c, d);
    }
  }
  return g;
}

function foot(x0, z0) {  const g = part();
  const outline = [
    [-0.10, -0.07], [-0.05, -0.10], [0.05, -0.10], [0.10, -0.07],
    [0.145, 0.0], [0.152, 0.10],
    [0.152, 0.17], [0.14, 0.22], [0.11, 0.245], [0.075, 0.24], [0.05, 0.215],
    [0.045, 0.255], [0.02, 0.275], [-0.02, 0.275], [-0.045, 0.255],
    [-0.05, 0.215], [-0.075, 0.24], [-0.11, 0.245], [-0.14, 0.22], [-0.152, 0.17],
    [-0.152, 0.10], [-0.145, 0.0],
  ];
  const n = outline.length;
  const bottom = [], top = [];
  for (const [u, v] of outline) {
    bottom.push(g.verts.length);
    g.verts.push([x0 + u, 0.004, z0 + v]);
    top.push(g.verts.length);
    g.verts.push([x0 + u * 0.94, 0.078, z0 + v * 0.94 + 0.004]);
  }
  g.verts.push([x0, 0.004, z0 + 0.08]);
  const bc = g.verts.length - 1;
  g.verts.push([x0, 0.105, z0 + 0.09]);
  const tc = g.verts.length - 1;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    g.tris.push(bottom[j], bottom[k], top[k], bottom[j], top[k], top[j]);
    g.tris.push(tc, top[j], top[k]);
    g.tris.push(bc, bottom[k], bottom[j]);
  }
  fixWinding(g);
  return g;
}

function surfaceRay(core, x, y) {
  let best = -Infinity;
  const org = [x, y, 5];
  const dir = [0, 0, -1];
  for (let t = 0; t < core.tris.length; t += 3) {
    const a = core.verts[core.tris[t]], b = core.verts[core.tris[t + 1]], c = core.verts[core.tris[t + 2]];
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(dir, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-9) continue;
    const inv = 1 / det, s = sub(org, a);
    const u = dot(s, h) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(dir, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const z = org[2] - dot(e2, q) * inv;
    if (z > best) best = z;
  }
  return best;
}

function build() {
  const base = readModel(BASE);
  // 骨架部件（基座原样保留，身体色统一到规格 #F8CB4A）
  const out = part();
  const colors = [];
  for (let i = 0; i < base.verts.length; i++) {
    out.verts.push(base.verts[i].slice());
    colors.push(base.cols[i] === 'F6C544' ? BODY : base.cols[i]);
  }
  out.tris.push(...base.tris);
  // 头身比例：奶龙是大头小身——纵向重排（脚底不动，躯干压缩、头部拉高），
  // 再按钟形放宽加深头部（基于原始 y 取形，最后再映射 y）
  const warpY = y => {
    if (y <= 0.3) return y;
    if (y < 1.5) return 0.3 + (y - 0.3) * 0.8;
    return 1.26 + (y - 1.5) * 1.26;
  };
  for (const v of out.verts) {
    const y0 = v[1];
    if (y0 < 1.5) {
      v[0] *= 0.94;
    } else {
      const bell = sm(1.55, 1.78, y0) * (1 - 0.55 * sm(2.18, 2.42, y0));
      const ox = v[0];
      v[0] *= 1 + 0.65 * bell;
      v[2] *= 1 + 0.08 * bell;
      if (v[2] > 0) {
        const cheek = Math.exp(-(((y0 - 1.88) / 0.20) ** 2)) * Math.max(0, 1 - (Math.abs(ox) / 0.62) ** 2);
        v[2] += 0.02 * cheek;
      }
    }
    v[1] = warpY(y0);
  }
  // 奶白肚：纵向重排后会被压扁，按其顶缘向下拉长，并略加宽（参考肚皮约占躯干 2/3）
  const bellyIds = [];
  for (let i = 0; i < base.cols.length; i++) if (base.cols[i] === BELLY) bellyIds.push(i);
  let bellyTop = -Infinity;
  for (const i of bellyIds) bellyTop = Math.max(bellyTop, out.verts[i][1]);
  for (const i of bellyIds) {
    const v = out.verts[i];
    v[0] *= 1.06;
    v[1] = bellyTop + (v[1] - bellyTop) * 1.3;
  }
  const coreView = { verts: out.verts.slice(), tris: out.tris.slice() };

  const addPart = (g, color) => {
    const off = out.verts.length;
    for (const v of g.verts) { out.verts.push(v); colors.push(color); }
    for (const i of g.tris) out.tris.push(off + i);
  };

  // 口鼻：极浅的吻部凸起，给微笑一个落点
  const muzzleY = 1.76;
  const muzzleZ = surfaceRay(coreView, 0, muzzleY) - 0.012;
  const muzzle = ellipsoid([0, muzzleY, muzzleZ], [0.20, 0.115, 0.05], { lon: 10, lat: 6 });
  addPart(muzzle, BODY);
  const muzzleFront = (x, y) => {
    const q = 1 - (x / 0.20) ** 2 - ((y - muzzleY) / 0.115) ** 2;
    return q <= 0 ? -Infinity : muzzleZ + 0.05 * Math.sqrt(q);
  };

  // 眼：绿半球 + 黑瞳 + 双高光 + 上眼睑弧
  const eyeY = 1.97;
  for (const s of [-1, 1]) {
    const ex = 0.19 * s;
    const ez = surfaceRay(coreView, ex, eyeY) - 0.005;
    addPart(ellipsoid([ex, eyeY, ez], [0.115, 0.135, 0.085], { lon: 10, lat: 6 }), EYE);
    const pz = ez + 0.05;
    addPart(ellipsoid([ex, eyeY - 0.012, pz], [0.055, 0.062, 0.05], { lon: 8, lat: 5 }), PUPIL);
    const pFront = pz + 0.05;
    addPart(ellipsoid([ex - 0.024, eyeY + 0.03, pFront - 0.002], [0.024, 0.024, 0.024], { lon: 6, lat: 4 }), WHITE);
    addPart(ellipsoid([ex + 0.027, eyeY - 0.032, pFront - 0.004], [0.01, 0.01, 0.01], { lon: 5, lat: 3 }), WHITE);
    const lid = [];
    for (let k = 0; k < 7; k++) {
      const a = Math.PI * (0.18 + (0.64 * k) / 6);
      const dx = 0.104 * Math.cos(a), dy = 0.122 * Math.sin(a);
      const q = Math.max(0, 1 - (dx / 0.115) ** 2 - (dy / 0.135) ** 2);
      lid.push([ex + dx, eyeY + dy, ez + 0.085 * Math.sqrt(q) + 0.004]);
    }
    addPart(tube(lid, lid.map(() => 0.008), { sides: 5 }), PUPIL);
  }

  // 微笑：贴合吻部的弧线
  const mouthPts = [];
  for (let k = 0; k < 11; k++) {
    const x = -0.09 + (0.18 * k) / 10;
    const y = 1.72 + 2.6 * x * x;
    const z = Math.max(surfaceRay(coreView, x, y), muzzleFront(x, y)) + 0.008;
    mouthPts.push([x, y, z]);
  }
  addPart(tube(mouthPts, mouthPts.map(() => 0.012), { sides: 6 }), MOUTH);

  // 腮红：贴面弧片（直接采头部曲面，避免平面片沉进脸里）
  for (const s of [-1, 1]) {
    addPart(patch(0.38 * s, 1.80, 0.072, 0.030, -0.22 * s, coreView), BLUSH);
  }

  // 手臂 + 灰手 + 三爪
  for (const s of [-1, 1]) {
    const pts = [
      [0.40 * s, 1.26, 0.03], [0.50 * s, 1.18, 0.08], [0.57 * s, 1.05, 0.13],
      [0.59 * s, 0.92, 0.16], [0.58 * s, 0.82, 0.18],
    ];
    addPart(tube(pts, [0.115, 0.108, 0.095, 0.082, 0.075], { sides: 8 }), BODY);
    const hx = 0.59 * s, hy = 0.77, hz = 0.19;
    addPart(ellipsoid([hx, hy, hz], [0.085, 0.10, 0.085], { lon: 8, lat: 5 }), LIMB);
    for (const dx of [-0.04, 0, 0.04]) {
      addPart(cone([hx + dx, hy - 0.075, hz + 0.03], [hx + dx * 1.2, hy - 0.14, hz + 0.06], 0.016), MOUTH);
    }
  }

  // 鸭蹼脚 + 三爪
  for (const s of [-1, 1]) {
    const fx = 0.27 * s;
    addPart(foot(fx, 0), LIMB);
    for (const [dx, dz] of [[-0.10, 0.235], [0, 0.27], [0.10, 0.235]]) {
      addPart(cone([fx + dx, 0.045, dz - 0.008], [fx + dx, 0.02, dz + 0.055], 0.017), MOUTH);
    }
  }

  const pos = [];
  for (const v of out.verts) pos.push(Math.round(v[0] * 1000), Math.round(v[1] * 1000), Math.round(v[2] * 1000));
  const model = { name: 'bs', sm: 1, pos, col: colors, idx: out.tris };
  return { model, muzzleZ };
}

function validate(model) {
  const nv = model.pos.length / 3;
  const tris = model.idx.length / 3;
  const bytes = JSON.stringify(model).length;
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, minz = 1e9, maxz = -1e9;
  for (let i = 0; i < model.pos.length; i += 3) {
    minx = Math.min(minx, model.pos[i]); maxx = Math.max(maxx, model.pos[i]);
    miny = Math.min(miny, model.pos[i + 1]); maxy = Math.max(maxy, model.pos[i + 1]);
    minz = Math.min(minz, model.pos[i + 2]); maxz = Math.max(maxz, model.pos[i + 2]);
  }
  const errs = [];
  if (model.pos.some(v => !Number.isFinite(v))) errs.push('pos NaN');
  if (model.col.length !== nv) errs.push('col 长度≠顶点数');
  if (model.col.some(c => !/^[0-9A-F]{6}$/.test(c))) errs.push('颜色格式');
  if (model.idx.some(i => !Number.isInteger(i) || i < 0 || i >= nv)) errs.push('索引越界');
  if (tris > 4000) errs.push(`面数 ${tris} > 4000`);
  if (bytes > 100 * 1024) errs.push(`体积 ${bytes} > 100KB`);
  if (Math.abs(minx) > 1000 || Math.abs(maxx) > 1000) errs.push('x 超出 Boss 圆柱半径 1.0');
  if (Math.abs(minz) > 1000 || Math.abs(maxz) > 1000) errs.push('z 超出 Boss 圆柱半径 1.0');
  if (miny < -10 || maxy > 2600) errs.push('y 范围异常');
  if (errs.length) throw new Error(`校验失败：${errs.join('；')} [bbox mm x ${minx}..${maxx} y ${miny}..${maxy} z ${minz}..${maxz}]`);
  return { nv, tris, bytes, bbox: [minx / 1000, maxx / 1000, miny / 1000, maxy / 1000, minz / 1000, maxz / 1000] };
}

function preview(model) {
  const nv = model.pos.length / 3;
  const P = [], C = [];
  for (let i = 0; i < nv; i++) {
    P.push([model.pos[3 * i] / 1000, model.pos[3 * i + 1] / 1000, model.pos[3 * i + 2] / 1000]);
    C.push(model.col[i]);
  }
  const chars = { F8CB4A: '.', F4E9D2: 'o', '7A6A55': 'h', '3E9B4F': 'G', '20242A': '@', '4A4438': 'x', FFFFFF: '*', F2A0A0: 'b' };
  const raster = (title, W, H, ax, ay, depth, bounds) => {
    const [amin, amax, bmin, bmax] = bounds;
    const zb = Array.from({ length: H }, () => Array(W).fill(-1e9));
    const cb = Array.from({ length: H }, () => Array(W).fill(null));
    const sx = v => (v - amin) / (amax - amin) * (W - 1);
    const sy = v => (bmax - v) / (bmax - bmin) * (H - 1);
    for (let t = 0; t < model.idx.length; t += 3) {
      const ids = [model.idx[t], model.idx[t + 1], model.idx[t + 2]];
      const Q = ids.map(i => P[i]);
      const A = [sx(Q[0][ax]), sy(Q[0][ay])], B = [sx(Q[1][ax]), sy(Q[1][ay])], D = [sx(Q[2][ax]), sy(Q[2][ay])];
      const dep = Q.map(p => p[depth]);
      const minx = Math.max(0, Math.floor(Math.min(A[0], B[0], D[0]))), maxx = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], D[0])));
      const miny = Math.max(0, Math.floor(Math.min(A[1], B[1], D[1]))), maxy = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], D[1])));
      const den = (B[1] - D[1]) * (A[0] - D[0]) + (D[0] - B[0]) * (A[1] - D[1]);
      if (Math.abs(den) < 1e-9) continue;
      for (let yy = miny; yy <= maxy; yy++) for (let xx = minx; xx <= maxx; xx++) {
        const w1 = ((B[1] - D[1]) * (xx - D[0]) + (D[0] - B[0]) * (yy - D[1])) / den;
        const w2 = ((D[1] - A[1]) * (xx - D[0]) + (A[0] - D[0]) * (yy - D[1])) / den;
        const w3 = 1 - w1 - w2;
        if (w1 < -0.02 || w2 < -0.02 || w3 < -0.02) continue;
        const z = w1 * dep[0] + w2 * dep[1] + w3 * dep[2];
        if (z > zb[yy][xx]) { zb[yy][xx] = z; cb[yy][xx] = C[ids[0]]; }
      }
    }
    console.log('\n' + title);
    console.log(cb.map(r => r.map(c => (c ? chars[c] || '?' : ' ')).join('')).join('\n'));
  };
  raster('FRONT', 64, 40, 0, 1, 2, [-0.8, 0.8, -0.02, 2.42]);
  raster('FACE', 64, 24, 0, 1, 2, [-0.62, 0.62, 1.7, 2.42]);
  raster('SIDE', 48, 40, 2, 1, 0, [-0.68, 0.68, -0.02, 2.42]);
}

const args = process.argv.slice(2);
if (args.includes('--extract')) {
  extractBase();
  process.exit(0);
}
const { model } = build();
const stats = validate(model);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : ASSET;
fs.writeFileSync(outFile, JSON.stringify(model));
const colorCounts = {};
for (const c of model.col) colorCounts[c] = (colorCounts[c] || 0) + 1;
console.log(`写出 ${path.relative(ROOT, outFile)}`);
console.log(`顶点 ${stats.nv} / 面 ${stats.tris} / ${(stats.bytes / 1024).toFixed(1)}KB`);
console.log(`包围盒 x[${stats.bbox[0].toFixed(2)},${stats.bbox[1].toFixed(2)}] y[${stats.bbox[2].toFixed(2)},${stats.bbox[3].toFixed(2)}] z[${stats.bbox[4].toFixed(2)},${stats.bbox[5].toFixed(2)}]`);
console.log('颜色', colorCounts);
if (args.includes('--preview')) preview(model);
