import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';

// Match the legacy build-test harness: no real builds, asset edits or dist writes.
const source = readFileSync(new URL('../client/build.mjs', import.meta.url), 'utf8');
const boundary = source.indexOf("\nif (process.argv.includes('--selftest'))");
assert.ok(boundary > 0);
const library = source.slice(0, boundary)
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^const ROOT = .*;\r?\n/m, '');
function api(extra = {}, suffix = '') {
  const ctx = vm.createContext({ ROOT: '/fixture', ...path.posix, Buffer, gzipSync, vm, console, ...extra });
  vm.runInContext(library + '\n' + suffix + `
    globalThis.api = { compactModule, maskSource, transformModule, scanLexical, build };
  `, ctx);
  return ctx.api;
}
const lexer = api();
const literalBytes = src => {
  const literals = [];
  lexer.scanLexical(src, 0, (a, b, kind) => {
    if (kind === 'literal') literals.push(src.slice(a, b));
  });
  return literals;
};
function compact(src) {
  const result = lexer.compactModule(src);
  assert.equal(result.beforeBytes, Buffer.byteLength(src));
  assert.equal(result.afterBytes, Buffer.byteLength(result.code));
  assert.equal(result.beforeBytes - result.afterBytes, result.commentBytesSaved + result.whitespaceBytesSaved);
  assert.ok(result.commentBytesSaved >= 0 && result.whitespaceBytesSaved >= 0);
  assert.deepEqual(literalBytes(result.code), literalBytes(src), 'all literal bytes survive exactly');
  const again = lexer.compactModule(result.code);
  assert.equal(again.code, result.code, 'compaction is idempotent');
  assert.equal(again.commentBytesSaved + again.whitespaceBytesSaved, 0);
  return result;
}
const evaluate = src => vm.runInNewContext(src + '\nJSON.stringify(result)', {}, { timeout: 1000 });
function equivalent(src, expected) {
  const baseline = evaluate(src);
  if (expected !== undefined) assert.equal(baseline, JSON.stringify(expected));
  const result = compact(src);
  assert.equal(evaluate(result.code), baseline, 'observable result agrees with the uncompressed source');
  return result;
}

test('pure comment lines and indentation have separate, exact UTF-8 savings', () => {
  const comment1 = '  // 注释\n';
  const comment2 = '\t/* block\n\t comment */\n';
  const src = comment1 + '\n\n  const x = 1;\n' + comment2 + '    globalThis.result = x;\n';
  const result = equivalent(src, 1);
  assert.equal(result.code, '\nconst x = 1;\nglobalThis.result = x;\n');
  assert.equal(result.commentBytesSaved, Buffer.byteLength(comment1 + comment2));
  assert.equal(result.whitespaceBytesSaved, 7);
});

for (const eol of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
  test(`comment/blank lines preserve original line terminators: ${JSON.stringify(eol)}`, () => {
    const src = ['  // top', '  const a = 1', '  /* block', '     */', '', '', '  const result = a + 2', '// EOF'].join(eol);
    const result = equivalent(src, 3);
    assert.equal(result.code, ['const a = 1', '', 'const result = a + 2', ''].join(eol));
    const masked = lexer.maskSource(src);
    assert.equal(masked.length, src.length);
    for (let i = 0; i < src.length; i++) {
      if (/[\n\r\u2028\u2029]/.test(src[i])) assert.equal(masked[i], src[i]);
    }
  });
}

test('adjacent comment groups cannot leave orphaned block delimiters', () => {
  const src = [
    '  /* first',
    '   */ /* second',
    '   */ const x = 2;',
    '  /* removable */ // also removable',
    '  /* removable block',
    '     ends */ /* next',
    '     ends */',
    '  const result = x; // keep inline',
  ].join('\n');
  const result = equivalent(src, 2);
  assert.ok(result.code.includes('/* first\n   */ /* second\n   */ const x = 2;'));
  assert.ok(result.code.includes('// keep inline'));
  assert.ok(!result.code.includes('removable'));
});

test('inline multiline comments retain ASI and comment contents verbatim', () => {
  const comment = '/*\n  blank\n\n  and a newline\n  */';
  const src = 'function f() { return ' + comment + ' 42; }\n  const result = [f(), 8 / /* inline */ 2];';
  const result = equivalent(src, [null, 4]);
  assert.ok(result.code.includes(comment));
  assert.equal(result.commentBytesSaved, 0);
});

