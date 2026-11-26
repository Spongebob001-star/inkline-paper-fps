#!/usr/bin/env node
// D9 单文件构建（T9.6）：dev/client.html → dist/inkline.html
//
//   node client/build.mjs
//
// 输入：dev/client.html（模板 + 内联 CSS）、src/three/three.min.js（UMD，全局 THREE）、
//       client/ + shared/ + host/ 全部 .mjs、src/models/*、src/audio/boss_laugh.mp3
// 输出：dist/inkline.html（单个 HTML，<2MB，file:// 双击可玩，运行期零网络请求）
//
// 打包器（零 npm 依赖，最小但正确）：
//   1. 只支持相对路径说明符的 import/export——本项目无裸导入、无动态 import、无 re-export；
//      出现不支持的形式立刻构建失败，不静默产出坏包。
//   2. 每个模块编译成工厂 `function (__exports, __req) { ... }` 注册进 __defs，
//      __req 带缓存 ⇒ 循环依赖可用（返回执行中的 __exports 对象，与 ESM 语义一致）。
//   3. 顶层 `export function` 在工厂入口**预注册**（等价 ESM 的函数声明提升），
//      因此循环边上的函数导入在对方只执行了一半时也能拿到真函数。
//   4. 构建期做链接检查：导入名必须存在于提供方导出集合；循环边上的导入必须是提升导出，
//      否则运行期会是 undefined —— 直接报错。
//   5. `/src/models/*.json` 的 fetch 调用点被重写成 __inlineModel('/src/models/x.json')，
//      返回与 fetch 同形的 Promise（{ok, json()}）；模型缺失时 ok:false，Boss 仍回退胶囊。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_FILE = join(ROOT, 'dev', 'client.html');
const THREE_FILE = join(ROOT, 'src', 'three', 'three.min.js');
const MODELS_DIR = join(ROOT, 'src', 'models');
const OUT_DIR = join(ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'inkline.html');
const MAX_BYTES = 2 * 1024 * 1024;
const ENTRY = 'client/main.mjs';
const PROJECT_DIRS = ['client', 'shared', 'host'];
const BUILDER_ID = 'client/build.mjs'; // 排除自身（依赖 node: 内置模块）

// 模块包装器保留标识符：源码不得占用
const RESERVED_RE = /\b__(?:exports|req|defs|cache|inlineModel|inlineGLB|decodeGLB|inlineAudio|AUDIO_B64|AUDIO_BUF|MODEL_DATA|MODEL_PATHS|BOSS_GLB_B64|dep\d+)\b/;

const posixDir = id => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
const toPosix = p => p.split(sep).join('/');
const kb = n => (n / 1024).toFixed(1) + ' KB';

// ---------------------------------------------------------------------------
// 词法扫描：字符串 / 模板 / 正则 / 注释；遮蔽和保守行压缩共用同一词法边界
// ---------------------------------------------------------------------------

const LINE_BREAK_RE = /[\n\r\u2028\u2029]/;
const IDENTIFIER_RE = /^(?:[$_\p{ID_Start}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))(?:[$\u200c\u200d\p{ID_Continue}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))*/u;
const CONTROL_PARENS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const BEFORE_EXPRESSION = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'instanceof', 'yield', 'await', 'else', 'do', 'extends']);

function skipString(src, i) {
  const q = src[i++];
  while (i < src.length) {
    const c = src[i];
    // CRLF is one escaped line continuation; its indentation is string data.
    if (c === '\\') { i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2; continue; }
    if (c === q) return i + 1;
    if (c === '\n' || c === '\r') throw new Error('未闭合的字符串字面量');
    i++;
  }
  throw new Error('未闭合的字符串字面量');
}

function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') { i = skipInterpolation(src, i + 2); continue; }
    i++;
  }
  throw new Error('未闭合的模板字面量');
}

function skipRegexp(src, i) {
  let inClass = false;
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (LINE_BREAK_RE.test(c)) break;
    if (c === '\\') {
      if (i + 1 >= src.length || LINE_BREAK_RE.test(src[i + 1])) break;
      i++;
    } else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[$\u200c\u200d\p{ID_Continue}]/u.test(src[i])) i++;
      return i;
    }
  }
  throw new Error('未闭合的正则字面量');
}

function skipInterpolation(src, i) {
  return scanLexical(src, i, undefined, true);
}

function nextCodeChar(src, i) {
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    if (src[i] === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < src.length && !LINE_BREAK_RE.test(src[i])) i++;
    } else if (src[i] === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new Error('未闭合的块注释');
      i = close + 2;
    } else break;
  }
  return src[i];
}

