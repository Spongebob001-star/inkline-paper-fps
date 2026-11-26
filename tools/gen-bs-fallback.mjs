// Δ8 Boss 备用皮：程序化黄色圆身小龙（原创，非奶龙特征）。
// 纯 Node 数学生成 src/models/bs-fallback.json（毫米整数 / 逐顶点色 / 索引网格 / sm=1）。
// 造型：蛋形圆身 + 短四肢 + 头顶双小角 + 背后小三角翼 + 锥形短尾 + 黑色圆点眼。
// 不依赖 Three/Blender；不读写 bs.json。用法：
//   node tools/gen-bs-fallback.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/models/bs-fallback.json');

// 4 色：主体黄 / 角翼尾深一档 / 眼近黑 / 少量橙红点缀
const BODY = 'F8CB4A';
const DARK = 'D9A02E';
const EYE = '1F1C1A';
const ACCENT = 'E0632B';
const PALETTE = [BODY, DARK, EYE, ACCENT];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]) || 1;
const norm = a => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

function part(name) { return { name, verts: [], tris: [] }; }

function centroidOf(verts) {
  const c = [0, 0, 0];
  for (const v of verts) { c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  const n = verts.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

function triNormal(g, t) {
  const a = g.verts[g.tris[t]], b = g.verts[g.tris[t + 1]], c = g.verts[g.tris[t + 2]];
  const n = cross(sub(b, a), sub(c, a));
  return norm(n);
}

function triCenter(g, t) {
  const a = g.verts[g.tris[t]], b = g.verts[g.tris[t + 1]], c = g.verts[g.tris[t + 2]];
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

function flipRange(g, start, end) {
  for (let t = start; t < end; t += 3) {
    const tmp = g.tris[t + 1];
    g.tris[t + 1] = g.tris[t + 2];
    g.tris[t + 2] = tmp;
  }
}

// 每组三角形按“外法线参考方向”统一转向；组内构造顺序一致，故测首片即可。
function orientGroup(g, start, end, outward) {
  const n = triNormal(g, start);
  if (dot(n, outward(triCenter(g, start))) < 0) flipRange(g, start, end);
}

function signedVolume(g) {
  let vol = 0;
  for (let t = 0; t < g.tris.length; t += 3) {
    const a = g.verts[g.tris[t]], b = g.verts[g.tris[t + 1]], c = g.verts[g.tris[t + 2]];
    vol += dot(a, cross(b, c)) / 6;
  }
  return vol;
}

function closePart(g) {
  const vol = signedVolume(g);
  if (Math.abs(vol) < 1e-10) throw new Error(`${g.name}: 封闭体积近似 0`);
  if (vol < 0) flipRange(g, 0, g.tris.length);
  return vol;
}

// 椭球（可选蛋形锥度 taper(cosφ)），经纬网格 + 两极扇形。
function ellipsoid(center, radii, { lon = 12, lat = 8, taper = null, name = 'ellipsoid' } = {}) {
  const g = part(name);
  const P = (sp, cp, th) => {
    const f = taper ? taper(cp) : 1;
    return [
      center[0] + radii[0] * sp * Math.cos(th) * f,
      center[1] + radii[1] * cp,
      center[2] + radii[2] * sp * Math.sin(th) * f,
    ];
  };
  g.verts.push([center[0], center[1] + radii[1], center[2]]);
  const rings = [];
  for (let i = 1; i < lat; i++) {
    const phi = (Math.PI * i) / lat;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const row = [];
    for (let j = 0; j < lon; j++) {
      g.verts.push(P(sp, cp, (2 * Math.PI * j) / lon));
      row.push(g.verts.length - 1);
    }
    rings.push(row);
  }
  g.verts.push([center[0], center[1] - radii[1], center[2]]);
  const bottom = g.verts.length - 1;

  for (let j = 0; j < lon; j++) g.tris.push(0, rings[0][(j + 1) % lon], rings[0][j]);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < lon; j++) {
      const a = rings[i][j], b = rings[i][(j + 1) % lon];
      const c = rings[i + 1][(j + 1) % lon], d = rings[i + 1][j];
      g.tris.push(a, b, c, a, c, d);
    }
  }
  const last = rings[rings.length - 1];
  for (let j = 0; j < lon; j++) g.tris.push(bottom, last[j], last[(j + 1) % lon]);

  orientGroup(g, 0, g.tris.length, p => sub(p, center));
  closePart(g);
  return g;
}

// 折线管（圆柱/胶囊式短肢、尾巴），双端加半球帽保证闭合。
function tube(points, radii, { sides = 8, name = 'tube', capStart = true, capEnd = true } = {}) {
  const g = part(name);
  const n = points.length;
  const tangents = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    return norm(sub(b, a));
  });
  const rings = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const ref = Math.abs(dot(t, [0, 1, 0])) > 0.92 ? [1, 0, 0] : [0, 1, 0];
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

  const sideStart = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = rings[i][j], b = rings[i][(j + 1) % sides];
      const c = rings[i + 1][(j + 1) % sides], d = rings[i + 1][j];
      g.tris.push(a, b, c, a, c, d);
    }
  }
  const sideEnd = g.tris.length;
  const mid0 = mul(add(points[0], points[1]), 0.5);
  orientGroup(g, sideStart, sideEnd, p => sub(p, mid0));

  if (capStart) {
    const apex = add(points[0], mul(tangents[0], -radii[0] * 0.55));
    g.verts.push(apex);
    const c = g.verts.length - 1;
    const s = g.tris.length;
    for (let j = 0; j < sides; j++) g.tris.push(rings[0][(j + 1) % sides], c, rings[0][j]);
    orientGroup(g, s, g.tris.length, () => sub(apex, points[0]));
  }
  if (capEnd) {
    const apex = add(points[n - 1], mul(tangents[n - 1], radii[n - 1] * 0.55));
    g.verts.push(apex);
    const c = g.verts.length - 1;
    const s = g.tris.length;
    for (let j = 0; j < sides; j++) g.tris.push(rings[n - 1][j], c, rings[n - 1][(j + 1) % sides]);
    orientGroup(g, s, g.tris.length, () => sub(apex, points[n - 1]));
  }
  closePart(g);
  return g;
}