for (const eol of ['\n', '\r\n', '\r']) {
  for (const quote of ["'", '"']) {
    test(`escaped ${JSON.stringify(quote)} string continuation retains indentation (${JSON.stringify(eol)})`, () => {
      const literal = quote + ['a\\', '    // string, not comment\\', '    /* string */\\', '  z'].join(eol) + quote;
      const src = '  // remove' + eol + '  const result = ' + literal + ';' + eol;
      const result = equivalent(src, 'a    // string, not comment    /* string */  z');
      assert.ok(result.code.includes(literal));
    });
  }
}

test('strings preserve escape sequences, URLs, Unicode and comment-like text', () => {
  equivalent(String.raw`
    // remove
    const result = ['https://host/a/*b*/', 'escaped \' quote', "escaped \" quote", '\\', '\u2028', '\u2029', '墨线'];
  `, ['https://host/a/*b*/', "escaped ' quote", 'escaped " quote', '\\', '\u2028', '\u2029', '墨线']);
});

test('tagged multiline templates and nested interpolations stay byte-for-byte opaque', () => {
  const src = [
    '  // removable outer comment',
    '  function tag(strings, ...values) { return [strings.raw, strings, values]; }',
    '  const result = tag`first',
    '    // literal line',
    '',
    '',
    '    /* literal block */',
    '    \\` escaped backtick \\${notInterpolation}',
    '    ${(() => {',
    '      // interpolation is retained, too',
    "      const re = /[}/*]/;",
    "      return `nested ${re.test('}') ? `${8 / 2}` : 'no'}`;",
    '    })()}',
    '    ${({ class: 8, function: 2 }).class / 2}',
    '    ${{valueOf() { return 8; }} / 2}',
    '  last`;',
    '  // removable footer',
  ].join('\n');
  const result = equivalent(src);
  assert.ok(result.commentBytesSaved > 0);
  assert.ok(result.code.includes('      // interpolation is retained, too'));
  assert.ok(result.code.includes('\n\n\n    /* literal block */'));
});

const regexCases = [
  ['character classes, escapes, braces, flags', String.raw`
    const a = /[/*]/.test('/');
    const b = /[//]/.test('/');
    const c = /[,;{}\[\]]/g.test('}');
    const d = /a\/\/b/.test('a//b');
    const e = /[\]\\]/.test(']');
    const f = /[[a-z]--[aeiou]]/v.test('b');
    const result = [a, b, c, d, e, f];
  `, [true, true, true, true, true, true]],
  ['control parentheses vs calls', String.raw`
    let n = 0;
    if (true) /[/*]/.test('/') && n++;
    while (n < 2) /[}]/.test('}') && n++;
    for (; n < 3;) /[//]/.test('/') && n++;
    function value() { return 12; }
    const result = [n, value() / 3 / 2, (12) / 3];
  `, [3, 2, 4]],
  ['blocks, labels, try/catch/finally, switch', String.raw`
    let n = 0;
    { n++; } /[/*]/.test('/') && n++;
    label: { n++; } /[}]/.test('}') && n++;
    try { throw 1; } catch (e) { n += e; } finally { n++; }
    /[//]/.test('/') && n++;
    switch (n) { case 7: /[}]/.test('}') && n++; break; }
    const result = n;
  `, 8],
  ['function/class declarations vs expressions', String.raw`
    function f() {} /[/*]/.test('/');
    class A {} /[}]/.test('}');
    const f1 = function() { return /[/*]/; } / 2;
    const f2 = async function() {} / 2;
    const C = class { static valueOf() { return 8; } } / 2;
    const result = [Number.isNaN(f1), Number.isNaN(f2), C];
  `, [true, true, 4]],
  ['object literals, ternaries and methods', String.raw`
    const value = true ? 1 : {valueOf() {return 8;}} / 2;
    const other = false ? 1 : {valueOf() {return 8;}} / 2;
    const o = {if() {return 12;}, class: 6, function: 9};
    const result = [value, other, o.if() / 3, o.class / 2, o.function / 3,
      {valueOf() {return 8;}} / 2, (() => 8)() / 2];
  `, [1, 4, 4, 3, 3, 4, 4]],
  ['division assignments, unary/binary operands and numeric forms', String.raw`
    let x = 24; x /= 3; x = x / /* inline */ 2;
    const of = 8;
    const result = [x, of / 2, 0x18 / 3, 1_200 / 3e2, .8 / .2,
      typeof /[/*]/, !/[}]/.test('x'), 12 / /./.source.length,
      /x/.source.length / 2, '1234'.length / 2, [8][0] / 2];
  `, [4, 4, 8, 4, 4, 'object', true, 12, 0.5, 2, 4]],
  ['keyword operands, generators and for-of', String.raw`
    function* g() { yield /[/*]/.test('/'); yield* [/}/.test('}')]; }
    let n = 0;
    for (const x of /[/*]/.source) n++;
    const result = [...g(), n > 0, (() => /[}]/.test('}'))()];
  `, [true, true, true, true]],
  ['keyword-named properties are not control statements', String.raw`
    const object = { if: x => x, while: x => x, class: 8, function: 6, return: 4 };
    const result = [object.if(8) / 2, object?.while(6) / 2,
      object.class / 2, object.function / 2, object.return / 2];
  `, [4, 3, 4, 3, 2]],
];
for (const [name, src, expected] of regexCases) {
  test('regexp vs division: ' + name, () => {
    equivalent('  // remove\n' + src, expected);
  });
}