// Delimiter context distinguishes regexp from division; templates stay opaque to callers.
function scanLexical(src, start = 0, visit, interpolation = false) {
  const stack = [{ kind: interpolation ? 'object' : 'block', isExpr: interpolation, questions: 0 }];
  let allowed = true, prev = interpolation ? '=' : '', beforeExpr = interpolation, lineBreak = false, property = false;
  let asyncExpression = false, restrictedLabel = false;
  let i = start;
  const top = () => stack[stack.length - 1];
  const span = (end, kind) => { visit?.(i, end, kind); i = end; };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      if (LINE_BREAK_RE.test(c)) lineBreak = true;
      i++;
      continue;
    }
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      let end = i + 2;
      if (src[i + 1] === '/') {
        while (end < src.length && !LINE_BREAK_RE.test(src[end])) end++;
      } else {
        const close = src.indexOf('*/', end);
        if (close < 0) throw new Error('未闭合的块注释');
        end = close + 2;
      }
      if (LINE_BREAK_RE.test(src.slice(i, end))) lineBreak = true;
      span(end, 'comment');
      continue;
    }
    if (lineBreak && (prev === 'break' || prev === 'continue' || prev === 'debugger' || restrictedLabel)) allowed = true;
    const wasAllowed = allowed;
    let token, nextBefore = false, nextProperty = false, nextLabel = false;
    if (c === "'" || c === '"' || c === '`' || (c === '/' && allowed)) {
      span(c === '`' ? skipTemplate(src, i) : c === '/' ? skipRegexp(src, i) : skipString(src, i), 'literal');
      token = 'literal';
      allowed = false;
    } else {
      const word = IDENTIFIER_RE.exec(src.slice(i));
      const number = /^(?:0[xob][\da-f_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?[\d_]+)?n?)/i.exec(src.slice(i));
      if (word) {
        token = word[0];
        i += token.length;
        const declarationExpr = prev === 'async' ? !lineBreak && asyncExpression :
          (beforeExpr && ![';', 'else', 'do'].includes(prev) &&
            !(prev === '{' && top().kind === 'block') && !(prev === ':' && top().kind === 'block'));
        const classKey = top().classBody && (['{', '}', ';', 'static', 'get', 'set', 'async', '*'].includes(prev) ||
          (lineBreak && !wasAllowed));
        if (!property && !classKey && (token === 'function' || token === 'class') &&
            ![':', '=', ';', '}'].includes(nextCodeChar(src, i))) {
          stack.push({ kind: token, isExpr: declarationExpr && !(lineBreak && (prev === 'return' || prev === 'yield')), questions: 0 });
        }
        if (token === 'async') asyncExpression = declarationExpr;
        nextLabel = !lineBreak && (prev === 'break' || prev === 'continue');
        nextBefore = !property && (BEFORE_EXPRESSION.has(token) ||
          (token === 'of' && top().kind === 'paren' && top().control === 'for' && !wasAllowed));
        allowed = nextBefore;
        // Keyword-named properties must behave like identifiers, not controls.
        if (property) token = 'name';
      } else if (number) {
        i += number[0].length;
        token = 'number';
        allowed = false;
      } else {
        token = /^(?:=>|\+\+|--|\?\.|\*\*=?|===?|!==?|&&=?|\|\|=?|\?\?=?|<<=?|>>>?=?|[+\-*%&|^!=<>/]=?)/.exec(src.slice(i))?.[0] || c;
        i += token.length;
        if (token === '(') {
          const control = CONTROL_PARENS.has(prev) ? prev : prev === 'await' && top().forAwait ? 'for' : null;
          stack.push({ kind: 'paren', isExpr: !control, control, questions: 0 });
          allowed = nextBefore = true;
        } else if (token === '[') {
          stack.push({ kind: 'bracket', isExpr: true, questions: 0 });
          allowed = nextBefore = true;
        } else if (token === '{') {
          const parent = top();
          const construct = parent.kind === 'function' || parent.kind === 'class';
          const block = construct || prev === '=>' ||
            (prev === ':' && parent.kind === 'block') ||
            ((prev === 'return' || prev === 'yield') && lineBreak) ||
            ['else', 'do', 'try', 'finally', ';', ')', ''].includes(prev) ||
            (prev === '{' ? parent.kind === 'block' : !allowed);
          stack.push({ kind: block ? 'block' : 'object', isExpr: !block || prev === '=>', construct,
            classBody: parent.kind === 'class', questions: 0 });
          allowed = nextBefore = true;
        } else if (token === ')' || token === ']' || token === '}') {
          if (token === '}' && interpolation && stack.length === 1) return i;
          let closed = stack.pop();
          if (!closed || !stack.length) throw new Error('词法扫描遇到未配对的括号');
          if (closed.construct) closed = stack.pop();
          allowed = !closed.isExpr;
        } else if (token === '.' || token === '?.') {
          allowed = false;
          nextProperty = true;
        } else if (token === '++' || token === '--') {
          allowed = wasAllowed;
        } else {
          if (token === '?') top().questions++;
          if (token === ':' && top().questions) { top().questions--; token = 'conditional:'; }
          if (token === ';') top().questions = 0;
          allowed = nextBefore = token !== '#';
        }
      }
    }
    top().forAwait = token === 'await' && prev === 'for';
    prev = token;
    beforeExpr = nextBefore;
    property = nextProperty;
    restrictedLabel = nextLabel;
    lineBreak = false;
  }
  if (interpolation) throw new Error('未闭合的模板插值');
  return i;
}

// 保留 UTF-16 偏移和全部换行，正则内的括号/注释标记不参与模块语法扫描。
function maskSource(src) {
  const out = src.split('');
  scanLexical(src, 0, (a, b) => {
    for (let k = a; k < b; k++) if (!LINE_BREAK_RE.test(out[k])) out[k] = ' ';
  });
  return out.join('');
}