// 圆锥（角/尾尖）：侧面扇 + 底盖。
function cone(base, tip, radius, { sides = 10, name = 'cone' } = {}) {
  const g = part(name);
  const axis = norm(sub(tip, base));
  const ref = Math.abs(dot(axis, [0, 1, 0])) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const n1 = norm(cross(axis, ref));
  const n2 = norm(cross(axis, n1));
  const ring = [];
  for (let j = 0; j < sides; j++) {
    const a = (2 * Math.PI * j) / sides;
    g.verts.push(add(base, add(mul(n1, Math.cos(a) * radius), mul(n2, Math.sin(a) * radius))));
    ring.push(g.verts.length - 1);
  }
  g.verts.push(base);
  const bc = g.verts.length - 1;
  g.verts.push(tip);
  const ti = g.verts.length - 1;

  const s1 = g.tris.length;
  for (let j = 0; j < sides; j++) g.tris.push(ring[j], ti, ring[(j + 1) % sides]);
  orientGroup(g, s1, g.tris.length, p => sub(p, base));

  const s2 = g.tris.length;
  for (let j = 0; j < sides; j++) g.tris.push(bc, ring[j], ring[(j + 1) % sides]);
  orientGroup(g, s2, g.tris.length, () => sub(base, tip));

  closePart(g);
  return g;
}