test('regexp bodies may contain quote/backtick characters without starting literals', () => {
  equivalent("  const result = /[\"'`/*{}]/.test('`');\n  // remove\n", true);
});

test('class fields, private methods, static blocks and nested extends retain semantics', () => {
  equivalent(String.raw`
    class A extends (class { m() { return 2; } }) {
      // removed, but field ASI must survive
      x = /[}/*]/.test('}')


      y = 3
      #z = 4
      static count = 0
      static { this.count = /[//]/.test('/') ? 5 : 0; }
      #value() { return this.#z; }
      value() { return [this.x, this.y, this.#value(), super.m()]; }
    }
    const result = [new A().value(), A.count];
  `, [[true, 3, 4, 2], 5]);
});

test('keyword-named semicolonless class fields do not open function/class contexts', () => {
  equivalent(String.raw`
    class A {
      function
      class
      static function
      static class
      other = class { static valueOf() { return 8; } } / 2
      fn = function() {} / 2
      value() { return this.other; }
    }
    /[}/*]/.test('/');
    const instance = new A();
    const result = [instance.function, instance.class, instance.value(), Number.isNaN(instance.fn)];
  `, [null, null, 4, true]);
});

test('debugger ASI and Unicode identifiers do not confuse a following regexp/division', () => {
  equivalent(String.raw`
    debugger
    // preserve the statement boundary
    /[}/*]/.test('/');
    const 墨线 = 8, \u0061 = 6;
    const result = [墨线 / 2, \u0061 / 2];
  `, [4, 3]);
});

test('ASI after return, postfix operators, continue/break and before tagged templates', () => {
  equivalent([
    '  function f() {',
    '    return',
    '    // return remains undefined',
    '    /* removed block */',
    '    /[}]/.test("}");',
    '  }',
    '  let a = 1, b = 1;',
    '  a',
    '  // not a postfix operation on a',
    '  ++b',
    '  outer: for (let i = 0; i < 2; i++) {',
    '    if (i === 0) { continue outer',
    '      // keep restricted-label boundary',
    '      /[/*]/.test("/"); }',
    '    break outer',
    '    /[}]/.test("}");',
    '  }',
    '  const tag = strings => strings[0];',
    '  const text = tag',
    '',
    '',
    '    `  literal`;',
    '  const result = [f(), a, b, text];',
  ].join('\n'), [null, 1, 2, '  literal']);
});

test('ASI distinguishes async identifiers and bare yield from following declarations/blocks', () => {
  equivalent(String.raw`
    const async = 1;
    const x = async
    // not an async function expression
    function f() {}
    /[}/*]/.test('/');
    function* g() {
      yield
      // not the yielded function expression
      function h() {}
      /[}/*]/.test('/');
      yield
      { const local = 2; }
      /[}/*]/.test('/');
    }
    const result = [x, ...g()];
  `, [1, null, null]);
});