// Keep code line terminators and literal bytes intact to preserve ASI.
function compactModule(src) {
  const kinds = new Uint8Array(src.length); // 1: literal, 2: comment
  const comments = [];
  scanLexical(src, 0, (a, b, kind) => {
    kinds.fill(kind === 'comment' ? 2 : 1, a, b);
    if (kind === 'comment') comments.push({ start: a, end: b });
  });
  const lines = [];
  const lineAt = new Uint32Array(src.length);
  const breaks = /\r\n|[\n\r\u2028\u2029]/g;
  let start = 0, match;
  const addLine = (bodyEnd, end) => {
    let hasCode = false, protectedLine = false;
    for (let i = start; i < end; i++) {
      if (kinds[i]) protectedLine = true;
      if (kinds[i] === 1 || (!kinds[i] && !/\s/.test(src[i]))) hasCode = true;
    }
    lineAt.fill(lines.length, start, end);
    lines.push({ start, bodyEnd, end, hasCode, protectedLine, remove: false });
    start = end;
  };
  while ((match = breaks.exec(src))) addLine(match.index, breaks.lastIndex);
  if (start < src.length) addLine(src.length, src.length);

  // Comments sharing a physical line form a group. Retain the whole group if
  // any member shares a line with code, so we cannot orphan a block delimiter.
  const groups = [];
  for (const comment of comments) {
    const first = lineAt[comment.start], last = lineAt[comment.end - 1];
    const group = groups[groups.length - 1];
    if (group && first <= group.last) group.last = last;
    else groups.push({ first, last });
  }
  for (const { first, last } of groups) {
    if (lines.slice(first, last + 1).some(line => line.hasCode)) continue;
    for (let n = first; n <= last; n++) lines[n].remove = true;
  }

  const chunks = [];
  let commentBytesSaved = 0, previousBlank = false;
  for (const line of lines) {
    if (line.remove) {
      commentBytesSaved += Buffer.byteLength(src.slice(line.start, line.end));
      continue;
    }
    let from = line.start;
    while (from < line.bodyEnd && !kinds[from] && (src[from] === ' ' || src[from] === '\t')) from++;
    const blank = from === line.bodyEnd && !line.protectedLine;
    if (!blank || !previousBlank) chunks.push(src.slice(from, line.end));
    previousBlank = blank;
  }
  const code = chunks.join('');
  const beforeBytes = Buffer.byteLength(src), afterBytes = Buffer.byteLength(code);
  return { code, beforeBytes, afterBytes, commentBytesSaved,
    whitespaceBytesSaved: beforeBytes - afterBytes - commentBytesSaved };
}

function bracketDepthAt(masked, index) {
  let d = 0;
  for (let i = 0; i < index; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
  }
  return d;
}

// 顶层（括号深度 0 且位于行首）的 import/export 关键字位置
function scanTopLevel(masked) {
  const res = [];
  const re = /(?:^|\n)[ \t]*(import|export)\b/g;
  let m;
  while ((m = re.exec(masked))) {
    const kw = m[1];
    const start = m.index + m[0].lastIndexOf(kw);
    if (bracketDepthAt(masked, start) !== 0) continue;
    res.push({ keyword: kw, start });
  }
  return res;
}

function findStatementSemicolon(masked, from) {
  let p = 0, b = 0, c = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '[') b++;
    else if (ch === ']') b--;
    else if (ch === '{') c++;
    else if (ch === '}') c--;
    else if (ch === ';' && p === 0 && b === 0 && c === 0) return i + 1;
  }
  throw new Error('语句缺少结尾分号');
}

// function/class 声明体：找到参数括号后的首个 `{`，再配对到收尾 `}`
function findDeclarationEnd(masked, from) {
  let p = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '{' && p === 0) {
      let depth = 1;
      for (let j = i + 1; j < masked.length; j++) {
        if (masked[j] === '{') depth++;
        else if (masked[j] === '}') { depth--; if (depth === 0) return j + 1; }
      }
      throw new Error('声明体未闭合');
    }
  }
  throw new Error('未找到声明体');
}

