import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';

// In-memory fixtures only. Execute the actual build functions with a fake fs;
// never read pending production assets or write the real dist/inkline.html.
const source = readFileSync(new URL('../client/build.mjs', import.meta.url), 'utf8');
const library = source.slice(0, source.indexOf("\nif (process.argv.includes('--selftest'))"))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^const ROOT = .*;\r?\n/m, '');
const template = '<html><title>test</title><style>body{}</style><canvas id="view"></canvas><div id="hud"></div>'
  + '<script src="/src/three/three.min.js"></script><script type="module" src="/client/main.mjs"></script></html>';
const entry = `
fetch('/src/models/er.json');
fetch('/src/models/nailong_boss.glb');
fetch('/src/models/nailong_boss_lod0.glb');
globalThis.audioResult = Promise.all([
  fetch('/src/audio/boss_laugh.mp3').then(r => r.arrayBuffer()),
  fetch('/src/audio/boss_laugh.mp3').then(r => r.arrayBuffer())
]);
`;
const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 255, 1, 128]);
function fixture(options = {}) {
  const files = new Map([
    ['/fixture/dev/client.html', template + (options.padding || '')],
    ['/fixture/src/three/three.min.js', options.three || 'var THREE = {};'],
    ['/fixture/client/main.mjs', entry + (options.extra || '')],
    ['/fixture/src/audio/boss_laugh.mp3', audio],
    ['/fixture/src/models/nailong_boss.glb', Buffer.from('synthetic-glb')],
    ['/fixture/dist/inkline.html', 'previous valid build'],
  ]);
  const writes = [];
  const ctx = vm.createContext({
    ROOT: '/fixture', ...path.posix, Buffer, gzipSync, vm, console,
    readFileSync(file) {
      if (!files.has(file)) throw new Error('missing fixture: ' + file);
      return files.get(file);
    },
    writeFileSync(file, content) { writes.push(file); files.set(file, content); },
    mkdirSync(dir) { writes.push(dir); },
  });
  vm.runInContext(library + `
listModuleIds = () => ['client/main.mjs'];
loadModels = () => ({ map: { '/src/models/er.json': {} }, list: [] });
globalThis.api = { build, transformModule, inlineAudioFetches, inlineGLBFetches, inlineModelFetches, maskSource };
`, ctx);
  return { ...ctx.api, files, writes, output: () => files.get('/fixture/dist/inkline.html') };
}

test('raw MP3 bytes inline with no gzip dependency; cached ArrayBuffer and accurate byte counts', async () => {
  const f = fixture();
  const info = f.build();
  assert.equal(info.audioHits, 2);
  assert.equal(info.audio.rawBytes, audio.length);
  assert.equal(info.audio.b64Bytes, audio.toString('base64').length);
  assert.equal(info.bytes, Buffer.byteLength(f.output(), 'utf8'));
  assert.equal(info.glbHits, 2);
  assert.equal(info.fetchHits, 1);
  assert.ok(!f.output().includes('https://'));
  const scripts = [...f.output().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const ctx = vm.createContext({ atob: str => Buffer.from(str, 'base64').toString('binary') });
  for (const code of scripts) {
    assert.doesNotMatch(f.maskSource(code), /\bfetch\s*\(|XMLHttpRequest/);
    vm.runInContext(code, ctx);
  }
  const [a, b] = await ctx.audioResult;
  assert.equal(a, b, 'inline response cache preserves the same bytes');
  assert.deepEqual(Buffer.from(a), audio, 'raw MP3 bytes survive base64 exactly');
});

test('audio rewrite handles both quote styles and reserves all injected names', () => {
  const f = fixture();
  for (const q of ["'", '"']) {
    const got = f.inlineAudioFetches(`fetch ( ${q}/src/audio/boss_laugh.mp3${q} )`);
    assert.equal(got.hits, 1); assert.equal(got.code, '__inlineAudio()');
  }
  for (const name of ['__inlineAudio', '__AUDIO_B64', '__AUDIO_BUF']) {
    assert.throws(() => f.transformModule('x.mjs', `const ${name} = 1;`), /保留|标识符/);
  }
});

test('actual renderer transforms, rewrites all media fetches and compiles', () => {
  const f = fixture();
  const render = readFileSync(new URL('../client/render.mjs', import.meta.url), 'utf8');
  let code = f.transformModule('client/render.mjs', render).code;
  const models = f.inlineModelFetches(code, 'client/render.mjs', new Set(['er', 'pl', 'fold', 'bo', 'ta'].map(name => '/src/models/' + name + '.json')));
  assert.equal(models.hits, 5);
  code = models.code;
  code = f.inlineGLBFetches(code, 'client/render.mjs').code;
  const result = f.inlineAudioFetches(code);
  assert.equal(result.hits, 1);
  assert.doesNotMatch(f.maskSource(result.code), /\bfetch\s*\(|XMLHttpRequest/);
  assert.doesNotThrow(() => new vm.Script('(' + result.code + ')'));
});

test('strict <2097152 UTF-8 budget: exact limit and oversized output leave valid dist untouched', () => {
  const base = fixture().build().bytes;
  for (const extra of [0, 1]) {
    const f = fixture({ padding: 'x'.repeat(2097152 - base + extra) });
    assert.throws(() => f.build(), /必须小于 2MB/);
    assert.equal(f.output(), 'previous valid build');
    assert.deepEqual(f.writes, []);
  }
  const fits = fixture({ padding: 'x'.repeat(2097152 - base - 1) });
  assert.equal(fits.build().bytes, 2097151);
  const unicode = fixture({ padding: '汉'.repeat(Math.ceil((2097152 - base) / 3)) });
  assert.throws(() => unicode.build(), /必须小于 2MB/);
  assert.deepEqual(unicode.writes, []);
});

for (const options of [
  { extra: 'const broken = ;' },
  { three: 'var broken = ;' },
  { extra: "fetch('/not-inlined');" },
  { extra: 'new XMLHttpRequest();' },
  { extra: "const external = 'https://example.invalid/';" },
  { three: 'new XMLHttpRequest();' },
]) test(`invalid syntax/network never overwrites dist: ${JSON.stringify(options)}`, () => {
  const f = fixture(options);
  assert.throws(() => f.build());
  assert.equal(f.output(), 'previous valid build');
  assert.deepEqual(f.writes, []);
});

test('vendored Three network fallbacks are sealed only in offline output', async () => {
  const three = readFileSync(new URL('../src/three/three.min.js', import.meta.url), 'utf8');
  const f = fixture({ three });
  const info = f.build();
  assert.equal(info.threeBlocked, 2);
  assert.ok(!f.output().includes('https://'));
  const code = [...f.output().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest/);
  const ctx = vm.createContext({ console: { warn() {} }, Request, Headers });
  vm.runInContext(code, ctx);
  await new Promise(resolve => {
    new ctx.THREE.FileLoader().load('https://example.invalid/missing', () => assert.fail('must not load'), undefined, error => {
      assert.match(error.message, /External asset loads disabled/);
      resolve();
    });
  });
});

test('missing required audio input does not overwrite valid dist', () => {
  const f = fixture();
  f.files.delete('/fixture/src/audio/boss_laugh.mp3');
  assert.throws(() => f.build(), /missing fixture/);
  assert.equal(f.output(), 'previous valid build');
  assert.deepEqual(f.writes, []);
});