// 薄三棱翼：凸多边形轮廓挤出成封闭棱柱。
function prism(outline, thickness, name = 'prism') {
  const N = outline.length;
  const nrm = norm(cross(sub(outline[1], outline[0]), sub(outline[2], outline[0])));
  const half = thickness / 2;
  const g = part(name);
  const A = outline.map(p => add(p, mul(nrm, half)));
  const B = outline.map(p => sub(p, mul(nrm, half)));
  for (const p of A) g.verts.push(p);
  for (const p of B) g.verts.push(p);

  const a0 = g.tris.length;
  for (let i = 1; i < N - 1; i++) g.tris.push(0, i, i + 1);
  const a1 = g.tris.length;
  for (let i = 1; i < N - 1; i++) g.tris.push(N, N + i + 1, N + i);
  const a2 = g.tris.length;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    g.tris.push(i, N + i, N + j);
    g.tris.push(i, N + j, j);
  }
  const a3 = g.tris.length;

  const ctr = centroidOf(g.verts);
  orientGroup(g, a0, a1, () => nrm);
  orientGroup(g, a1, a2, () => mul(nrm, -1));
  orientGroup(g, a2, a3, p => sub(p, ctr));
  closePart(g);
  return g;
}

function build() {
  const out = { verts: [], cols: [], tris: [], parts: [] };
  const push = (g, color) => {
    const v0 = out.verts.length, t0 = out.tris.length;
    for (const v of g.verts) { out.verts.push(v.slice()); out.cols.push(color); }
    for (const t of g.tris) out.tris.push(t + v0);
    const p = {
      name: g.name, v0, v1: out.verts.length, t0, t1: out.tris.length,
      center: centroidOf(g.verts), color,
    };
    out.parts.push(p);
    return p;
  };

  // 蛋形圆身：上窄下圆，底部略收，脚底 y=0 时头顶约 1.98m
  push(ellipsoid([0, 1.08, 0], [0.56, 0.90, 0.50], {
    lon: 22, lat: 14, name: 'body',
    taper: cp => 1 - 0.15 * Math.pow(Math.max(0, cp), 1.5) - 0.05 * Math.pow(Math.max(0, -cp), 2),
  }), BODY);

  // 面部：黑色圆点眼（竖椭圆）+ 橙色小腮红 + 一道短嘴缝
  for (const sx of [-1, 1]) {
    push(ellipsoid([sx * 0.205, 1.36, 0.407], [0.078, 0.098, 0.050], { lon: 12, lat: 8, name: 'eye' }), EYE);
    push(ellipsoid([sx * 0.305, 1.22, 0.390], [0.060, 0.038, 0.032], { lon: 10, lat: 6, name: 'cheek' }), ACCENT);
  }
  push(tube([[-0.075, 1.15, 0.492], [0.075, 1.15, 0.492]], [0.018, 0.018], { sides: 6, name: 'mouth' }), EYE);

  // 头顶双小角（奶龙无角）
  for (const sx of [-1, 1]) {
    push(cone([sx * 0.20, 1.80, 0.03], [sx * 0.29, 2.32, 0.05], 0.085, { sides: 10, name: 'horn' }), DARK);
  }

  // 背后一对小三角翼（奶龙无翼）
  for (const sx of [-1, 1]) {
    push(prism([
      [sx * 0.13, 1.44, -0.42],
      [sx * 0.56, 1.70, -0.60],
      [sx * 0.70, 1.40, -0.64],
      [sx * 0.54, 1.10, -0.60],
      [sx * 0.12, 1.08, -0.44],
    ], 0.03, 'wing'), DARK);
  }

  // 锥形短尾，尾梢上翘并渐变橙红
  const tail = push(tube([
    [0, 0.62, -0.42],
    [0, 0.54, -0.62],
    [0, 0.56, -0.76],
    [0, 0.67, -0.82],
  ], [0.15, 0.115, 0.075, 0.038], { sides: 9, name: 'tail' }), DARK);
  for (let i = tail.v0; i < tail.v1; i++) {
    if (out.verts[i][2] < -0.745) out.cols[i] = ACCENT;
  }

  // 短臂 + 圆手
  for (const sx of [-1, 1]) {
    push(tube([
      [sx * 0.44, 1.12, 0.10],
      [sx * 0.58, 0.96, 0.14],
      [sx * 0.60, 0.80, 0.18],
    ], [0.16, 0.13, 0.105], { sides: 9, name: 'arm' }), BODY);
    push(ellipsoid([sx * 0.61, 0.74, 0.19], [0.11, 0.10, 0.115], { lon: 10, lat: 6, name: 'hand' }), BODY);
  }

  // 短腿 + 圆脚 + 三枚深色趾甲（不是鸭蹼）
  for (const sx of [-1, 1]) {
    push(tube([
      [sx * 0.23, 0.46, 0.03],
      [sx * 0.23, 0.30, 0.05],
      [sx * 0.23, 0.17, 0.06],
    ], [0.16, 0.145, 0.13], { sides: 8, name: 'leg' }), BODY);
    push(ellipsoid([sx * 0.23, 0.095, 0.13], [0.18, 0.095, 0.24], { lon: 14, lat: 8, name: 'foot' }), BODY);
    for (const dx of [-0.09, 0, 0.09]) {
      push(ellipsoid([sx * 0.23 + dx, 0.062, 0.30], [0.050, 0.045, 0.060], { lon: 8, lat: 5, name: 'toe' }), DARK);
    }
  }

  return out;
}