function statementEnd(masked, start) {
  const rest = masked.slice(start);
  if (rest.startsWith('import')) return findStatementSemicolon(masked, start + 6);
  let m = /^export\s*\{/.exec(rest);
  if (m) {
    const close = masked.indexOf('}', start + m[0].length - 1);
    if (close < 0) throw new Error('export 列表未闭合');
    let j = close + 1;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    if (masked[j] === ';') j++;
    return j;
  }
  if (/^export\s*\*/.test(rest)) throw new Error('不支持 `export * from`（本项目未使用）');
  if (/^export\s+default\s+(?:async\s+)?function\b/.test(rest)) {
    return findDeclarationEnd(masked, start + rest.indexOf('function'));
  }
  if (/^export\s+default\s+class\b/.test(rest)) {
    return findDeclarationEnd(masked, start + rest.indexOf('class'));
  }
  if (/^export\s+default\b/.test(rest)) return findStatementSemicolon(masked, start + 6);
  if (/^export\s+(?:async\s+)?function\b/.test(rest)) {
    return findDeclarationEnd(masked, start + rest.indexOf('function'));
  }
  if (/^export\s+class\b/.test(rest)) return findDeclarationEnd(masked, start + rest.indexOf('class'));
  return findStatementSemicolon(masked, start + 6);
}

function hasTopLevelComma(masked, from, to) {
  let p = 0, b = 0, c = 0;
  for (let i = from; i < to; i++) {
    const ch = masked[i];
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '[') b++;
    else if (ch === ']') b--;
    else if (ch === '{') c++;
    else if (ch === '}') c--;
    else if (ch === ',' && p === 0 && b === 0 && c === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 模块说明符解析（只允许相对路径）
// ---------------------------------------------------------------------------

function resolveSpecifier(modId, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new Error(`${modId}: 不支持的模块说明符 "${spec}"（仅相对路径；three 走全局 THREE）`);
  }
  const parts = posixDir(modId) ? posixDir(modId).split('/') : [];
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error(`${modId}: 说明符越出项目根 "${spec}"`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const id = parts.join('/');
  if (!/\.(mjs|js)$/.test(id)) throw new Error(`${modId}: 说明符缺少 .mjs 扩展名 "${spec}"`);
  return id;
}

function parseImport(text, modId) {
  const side = /^import\s*(['"])([^'"]+)\1\s*;?$/.exec(text);
  if (side) return { spec: side[2], clause: null };
  const m = /^import\s+([\s\S]+?)\s+from\s*(['"])([^'"]+)\2\s*;?$/.exec(text);
  if (!m) throw new Error(`${modId}: 无法解析的 import 语句: ${text.split('\n')[0]}`);
  return { spec: m[3], clause: m[1].trim() };
}

function parseImportClause(clause, modId) {
  // 统一成 bindings 列表：imported 为 'default' | 导出名 | '*'
  const once = text => {
    if (text.startsWith('*')) {
      const m = /^\*\s+as\s+([\w$]+)$/.exec(text);
      if (!m) throw new Error(`${modId}: 无法解析的命名空间导入 "${text}"`);
      return [{ imported: '*', local: m[1] }];
    }
    if (text.startsWith('{')) {
      const inner = text.slice(1, text.lastIndexOf('}'));
      return inner.split(',').map(s => s.trim()).filter(Boolean).map(item => {
        const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(item);
        if (!m) throw new Error(`${modId}: 无法解析的具名导入 "${item}"`);
        return { imported: m[1], local: m[2] || m[1] };
      });
    }
    const m = /^([\w$]+)$/.exec(text);
    if (!m) throw new Error(`${modId}: 无法解析的导入子句 "${text}"`);
    return [{ imported: 'default', local: m[1] }];
  };
  // `import D, { a, b } from` / `import D, * as ns from`
  const combo = /^([\w$]+)\s*,\s*([\s\S]+)$/.exec(clause);
  if (combo) return [{ imported: 'default', local: combo[1] }, ...once(combo[2].trim())];
  return once(clause);
}

// ---------------------------------------------------------------------------
// 单模块编译：ESM → 工厂函数源码
// ---------------------------------------------------------------------------

function applyEdits(src, edits) {
  const list = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const e of list) {
    if (e.start < pos) throw new Error('源码编辑区间重叠');
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

function transformModule(id, src) {
  if (RESERVED_RE.test(src)) throw new Error(`${id}: 源码占用了打包器保留标识符（__exports/__req/...）`);
  const masked = maskSource(src);
  const stmts = scanTopLevel(masked);
  const edits = [];
  const imports = [];
  const deps = [];
  const exported = new Set();   // 该模块对外暴露的全部导出名
  const hoisted = new Map();    // 导出名 → 顶层函数名（工厂入口预注册，破循环依赖）
  let depN = 0;

  for (const st of stmts) {
    const end = statementEnd(masked, st.start);
    const text = src.slice(st.start, end);

    if (st.keyword === 'import') {
      const { spec, clause } = parseImport(text, id);
      const depId = resolveSpecifier(id, spec);
      const v = `__dep${depN++}`;
      imports.push(`const ${v} = __req(${JSON.stringify(depId)});`);
      const dep = { id: depId, bindings: [] };
      if (clause) {
        for (const it of parseImportClause(clause, id)) {
          if (it.imported === '*') {
            imports.push(`const ${it.local} = ${v};`);
          } else {
            imports.push(`const ${it.local} = ${v}[${JSON.stringify(it.imported)}];`);
          }
          if (it.imported !== '*') dep.bindings.push(it);
        }
      }
      deps.push(dep);
      edits.push({ start: st.start, end, text: '' });
      continue;
    }

    // export ...
    let m;

    // export default function name(...) {...} / export default class Name {...}
    m = /^export\s+default\s+/.exec(text);
    if (m) {
      const body = text.slice(m[0].length);
      const fn = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(body);
      if (fn) {
        edits.push({ start: st.start, end, text: body });
        exported.add('default');
        hoisted.set('default', fn[1]);
      } else {
        const expr = body.trim().replace(/;$/, '');
        edits.push({ start: st.start, end, text: `__exports["default"] = ${expr};` });
        exported.add('default');
      }
      continue;
    }

    // export function name(...) {...}
    m = /^export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(text);
    if (m) {
      edits.push({ start: st.start, end, text: text.replace(/^export\s+/, '') });
      exported.add(m[1]);
      hoisted.set(m[1], m[1]);
      continue;
    }

    // export class Name {...}
    m = /^export\s+class\s+([\w$]+)/.exec(text);
    if (m) {
      const name = m[1];
      edits.push({
        start: st.start, end,
        text: `${text.replace(/^export\s+/, '')}\n__exports[${JSON.stringify(name)}] = ${name};`,
      });
      exported.add(name);
      continue;
    }

    // export const/let/var NAME = ...
    m = /^export\s+(const|let|var)\s+([\w$]+)\s*=/.exec(text);
    if (m) {
      const name = m[2];
      const eq = st.start + text.indexOf('=');
      if (hasTopLevelComma(masked, eq, end)) {
        throw new Error(`${id}: export ${m[1]} 多声明符暂不支持`);
      }
      edits.push({
        start: st.start, end,
        text: `${text.replace(/^export\s+/, '')}\n__exports[${JSON.stringify(name)}] = ${name};`,
      });
      exported.add(name);
      continue;
    }

    // export { a, b as c };
    m = /^export\s*\{([\s\S]*?)\}\s*;?$/.exec(text);
    if (m) {
      const lines = [];
      for (const item of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const im = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(item);
        if (!im) throw new Error(`${id}: 无法解析的导出项 "${item}"`);
        const local = im[1];
        const out = im[2] || im[1];
        lines.push(`__exports[${JSON.stringify(out)}] = ${local};`);
        exported.add(out);
      }
      edits.push({ start: st.start, end, text: lines.length ? lines.join('\n') : ';' });
      continue;
    }

    throw new Error(`${id}: 不支持的 export 形式: ${text.split('\n')[0]}`);
  }

  const prereg = [...hoisted.entries()].map(([name, local]) =>
    `__exports[${JSON.stringify(name)}] = ${local};`);
  const body = applyEdits(src, edits);
  const code = [
    'function (__exports, __req) {',
    '"use strict";',
    ...prereg,
    ...imports,
    body,
    '}',
  ].join('\n');

  return { id, code, deps, exported, hoisted: new Set(hoisted.keys()) };
}

// ---------------------------------------------------------------------------
// 模块清单 / 链接检查 / 循环依赖检查
// ---------------------------------------------------------------------------

function listModuleIds() {
  const ids = [];
  const walk = (absDir, relDir) => {
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir + '/' + ent.name;
      if (ent.isDirectory()) walk(join(absDir, ent.name), rel);
      else if (ent.name.endsWith('.mjs') && rel !== BUILDER_ID) ids.push(rel);
    }
  };
  for (const dir of PROJECT_DIRS) walk(join(ROOT, dir), dir);
  return ids.sort();
}

function linkCheck(mods) {
  for (const [id, mod] of mods) {
    for (const dep of mod.deps) {
      const target = mods.get(dep.id);
      if (!target) throw new Error(`${id}: 找不到依赖模块 ${dep.id}`);
      for (const b of dep.bindings) {
        if (!target.exported.has(b.imported)) {
          throw new Error(`${id}: ${dep.id} 没有导出 "${b.imported}"（链接失败）`);
        }
      }
    }
  }
}

function cycleCheck(mods, entry) {
  const state = new Map(); // 'loading' | 'done'
  const cycles = [];
  const visit = (id, stack) => {
    const st = state.get(id);
    if (st === 'done') return;
    if (st === 'loading') return; // 由调用方在回边处检查
    state.set(id, 'loading');
    for (const dep of mods.get(id).deps) {
      if (state.get(dep.id) === 'loading') {
        cycles.push(`${id} → ${dep.id}`);
        const target = mods.get(dep.id);
        for (const b of dep.bindings) {
          if (!target.hoisted.has(b.imported)) {
            throw new Error(
              `循环依赖 ${id} → ${dep.id}：导入 "${b.imported}" 不是顶层函数导出，` +
              '运行期会拿到 undefined（打包器不支持在循环边上读取非提升导出）');
          }
        }
        continue;
      }
      visit(dep.id, [...stack, dep.id]);
    }
    state.set(id, 'done');
  };
  visit(entry, [entry]);
  return cycles;
}

function reachableOrder(mods, entry) {
  const out = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const dep of mods.get(id).deps) visit(dep.id);
  };
  visit(entry);
  return out;
}

// ---------------------------------------------------------------------------
// 模型 JSON：转内联常量 + 重写 fetch 调用点
// ---------------------------------------------------------------------------

function loadModels() {
  const map = {};
  const list = [];
  for (const name of readdirSync(MODELS_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = '/src/models/' + name;
    const model = JSON.parse(readFileSync(join(MODELS_DIR, name), 'utf8'));
    map[path] = model;
    list.push({
      path,
      bytes: statSync(join(MODELS_DIR, name)).size,
      verts: model.pos ? model.pos.length / 3 : 0,
      idx: model.idx ? model.idx.length : 0,
      cols: model.col ? model.col.length : 0,
    });
  }
  if (!Object.keys(map).length) throw new Error('src/models 下没有模型 JSON');
  return { map, list };
}

const FETCH_MODEL_RE = /fetch\s*\(\s*(['"])(\/src\/models\/[^'"]+\.json)\1\s*\)/g;

function inlineModelFetches(code, id, modelPaths, usedModelPaths) {
  let hits = 0;
  const out = code.replace(FETCH_MODEL_RE, (_all, q, path) => {
    if (!modelPaths.has(path)) {
      throw new Error(`${id}: fetch("${path}") 在构建输入的模型清单里不存在`);
    }
    usedModelPaths?.add(path);
    hits++;
    return `__inlineModel(${q}${path}${q})`;
  });
  return { code: out, hits };
}

// ---------------------------------------------------------------------------
// Boss GLB：gzip + base64 内联，运行期 DecompressionStream('gzip') 解压。
// 只内联 LOD2（nailong_boss.glb）；LOD0 仅 dev 可用，产物里 ok:false 走回退。
// ---------------------------------------------------------------------------

const GLB_PATH = '/src/models/nailong_boss.glb';
const FETCH_GLB_RE = /fetch\s*\(\s*(['"])(\/src\/models\/nailong_boss(?:_lod0)?\.glb)\1\s*\)/g;

function loadBossGLB() {
  const file = join(ROOT, 'src', 'models', 'nailong_boss.glb');
  const raw = readFileSync(file);
  const gz = gzipSync(raw, { level: 9 });
  return { rawBytes: raw.length, gzBytes: gz.length, b64: gz.toString('base64') };
}

function inlineGLBFetches(code, id) {
  let hits = 0;
  const out = code.replace(FETCH_GLB_RE, (_all, q, path) => {
    hits++;
    return `__inlineGLB(${q}${path}${q})`;
  });
  return { code: out, hits };
}

// MP3 is already compressed: embed raw bytes, without gzip/DecompressionStream.
const AUDIO_PATH = '/src/audio/boss_laugh.mp3';
const FETCH_AUDIO_RE = /fetch\s*\(\s*(['"])(\/src\/audio\/boss_laugh\.mp3)\1\s*\)/g;
function loadBossAudio() {
  const raw = readFileSync(join(ROOT, 'src', 'audio', 'boss_laugh.mp3'));
  return { rawBytes: raw.length, b64: raw.toString('base64') };
}
function inlineAudioFetches(code) {
  let hits = 0;
  const out = code.replace(FETCH_AUDIO_RE, () => { hits++; return '__inlineAudio()'; });
  return { code: out, hits };
}

// ---------------------------------------------------------------------------
// Three UMD：内联前摘掉带外链的弃用告警（字符串里的 https:// 不属于外链，
// 但产物要求零 https://，且这些告警在单文件里只是噪音）
// ---------------------------------------------------------------------------

function patchThree(src) {
  let stripped = 0;
  const out = src.replace(
    /console\.warn\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g,
    m => {
      if (!m.includes('https://') && !m.includes('fetch()')) return m;
      stripped++;
      return '0';
    });
  if (/https:\/\//.test(out)) throw new Error('three.min.js 仍有 https:// 字面量，无法保证产物零外链');
  // Generic FileLoader/ImageBitmapLoader are unused (embedded GLBs use parse).
  // Seal their network fallback in the offline output, leaving vendored source intact.
  // Match the two pinned minified call signatures; do not run our module lexer
  // over vendor regex literals. The final raw network check rejects other forms.
  let blocked = 0;
  const code = out.replace(/\bfetch(?=\(\w+(?:,\w+)*\)\.then\b)/g, () => {
    blocked++;
    return '(function(){return Promise.reject(new Error("External asset loads disabled"));})';
  });
  return { code, stripped, blocked };
}

// ---------------------------------------------------------------------------
// 打包器自检（node client/build.mjs --selftest）：用合成模块覆盖 default/named/
// namespace 导入、export function/const/class/列表/default、函数提升 + 循环依赖
// ---------------------------------------------------------------------------

function selfTest() {
  const sources = {
    't/a.mjs': [
      "import { rb } from './b.mjs';",
      'export function ra() { return "a+" + rb(); }',
      'export const A_CONST = 42;',
      'export { ra as raAlias };',
      '',
    ].join('\n'),
    't/b.mjs': [
      "import { ra } from './a.mjs';",
      'export function rb() { return "b"; }',
      'export function callA() { return ra(); }',
      '',
    ].join('\n'),
    't/c.mjs': [
      'export const C = 3;',
      'export function cf() { return 4; }',
      'export class Ck { m() { return 5; } }',
      "export default 'cd';",
      '',
    ].join('\n'),
    't/d.mjs': [
      'export default function dflt(x) { return x * 2; }',
      '',
    ].join('\n'),
    't/main.mjs': [
      "import A_DEFAULT, { C, cf, Ck } from './c.mjs';",
      "import * as ns from './c.mjs';",
      "import { ra, raAlias, A_CONST } from './a.mjs';",
      "import dflt from './d.mjs';",
      "import { callA } from './b.mjs';",
      'globalThis.__SELFTEST__ = {',
      '  def: A_DEFAULT, C, cf: cf(), ck: new Ck().m(),',
      '  nsC: ns.C, nsDefault: ns.default,',
      '  ra: ra(), alias: raAlias(), aConst: A_CONST,',
      '  dflt: dflt(21), callA: callA(),',
      '};',
      '',
    ].join('\n'),
  };
  const mods = new Map();
  for (const [id, src] of Object.entries(sources)) {
    const mod = transformModule(id, src);
    mod.code = compactModule(mod.code).code;
    mods.set(id, mod);
  }
  linkCheck(mods);
  const cycles = cycleCheck(mods, 't/main.mjs');
  const order = reachableOrder(mods, 't/main.mjs');
  const code = `(function () {
"use strict";
var __defs = Object.create(null);
var __cache = Object.create(null);
function __req(id) {
  var hit = __cache[id];
  if (hit) return hit;
  var factory = __defs[id];
  if (!factory) throw new Error('missing ' + id);
  var exports = __cache[id] = Object.create(null);
  factory(exports, __req);
  return exports;
}
${order.map(id => `__defs[${JSON.stringify(id)}] = ${mods.get(id).code};`).join('\n')}
__req('t/main.mjs');
})();`;
  const ctx = {};
  vm.runInNewContext(code, ctx, { filename: 'selftest.js' });
  const got = ctx.__SELFTEST__ || {};
  const want = {
    def: 'cd', C: 3, cf: 4, ck: 5, nsC: 3, nsDefault: 'cd',
    ra: 'a+b', alias: 'a+b', aConst: 42, dflt: 42, callA: 'a+b',
  };
  const bad = Object.keys(want).filter(k => got[k] !== want[k]);
  if (bad.length) {
    throw new Error('自检失败: ' + bad.map(k => `${k}=${JSON.stringify(got[k])}≠${JSON.stringify(want[k])}`).join(', '));
  }
  console.log('[inkline] 打包器自检通过：' + JSON.stringify(got));
  console.log('[inkline] 自检覆盖循环依赖: ' + (cycles.join(', ') || '无') + '；恒等断言 ' + Object.keys(want).length + ' 项');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function build() {
  if (resolve(OUT_FILE) === resolve(ROOT, '墨线突围.html')) {
    throw new Error('拒绝覆盖根目录旧原型 墨线突围.html');
  }

  const html = readFileSync(TEMPLATE_FILE, 'utf8');
  const threeTag = '<script src="/src/three/three.min.js"></script>';
  const entryTag = '<script type="module" src="/client/main.mjs"></script>';
  if (!html.includes(threeTag) || !html.includes(entryTag)) {
    throw new Error('dev/client.html 结构与构建器预期不一致（找不到 three / main.mjs 的 script 标签）');
  }
  if (!html.includes('<canvas id="view"></canvas>') || !html.includes('<div id="hud"></div>')) {
    throw new Error('dev/client.html 缺少 #view 画布或 #hud 容器');
  }
  if (!/<style>[\s\S]*<\/style>/.test(html)) throw new Error('dev/client.html 缺少内联 <style>');

  // 1) 模块
  const ids = listModuleIds();
  const mods = new Map();
  for (const id of ids) {
    const src = readFileSync(join(ROOT, id), 'utf8');
    mods.set(id, transformModule(id, src));
  }
  linkCheck(mods);
  const cycles = cycleCheck(mods, ENTRY);
  const order = reachableOrder(mods, ENTRY);
  if (!mods.has(ENTRY)) throw new Error(`入口模块 ${ENTRY} 不存在`);

  // 2) 模型
  const { map: models, list: modelList } = loadModels();
  const modelPaths = new Set(Object.keys(models));
  const usedModelPaths = new Set();
  const reachableIds = new Set(order);

  // 3) fetch → __inlineModel / __inlineGLB / __inlineAudio
  // 全部模块仍校验并重写；只有入口可达模块的调用点保留模型数据。
  let fetchHits = 0;
  let glbHits = 0;
  let audioHits = 0;
  for (const id of ids) {
    const mod = mods.get(id);
    const res = inlineModelFetches(mod.code, id, modelPaths, reachableIds.has(id) ? usedModelPaths : undefined);
    mod.code = res.code;
    fetchHits += res.hits;
    const glb = inlineGLBFetches(mod.code, id);
    mod.code = glb.code;
    glbHits += glb.hits;
    const audio = inlineAudioFetches(mod.code);
    mod.code = audio.code;
    audioHits += audio.hits;
  }
  const bossAudio = loadBossAudio();
  if (audioHits === 0) throw new Error('没有找到 boss_laugh.mp3 的 fetch 调用点（Boss 音频未内联）');
  if (fetchHits === 0) throw new Error('没有找到任何 /src/models/*.json 的 fetch 调用点（Boss 模型未内联）');
  const bossGLB = loadBossGLB();
  if (glbHits === 0) throw new Error('没有找到 nailong_boss.glb 的 fetch 调用点（Boss GLB 未内联）');

  // 4) three
  const three = patchThree(readFileSync(THREE_FILE, 'utf8'));

  // 5) 组装 bundle（入口可达模块在前，其余模块只注册不执行 ⇒ "全部 ES 模块" 都在产物里）
  const inlineModels = Object.fromEntries([...usedModelPaths].map(path => [path, models[path]]));
  const inlineModelList = modelList.filter(model => usedModelPaths.has(model.path));
  const modelsLiteral = JSON.stringify(inlineModels);
  if (modelsLiteral.includes('</script')) throw new Error('模型数据包含 </script，需要额外转义');
  const emitIds = [...order, ...ids.filter(id => !order.includes(id))];
  const compaction = { beforeBytes: 0, afterBytes: 0, commentBytesSaved: 0, whitespaceBytesSaved: 0 };
  const moduleCode = emitIds
    .map(id => {
      const result = compactModule(mods.get(id).code);
      for (const key of Object.keys(compaction)) compaction[key] += result[key];
      return `__defs[${JSON.stringify(id)}] = ${result.code};`;
    })
    .join('\n\n');
  const bundle = `(function () {
"use strict";
var __MODEL_DATA = ${modelsLiteral};
var __MODEL_PATHS = ${JSON.stringify([...usedModelPaths])};
// 模型 fetch 调用点的构建期内联替身：与 Response 同形（ok + json()），
// 模型缺失时 ok:false ⇒ 调用方走原有「回退胶囊」分支。
function __inlineModel(path) {
  var data = Object.prototype.hasOwnProperty.call(__MODEL_DATA, path) ? __MODEL_DATA[path] : null;
  return Promise.resolve({
    ok: data !== null,
    url: path,
    json: function () { return Promise.resolve(data); }
  });
}
// Boss GLB：gzip+base64 内联，运行期原生 DecompressionStream 解压（零网络）。
// 不支持 DecompressionStream 或 LOD0 路径时 ok:false ⇒ 调用方回退黄色胶囊。
var __BOSS_GLB_B64 = ${JSON.stringify(bossGLB.b64).replace(/XHR/g, '\\u0058HR')};
function __decodeGLB() {
  if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('DecompressionStream unsupported'));
  var bin = atob(__BOSS_GLB_B64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
function __inlineGLB(path) {
  var miss = function () { return { ok: false, url: path, arrayBuffer: function () { return Promise.resolve(null); } }; };
  if (path !== ${JSON.stringify(GLB_PATH)}) return Promise.resolve(miss());
  return __decodeGLB().then(function (buf) {
    return { ok: true, url: path, arrayBuffer: function () { return Promise.resolve(buf); } };
  }).catch(miss);
}
var __AUDIO_B64 = ${JSON.stringify(bossAudio.b64).replace(/XHR/g, '\\u0058HR')}, __AUDIO_BUF;
function __inlineAudio() {
  if (!__AUDIO_BUF) {
    var bin = atob(__AUDIO_B64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    __AUDIO_BUF = bytes.buffer;
  }
  return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(__AUDIO_BUF); } });
}
var __defs = Object.create(null);
var __cache = Object.create(null);
function __req(id) {
  var hit = __cache[id];
  if (hit) return hit;
  var factory = __defs[id];
  if (!factory) throw new Error('[inkline] 模块未注册: ' + id);
  var exports = __cache[id] = Object.create(null);
  try { factory(exports, __req); }
  catch (err) { delete __cache[id]; throw err; }
  return exports;
}

${moduleCode}

__req(${JSON.stringify(ENTRY)});
})();`;

  // 6) 产物自检（构建期，失败即不出包）
  const maskedBundle = maskSource(bundle);
  if (/\bfetch\s*\(/.test(maskedBundle)) throw new Error('bundle 里仍有 fetch() 调用，无法保证零网络请求');
  if (/XMLHttpRequest/.test(maskedBundle)) throw new Error('bundle 里出现 XMLHttpRequest');
  if (/^\s*(?:import|export)\b/m.test(maskedBundle)) throw new Error('bundle 里仍有未处理的 import/export 语句');
  if (bundle.includes('</script')) throw new Error('bundle 包含 </script，需要额外转义');
  if (three.code.includes('</script')) throw new Error('three.min.js 包含 </script，需要额外转义');

  // 7) 组装 HTML；全部检查成功前不触碰已有产物
  const built = html
    .replace(/<title>[\s\S]*?<\/title>/, '<title>墨线突围 · INKLINE</title>')
    .replace(threeTag, () => `<script>\n${three.code}\n</script>`)
    .replace(entryTag, () => `<script>\n${bundle}\n</script>`);

  if (built.includes('https://')) throw new Error('产物仍有 https:// 外链');
  if (built.includes('XHR')) throw new Error('产物仍有 XHR 字面文本');
  if (/<script\b[^>]*\bsrc\s*=/.test(built)) throw new Error('产物仍有外部脚本');

  // 8) 语法编译校验（与浏览器解析同一入口脚本）
  const scripts = [...built.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length !== 2) throw new Error(`期望 2 段内联脚本，实际 ${scripts.length}`);
  for (const [i, code] of scripts.entries()) {
    const masked = i === 0 ? code : maskSource(code);
    if (/\bfetch\s*\(|XMLHttpRequest/.test(masked)) throw new Error('产物仍有 fetch/XMLHttpRequest');
    new vm.Script(code, { filename: `inline-${i}.js` });
  }

  const bytes = Buffer.byteLength(built, 'utf8');
  if (bytes >= MAX_BYTES) throw new Error(`产物 ${bytes} 字节必须小于 2MB 上限`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, built);

  return {
    bytes, bundleBytes: Buffer.byteLength(bundle), threeBytes: Buffer.byteLength(three.code), compaction,
    modules: ids.length, reachable: order.length, order,
    models: inlineModelList, modelBytes: inlineModelList.reduce((n, m) => n + m.bytes, 0),
    fetchHits, glbHits, audioHits, cycles, threeWarns: three.stripped, threeBlocked: three.blocked,
    audio: { path: AUDIO_PATH, rawBytes: bossAudio.rawBytes, b64Bytes: bossAudio.b64.length },
    glb: { path: GLB_PATH, rawBytes: bossGLB.rawBytes, gzBytes: bossGLB.gzBytes, b64Bytes: bossGLB.b64.length },
  };
}

if (process.argv.includes('--selftest')) {
  try {
    selfTest();
    process.exit(0);
  } catch (err) {
    console.error('[inkline] 自检失败：' + (err && err.message ? err.message : err));
    process.exit(1);
  }
}

let info;
try {
  info = build();
} catch (err) {
  console.error('[inkline] 构建失败：' + (err && err.message ? err.message : err));
  process.exit(1);
}

console.log('[inkline] 构建成功 → ' + toPosix(relative(ROOT, OUT_FILE)));
console.log('[inkline] 产物大小 ' + kb(info.bytes) + '（' + info.bytes + ' 字节，上限 2097152）');
console.log('[inkline] 模块 ' + info.modules + ' 个（入口可达 ' + info.reachable + '），bundle ' + kb(info.bundleBytes)
  + '；three UMD ' + kb(info.threeBytes) + '；模型 ' + info.models.length + ' 个 ' + kb(info.modelBytes));
console.log('[inkline] 模块词法压缩 ' + info.compaction.beforeBytes + ' → ' + info.compaction.afterBytes
  + ' 字节；纯注释行节省 ' + info.compaction.commentBytesSaved + 'B；缩进/空行节省 ' + info.compaction.whitespaceBytesSaved
  + 'B；合计节省 ' + (info.compaction.beforeBytes - info.compaction.afterBytes) + 'B（对比内联后的未压缩模块）；预算余量 ' + (MAX_BYTES - info.bytes) + 'B');
console.log('[inkline] 模型内联: ' + info.models.map(m => m.path.replace('/src/models/', '') + '(' + m.verts + 'v/' + m.idx + 'i)').join(' '));
console.log('[inkline] fetch → __inlineModel 替换 ' + info.fetchHits + ' 处；fetch → __inlineGLB 替换 ' + info.glbHits + ' 处；循环依赖 ' + (info.cycles.length ? info.cycles.join(', ') : '无')
  + '；three 弃用告警剥离 ' + info.threeWarns + ' 处；禁用外部加载 ' + info.threeBlocked + ' 处');
console.log('[inkline] Boss GLB 内联: ' + info.glb.path + ' 原始 ' + kb(info.glb.rawBytes) + ' → gzip ' + kb(info.glb.gzBytes) + ' → base64 ' + kb(info.glb.b64Bytes));
console.log('[inkline] Boss 音频内联: ' + info.audio.path + ' 原始 ' + info.audio.rawBytes + 'B → base64 ' + info.audio.b64Bytes + 'B；fetch → __inlineAudio 替换 ' + info.audioHits + ' 处');
console.log('[inkline] 入口可达顺序: ' + info.order.join(' → '));
