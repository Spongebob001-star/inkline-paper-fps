#!/usr/bin/env node
// 从 N5-Open/validation/vendor/three（已实机验证的 r160 本地源码）生成零外链 GLTFLoader 模块。
//   node tools/make-gltf-loader.mjs
// 产物 client/gltf-loader.mjs：
//   - `import {...} from 'three'` → 解构全局 window.THREE（UMD r160），无裸导入、无 CDN；
//   - `toTrianglesDrawMode` 由本地 BufferGeometryUtils 同源内联，去掉相对 utils 导入；
//   - 删除含 https:// 的注释行，保证产物零 https 字面量；
//   - 仅保留 `export { GLTFLoader }`，供 client/build.mjs 的相对路径打包器链接。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'N5-Open', 'validation', 'vendor', 'three', 'examples', 'jsm');
const OUT = join(ROOT, 'client', 'gltf-loader.mjs');

let src = readFileSync(join(SRC, 'loaders', 'GLTFLoader.js'), 'utf8');
const utils = readFileSync(join(SRC, 'utils', 'BufferGeometryUtils.js'), 'utf8');

// 1) three 导入块 → 全局解构
const impStart = src.indexOf('import {');
const impEnd = src.indexOf("} from 'three';", impStart);
if (impStart < 0 || impEnd < 0) throw new Error('找不到 three 导入块');
const names = src.slice(impStart + 'import {'.length, impEnd)
  .split(',').map(s => s.trim()).filter(Boolean);
if (!names.includes('TrianglesDrawMode')) names.push('TrianglesDrawMode');
const destructure = 'const {\n\t' + names.join(',\n\t') + '\n} = window.THREE;';
src = src.slice(0, impStart) + destructure + src.slice(impEnd + "} from 'three';".length);

// 2) 内联 toTrianglesDrawMode（同源拷贝），移除 utils 导入
const utilImport = "import { toTrianglesDrawMode } from '../utils/BufferGeometryUtils.js';";
if (!src.includes(utilImport)) throw new Error('找不到 BufferGeometryUtils 导入');
const fnStart = utils.indexOf('function toTrianglesDrawMode');
let depth = 0, fnEnd = -1;
for (let i = utils.indexOf('{', fnStart); i < utils.length; i++) {
  if (utils[i] === '{') depth++;
  else if (utils[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
}
const fnSrc = utils.slice(fnStart, fnEnd);
src = src.replace(utilImport, fnSrc);

// 3) 去掉含 https:// 的注释行（规格链接注释，非运行期外链）
src = src.split('\n').filter(line => !line.includes('https://')).join('\n');

const header = [
  '// 本地零外链 GLTFLoader（r160，源自 N5-Open/validation/vendor/three 已验证源码）。',
  '// 由 tools/make-gltf-loader.mjs 生成：three 走全局 window.THREE，无 CDN/裸导入/网络请求。',
  '// 仅使用 parse(ArrayBuffer) 路径；load()/FileLoader 网络路径在本工程不被调用。',
  '',
].join('\n');

writeFileSync(OUT, header + src);
console.log('[gltf] 生成 client/gltf-loader.mjs', (header + src).length, 'bytes;', names.length, '个 three 绑定');