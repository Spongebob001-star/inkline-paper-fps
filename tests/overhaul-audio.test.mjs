import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CONFIG } from '../shared/config.mjs';

const source = readFileSync(new URL('../client/audio.mjs', import.meta.url), 'utf8');
const script = new vm.Script(source.replace(/^import .*;\r?\n/gm, '')
  .replace('export function createAudio', 'function createAudio'), { filename: 'audio.mjs' });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

// Strict scheduling/graph doubles: source ends use an audio clock, whereas the
// only JS timers exposed to the module are tracked disposal fallbacks.
function harness({ stored = null, reduced = false, storageError = false, unsupported = false,
  webkit = false, legacyMedia = false, resume = 'instant', onMuteChange } = {}) {
  const contexts = [], nodes = [], sources = [], buffers = [], listeners = new Map(), trace = [];
  const timers = new Map(), storage = new Map(), writes = [], calls = {}, faults = {};
  if (stored !== null) storage.set(CONFIG.storage.sound, stored);
  let gesture = false, wallTime = 0, timerId = 0, mediaChange;
  let randomValue = 0.5, randomCalls = 0;
  function call(name) {
    calls[name] = (calls[name] || 0) + 1;
    trace.push({ name, gesture });
    if (faults[name] === calls[name]) throw new Error('hardware: ' + name);
  }
  class Param {
    value = 1; records = [];
    record(type, value, time) {
      assert.ok(Number.isFinite(value) && Number.isFinite(time));
      assert.ok(time >= 0 && (!this.records.length || time >= this.records.at(-1).time), 'monotonic automation');
      if (type === 'exp') assert.ok(value > 0, 'exponential ramps cannot reach zero');
      this.records.push({ type, value, time }); this.value = value;
    }
    setValueAtTime(value, time) { this.record('set', value, time); }
    linearRampToValueAtTime(value, time) { this.record('linear', value, time); }
    exponentialRampToValueAtTime(value, time) { this.record('exp', value, time); }
  }
  class Node {
    connections = []; disconnected = false;
    constructor(kind) { this.kind = kind; nodes.push(this); }
    connect(node) { call('connect'); this.connections.push(node); return node; }
    disconnect() { this.disconnected = true; call('disconnect'); }
  }
  class Source extends Node {
    frequency = new Param(); stopCalls = []; started = false; ended = false; endAt = Infinity;
    constructor(ctx, kind) { super(kind); this.ctx = ctx; sources.push(this); }
    start(at) { call('start'); this.started = true; this.at = at; }
    stop(at = this.ctx.currentTime) { call('stop'); this.stopCalls.push(at); this.endAt = at; }
    finish() { if (!this.ended) { this.ended = true; this.onended?.(); } }
  }
  class AudioContext {
    state = 'suspended'; currentTime = 0; sampleRate = 48000; destination = { kind: 'destination' };
    resumeMode = resume;
    constructor() { call('constructor'); contexts.push(this); }
    resume() {
      call('resume');
      if (this.resumeMode === 'throw') throw new Error('resume failed');
      if (this.resumeMode === 'reject') return Promise.reject(new Error('resume denied'));
      if (this.resumeMode === 'pending') return new Promise((resolve, reject) => { this.resolveResume = resolve; this.rejectResume = reject; });
      if (this.resumeMode === 'instant') this.state = 'running';
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; this.onstatechange?.(); }
    createGain() { call('createGain'); const n = new Node('gain'); n.gain = new Param(); return n; }
    createWaveShaper() { call('createWaveShaper'); return new Node('shaper'); }
    createDynamicsCompressor() {
      call('createDynamicsCompressor'); const n = new Node('compressor');
      for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[key] = new Param();
      n.reduction = 0; return n;
    }
    createBuffer(channels, count, rate) {
      call('createBuffer');
      const data = new Float32Array(count), buffer = { channels, length: count, sampleRate: rate, duration: count / rate, getChannelData: () => data };
      buffers.push(buffer); return buffer;
    }
    createBufferSource() { call('createBufferSource'); return new Source(this, 'noise'); }
    createOscillator() { call('createOscillator'); return new Source(this, 'oscillator'); }
    createBiquadFilter() { call('createBiquadFilter'); const n = new Node('filter'); n.Q = new Param(); n.frequency = new Param(); return n; }
  }
  const media = { matches: reduced };
  if (legacyMedia) media.addListener = fn => { mediaChange = fn; };
  else media.addEventListener = (name, fn) => { assert.equal(name, 'change'); mediaChange = fn; };
  const window = {
    navigator: { userActivation: { isActive: true } }, matchMedia: () => media,
    localStorage: {
      getItem(key) { if (storageError) throw new Error('storage denied'); return storage.get(key); },
      setItem(key, value) { if (storageError) throw new Error('storage denied'); storage.set(key, value); writes.push([key, value]); },
    },
    addEventListener(name, fn, capture) { listeners.set(name, { fn, capture }); },
  };
  if (!unsupported) window[webkit ? 'webkitAudioContext' : 'AudioContext'] = AudioContext;
  const math = Object.create(Math);
  math.random = () => { randomCalls++; return randomValue; };
  const sandbox = vm.createContext({ CONFIG, window, Math: math,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: wallTime + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  script.runInContext(sandbox);
  const audio = sandbox.createAudio({ onMuteChange });
  function advance(seconds) {
    for (const ctx of contexts) {
      if (ctx.state !== 'running') continue;
      const end = ctx.currentTime + seconds;
      for (;;) {
        const next = sources.filter(s => s.ctx === ctx && !s.ended && s.started && s.endAt <= end + 1e-10)
          .sort((a, b) => a.endAt - b.endAt)[0];
        if (!next) break;
        ctx.currentTime = Math.max(ctx.currentTime, next.endAt); next.finish();
      }
      ctx.currentTime = end;
    }
    wallTime += seconds * 1000;
    for (const [id, timer] of [...timers]) if (timer.at <= wallTime) { timers.delete(id); timer.fn(); }
  }
  return { audio, window, media, contexts, nodes, sources, buffers, listeners, trace, timers, storage, writes, calls, faults, advance,
    get randomCalls() { return randomCalls; },
    random(value) { randomValue = value; },
    failNext(name, offset = 1) { faults[name] = (calls[name] || 0) + offset; },
    unlock(name = 'pointerdown', trusted = true, afterCapture) {
      gesture = true;
      try { listeners.get(name)?.fn({ isTrusted: trusted, type: name }); afterCapture?.(); }
      finally { gesture = false; }
    },
    reduce(value) { media.matches = value; mediaChange({ matches: value }); },
  };
}

const frequency = s => s.kind === 'noise' ? s.connections[0].frequency : s.frequency;
const envelope = s => s.kind === 'noise' ? s.connections[0].connections[0] : s.connections[0];
function layer(s, from, to, duration, at = 0, pitch = 1) {
  assert.equal(s.started, true);
  close(s.at, at);
  const f = frequency(s).records;
  assert.equal(f.length, 2); assert.equal(f[0].type, 'set'); assert.equal(f[1].type, 'exp');
  close(f[0].value, from * pitch); close(f[1].value, to * pitch);
  close(f[0].time, at); close(f[1].time, at + duration);
  close(s.stopCalls[0], at + duration + 0.002);
  const e = envelope(s).gain.records;
  assert.deepEqual(e.map(r => r.type), ['set', 'linear', 'exp', 'linear']);
  assert.equal(e[0].value, 0); assert.ok(e[1].value > 0); assert.equal(e[2].value, 0.0001); assert.equal(e[3].value, 0);
  close(e[0].time, at); close(e[3].time, at + duration);
  for (let i = 1; i < e.length; i++) assert.ok(e[i].time > e[i - 1].time, 'strictly ordered envelope');
}
function clean(h) {
  assert.equal(h.audio.debug().active, 0); assert.equal(h.audio.debug().sources, 0);
  assert.equal(h.audio.debug().nodes, 3); assert.equal(h.timers.size, 0);
  assert.ok(h.sources.every(s => s.disconnected && s.onended === null));
  assert.ok(h.nodes.slice(3).every(n => n.disconnected));
  assert.ok(h.nodes.slice(0, 3).every(n => !n.disconnected), 'shared graph survives voice cleanup');
}

for (const [stored, muted] of [[null, false], ['on', false], ['off', true], ['', false], ['other', false]]) {
  test(`audio preferences: stored ${JSON.stringify(stored)} => muted ${muted}`, () => {
    const h = harness({ stored });
    assert.equal(h.audio.isMuted(), muted); assert.equal(h.audio.debug().state, 'locked');
    assert.equal(h.contexts.length, 0); assert.deepEqual(h.writes, []);
    assert.equal(h.audio.shot(), false); assert.equal(h.contexts.length, 0);
  });
}

test('blocked storage defaults open; mute persistence and callback failures never break audio', async () => {
  for (const callback of [() => { throw new Error('callback'); }, () => Promise.reject(new Error('callback'))]) {
    const h = harness({ storageError: true, onMuteChange: callback });
    assert.equal(h.audio.isMuted(), false); h.unlock();
    assert.equal(h.audio.shot(), true); assert.equal(h.audio.setMuted(true), true);
    await flush(); h.advance(0.05); clean(h);
    assert.equal(h.audio.toggleMute(), false); assert.equal(h.audio.shot(), true);
    h.advance(1); clean(h);
  }
  const changes = [], h = harness({ onMuteChange: muted => changes.push(muted) });
  h.audio.setMuted(false); h.audio.setMuted(true); h.audio.setMuted(true); h.audio.toggleMute();
  assert.deepEqual(changes, [true, false]); assert.equal(h.storage.get(CONFIG.storage.sound), 'on');
});

for (const name of ['pointerdown', 'mousedown', 'keydown', 'click']) {
  test(`trusted ${name} capture builds graph and resumes synchronously, before playback handler`, async () => {
    const h = harness();
    assert.equal(h.listeners.get(name).capture, true);
    h.unlock(name, false); assert.equal(h.contexts.length, 0);
    h.window.navigator.userActivation.isActive = false;
    h.unlock(name); assert.equal(h.contexts.length, 0);
    h.window.navigator.userActivation.isActive = true;
    h.unlock(name, true, () => assert.equal(h.audio.shot(), true));
    assert.equal(h.audio.debug().starts, 1);
    assert.ok(h.trace.filter(t => ['constructor', 'createGain', 'createWaveShaper', 'createDynamicsCompressor', 'createBuffer', 'resume'].includes(t.name))
      .every(t => t.gesture));
    await flush(); h.unlock(name);
    assert.equal(h.contexts.length, 1); assert.equal(h.buffers.length, 1); assert.equal(h.calls.resume, 1);
    h.advance(1); clean(h);
  });
}

test('muted gestures can initialize for a later same-event unmute; settings and synthetic calls cannot unlock', () => {
  const h = harness({ stored: 'off', webkit: true });
  h.audio.setVolume(0.5); h.audio.setMuted(false); h.audio.kill();
  assert.equal(h.contexts.length, 0);
  h.audio.setMuted(true);
  delete h.window.navigator.userActivation;
  h.unlock('mousedown', true, () => {
    assert.equal(h.audio.shot(), false);
    h.audio.setMuted(false); assert.equal(h.audio.shot(), true);
  });
  assert.equal(h.audio.debug().starts, 1); h.advance(1); clean(h);
});

test('shared gate -> softclip -> compressor -> volume bus graph, bounded reusable odd curve and diagnostics', () => {
  const h = harness(); h.unlock(); h.audio.shot();
  const [master, punch, compressor, gate] = h.nodes;
  assert.deepEqual(gate.connections, [punch]); assert.deepEqual(punch.connections, [compressor]);
  assert.deepEqual(compressor.connections, [master]); assert.deepEqual(master.connections, [h.contexts[0].destination]);
  close(master.gain.value, 0.62); assert.equal(punch.oversample, '2x');
  const c = punch.curve;
  assert.equal(c.length, 2049); assert.equal(c[0], -1); assert.equal(c.at(-1), 1); assert.equal(c[1024], 0);
  for (let i = 0; i < c.length; i++) {
    assert.ok(Number.isFinite(c[i]) && Math.abs(c[i]) <= 1);
    close(c[i], -c[c.length - 1 - i]);
    if (i) assert.ok(c[i] >= c[i - 1]);
  }
  assert.ok(c[1025] - c[1024] > c[2048] - c[2047], 'gentle saturation reduces slope near peaks');
  const debug = h.audio.debug();
  assert.deepEqual(plain(debug.graph), ['voice.gate', 'punch', 'compressor', 'masterGain', 'destination']);
  assert.deepEqual(plain(debug.curve), { length: 2049, peak: 1, drive: 1.5, oversample: '2x' });
  assert.deepEqual(plain(debug.compressor), { threshold: -14, knee: 18, ratio: 6, attack: 0.003, release: 0.16, reduction: 0 });
  assert.equal(debug.peak, 0.62); assert.equal(debug.nodes, h.nodes.length); assert.equal(debug.voices[0].sources, 4);
  assert.ok(Object.isFrozen(debug) && Object.isFrozen(debug.voices) && Object.isFrozen(debug.voices[0]));
  compressor.reduction = -4.5; assert.equal(h.audio.debug().compressor.reduction, -4.5);
  h.advance(1); h.audio.shot(1); h.audio.shot(2);
  assert.equal(punch.curve, c); assert.equal(h.calls.createWaveShaper, 1); assert.equal(h.calls.createDynamicsCompressor, 1);
  assert.equal(h.buffers.length, 1); assert.ok(h.sources.filter(s => s.kind === 'noise').every(s => s.buffer === h.buffers[0]));
  assert.equal(h.buffers[0].duration, 0.5); assert.equal(h.timers.size, 0);
  h.advance(1); clean(h);
});

test('live volume scales only the master bus, validates inputs and remains separate from mute', () => {
  const h = harness(); assert.equal(h.audio.debug().volume, 0.85);
  assert.equal(h.audio.setVolume(0), 0); assert.equal(h.contexts.length, 0);
  h.unlock(); h.audio.shot(1); const master = h.nodes[0];
  const envelopes = h.sources.map(s => envelope(s).gain.records.slice());
  for (const [value, expected] of [[0.85, 0.85], [0, 0], [1, 1], [-2, 0], [2, 1]]) {
    assert.equal(h.audio.setVolume(value), expected); close(master.gain.value, 0.62 * expected / 0.85);
    close(h.audio.debug().masterGain, master.gain.value); close(h.audio.debug().masterPeak, master.gain.value);
    assert.equal(h.audio.isMuted(), false); assert.deepEqual(h.sources.map(s => envelope(s).gain.records), envelopes);
  }
  for (const value of [NaN, Infinity, -Infinity, undefined, null, '0.5', true, {}, [], Symbol('v'), 1n]) {
    assert.equal(h.audio.setVolume(value), 1);
  }
  assert.deepEqual(h.writes, []); h.audio.setMuted(true); h.audio.setVolume(0.85);
  assert.equal(h.audio.isMuted(), true); assert.equal(h.storage.get(CONFIG.storage.sound), 'off');
  h.advance(0.05); clean(h);
});

test('rifle has four layers and a valid strictly monotonic 4ms high-Q click', () => {
  const h = harness(); h.unlock(); assert.equal(h.audio.shot(0), true);
  assert.equal(h.sources.length, 4);
  layer(h.sources[0], 3400, 3400, 0.004); assert.equal(h.sources[0].connections[0].Q.value, 9);
  layer(h.sources[1], 175, 52, 0.14); assert.equal(h.sources[1].type, 'sine');
  layer(h.sources[2], 1800, 420, 0.085);
  layer(h.sources[3], 760, 240, 0.12, 0.025);
  const click = envelope(h.sources[0]).gain.records;
  close(click[1].time, 0.0008); close(click[2].time, 0.0032);
  assert.equal(h.timers.size, 0); h.advance(0.15); clean(h);
});

for (const [weapon, expected] of [
  [1, [[115, 30, 0.24], [1400, 180, 0.16], [3200, 600, 0.095], [1900, 1000, 0.022, 0.210], [2600, 1200, 0.016, 0.290]]],
  [2, [[5800, 750, 0.105], [2200, 280, 0.09], [150, 38, 0.26], [3800, 2000, 0.012, 0.310], [2300, 1400, 0.014, 0.390]]],
]) {
  test(`${weapon === 1 ? 'shotgun' : 'sniper'} schedules all five layers and both mechanical clicks immediately`, () => {
    const h = harness(); h.unlock(); h.audio.shot(weapon);
    assert.equal(h.sources.length, 5);
    expected.forEach((values, i) => layer(h.sources[i], ...values));
    if (weapon === 2) assert.equal(h.sources[1].type, 'sawtooth');
    assert.equal(h.timers.size, 0); h.advance(0.28); assert.equal(h.audio.debug().active, 1);
    assert.equal(h.sources.length, 5); h.advance(0.2); clean(h);
  });
}

for (const weapon of [0, 1, 2]) {
  test(`weapon ${weapon} gets one coherent +/-6% audio-only pitch draw per shot`, () => {
    const h = harness(); h.unlock();
    const count = h.randomCalls;
    const starts = [];
    for (const value of [0, 0.5, 1]) {
      h.random(value); const before = h.sources.length; h.audio.shot(weapon);
      starts.push(h.sources.slice(before).map(s => frequency(s).records.map(r => r.value)));
      close(h.audio.debug().voices.at(-1).pitch, 0.94 + value * 0.12);
    }
    assert.equal(h.randomCalls - count, 3);
    starts[1].forEach((frequencies, i) => frequencies.forEach((hz, j) => {
      close(starts[0][i][j], hz * 0.94); close(starts[2][i][j], hz * 1.06);
    }));
    h.audio.setMuted(true); const before = h.randomCalls; h.audio.shot(weapon);
    assert.equal(h.randomCalls, before); h.advance(0.05); clean(h);
  });
}

test('normal, armor and critical confirms retain distinct low/bright frequency signatures', () => {
  const h = harness(); h.unlock();
  h.audio.hit(false); layer(h.sources[0], 190, 95, 0.09); layer(h.sources[1], 1450, 1450, 0.04, 0.006);
  h.audio.hit(true); layer(h.sources[2], 620, 380, 0.085); layer(h.sources[3], 1800, 1800, 0.006);
  h.audio.crit(); layer(h.sources[4], 1760, 1760, 0.11); layer(h.sources[5], 2637, 2637, 0.15, 0.028);
  h.advance(1); clean(h);
});

test('kill ink pop, rising major third/fifth, local 3.5s combo and explicit combo override/cap', () => {
  const h = harness(); h.unlock();
  h.audio.kill(); assert.equal(h.audio.debug().combo, 1);
  layer(h.sources[0], 850, 180, 0.055); layer(h.sources[1], 165, 70, 0.075);
  layer(h.sources[2], 660, 660, 0.1, 0.025);
  const third = 660 * 2 ** (4 / 12), fifth = 660 * 2 ** (7 / 12);
  layer(h.sources[3], third, third, 0.14, 0.075); layer(h.sources[4], fifth, fifth, 0.18, 0.125);
  h.advance(3.5); h.audio.kill(); assert.equal(h.audio.debug().combo, 2);
  close(h.audio.debug().voices[0].pitch, 2 ** (1 / 12));
  h.advance(3.501); h.audio.kill(); assert.equal(h.audio.debug().combo, 1);
  h.advance(1); h.audio.kill(5); assert.equal(h.audio.debug().combo, 5);
  close(h.audio.debug().voices[0].pitch, 2 ** (4 / 12));
  h.advance(1); h.audio.kill(99); close(h.audio.debug().voices[0].pitch, 2 ** (6 / 12));
  h.audio.stop(); assert.equal(h.audio.debug().combo, 0); h.advance(0.05); clean(h);
  h.audio.kill(); assert.equal(h.audio.debug().combo, 1);
  h.audio.reset(); assert.equal(h.audio.debug().combo, 0); h.advance(0.05); clean(h);
});

test('skipped kills do not accumulate latent combo; invalid optional combos safely use the window', () => {
  const h = harness(); h.audio.kill(10); assert.equal(h.audio.debug().combo, 0); h.unlock();
  h.audio.kill(); assert.equal(h.audio.debug().combo, 1);
  for (const value of [NaN, Infinity, -1, 0, '9', null, Symbol('combo')]) {
    h.advance(4); h.audio.kill(value); assert.equal(h.audio.debug().combo, 1);
  }
  h.audio.setMuted(true); h.audio.kill(50); assert.equal(h.audio.debug().combo, 0); h.advance(0.05); clean(h);
});

test('reload(weaponIdx) distinguishes rifle pouch, shotgun shells and sniper latch, with a rifle default', () => {
  const signatures = [];
  for (const weapon of [undefined, 0, 1, 2]) {
    const h = harness(); h.unlock(); assert.equal(h.audio.reload(weapon), true);
    signatures.push(h.sources.map(s => [s.kind, s.type, frequency(s).records[0].value, s.at]));
    const times = weapon === 1 ? [0, 0.12, 0.24, 0.36] : weapon === 2 ? [0, 0.075, 0.27] : [0, 0.105, 0.19];
    assert.deepEqual(h.sources.map(s => s.at), times);
    assert.equal(h.timers.size, 0); h.advance(0.5); clean(h);
  }
  assert.deepEqual(signatures[0], signatures[1]);
  assert.notDeepEqual(signatures[1], signatures[2]); assert.notDeepEqual(signatures[2], signatures[3]);
});

for (const [method, count] of [['armorStrip', 3], ['bossStun', 4], ['wallDraw', 3], ['erase', 3], ['playerHit', 3],
  ['fold', 2], ['pickup', 2], ['perkPick', 3], ['weaponSwitch', 2]]) {
  test(`${method} routes every layer through the shared punch graph and disposes fully`, () => {
    const h = harness(); h.unlock(); assert.equal(h.audio[method](), true);
    assert.equal(h.sources.length, count);
    for (const s of h.sources) {
      const env = envelope(s), gate = env.connections[0];
      assert.equal(gate.connections[0], h.nodes[1]);
      assert.equal(env.gain.records.at(-1).value, 0);
    }
    assert.equal(h.timers.size, 0); h.advance(1); clean(h);
  });
}

test('eighteen complete voices cap all source layers, rejects overflow without RNG/allocation, and recovers', () => {
  const h = harness(); h.unlock();
  for (let i = 0; i < 18; i++) assert.equal(h.audio.shot(2), true);
  const before = h.nodes.length, random = h.randomCalls;
  for (let i = 0; i < 10; i++) assert.equal(h.audio.shot(2), false);
  assert.equal(h.audio.debug().active, 18); assert.equal(h.audio.debug().maxVoices, 18);
  assert.equal(h.audio.debug().sources, 90); assert.equal(h.audio.debug().skipped, 10);
  assert.equal(h.nodes.length, before); assert.equal(h.randomCalls, random);
  h.audio.stop(); assert.equal(h.audio.debug().stopping, 18);
  assert.equal(h.audio.shot(), false, 'fading voices still count toward cap');
  h.advance(0.05); clean(h); assert.equal(h.audio.shot(), true); h.advance(1); clean(h);
});

for (const reason of ['stop', 'reset', 'mute', 'reduce', 'suspend', 'closed']) {
  test(`${reason} cancels future pump/bolt layers; no playback or combo replay after resume`, async () => {
    const h = harness(); h.unlock(); await flush(); h.audio.shot(1); h.audio.shot(2); h.audio.kill(5);
    h.advance(0.05);
    if (reason === 'mute') h.audio.setMuted(true);
    else if (reason === 'reduce') h.reduce(true);
    else if (reason === 'suspend') h.contexts[0].suspend();
    else if (reason === 'closed') { h.contexts[0].state = 'closed'; h.contexts[0].onstatechange(); }
    else h.audio[reason]();
    assert.equal(h.audio.debug().combo, 0);
    assert.ok(h.sources.filter(s => s.at >= 0.21).every(s => s.stopCalls.at(-1) < s.at), 'future sources stopped before their starts');
    if (!['suspend', 'closed'].includes(reason)) {
      assert.equal(h.audio.debug().stopping, 3); const timers = h.timers.size;
      h.audio.stop(); assert.equal(h.timers.size, timers, 'stop is idempotent while fading');
    }
    h.advance(0.05); clean(h);
    if (reason === 'reduce') h.reduce(false);
    h.audio.setMuted(false); h.unlock(); await flush(); h.advance(1);
    assert.equal(h.audio.debug().starts, 3); assert.equal(h.sources.length, 15);
    if (reason === 'closed') assert.equal(h.audio.shot(), false);
    else { assert.equal(h.audio.kill(), true); assert.equal(h.audio.debug().combo, 1); h.advance(1); clean(h); }
  });
}

test('cleanup fallback disconnects a voice even when source onended never fires', () => {
  const h = harness(); h.unlock(); h.audio.shot(2);
  for (const s of h.sources) s.finish = () => { s.ended = true; };
  h.audio.stop(); h.advance(0.039); assert.equal(h.audio.debug().active, 1);
  h.advance(0.002); clean(h);
});

test('pending resume does not replay skipped effects after pause, and resume requests are deduplicated', async () => {
  const h = harness({ resume: 'pending' });
  h.audio.shot(); h.unlock(); const ctx = h.contexts[0];
  assert.equal(h.audio.debug().resuming, true); assert.equal(h.audio.shot(), false);
  h.unlock('mousedown'); h.unlock('keydown'); h.unlock('click'); assert.equal(h.calls.resume, 1);
  h.audio.stop(); ctx.state = 'running'; ctx.resolveResume(); await flush();
  assert.equal(h.audio.debug().resuming, false); assert.equal(h.audio.debug().starts, 0);
  h.advance(1); assert.equal(h.sources.length, 0); assert.equal(h.audio.shot(), true);
  ctx.suspend(); clean(h); ctx.resumeMode = 'instant'; h.unlock(); await flush();
  h.advance(1); assert.equal(h.audio.debug().starts, 1); assert.equal(h.audio.shot(), true); h.advance(1); clean(h);
});

for (const mode of ['reject', 'throw', 'stagnant']) {
  test(`resume ${mode} stays silent, catches errors and allows a fresh trusted retry`, async () => {
    const h = harness({ resume: mode }); h.unlock(); h.audio.shot(); await flush();
    assert.equal(h.audio.debug().resuming, false); assert.equal(h.audio.debug().active, 0);
    assert.equal(h.sources.length, 0);
    h.contexts[0].resumeMode = 'instant'; h.unlock(); await flush();
    assert.equal(h.audio.debug().starts, 0); assert.equal(h.audio.shot(), true); h.advance(1); clean(h);
  });
}

for (const legacyMedia of [false, true]) {
  test(`reduced motion forces mute and explicit opt-in after removal (legacy=${legacyMedia})`, async () => {
    const changes = [], h = harness({ reduced: true, stored: 'on', legacyMedia, onMuteChange: value => changes.push(value) });
    h.unlock(); assert.equal(h.contexts.length, 0); assert.equal(h.audio.isMuted(), true);
    assert.equal(h.audio.setMuted(false), true); h.audio.setVolume(1);
    assert.equal(h.audio.debug().volume, 1); assert.equal(h.storage.get(CONFIG.storage.sound), 'off');
    h.reduce(false); assert.equal(h.audio.isMuted(), true); assert.equal(h.audio.setMuted(false), false);
    h.unlock(); await flush(); h.audio.shot(2); h.reduce(true); h.advance(0.05); clean(h);
    assert.equal(h.audio.shot(), false); assert.deepEqual(changes, [false, true]);
    assert.equal(h.audio.debug().reducedMotion, true);
  });
}

for (const method of ['constructor', 'createGain', 'createWaveShaper', 'createDynamicsCompressor', 'connect', 'createBuffer']) {
  test(`unlock ${method} failure is contained and partial graph allocation is cleaned or reused`, async () => {
    const h = harness(); h.failNext(method); h.unlock(); await flush();
    assert.equal(h.audio.debug().starts, 0); assert.equal(h.audio.debug().active, 0);
    if (!['constructor', 'createBuffer'].includes(method)) assert.ok(h.nodes.every(n => n.disconnected));
    h.unlock(); await flush(); assert.equal(h.audio.shot(), true); h.advance(1);
    assert.equal(h.audio.debug().nodes, 3); assert.equal(h.audio.debug().active, 0);
    assert.equal(h.nodes.filter(n => !n.disconnected).length, 3);
    assert.ok(h.sources.every(s => s.disconnected && s.onended === null));
  });
}

for (const [method, offset] of [['createGain', 3], ['createOscillator', 1], ['createBufferSource', 2], ['createBiquadFilter', 2], ['connect', 5], ['start', 3], ['stop', 2]]) {
  test(`partial voice ${method} failure stops and disconnects all allocated layers`, () => {
    const h = harness(); h.unlock(); h.failNext(method, offset);
    assert.equal(h.audio.shot(), false); assert.equal(h.audio.debug().starts, 0); clean(h);
    assert.equal(h.audio.shot(), true); h.advance(1); clean(h);
  });
}

test('source stop/disconnect errors during cleanup are isolated to the failed node', () => {
  const h = harness(); h.unlock(); h.audio.shot(2);
  h.failNext('stop'); h.failNext('disconnect');
  h.audio.stop(); clean(h); h.advance(1); assert.equal(h.audio.debug().starts, 1);
});

test('unsupported audio remains a no-op without blocking settings or mute', () => {
  const h = harness({ unsupported: true }); h.unlock();
  assert.equal(h.audio.debug().state, 'unsupported'); assert.equal(h.audio.isMuted(), false);
  assert.equal(h.audio.setVolume(0.4), 0.4); assert.equal(h.audio.kill(), false); assert.equal(h.audio.reload(2), false);
  assert.equal(h.audio.setMuted(true), true); assert.equal(h.contexts.length, 0); assert.equal(h.audio.debug().nodes, 0);
});

test('overhaul4: dash and stamp voices stay bounded and recycle every node', () => {
  const h = harness(); h.unlock();
  for (const [method, kind] of [['dash', 'dash'], ['stamp', 'stamp']]) {
    assert.equal(h.audio[method](), true);
    const voice = h.audio.debug().voices.find(v => v.kind === kind);
    assert.ok(voice && voice.sources >= 2);
    h.advance(1); clean(h);
  }
  const h2 = harness();
  assert.equal(h2.audio.dash(), false, 'locked context skips silently');
  assert.equal(h2.audio.stamp(), false);
  assert.equal(h2.audio.debug().skipped, 2);
});

test('audio module obeys the lightweight build boundary and never consumes simulation randomness', () => {
  assert.deepEqual([...source.matchAll(/^import .*from ['"]([^'"]+)['"];$/gm)].map(m => m[1]), ['../shared/config.mjs']);
  assert.doesNotMatch(source, /export\s*\*|export\s+(?:const|let|var)|\b__\w+|\bsim\b|\brand\s*\(/);
  assert.equal((source.match(/setTimeout\(/g) || []).length, 1, 'only cleanup uses a JS timeout');
});