// 每个封闭部件检查“每条有向边恰好配对一条反向边”。
function edgeAudit(g) {
  const edges = new Map();
  const addEdge = (a, b) => {
    const k = `${a},${b}`;
    edges.set(k, (edges.get(k) || 0) + 1);
  };
  for (let t = 0; t < g.tris.length; t += 3) {
    const a = g.tris[t], b = g.tris[t + 1], c = g.tris[t + 2];
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }
  let bad = 0;
  for (const [k, cnt] of edges) {
    const [a, b] = k.split(',').map(Number);
    if (cnt !== 1 || (edges.get(`${b},${a}`) || 0) !== 1) bad++;
  }
  return bad;
}

function buildModel() {
  const g = build();
  const nv = g.verts.length;
  const pos = [];
  for (const v of g.verts) pos.push(Math.round(v[0] * 1000), Math.round(v[1] * 1000), Math.round(v[2] * 1000));
  return {
    name: 'bs-fallback',
    sm: 1,
    pos,
    col: g.cols,
    idx: g.tris,
    _parts: g.parts,
  };
}

function bboxOf(pos) {
  const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      b[2 * k] = Math.min(b[2 * k], pos[i + k]);
      b[2 * k + 1] = Math.max(b[2 * k + 1], pos[i + k]);
    }
  }
  return b;
}

function crossLen(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  return Math.hypot(n[0], n[1], n[2]);
}

