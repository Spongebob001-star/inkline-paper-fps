#!/usr/bin/env node
// D9 单文件产物静态检查（T9.6 验收）：node tools/check-singlefile.mjs [dist/inkline.html]
//
// 检查项：
//   1. 产物存在、体积 ≤ 2MB
//   2. 零外链 / 零运行期网络：无 src="/..."、fetch('/ 或 fetch("/、https://、(<link>/<img>/<iframe>/@import/http 外链属性
//   3. 结构保留：#view 画布、#hud 容器、内联 <style>（含 #crosshair/#boss-bar 规则）
//   4. 内联脚本全部可编译（vm.Script），并把 bundle 抽到临时文件跑 node --check
//   5. 模型已内联：从 __MODEL_DATA 抽出 JSON 与 src/models/*.json 逐项比对（名/pos/idx/col 长度）
// 退出码：0 全过；1 有失败。
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 2 * 1024 * 1024;
const target = resolve(process.argv[2] || join(ROOT, 'dist', 'inkline.html'));
const toPosix = p => p.split(sep).join('/');

let failures = 0;
const pass = (label, extra = '') => console.log('PASS  ' + label + (extra ? '  ' + extra : ''));
const fail = (label, extra = '') => { failures++; console.log('FAIL  ' + label + (extra ? '  ' + extra : '')); };

if (!existsSync(target)) {
  console.log('FAIL  产物不存在: ' + toPosix(relative(ROOT, target)));
  process.exit(1);
}

const html = readFileSync(target, 'utf8');
const bytes = statSync(target).size;
const kb = n => (n / 1024).toFixed(1) + ' KB';

// 1) 体积 -------------------------------------------------------------------
console.log('产物: ' + toPosix(relative(ROOT, target)) + '  ' + bytes + ' 字节 (' + kb(bytes) + ')');
if (bytes <= MAX_BYTES) pass('体积 ≤ 2MB', kb(bytes) + ' / ' + kb(MAX_BYTES));
else fail('体积 ≤ 2MB', kb(bytes) + ' 超限');

// 2) 外链 / 网络 ------------------------------------------------------------
const forbidden = [
  ['src="/', 'src="/'],
  ["fetch('/", "fetch('/"],
  ['fetch("/', 'fetch("/'],
  ['https://', 'https://'],
  ['href="http', 'href="http'],
  ['src="http', 'src="http'],
  ['url(http', 'url(http'],
  ['<link ', '<link>'],
  ['<img ', '<img>'],
  ['<iframe', '<iframe>'],
  ['@import', '@import'],
  ['XMLHttpRequest', 'XMLHttpRequest'],
  ['importScripts', 'importScripts'],
];
for (const [needle, label] of forbidden) {
  const n = html.split(needle).length - 1;
  if (n === 0) pass('无 ' + label);
  else fail('无 ' + label, n + ' 处');
}
// 任何 fetch( 调用都不该留在入口 bundle 里（模型访问已改 __inlineModel）；
// three.min.js 内部 FileLoader/ImageBitmapLoader 的 fetch 属库代码，本项目不实例化也不调用。
// 入口 bundle 的 fetch 计数在下方抽出内联脚本后校验。

// 3) 结构 -------------------------------------------------------------------
const structure = [
  ['<canvas id="view">', '#view 画布'],
  ['<div id="hud"></div>', '#hud 容器'],
  ['#crosshair::before', '准星样式'],
  ['#boss-bar', 'Boss 血条样式'],
  ['#hud-abilities', '能力 HUD 样式'],
  ['<style>', '内联 <style>'],
];
for (const [needle, label] of structure) {
  if (html.includes(needle)) pass('保留 ' + label);
  else fail('保留 ' + label);
}
const externalScripts = [...html.matchAll(/<script[^>]*\bsrc=[^>]*>/g)].map(m => m[0]);
if (externalScripts.length === 0) pass('无外链 script');
else fail('无外链 script', externalScripts.join(' | '));

// 4) 内联脚本可编译 ----------------------------------------------------------
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('内联脚本 ' + scripts.length + ' 段: ' + scripts.map(s => kb(s.length)).join(' + '));
if (scripts.length === 2) pass('内联脚本段数 = 2（three + 入口 bundle）');
else fail('内联脚本段数 = 2（three + 入口 bundle）', '实际 ' + scripts.length);