test('async interpolation with for-await and regexp operands keeps its boundaries', async () => {
  const src = [
    '  const result = (async () => {',
    '    let n = 0;',
    '    for await (const x of [1, 2]) /[}/*]/.test("/") && (n += x);',
    '    return `  ${await Promise.resolve(`${ /[}]/.test("}") }`)}:${n}`;',
    '  })();',
  ].join('\n');
  const before = await vm.runInNewContext(src + '\nresult');
  const after = await vm.runInNewContext(compact(src).code + '\nresult');
  assert.equal(before, '  true:3');
  assert.equal(after, before);
});

test('comments cannot create an async arrow or repair an invalid throw/postfix', () => {
  for (const src of [
    'function f() { throw\n  // comment\n  42; }',
    'const f = async\n  // comment\n  () => 42;',
    'let x = 1; x\n  // comment\n  ++;',
  ]) {
    assert.throws(() => new vm.Script(src));
    assert.throws(() => new vm.Script(compact(src).code));
  }
});

test('empty/comment-only sources and EOF without newline compact safely', () => {
  for (const src of ['', '// lone comment', ' /* block */ ', '/*a*/ //b', '/*a\nb*/']) {
    assert.equal(compact(src).code, '');
  }
  assert.equal(compact('   const result = 42;').code, 'const result = 42;');
});

for (const src of ["const x = 'open", 'const x = `open', 'const x = `${ /}/',
  '/* open', 'const x = /open', 'const x = /escaped\\\n/']) {
  test('unterminated literal/comment fails closed: ' + JSON.stringify(src), () => {
    assert.throws(() => lexer.compactModule(src), /未闭合/);
    assert.throws(() => lexer.maskSource(src), /未闭合/);
  });
}

test('module masking handles regexp punctuation in exports, declarations and nested templates', () => {
  const src = [
    '  // remove',
    'export const pattern = /[,;{}/*]/;',
    'export function match(x) { return /[}]/.test(x); }',
    'export class Example { value = /[}/*]/; method() { return /[//]/.test("/"); } }',
    'export const template = `  ${ /[}]/.test("}") ? `nested ${8 / 2}` : "no" }`;',
    'export const division = {valueOf() { return 8; }} / 2;',
  ].join('\n');
  const mod = lexer.transformModule('fixture.mjs', src);
  const result = compact(mod.code);
  const exports = {};
  vm.runInNewContext('(' + result.code + ')')(exports, () => assert.fail('no imports'));
  assert.deepEqual([...mod.exported], ['pattern', 'match', 'Example', 'template', 'division']);
  assert.ok(exports.pattern.test('/'));
  assert.equal(exports.match('}'), true);
  assert.equal(new exports.Example().method(), true);
  assert.equal(exports.template, '  nested 4');
  assert.equal(exports.division, 4);
});

const template = '<html><title>test</title><style>body{}</style><canvas id="view"></canvas><div id="hud"></div>'
  + '<script src="/src/three/three.min.js"></script><script type="module" src="/client/main.mjs"></script></html>';
