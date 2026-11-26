import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';

// Read source inputs only; all build output and filesystem mutations stay in memory.
const source = readFileSync(new URL('../client/build.mjs', import.meta.url), 'utf8');
const library = source.slice(0, source.indexOf("\nif (process.argv.includes('--selftest'))"))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^const ROOT = .*;\r?\n/m, '');
const modelsDir = new URL('../src/models/', import.meta.url);
const diskModels = new Map(readdirSync(modelsDir).sort().map(name => [name, readFileSync(new URL(name, modelsDir))]));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHashes = new Map([...diskModels].map(([name, bytes]) => [name, sha256(bytes)]));
const fallbackPath = '/src/models/bs-fallback.json';
const fivePaths = ['er', 'pl', 'fold', 'bo', 'ta'].map(name => '/src/models/' + name + '.json').sort();
const template = '<html><title>test</title><style>body{}</style><canvas id="view"></canvas><div id="hud"></div>'
  + '<script src="/src/three/three.min.js"></script><script type="module" src="/client/main.mjs"></script></html>';
const entry = `
fetch('/src/models/er.json');
fetch('/src/models/nailong_boss.glb');
fetch('/src/audio/boss_laugh.mp3');
`;

function fixture(modules = { 'client/main.mjs': entry }) {
  const files = new Map([
    ['/fixture/dev/client.html', template],
    ['/fixture/src/three/three.min.js', 'var THREE = {};'],
    ['/fixture/src/audio/boss_laugh.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64])],
    ['/fixture/src/models/nailong_boss.glb', Buffer.from('synthetic-glb')],
    ['/fixture/dist/inkline.html', 'previous valid build'],
    ...[...diskModels].filter(([name]) => name.endsWith('.json')).map(([name, bytes]) => ['/fixture/src/models/' + name, bytes]),
    ...Object.entries(modules).map(([id, code]) => ['/fixture/' + id, code]),
  ]);
  const writes = [];
  const ctx = vm.createContext({
    ROOT: '/fixture', ...path.posix, Buffer, gzipSync, vm, console,
    moduleIds: Object.keys(modules).sort(),
    readFileSync(file, encoding) {
      if (!files.has(file)) throw new Error('missing fixture: ' + file);
      const value = files.get(file);
      return encoding ? value.toString(encoding) : value;
    },
    readdirSync(dir) {
      assert.equal(dir, '/fixture/src/models');
      return [...diskModels.keys()].filter(name => name.endsWith('.json'));
    },
    statSync(file) {
      if (!files.has(file)) throw new Error('missing fixture: ' + file);
      return { size: Buffer.byteLength(files.get(file)) };
    },
    mkdirSync(dir) { writes.push(dir); },
    writeFileSync(file, content) { writes.push(file); files.set(file, content); },
  });
  vm.runInContext(library + `
listModuleIds = () => moduleIds;
globalThis.api = { build, inlineModelFetches };
`, ctx);
  return { ...ctx.api, writes, output: () => files.get('/fixture/dist/inkline.html') };
}

function embeddedModels(html) {
  return {
    data: JSON.parse(/var __MODEL_DATA = (.*);/.exec(html)[1]),
    paths: JSON.parse(/var __MODEL_PATHS = (.*);/.exec(html)[1]),
  };
}

function productionModules() {
  const modules = {};
  const walk = dir => {
    for (const item of readdirSync(new URL('../' + dir + '/', import.meta.url), { withFileTypes: true })) {
      const id = dir + '/' + item.name;
      if (item.isDirectory()) walk(id);
      else if (item.name.endsWith('.mjs') && id !== 'client/build.mjs') {
        modules[id] = readFileSync(new URL('../' + id, import.meta.url), 'utf8');
      }
    }
  };
  for (const dir of ['client', 'shared', 'host']) walk(dir);
  return modules;
}

const fallbackModules = {
  'client/main.mjs': "import './bridge.mjs';\n" + entry,
  'client/bridge.mjs': "import './fallback.mjs';",
  'client/fallback.mjs': `globalThis.fallbackResult = fetch('${fallbackPath}')
    .then(async response => ({ ok: response.ok, url: response.url, data: await response.json() }));
`,
};

test('model fetch collection is optional, validates paths and deduplicates both quote styles', () => {
  const f = fixture();
  const paths = new Set(['/src/models/bs.json', fallbackPath]);
  const used = new Set();
  const code = `fetch ( '${fallbackPath}' ); fetch("${fallbackPath}");`;
  const result = f.inlineModelFetches(code, 'client/fallback.mjs', paths, used);
  assert.equal(result.hits, 2);
  assert.deepEqual([...used], [fallbackPath]);
  assert.equal(result.code, `__inlineModel('${fallbackPath}'); __inlineModel("${fallbackPath}");`);
  const legacy = f.inlineModelFetches(code, 'client/fallback.mjs', paths);
  assert.equal(legacy.code, result.code);
  assert.equal(legacy.hits, result.hits);
  assert.throws(() => f.inlineModelFetches("fetch('/src/models/missing.json')", 'client/missing.mjs', paths, used),
    /client\/missing\.mjs:.*missing\.json.*不存在/);
  assert.deepEqual([...used], [fallbackPath], 'missing paths are not collected');
});

test('production entry embeds exactly five referenced JSON models, not the disk fallback', () => {
  const f = fixture(productionModules());
  const info = f.build();
  const embedded = embeddedModels(f.output());
  assert.deepEqual(embedded.paths.slice().sort(), fivePaths);
  assert.deepEqual(Object.keys(embedded.data).sort(), fivePaths);
  assert.deepEqual(Array.from(info.models, model => model.path).sort(), fivePaths);
  assert.equal(info.models.length, 5);
  assert.equal(info.fetchHits, 5);
  let expectedBytes = 0;
  for (const model of info.models) {
    const raw = diskModels.get(model.path.replace('/src/models/', ''));
    assert.equal(model.bytes, raw.length);
    assert.deepEqual(embedded.data[model.path], JSON.parse(raw));
    expectedBytes += raw.length;
  }
  assert.equal(info.modelBytes, expectedBytes);
  assert.equal(info.bytes, Buffer.byteLength(f.output(), 'utf8'));
  assert.doesNotMatch(f.output(), /bs-fallback/);
  assert.ok(info.order.includes('client/render.mjs'));
  assert.deepEqual(f.writes, ['/fixture/dist', '/fixture/dist/inkline.html']);
});

test('a transitively reachable fallback reference embeds and returns the original JSON', async () => {
  const f = fixture(fallbackModules);
  const info = f.build();
  const embedded = embeddedModels(f.output());
  assert.deepEqual(embedded.paths.slice().sort(), [fallbackPath, '/src/models/er.json'].sort());
  assert.deepEqual(Object.keys(embedded.data).sort(), embedded.paths.slice().sort());
  assert.equal(info.models.length, 2);
  assert.equal(info.fetchHits, 2);
  assert.equal(info.modelBytes, diskModels.get('er.json').length + diskModels.get('bs-fallback.json').length);
  assert.ok(info.order.includes('client/fallback.mjs'));
  const ctx = vm.createContext({ atob: str => Buffer.from(str, 'base64').toString('binary') });
  for (const match of f.output().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], ctx);
  }
  const response = await ctx.fallbackResult;
  assert.equal(response.ok, true);
  assert.equal(response.url, fallbackPath);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), JSON.parse(diskModels.get('bs-fallback.json')));
});

