import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const raw = fs.readFileSync(new URL('../src/models/bs-fallback.json', import.meta.url), 'utf8');
const m = JSON.parse(raw);
const nv = m.pos.length / 3;
const nt = m.idx.length / 3;
const P = i => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];

const BODY = 'F8CB4A';
const DARK = 'D9A02E';
const EYE = '1F1C1A';
const ACCENT = 'E0632B';

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

test('bs-fallback：格式/索引/四色规范', () => {
  assert.equal(m.name, 'bs-fallback');
  assert.equal(m.sm, 1);
  assert.deepEqual(Object.keys(m).sort(), ['col', 'idx', 'name', 'pos', 'sm']);
  assert.equal(m.pos.length % 3, 0);
  assert.equal(m.idx.length % 3, 0);
  assert.equal(m.col.length, nv);
  assert.deepEqual([...new Set(m.col)].sort(), [EYE, DARK, ACCENT, BODY].sort());
  for (const c of m.col) assert.match(c, /^[0-9A-F]{6}$/);
  for (const i of m.idx) assert.ok(Number.isInteger(i) && i >= 0 && i < nv, `索引 ${i}`);
  for (const v of m.pos) assert.ok(Number.isInteger(v), 'pos 必须为毫米整数');

  for (let t = 0; t < m.idx.length; t += 3) {
    const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2];
    assert.ok(a !== b && b !== c && a !== c, `索引重复 t=${t}`);
    const pa = P(a), pb = P(b), pc = P(c);
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cr) > 0.5, `退化三角形 t=${t}`);
  }
});

test('bs-fallback：≤4000 面 / ≤100KB / 落地 / 居中', () => {
  assert.ok(nt <= 4000, `tris=${nt}`);
  assert.ok(Buffer.byteLength(raw) <= 100 * 1024, `bytes=${Buffer.byteLength(raw)}`);

  const [minx, maxx, miny, maxy, minz, maxz] = bbox();
  assert.ok(Math.abs(minx + maxx) <= 2, `x 不居中 ${minx}..${maxx}`);
  assert.ok(miny >= -1 && miny <= 5, `脚底 miny=${miny}`);
  assert.ok(maxy >= 2200 && maxy <= 2500, `高度 maxy=${maxy}`);
  assert.ok(maxx - minx >= 1200, `宽度过窄 ${minx}..${maxx}`);
  assert.ok(Math.abs(minx) <= 1000 && Math.abs(maxx) <= 1000, 'x 超出 ±1000');
  assert.ok(Math.abs(minz) <= 1000 && Math.abs(maxz) <= 1000, 'z 超出 ±1000');

  const yellow = m.col.filter(c => c === BODY).length;
  assert.ok(yellow > nv * 0.5, `主体黄占比不足 ${yellow}/${nv}`);
});

test('bs-fallback：非奶龙特征（角/翼/尾/黑点眼/无奶白肚皮）', () => {
  let hornL = 0, hornR = 0, wingL = 0, wingR = 0, tail = 0, eyeL = 0, eyeR = 0;
  let faceZ = 0, faceN = 0;

  for (let i = 0; i < nv; i++) {
    const c = m.col[i];
    const [x, y, z] = P(i);
    if (c === DARK && y >= 2200) (x > 0 ? hornR++ : hornL++);
    if (c === DARK && z <= -550 && y >= 1000 && y <= 1800 && Math.abs(x) >= 300) {
      (x > 0 ? wingR++ : wingL++);
    }
    if ((c === DARK || c === ACCENT) && z <= -700) tail++;
    if (c === EYE && z >= 300 && y >= 1200) (x > 0 ? eyeR++ : eyeL++);
    if (c === EYE) { faceZ += z; faceN++; }
  }

  assert.ok(hornL >= 1 && hornR >= 1, `头顶双角缺失 L=${hornL} R=${hornR}`);
  assert.ok(wingL >= 4 && wingR >= 4, `背翼缺失 L=${wingL} R=${wingR}`);
  assert.ok(tail >= 8, `锥形短尾缺失 n=${tail}`);
  assert.ok(eyeL >= 20 && eyeR >= 20, `黑色点眼缺失 L=${eyeL} R=${eyeR}`);
  assert.ok(faceZ / faceN > 350, `面部未朝向 +Z z=${(faceZ / faceN).toFixed(1)}`);

  // 备用皮不得复用奶龙的奶白肚皮/绿眼，避免 IP 特征回潮
  assert.ok(!m.col.includes('F4E9D2'), '出现奶白肚皮色');
  assert.ok(!m.col.includes('3E9B4F'), '出现奶龙绿眼色');
});