function validate(model, bytes) {
  const { pos, col, idx } = model;
  const nv = pos.length / 3;
  const nt = idx.length / 3;
  const fail = msg => { throw new Error(`校验失败：${msg}`); };

  if (model.name !== 'bs-fallback') fail(`name=${model.name}`);
  if (model.sm !== 1) fail(`sm=${model.sm}`);
  if (Object.keys(model).sort().join(',') !== 'col,idx,name,pos,sm') fail(`字段集合异常 ${Object.keys(model).join(',')}`);
  if (pos.length % 3 !== 0) fail('pos 长度不是 3 的倍数');
  if (idx.length % 3 !== 0) fail('idx 长度不是 3 的倍数');
  if (col.length !== nv) fail(`col=${col.length} 与顶点数 ${nv} 不符`);
  if (nt > 4000) fail(`三角面 ${nt} > 4000`);
  if (bytes > 102400) fail(`字节 ${bytes} > 102400`);
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isInteger(pos[i])) fail(`pos[${i}] 非整数`);
  }
  for (const c of col) {
    if (!/^[0-9A-F]{6}$/.test(c)) fail(`颜色非法 ${c}`);
    if (!PALETTE.includes(c)) fail(`颜色超出 4 色方案 ${c}`);
  }

  let badIdx = 0;
  for (const i of idx) {
    if (!Number.isInteger(i) || i < 0 || i >= nv) badIdx++;
  }
  if (badIdx) fail(`索引越界 ${badIdx} 个`);

  let dupIdx = 0, degenerate = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) dupIdx++;
    const pa = [pos[3 * a], pos[3 * a + 1], pos[3 * a + 2]];
    const pb = [pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]];
    const pc = [pos[3 * c], pos[3 * c + 1], pos[3 * c + 2]];
    if (crossLen(pa, pb, pc) < 0.5) degenerate++;
  }
  if (dupIdx) fail(`索引重复三角形 ${dupIdx} 个`);
  if (degenerate) fail(`退化三角形 ${degenerate} 个`);

  const b = bboxOf(pos);
  const [minx, maxx, miny, maxy, minz, maxz] = b;
  if (Math.abs(minx + maxx) > 2) fail(`x 不居中 ${minx}..${maxx}`);
  if (miny < -1 || miny > 5) fail(`脚底 miny=${miny}`);
  if (maxy < 2200 || maxy > 2500) fail(`高度 maxy=${maxy}`);
  if (Math.abs(minx) > 1000 || Math.abs(maxx) > 1000) fail(`x 超出 ±1000 ${minx}..${maxx}`);
  if (Math.abs(minz) > 1000 || Math.abs(maxz) > 1000) fail(`z 超出 ±1000 ${minz}..${maxz}`);

  return { nv, nt, bbox: b, badIdx, dupIdx, degenerate };
}

function main() {
  const model = buildModel();
  const parts = model._parts;
  delete model._parts;
  const bytes = Buffer.byteLength(JSON.stringify(model));

  // 部件级闭合/绕序体检（打印，不写入文件）
  let edgeBad = 0;
  let outOk = 0, outAll = 0;
  for (const p of parts) {
    const g = { verts: [], tris: [] };
    for (let i = p.v0; i < p.v1; i++) g.verts.push([model.pos[3 * i], model.pos[3 * i + 1], model.pos[3 * i + 2]]);
    for (let t = p.t0; t < p.t1; t++) g.tris.push(model.idx[t] - p.v0);
    edgeBad += edgeAudit(g);
    const pc = [p.center[0] * 1000, p.center[1] * 1000, p.center[2] * 1000];
    for (let t = 0; t < g.tris.length; t += 3) {
      const a = g.verts[g.tris[t]], b = g.verts[g.tris[t + 1]], c = g.verts[g.tris[t + 2]];
      const n = norm(cross(sub(b, a), sub(c, a)));
      const ctr = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      if (dot(n, sub(ctr, pc)) > 0) outOk++;
      outAll++;
    }
  }

  const { nv, nt, bbox } = validate(model, bytes);
  const [minx, maxx, miny, maxy, minz, maxz] = bbox;
  const counts = Object.fromEntries(PALETTE.map(c => [c, model.col.filter(x => x === c).length]));

  fs.writeFileSync(OUT, JSON.stringify(model));
  const rel = path.relative(ROOT, OUT).replace(/\\/g, '/');
  console.log(`已生成 ${rel}`);
  console.log(`顶点 ${nv} · 三角面 ${nt} · 字节 ${bytes} / 102400`);
  console.log(`包围盒 x[${minx}, ${maxx}] y[${miny}, ${maxy}] z[${minz}, ${maxz}] mm`);
  console.log(`配色 ${PALETTE.map(c => `${c}×${counts[c]}`).join(' · ')}`);
  console.log(`索引越界 0 · 退化三角形 0 · 边一致性问题 ${edgeBad} · 法线朝外 ${(outOk / outAll * 100).toFixed(1)}%`);
}

main();