test('an unreachable fallback fetch is validated and rewritten but contributes no embedded data', () => {
  const f = fixture({
    'client/main.mjs': entry,
    'client/unused.mjs': `fetch('${fallbackPath}');`,
  });
  const info = f.build();
  const embedded = embeddedModels(f.output());
  assert.deepEqual(embedded.paths, ['/src/models/er.json']);
  assert.deepEqual(Object.keys(embedded.data), ['/src/models/er.json']);
  assert.deepEqual(Array.from(info.models, model => model.path), ['/src/models/er.json']);
  assert.equal(info.modelBytes, diskModels.get('er.json').length);
  assert.equal(info.fetchHits, 2, 'both emitted factories have their literal fetch rewritten');
  assert.equal(info.modules, 2);
  assert.equal(info.reachable, 1);
  assert.match(f.output(), /__defs\["client\/unused\.mjs"\]/);
  assert.ok(f.output().includes(`__inlineModel('${fallbackPath}')`));
  assert.ok(!f.output().includes(JSON.stringify(JSON.parse(diskModels.get('bs-fallback.json')))));
});

for (const reachable of [true, false]) {
  test(`missing model path rejects before output writes (reachable=${reachable})`, () => {
    const f = fixture({
      'client/main.mjs': (reachable ? "import './missing.mjs';\n" : '') + entry,
      'client/missing.mjs': "fetch('/src/models/missing.json');",
    });
    assert.throws(() => f.build(), /client\/missing\.mjs:.*missing\.json.*不存在/);
    assert.equal(f.output(), 'previous valid build');
    assert.deepEqual(f.writes, []);
  });
}

for (const [label, code, error] of [
  ['syntax', `fetch('${fallbackPath}'); const broken = ;`, /Unexpected token/],
  ['network', "fetch('/not-inlined');", /fetch/],
  ['XHR', 'new XMLHttpRequest();', /XMLHttpRequest/],
  ['link', "import './missing.mjs';", /找不到依赖模块/],
]) {
  test(`unreachable modules retain ${label} validation before output writes`, () => {
    const f = fixture({ 'client/main.mjs': entry, 'client/unused.mjs': code });
    assert.throws(() => f.build(), error);
    assert.equal(f.output(), 'previous valid build');
    assert.deepEqual(f.writes, []);
  });
}

test('disk fallback remains exactly 57907 bytes with its original SHA-256; all models stay unchanged', () => {
  fixture(fallbackModules).build();
  const fallback = readFileSync(new URL('bs-fallback.json', modelsDir));
  assert.equal(fallback.length, 57907);
  assert.equal(sha256(fallback), '814d648d2511c966749e8b1a1a172bc3fcdd1aca35775ce247acae2e52acb8ee');
  assert.deepEqual(readdirSync(modelsDir).sort(), [...diskModels.keys()]);
  for (const [name, hash] of originalHashes) {
    assert.equal(sha256(readFileSync(new URL(name, modelsDir))), hash, name + ' was modified');
  }
});