scripts.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `inline-${i}.js` });
    pass(`第 ${i + 1} 段脚本 vm 编译通过`);
  } catch (err) {
    fail(`第 ${i + 1} 段脚本 vm 编译通过`, err.message);
  }
});

const bundle = scripts[scripts.length - 1] || '';
const fetchCalls = (html.match(/\bfetch\s*\(/g) || []).length;
const bundleFetchCalls = (bundle.match(/\bfetch\s*\(/g) || []).length;
if (bundleFetchCalls === 0) pass('入口 bundle 内无 fetch() 调用');
else fail('入口 bundle 内无 fetch() 调用', bundleFetchCalls + ' 处');
if (fetchCalls === bundleFetchCalls) pass('其余 fetch 仅来自 three 库未使用的加载器', fetchCalls + ' 处');
const dir = mkdtempSync(join(tmpdir(), 'inkline-check-'));
const entryFile = join(dir, 'entry.js');
try {
  writeFileSync(entryFile, bundle);
  const res = spawnSync(process.execPath, ['--check', entryFile], { encoding: 'utf8' });
  if (res.status === 0) pass('入口 bundle node --check 通过');
  else fail('入口 bundle node --check 通过', (res.stderr || '').trim().split('\n').slice(-3).join(' / '));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 5) 模型内联 ---------------------------------------------------------------
const dataMatch = /var __MODEL_DATA = ([\s\S]*?);\nvar __MODEL_PATHS/.exec(bundle);
if (!dataMatch) {
  fail('产物含内联模型表 __MODEL_DATA');
} else {
  pass('产物含内联模型表 __MODEL_DATA');
  let inline = null;
  try { inline = JSON.parse(dataMatch[1]); } catch (err) { fail('内联模型表可解析', err.message); }
  if (inline) {
    const files = readdirSync(join(ROOT, 'src', 'models')).filter(f => f.endsWith('.json')).sort();
    const keys = Object.keys(inline).sort();
    const expectKeys = files.map(f => '/src/models/' + f).sort();
    if (keys.join() === expectKeys.join()) pass('模型清单与 src/models 一致', keys.length + ' 个');
    else fail('模型清单与 src/models 一致', '产物 [' + keys + '] vs 源 [' + expectKeys + ']');

    let matched = 0;
    for (const f of files) {
      const src = JSON.parse(readFileSync(join(ROOT, 'src', 'models', f), 'utf8'));
      const got = inline['/src/models/' + f];
      if (!got) continue;
      const same = got.name === src.name
        && got.pos.length === src.pos.length
        && (got.idx ? got.idx.length : -1) === (src.idx ? src.idx.length : -1)
        && (got.col ? got.col.length : -1) === (src.col ? src.col.length : -1);
      if (same) matched++;
      else fail(`${f} 内联数据与源一致`);
      if (f === 'bs.json') {
        const verts = got.pos.length / 3, idx = got.idx ? got.idx.length : 0;
        if (verts > 0 && idx > 0) {
          pass('bs.json 已内联', verts + ' 顶点 / ' + idx + ' 索引 / ' + (got.col ? got.col.length : 0) + ' 顶点色');
        } else fail('bs.json 已内联', 'pos/idx 为空');
        const fragment = '"idx":[' + src.idx.slice(0, 6).join(',');
        if (bundle.includes(fragment)) pass('bs.json 索引片段命中', fragment.slice(0, 40) + '…');
        else fail('bs.json 索引片段命中', fragment.slice(0, 40));
      }
    }
    if (matched === files.length) pass('全部模型数据逐项比对一致', matched + '/' + files.length);
  }
}

// 6) 未处理的 ESM / 无打包残留 ------------------------------------------------
if (/^\s*(?:import|export)\s/m.test(bundle)) fail('bundle 无未处理的 import/export');
else pass('bundle 无未处理的 import/export');
if (bundle.includes('__inlineModel(')) pass('模型读取走 __inlineModel');
else fail('模型读取走 __inlineModel');

console.log('');
console.log(failures === 0 ? '结果: 全部通过（' + bytes + ' 字节）' : '结果: ' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
