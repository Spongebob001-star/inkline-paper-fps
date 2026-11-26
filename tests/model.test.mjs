import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const raw = fs.readFileSync(new URL('../src/models/bs.json', import.meta.url), 'utf8');
const m = JSON.parse(raw);
const nv = m.pos.length / 3;
const P = i => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];

function bbox() {
  const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    const p = P(i);
    for (let k = 0; k < 3; k++) {
      b[2 * k] = Math.min(b[2 * k], p[k]);
      b[2 * k + 1] = Math.max(b[2 * k + 1], p[k]);
    }
  }
  return b;
}

function centroidOf(pred) {
  let n = 0, x = 0, y = 0, z = 0;
  for (let i = 0; i < nv; i++) {
    if (!pred(i, P(i), m.col[i])) continue;
    const p = P(i);
    n++; x += p[0]; y += p[1]; z += p[2];
  }
  return { n, x: x / n, y: y / n, z: z / n };
}

test('Boss 模型：格式/索引/规格色齐全', () => {
  assert.equal(m.name, 'bs');
  assert.equal(m.sm, 1);
  assert.equal(m.pos.length % 3, 0);
  assert.equal(m.idx.length % 3, 0);
  assert.equal(m.col.length, nv);
  for (const c of m.col) assert.match(c, /^[0-9A-F]{6}$/);
  for (const i of m.idx) assert.ok(Number.isInteger(i) && i >= 0 && i < nv);
  for (let t = 0; t < m.idx.length; t += 3) {
    assert.ok(m.idx[t] !== m.idx[t + 1] && m.idx[t + 1] !== m.idx[t + 2] && m.idx[t] !== m.idx[t + 2]);
  }
  const colors = new Set(m.col);
  for (const c of ['F8CB4A', 'F4E9D2', '7A6A55', '3E9B4F', '20242A']) assert.ok(colors.has(c), c);
});

test('Boss 模型：≤4000 面、≤100KB、命中盒内且落地', () => {
  assert.ok(m.idx.length / 3 <= 4000, `tris=${m.idx.length / 3}`);
  assert.ok(Buffer.byteLength(raw) <= 100 * 1024, `bytes=${Buffer.byteLength(raw)}`);
  const [minx, maxx, miny, maxy, minz, maxz] = bbox();
  assert.ok(Math.abs(minx) <= 1000 && Math.abs(maxx) <= 1000, 'x 超出 Boss 圆柱半径 1.0');
  assert.ok(Math.abs(minz) <= 1000 && Math.abs(maxz) <= 1000, 'z 超出 Boss 圆柱半径 1.0');
  assert.ok(miny >= -5 && miny < 50, `miny=${miny}`);
  assert.ok(maxy > 2300 && maxy < 2600, `maxy=${maxy}`);
});

test('Boss 模型：正面 +Z，肚皮/双眼/鸭蹼脚朝向正确', () => {
  const belly = centroidOf((i, p, c) => c === 'F4E9D2');
  assert.ok(belly.n > 50);
  assert.ok(belly.z > 350, `belly z=${belly.z}`);
  assert.ok(belly.y > 600 && belly.y < 1400, `belly y=${belly.y}`);

  const eyes = centroidOf((i, p, c) => c === '3E9B4F');
  assert.ok(eyes.z > 100, `eyes z=${eyes.z}`);
  assert.ok(eyes.y > 1800, `eyes y=${eyes.y}`);

  let minx = Infinity, maxx = -Infinity, footMaxZ = -Infinity;
  for (let i = 0; i < nv; i++) {
    const p = P(i);
    if (m.col[i] !== '7A6A55' || p[1] > 250) continue;
    minx = Math.min(minx, p[0]);
    maxx = Math.max(maxx, p[0]);
    footMaxZ = Math.max(footMaxZ, p[2]);
  }
  assert.ok(maxx > 100 && minx < -100, '双脚左右分布');
  assert.ok(footMaxZ > 250, `脚尖应朝 +Z，footMaxZ=${footMaxZ}`);
});