const entry = `
  // entry comment to compact
  globalThis.models = fetch('/src/models/er.json').then(r => r.json());
  fetch('/src/models/nailong_boss.glb');
  fetch('/src/models/nailong_boss_lod0.glb');
  fetch('/src/audio/boss_laugh.mp3');
`;
function fixture(extra = '', baseline = false) {
  const files = new Map([
    ['/fixture/dev/client.html', template],
    ['/fixture/src/three/three.min.js', 'var THREE = {};'],
    ['/fixture/client/main.mjs', entry + extra],
    ['/fixture/client/unused.mjs', '  /* unused comment */\n\n\n  const unused = /[}/*]/;\n'],
    ['/fixture/src/models/nailong_boss.glb', Buffer.from('test glb')],
    ['/fixture/src/audio/boss_laugh.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64])],
    ['/fixture/dist/inkline.html', 'previous valid build'],
  ]);
  const writes = [];
  const f = api({
    readFileSync(file) {
      if (!files.has(file)) throw new Error('missing fixture: ' + file);
      return files.get(file);
    },
    mkdirSync(dir) { writes.push(dir); },
    writeFileSync(file, content) { writes.push(file); files.set(file, content); },
  }, `
    listModuleIds = () => ['client/main.mjs', 'client/unused.mjs'];
    loadModels = () => ({ map: { '/src/models/er.json': { text: '原始', pos: [0, 1, 2] } }, list: [] });
    ${baseline ? `compactModule = code => ({ code, beforeBytes: Buffer.byteLength(code), afterBytes: Buffer.byteLength(code),
      commentBytesSaved: 0, whitespaceBytesSaved: 0 });` : ''}
  `);
  return { ...f, files, writes, output: () => files.get('/fixture/dist/inkline.html') };
}

test('build compacts all emitted factories; reported savings equal precompaction output byte delta', async () => {
  const before = fixture('', true), after = fixture();
  const original = before.build(), current = after.build();
  const stats = current.compaction;
  assert.ok(stats.commentBytesSaved > 0 && stats.whitespaceBytesSaved > 0);
  assert.equal(stats.beforeBytes, original.compaction.beforeBytes);
  assert.equal(original.bytes - current.bytes, stats.beforeBytes - stats.afterBytes);
  assert.equal(original.bundleBytes - current.bundleBytes, stats.commentBytesSaved + stats.whitespaceBytesSaved);
  assert.equal(current.bytes, Buffer.byteLength(after.output()));
  assert.ok(!after.output().includes('entry comment'));
  assert.ok(!after.output().includes('unused comment'));
  assert.match(after.output(), /__defs\["client\/unused\.mjs"\]/);
  assert.equal(current.modules, 2);
  assert.equal(current.reachable, 1);
  for (const key of ['fetchHits', 'glbHits', 'audioHits', 'modelBytes', 'threeBytes']) assert.equal(current[key], original[key]);
  for (const name of ['MODEL_DATA', 'MODEL_PATHS']) {
    const re = new RegExp('^var __' + name + ' = (.*);$', 'm');
    assert.equal(re.exec(after.output())?.[0], re.exec(before.output())?.[0]);
    assert.ok(re.test(after.output()), name + ' format is unchanged');
  }
  const ctx = vm.createContext({ atob: value => Buffer.from(value, 'base64').toString('binary') });
  for (const script of after.output().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], ctx);
  assert.equal(JSON.stringify(await ctx.models), JSON.stringify({ text: '原始', pos: [0, 1, 2] }));
  assert.deepEqual(after.writes, ['/fixture/dist', '/fixture/dist/inkline.html']);
});

for (const extra of [
  'const value = 8 / fetch("/external") / 2;',
  'const value = (8) / fetch("/external") / 2;',
  'const value = {valueOf() {return 8;}} / fetch("/external") / 2;',
  'const value = function() {} / fetch("/external") / 2;',
  'const value = async function() {} / fetch("/external") / 2;',
  'const value = class {} / fetch("/external") / 2;',
  'const value = true ? 1 : {} / fetch("/external") / 2;',
  'const value = 8 / new XMLHttpRequest() / 2;',
]) {
  test('division cannot hide live network code: ' + extra, () => {
    const f = fixture(extra);
    assert.throws(() => f.build(), /fetch|XMLHttpRequest/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.output(), 'previous valid build');
  });
}

test('base64 XHR collisions use JSON escapes without changing decoded media bytes', () => {
  const f = fixture(), b64 = 'XHRAXHRB';
  f.files.set('/fixture/src/audio/boss_laugh.mp3', Buffer.from(b64, 'base64'));
  f.build();
  const encoded = /var __AUDIO_B64 = (".*?"), __AUDIO_BUF;/.exec(f.output())[1];
  assert.equal(f.output().includes('XHR'), false);
  assert.ok(encoded.includes('\\u0058HR'));
  assert.equal(JSON.parse(encoded), b64);
  assert.deepEqual(Buffer.from(JSON.parse(encoded), 'base64'), f.files.get('/fixture/src/audio/boss_laugh.mp3'));
});

test('literal-only network spellings are masked, not treated as executable calls', () => {
  const f = fixture(String.raw`
    const re = /fetch\(\)|XMLHttpRequest|[{}/*]/;
    // fetch('/external') is only a comment
  `);
  assert.doesNotThrow(() => f.build());
  assert.ok(f.output().includes(String.raw`/fetch\(\)|XMLHttpRequest|[{}/*]/`));
});
