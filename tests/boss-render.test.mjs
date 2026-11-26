import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import * as world from '../shared/world.mjs';

// Execute the real renderer and real Three animation mixer; stub only GPU, DOM,
// GLB input and WebAudio. No browser, real media decode or asset validation here.
const threeScript = new vm.Script(readFileSync(new URL('../src/three/three.min.js', import.meta.url), 'utf8'));
const renderScript = new vm.Script(readFileSync(new URL('../client/render.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function createRenderer', 'function createRenderer'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${message}: expected ${expected}, got ${actual}`);

async function harness(options = {}) {
  let nowMs = 10000, nextTimer = 0, maxPlaying = 0;
  const events = new Map(), requests = [], contexts = [], sources = [], gains = [], parses = [];
  const timers = new Map(), timeoutCalls = [], clearedTimeouts = [];
  const storage = new Map(options.muted ? [['inkline-sound', 'off']] : []);
  const decode = deferred(), resume = deferred(), download = deferred();
  let decodeCalls = 0, resumeCalls = 0;
  const roundMs = value => Math.round(value * 1e6) / 1e6;
  function schedule(fn, delay, kind) {
    const id = ++nextTimer;
    timers.set(id, { id, at: roundMs(nowMs + Math.max(0, delay)), fn, kind });
    return id;
  }
  function moveClock(at) {
    for (const context of contexts) {
      if (context.state === 'running') context.currentTime = roundMs(context.currentTime * 1000 + at - nowMs) / 1000;
    }
    nowMs = at;
  }
  function elapse(seconds) {
    const end = roundMs(nowMs + seconds * 1000);
    assert.ok(end >= nowMs, 'fake time must not go backwards');
    for (;;) {
      const next = [...timers.values()].filter(t => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      moveClock(next.at);
      timers.delete(next.id);
      next.fn(); // callbacks can schedule more callbacks within this same advance
    }
    moveClock(end);
  }
  class AudioParam {
    constructor(context) { this.context = context; this.records = []; this.timeline = []; this.initial = 1; }
    valueAt(time) {
      let value = this.initial, at = 0, target = null;
      const evolve = t => target ? target.value + (value - target.value) * Math.exp(-(t - at) / target.constant) : value;
      for (const event of this.timeline) {
        if (time < event.time) {
          if (event.type === 'linear' && !target) return value + (event.value - value) * (time - at) / (event.time - at);
          return evolve(time);
        }
        value = evolve(event.time);
        at = event.time;
        if (event.type === 'target') target = event;
        else { value = event.value; target = null; }
      }
      return evolve(time);
    }
    get value() { return this.valueAt(this.context.currentTime); }
    set value(value) { this.initial = value; }
    add(type, value, time, constant) {
      const event = { type, value, time, ...(constant === undefined ? {} : { constant }) };
      this.records.push(event);
      this.timeline.push(event);
      this.timeline.sort((a, b) => a.time - b.time);
      return this;
    }
    setValueAtTime(value, time) { return this.add('set', value, time); }
    linearRampToValueAtTime(value, time) { return this.add('linear', value, time); }
    setTargetAtTime(value, time, constant) { return this.add('target', value, time, constant); }
    cancelAndHoldAtTime(time) {
      const value = this.valueAt(time);
      const next = this.timeline.find(event => event.time > time);
      this.records.push({ type: 'hold', time, value });
      this.timeline = this.timeline.filter(event => event.time < time);
      // Preserve the part of an in-flight linear ramp before the held instant.
      this.timeline.push({ type: next?.type === 'linear' ? 'linear' : 'set', time, value });
      return this;
    }
  }
  class AudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    constructor() { contexts.push(this); }
    resume() {
      resumeCalls++;
      if (options.resume === 'reject') return Promise.reject(new Error('blocked'));
      if (options.resume === 'deferred') return resume.promise.then(() => { this.state = 'running'; });
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; this.onstatechange?.(); }
    decodeAudioData(bytes) {
      decodeCalls++;
      assert.notEqual(bytes, rawBytes, 'decode must receive a copy to preserve the byte cache');
      if (options.decode === 'reject') return Promise.reject(new Error('bad MP3'));
      return options.decode === 'deferred' ? decode.promise : Promise.resolve({ duration: 2 });
    }
    createGain() {
      const gain = {
        gain: new AudioParam(this), connections: [], disconnected: 0,
        connect(node) { this.connections.push(node); return node; },
        disconnect() { this.disconnected++; },
      };
      gains.push(gain);
      return gain;
    }
    createBufferSource() {
      const context = this;
      const source = {
        started: false, stopped: false, ended: false, disconnected: 0,
        connections: [], stopCalls: [], endTimer: null,
        connect(node) { this.connections.push(node); return node; },
        disconnect() { this.disconnected++; },
        scheduleEnd(at) {
          timers.delete(this.endTimer);
          this.endTimer = schedule(() => this.finish(), (at - context.currentTime) * 1000, 'audio');
        },
        start(at = context.currentTime) {
          this.started = true; this.at = at; this.wallAt = nowMs / 1000;
          maxPlaying = Math.max(maxPlaying, sources.filter(s => s.started && !s.ended).length);
          this.naturalEnd = options.holdSources ? Infinity : at + this.buffer.duration;
          if (Number.isFinite(this.naturalEnd)) this.scheduleEnd(this.naturalEnd);
        },
        stop(at = context.currentTime) {
          this.stopped = true;
          this.stopCalls.push({ time: context.currentTime, at });
          this.scheduleEnd(Math.min(Math.max(at, context.currentTime), this.naturalEnd));
        },
        finish() {
          if (this.ended) return;
          timers.delete(this.endTimer);
          this.ended = true; this.endedAt = context.currentTime; this.endedWallAt = nowMs / 1000;
          this.onended?.();
        },
      };
      sources.push(source);
      return source;
    }
  }
  const rawBytes = new ArrayBuffer(8);
  const ctx = vm.createContext({
    CONFIG, ...world, console: { ...console, warn() {} },
    performance: { now: () => nowMs },
    setTimeout(fn, delay) {
      const id = schedule(fn, delay, 'timeout');
      timeoutCalls.push({ id, delay, at: nowMs / 1000 });
      return id;
    },
    clearTimeout(id) { clearedTimeouts.push(id); timers.delete(id); },
    document: { createElement: () => ({ getContext: () => ({ clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, strokeRect() {}, setLineDash() {}, closePath() {} }) }) },
    fetch(path) {
      requests.push(path);
      if (path.endsWith('.mp3')) {
        if (options.download === 'reject') return Promise.reject(new Error('missing'));
        return Promise.resolve({ ok: true, arrayBuffer: () => options.download === 'deferred' ? download.promise : Promise.resolve(rawBytes) });
      }
      return Promise.resolve({ ok: path.endsWith('.glb'), arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
    },
    location: { search: '' },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    addEventListener(name, fn) { events.set(name, fn); },
    innerWidth: 1280, innerHeight: 720,
    ...(options.unsupported ? {} : { AudioContext }),
  });
  ctx.window = ctx;
  threeScript.runInContext(ctx);
  const T = ctx.THREE;
  T.WebGLRenderer = class { shadowMap = {}; setPixelRatio() {} setSize() {} render() {} };
  ctx.GLTFLoader = class {
    parse(_bytes, _path, done) {
      const scene = new T.Group();
      scene.add(new T.Mesh(new T.BoxGeometry(1, 2, 1), new T.MeshStandardMaterial()));
      const animations = ['Idle', 'Move', 'Attack', 'Hit', 'Death', 'LaughAttack'].map(name => {
        const duration = name === 'LaughAttack' ? 2 : 1;
        return new T.AnimationClip(name, duration, [new T.NumberKeyframeTrack('.rotation[z]', [0, duration], [0, 0.1])]);
      });
      const gltf = { scene, animations };
      parses.push(gltf);
      done(gltf);
    }
  };
  renderScript.runInContext(ctx);
  const renderer = ctx.createRenderer({ clientWidth: 1280, clientHeight: 720 });
  const snap = {
    players: [{ id: 0, st: 0, x: 0, y: 1.7, z: -10, yaw: 0, pitch: 0 }],
    enemies: [], projectiles: [], folds: [], pickups: [], walls: [], anchors: [], phase: 'boss',
    boss: { x: 0, z: 0, fy: 0, hp: 100, raged: false, state: 'idle', t: 0, ax: 1, az: 1 },
  };
  await flush();
  renderer.update(snap, 0);
  return {
    renderer, snap, T, contexts, sources, gains, requests, parses, decode, resume, download, storage,
    timers, timeoutCalls, clearedTimeouts, elapse,
    get now() { return nowMs / 1000; }, get maxPlaying() { return maxPlaying; },
    get decodeCalls() { return decodeCalls; }, get resumeCalls() { return resumeCalls; },
    unlock(name = 'pointerdown', isTrusted = true) { events.get(name)({ isTrusted }); },
    advance(seconds, state = 'idle', x) {
      elapse(seconds);
      if (snap.boss) Object.assign(snap.boss, { state, ...(x === undefined ? {} : { x }) });
      renderer.update(snap, seconds);
    },
    event(type, data = {}) { renderer.onEvent({ type, data }); },
    attack(attack) { renderer.onEvent({ type: 'bossAttack', data: { attack, count: 0, dirX: 1, dirZ: 0 } }); },
  };
}

async function ready(options) {
  const h = await harness(options);
  h.unlock(); await flush();
  assert.equal(h.renderer.bossAudioDebug().loaded, true);
  assert.equal(h.renderer.bossAudioDebug().state, 'running');
  return h;
}
function start(h) {
  assert.equal(h.renderer.triggerBossLaugh(), true);
  assert.equal(h.renderer.bossAudioDebug().pending, true);
  h.advance(0.22);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.renderer.bossAudioDebug().active, 1);
  assert.equal(h.renderer.bossAudioDebug().error, false);
  return h.sources.at(-1);
}
function nodes(source) {
  const envelope = source.connections[0];
  return { envelope, gain: envelope.connections[0] };
}
function assertDisposed(h, source) {
  const { envelope, gain } = nodes(source);
  assert.equal(source.disconnected, 1, 'source disconnected once');
  assert.equal(envelope.disconnected, 1, 'envelope disconnected once');
  assert.equal(gain.disconnected, 1, 'distance/volume gain disconnected once');
  assert.equal(source.onended, null, 'cleanup releases the ended callback');
  assert.equal(h.renderer.bossAudioDebug().active, 0);
  assert.equal(h.renderer.bossAudioDebug().stopping, false);
  assert.equal(h.renderer.bossAudioDebug().gain, 0);
}
function assertFading(h, source) {
  assert.equal(h.renderer.bossAudioDebug().active, 1, 'source retains the mutex throughout the fade');
  assert.equal(h.renderer.bossAudioDebug().stopping, true);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(source.stopped, true, 'stop has been scheduled');
  assert.equal(source.ended, false, 'scheduled stop does not end synchronously');
  assert.equal(source.disconnected, 0);
  assert.equal(nodes(source).envelope.disconnected, 0);
  assert.equal(nodes(source).gain.disconnected, 0);
}
function cancel(h, reason) {
  if (reason === 'bossDown') { h.event('bossDown'); h.snap.boss = null; }
  else if (reason === 'reset') h.renderer.reset();
  else if (reason === 'mute') h.renderer.setBossSoundMuted(true);
  else if (reason === 'removal') { h.snap.boss = null; h.advance(0); }
  else if (reason === 'suspension') h.contexts[0].suspend();
  else h.attack(reason);
}

for (const mode of ['unsupported', 'locked', 'muted']) test(`audio skips ${mode}; animation still runs`, async () => {
  const h = await harness({ [mode]: true });
  if (mode !== 'locked') h.unlock();
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  assert.equal(h.renderer.bossAudioDebug().starts, 0);
  assert.equal(h.renderer.bossAudioDebug().active, 0);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.timeoutCalls.length, 0);
  h.elapse(1);
  assert.equal(h.sources.length, 0);
  if (mode === 'unsupported') assert.equal(h.renderer.bossAudioDebug().state, 'unsupported');
});

test('trusted handlers resume synchronously; one context, fetch and decode cache across lifetimes', async () => {
  const h = await harness();
  h.unlock('click', false);
  assert.equal(h.contexts.length, 0);
  h.unlock('pointerdown');
  assert.equal(h.resumeCalls, 1, 'resume invoked before returning from handler');
  h.renderer.triggerBossLaugh(); // buffer is not decoded yet: must not queue
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  await flush();
  h.elapse(0.3);
  assert.equal(h.renderer.bossAudioDebug().starts, 0);
  h.unlock('keydown'); h.unlock('click');
  const first = start(h);
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  assert.equal(h.renderer.bossAudioDebug().duration, 2);
  assert.equal(h.renderer.bossAudioDebug().bytes, 8);
  h.renderer.reset();
  assertFading(h, first);
  h.elapse(0.05);
  assertDisposed(h, first);
  h.renderer.update(h.snap, 0);
  assert.equal(h.renderer.bossAudioDebug().starts, 0);
  assert.equal(h.renderer.bossAudioDebug().cooldown, 0);
  start(h);
  assert.equal(h.renderer.bossAudioDebug().starts, 1, 'new lifetime has clean counters/cooldown');
  assert.equal(h.contexts.length, 1);
  assert.equal(h.decodeCalls, 1);
  assert.equal(h.resumeCalls, 1);
  assert.equal(h.requests.filter(x => x.endsWith('.mp3')).length, 1);
  assert.equal(h.requests.filter(x => x.endsWith('.glb')).length, 1);
  assert.equal(h.parses.length, 2, 'new boss gets a fresh model');
  assert.notEqual(h.parses[0].scene, h.parses[1].scene);
  assert.equal(h.maxPlaying, 1);
});

test('exact 220ms native timer, pending dedup and trigger-based 3.5s cooldown ignore animation dt', async () => {
  const h = await ready();
  const triggered = h.now;
  assert.equal(h.renderer.triggerBossLaugh(), true);
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  assert.equal(h.renderer.bossDebug().actions.LaughAttack.time, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, true);
  close(h.renderer.bossAudioDebug().cooldown, 3.5);
  assert.equal(h.renderer.bossAudioDebug().active, 0);
  assert.equal(h.sources.length, 0);
  assert.equal(h.gains.length, 0);
  assert.deepEqual(h.timeoutCalls.map(t => t.delay), [220]);
  h.advance(0.1);
  h.event('rage'); h.attack('summon'); h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossDebug().actions.LaughAttack.time, 0, 'forced animation still restarts');
  assert.equal(h.timeoutCalls.length, 1, 'dedup must not restart or extend the pending timer');
  close(h.renderer.bossAudioDebug().cooldown, 3.4);
  h.advance(0.119);
  assert.equal(h.sources.length, 0, '219ms creates no audio nodes');
  assert.equal(h.gains.length, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, true);
  h.advance(0.001);
  assert.equal(h.sources.length, 1);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  close(h.sources[0].wallAt, triggered + 0.22);
  close(h.renderer.bossAudioDebug().cooldown, 3.28);
  h.sources[0].finish();
  assertDisposed(h, h.sources[0]);
  h.renderer.update(h.snap, 100); // simulation time is irrelevant to sound cooldown
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  h.advance(3.279);
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossAudioDebug().pending, false, '3.499s is too early');
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  h.advance(0.001);
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossAudioDebug().pending, true, '3.5s from trigger, not source start');
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  close(h.renderer.bossAudioDebug().cooldown, 3.5);
  h.advance(0.22);
  const audio = h.renderer.bossAudioDebug();
  assert.equal(audio.starts, 2);
  close(audio.startTimes[1] - audio.startTimes[0], 3.5);
  assert.equal(audio.active, 1);
  assert.equal(h.maxPlaying, 1);
});

test('a large clock step processes delayed start and natural onended chronologically', async () => {
  const h = await ready();
  h.renderer.triggerBossLaugh();
  h.advance(3);
  const source = h.sources[0];
  close(source.wallAt, 10.22);
  close(source.at, 0.22, 'AudioContext clock is not performance.now');
  close(source.endedWallAt, 12.22);
  close(source.endedAt, 2.22);
  assert.equal(source.stopped, false, 'natural completion needs no explicit stop');
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  assertDisposed(h, source);
  assert.equal(h.timers.size, 0);
});

test('one source maximum even after cooldown; mute fades for 50ms and unmute never autoplays', async () => {
  const h = await ready({ holdSources: true });
  const source = start(h);
  h.advance(4);
  h.event('rage'); h.attack('summon');
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.sources.length, 1);
  h.renderer.setBossSoundMuted(true);
  assertFading(h, source);
  assert.equal(h.storage.get('inkline-sound'), 'off');
  h.renderer.setBossSoundMuted(false);
  assert.equal(h.storage.get('inkline-sound'), 'on');
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossAudioDebug().pending, false, 'fading source still owns the mutex');
  h.elapse(0.049);
  assertFading(h, source);
  h.elapse(0.001);
  assertDisposed(h, source);
  h.advance(0.3);
  assert.equal(h.renderer.bossAudioDebug().starts, 1, 'unmute and blocked triggers never replay');
  start(h);
  assert.equal(h.renderer.bossAudioDebug().starts, 2);
  assert.equal(h.maxPlaying, 1);
});

test('context suspension immediately disconnects active audio; later resume never restarts it', async () => {
  const h = await ready();
  const source = start(h), { envelope } = nodes(source);
  h.advance(0.1);
  const at = h.contexts[0].currentTime, automation = envelope.gain.records.slice();
  h.contexts[0].suspend();
  assertDisposed(h, source);
  assert.equal(source.stopped, true);
  close(source.stopCalls[0].at, at, 'suspended contexts cannot execute a delayed fade');
  assert.deepEqual(envelope.gain.records, automation, 'no suspended-clock fade automation');
  h.elapse(1);
  close(h.contexts[0].currentTime, at, 'suspended audio clock is frozen');
  assertDisposed(h, source);
  h.unlock('keydown'); await flush();
  h.advance(4);
  assert.equal(h.renderer.bossAudioDebug().active, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  assert.equal(h.sources.length, 1);
});

test('mute/unmute cannot bypass the trigger-to-trigger cooldown', async () => {
  const h = await ready();
  const source = start(h);
  h.renderer.setBossSoundMuted(true); h.renderer.setBossSoundMuted(false);
  assertFading(h, source);
  h.advance(2);
  assertDisposed(h, source);
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  close(h.renderer.bossAudioDebug().cooldown, 1.28);
});

for (const completion of ['decode', 'download', 'resume']) {
  for (const end of ['bossDown', 'reset']) test(`${end}: late ${completion} never plays stale audio`, async () => {
    const h = await harness({ [completion]: 'deferred' });
    h.unlock();
    h.renderer.triggerBossLaugh();
    if (end === 'reset') h.renderer.reset(); else { h.event('bossDown'); h.snap.boss = null; }
    h[completion].resolve(completion === 'decode' ? { duration: 2 } : completion === 'download' ? new ArrayBuffer(8) : undefined);
    await flush();
    assert.equal(h.renderer.bossAudioDebug().active, 0);
    assert.equal(h.renderer.bossAudioDebug().starts, 0);
    h.unlock('click'); await flush();
    h.elapse(4);
    assert.equal(h.renderer.bossAudioDebug().starts, 0);
    assert.equal(h.renderer.bossAudioDebug().pending, false);
    assert.equal(h.timeoutCalls.length, 0);
    assert.equal(h.sources.length, 0);
    assert.equal(h.renderer.triggerBossLaugh(), false);
  });
}

test('late unlock after a locked laugh never replays it', async () => {
  const h = await harness();
  h.renderer.triggerBossLaugh(); h.advance(2.1);
  h.unlock(); await flush();
  h.elapse(4);
  assert.equal(h.renderer.bossAudioDebug().starts, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.timeoutCalls.length, 0);
});

for (const failure of ['resume', 'decode', 'download']) test(`${failure} rejection is silent`, async () => {
  const h = await harness({ [failure]: 'reject' });
  h.unlock(); await flush();
  assert.doesNotThrow(() => h.renderer.triggerBossLaugh());
  h.elapse(4);
  assert.equal(h.renderer.bossAudioDebug().active, 0);
  assert.equal(h.renderer.bossAudioDebug().starts, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.timeoutCalls.length, 0);
  assert.equal(h.renderer.bossAudioDebug().error, failure !== 'resume');
  assert.equal(h.sources.length, 0);
});

test('six actions, LoopOnce/clamp laugh, event-only routing and crossfade back to Idle/Move', async () => {
  const h = await harness();
  const initial = h.renderer.bossDebug();
  assert.equal(Object.keys(initial.actions).length, 6);
  assert.equal(initial.actions.LaughAttack.loop, h.T.LoopOnce);
  assert.equal(initial.actions.LaughAttack.clamp, true);
  assert.equal(initial.laughDur, 2);
  h.advance(0.1, 'summon');
  assert.equal(h.renderer.bossDebug().cur, 'Idle', 'telegraph does not trigger');
  h.attack('summon'); // count=0 is still an attack
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  h.advance(0.2, 'idle');
  h.advance(0.2, 'fan');
  assert.equal(h.renderer.bossDebug().actions.LaughAttack.time, 0.4, 'state entry did not restart laugh');
  h.event('hit', { boss: true, point: { x: 0, y: 1, z: 0 } });
  h.advance(0, 'charge');
  h.advance(0, 'charging');
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  assert.equal(h.renderer.bossDebug().hitT, 0);
  assert.equal(h.renderer.bossDebug().atkT, 0);
  h.advance(1.7);
  assert.equal(h.renderer.bossDebug().cur, 'Idle');
  h.advance(0.2);
  assert.equal(h.renderer.bossDebug().actions.LaughAttack.weight, 0, 'laugh faded out');
  h.renderer.triggerBossLaugh();
  h.advance(2.1, 'idle', 1);
  assert.equal(h.renderer.bossDebug().cur, 'Move');
});

test('fan cooldown fallback and charge use Attack; summon/rage force/restart laugh but not sound', async () => {
  const h = await harness(); h.unlock(); await flush();
  h.attack('fan');
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  h.advance(2.1);
  h.attack('fan');
  assert.equal(h.renderer.bossDebug().cur, 'Attack');
  h.advance(1.4);
  h.attack('fan');
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  h.advance(0.2);
  h.attack('summon');
  assert.equal(h.renderer.bossDebug().actions.LaughAttack.time, 0);
  h.advance(0.2);
  h.event('rage');
  assert.equal(h.renderer.bossDebug().actions.LaughAttack.time, 0);
  assert.equal(h.renderer.bossAudioDebug().starts, 2);
  h.advance(2.1);
  h.attack('charge');
  assert.equal(h.renderer.bossDebug().cur, 'Attack');
  h.advance(0.2);
  h.attack('charge');
  assert.equal(h.renderer.bossDebug().actions.Attack.time, 0, 'consecutive regular attacks can restart');
});

test('forced silent laughs do not postpone the sound cooldown used by fan', async () => {
  const h = await harness(); h.unlock(); await flush();
  h.event('rage');
  h.advance(3);
  h.attack('summon');
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  h.advance(0.5);
  h.attack('fan');
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  assert.equal(h.renderer.bossAudioDebug().pending, true);
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  h.advance(0.22);
  assert.equal(h.renderer.bossAudioDebug().starts, 2);
});

for (const attack of ['charge', 'fan']) test(`real ${attack} event replaces active laugh with Attack, unlike telegraph snapshots`, async () => {
  const h = await ready();
  const source = start(h);
  h.advance(0.2, attack);
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack', 'telegraph snapshot is not an attack event');
  assert.equal(source.stopped, false);
  h.attack(attack);
  assert.equal(h.renderer.bossDebug().cur, 'Attack');
  assert.equal(h.renderer.bossDebug().laughT, 0);
  assertFading(h, source);
  h.elapse(0.05);
  assertDisposed(h, source);
});

test('rage then bossDown in one batch: Death wins, cancels pending sound and rejects later laughs', async () => {
  const h = await ready();
  h.event('rage');
  assert.equal(h.renderer.bossAudioDebug().pending, true);
  h.event('bossDown');
  assert.equal(h.renderer.bossDebug().cur, 'Death');
  assert.equal(h.renderer.bossDebug().laughT, 0);
  assert.equal(h.renderer.bossAudioDebug().active, 0);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.sources.length, 0);
  assert.deepEqual(h.clearedTimeouts, [h.timeoutCalls[0].id]);
  h.snap.boss = null;
  h.advance(0.1); h.attack('summon'); h.event('rage');
  assert.equal(h.renderer.bossDebug().cur, 'Death');
  assert.equal(h.renderer.triggerBossLaugh(), false);
  h.advance(3);
  assert.equal(h.renderer.bossDebug().present, false);
  assert.equal(h.sources.length, 0);
});

test('snapshot removal fades and disconnects sound without bossDown', async () => {
  const h = await ready();
  const source = start(h);
  h.snap.boss = null; h.advance(0);
  assert.equal(h.renderer.bossDebug().present, false);
  assertFading(h, source);
  h.elapse(0.05);
  assertDisposed(h, source);
});

for (const [distance, factor] of [[4, 1], [6, 1], [14, 0.64], [20, 0.37], [22, 0.28], [30, 0.28]]) {
  test(`horizontal distance ${distance}m gives factor ${factor}`, async () => {
    const h = await ready();
    h.snap.players[0].z = -distance;
    h.advance(0);
    close(h.renderer.bossAudioDebug().distanceFactor, factor);
    close(h.renderer.bossAudioDebug().volume, 0.35);
    close(h.renderer.bossAudioDebug().targetGain, 0.35 * factor);
    const source = start(h), { envelope, gain } = nodes(source);
    close(gain.gain.records[0].value, factor);
    close(h.renderer.bossAudioDebug().gain, 0.001 * factor);
    h.advance(0.2);
    close(envelope.gain.value, 0.35);
    close(h.renderer.bossAudioDebug().gain, 0.35 * factor);
  });
}

test('horizontal Euclidean distance ignores y and follows both boss and player movement', async () => {
  const h = await ready();
  Object.assign(h.snap.players[0], { x: 2.4, z: 3.2, y: 1000 }); // 4m, not Manhattan distance
  Object.assign(h.snap.boss, { x: 0, z: 0, y: -1000 });
  h.advance(0);
  close(h.renderer.bossAudioDebug().distanceFactor, 1);
  const { gain } = nodes(start(h));
  const positions = [
    [{ x: 8.4, z: 11.2, y: -1000 }, { x: 0, z: 0, y: 1000 }, 0.64],
    [{ x: 8.4, z: 11.2, y: 9999 }, { x: 0, z: 0, y: -9999 }, 0.64],
    [{ x: 8.4, z: 11.2 }, { x: 4.8, z: 6.4 }, 1], // boss moves to 6m away
    [{ x: 8.4, z: 11.2 }, { x: -3.6, z: -4.8 }, 0.37], // boss moves to 20m away
  ];
  for (const [player, boss, factor] of positions) {
    Object.assign(h.snap.players[0], player);
    Object.assign(h.snap.boss, boss);
    const count = gain.gain.records.length;
    h.advance(0.016);
    close(h.renderer.bossAudioDebug().distanceFactor, factor);
    close(h.renderer.bossAudioDebug().targetGain, 0.35 * factor);
    assert.equal(gain.gain.records.length, count + 1);
    assert.equal(gain.gain.records.at(-1).type, 'target');
    close(gain.gain.records.at(-1).value, factor);
    close(gain.gain.records.at(-1).constant, 0.05);
  }
});

test('source -> 200ms/250ms envelope -> independent gain -> destination; natural end cleans all nodes', async () => {
  const h = await ready();
  h.snap.players[0].z = -6; h.advance(0);
  const source = start(h), { envelope, gain } = nodes(source), at = source.at;
  assert.equal(h.gains.length, 2);
  assert.deepEqual(source.connections, [envelope]);
  assert.deepEqual(envelope.connections, [gain]);
  assert.deepEqual(gain.connections, [h.contexts[0].destination]);
  assert.deepEqual(envelope.gain.records, [
    { type: 'set', value: 0.001, time: at },
    { type: 'linear', value: 0.35, time: at + 0.20 },
    { type: 'set', value: 0.35, time: at + 2 - 0.25 },
    { type: 'linear', value: 0.001, time: at + 2 },
  ]);
  assert.deepEqual(gain.gain.records[0], { type: 'set', value: 1, time: at });
  close(envelope.gain.value, 0.001);
  h.elapse(0.1); close(envelope.gain.value, 0.1755);
  h.elapse(0.1); close(envelope.gain.value, 0.35);
  h.elapse(1.55); close(envelope.gain.value, 0.35);
  h.elapse(0.125); close(envelope.gain.value, 0.1755);
  close(h.renderer.bossAudioDebug().gain, envelope.gain.value * gain.gain.value);
  h.elapse(0.124);
  assert.equal(h.renderer.bossAudioDebug().active, 1);
  assert.equal(source.disconnected, 0);
  h.elapse(0.001);
  close(envelope.gain.value, 0.001);
  close(source.endedAt, at + 2);
  assert.equal(source.stopCalls.length, 0);
  assertDisposed(h, source);
  source.finish(); // duplicate completion must not repeat cleanup
  assertDisposed(h, source);
});

for (const [phase, elapsed] of [['ramp', 0.05], ['plateau', 0.8], ['tail', 1.8]]) {
  test(`per-frame 50ms distance/volume smoothing leaves the ${phase} envelope untouched`, async () => {
    const h = await ready();
    h.snap.players[0].z = -6; h.advance(0);
    const source = start(h), { envelope, gain } = nodes(source);
    const automation = envelope.gain.records.slice();
    h.elapse(elapsed);
    const before = gain.gain.records.length, at = h.contexts[0].currentTime;
    h.snap.players[0].z = -22;
    h.advance(0);
    assert.equal(gain.gain.records.length, before + 1);
    const target = gain.gain.records.at(-1);
    assert.equal(target.type, 'target');
    close(target.time, at); close(target.value, 0.28); close(target.constant, 0.05);
    close(gain.gain.value, 1, 'setTarget cannot jump immediately');
    close(h.renderer.bossAudioDebug().targetGain, 0.098);
    h.elapse(0.025);
    close(gain.gain.value, 0.28 + 0.72 * Math.exp(-0.5));
    h.advance(0); // unchanged target still updates each frame, without resetting the current value
    assert.equal(gain.gain.records.length, before + 2);
    h.elapse(0.025);
    const smoothed = 0.28 + 0.72 * Math.exp(-1);
    close(gain.gain.value, smoothed);
    assert.equal(h.renderer.setBossLaughVolume(0.7), 0.7);
    const volumeTarget = gain.gain.records.at(-1);
    assert.equal(volumeTarget.type, 'target');
    close(volumeTarget.value, 0.56); close(volumeTarget.constant, 0.05);
    close(gain.gain.value, smoothed, 'volume also changes through smoothing');
    h.elapse(0.05);
    close(gain.gain.value, 0.56 + (smoothed - 0.56) * Math.exp(-1));
    assert.deepEqual(envelope.gain.records, automation, 'no cancellation or rewritten envelope ramps');
    const t = h.contexts[0].currentTime - source.at;
    const expectedEnvelope = t < 0.2 ? 0.001 + 0.349 * t / 0.2
      : t <= 1.75 ? 0.35 : 0.35 - 0.349 * (t - 1.75) / 0.25;
    close(envelope.gain.value, expectedEnvelope);
    close(h.renderer.bossAudioDebug().gain, expectedEnvelope * gain.gain.value);
    close(h.renderer.bossAudioDebug().targetGain, 0.7 * 0.28);
  });
}

test('volume defaults to .35, clamps finite numbers to 0..1, returns the stored volume and smooths independently', async () => {
  const h = await ready();
  h.snap.players[0].z = -14; h.advance(0);
  close(h.renderer.bossAudioDebug().volume, 0.35);
  const { envelope, gain } = nodes(start(h));
  const automation = envelope.gain.records.slice();
  for (const [input, expected] of [[-1, 0], [0, 0], [0.42, 0.42], [1, 1], [9, 1], [-0, 0], [0.35, 0.35]]) {
    close(h.renderer.setBossLaughVolume(input), expected);
    close(h.renderer.bossAudioDebug().volume, expected);
    close(h.renderer.bossAudioDebug().targetGain, expected * 0.64);
    const event = gain.gain.records.at(-1);
    assert.equal(event.type, 'target');
    close(event.value, expected / 0.35 * 0.64);
    close(event.constant, 0.05);
    assert.deepEqual(envelope.gain.records, automation);
  }
});

test('nonfinite and nonnumeric volume inputs are ignored without coercion or new automation', async () => {
  const h = await ready();
  const { gain } = nodes(start(h));
  assert.equal(h.renderer.setBossLaughVolume(0.6), 0.6);
  const automation = gain.gain.records.slice();
  for (const input of [NaN, Infinity, -Infinity, undefined, null, '0.8', true, {}, [], new Number(0.8), Symbol('volume'), 1n]) {
    assert.equal(h.renderer.setBossLaughVolume(input), 0.6);
    assert.equal(h.renderer.bossAudioDebug().volume, 0.6);
    assert.deepEqual(gain.gain.records, automation);
  }
});

test('volume and latest distance set while pending apply at callback; zero volume remains valid playback', async () => {
  const h = await ready();
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.setBossLaughVolume(0), 0);
  h.snap.players[0].z = -30; h.advance(0.219);
  assert.equal(h.gains.length, 0);
  h.advance(0.001);
  const { envelope, gain } = nodes(h.sources[0]);
  assert.equal(gain.gain.records[0].value, 0);
  assert.equal(h.renderer.bossAudioDebug().active, 1);
  assert.equal(h.renderer.bossAudioDebug().gain, 0);
  close(h.renderer.bossAudioDebug().distanceFactor, 0.28);
  h.renderer.setBossLaughVolume(1);
  close(gain.gain.records.at(-1).value, 0.28 / 0.35);
  close(envelope.gain.records[1].value, 0.35, 'full volume does not rewrite envelope peak');
});

for (const reason of ['bossDown', 'reset', 'mute', 'charge', 'fan', 'removal', 'suspension']) {
  test(`${reason} at 219ms clears the pending native timeout and never replays after recovery`, async () => {
    const h = await ready();
    const boss = h.snap.boss;
    h.renderer.triggerBossLaugh();
    h.advance(0.219);
    assert.equal(h.renderer.bossAudioDebug().pending, true);
    cancel(h, reason);
    assert.equal(h.renderer.bossAudioDebug().pending, false);
    assert.equal(h.renderer.bossAudioDebug().active, 0);
    assert.deepEqual(h.clearedTimeouts, [h.timeoutCalls[0].id]);
    assert.equal(h.timers.size, 0, 'timer must be cleared, not merely ignored by its callback');
    close(h.renderer.bossAudioDebug().cooldown, 3.281, 'cancellation does not refund the trigger reservation');
    if (reason === 'mute') h.renderer.setBossSoundMuted(false);
    if (reason === 'suspension') { h.unlock('keydown'); await flush(); }
    if (reason === 'reset' || reason === 'removal') { h.snap.boss = boss; h.renderer.update(h.snap, 0); }
    h.elapse(0.001);
    assert.equal(h.sources.length, 0);
    h.advance(4);
    assert.equal(h.renderer.bossAudioDebug().starts, 0);
    assert.equal(h.renderer.bossAudioDebug().pending, false);
    assert.equal(h.sources.length, 0);
    assert.equal(h.gains.length, 0);
    assert.equal(h.decodeCalls, 1);
    if (reason !== 'bossDown') {
      start(h); // recovery permits a fresh event, but never queues the canceled one
      assert.equal(h.renderer.bossAudioDebug().starts, 1);
    } else assert.equal(h.renderer.triggerBossLaugh(), false);
  });
}

for (const [phase, elapsed] of [['ramp', 0.1], ['plateau', 0.8], ['tail', 1.8]]) {
  for (const reason of ['bossDown', 'reset', 'mute', 'charge', 'fan', 'removal']) {
    test(`${reason} interrupts ${phase} using cancelAndHold and an idempotent 50ms stop`, async () => {
      const h = await ready();
      const source = start(h), { envelope, gain } = nodes(source);
      h.advance(elapsed);
      const at = h.contexts[0].currentTime, held = envelope.gain.value;
      const automation = envelope.gain.records.slice(), gainAutomation = gain.gain.records.slice();
      cancel(h, reason);
      assertFading(h, source);
      assert.equal(source.stopCalls.length, 1);
      close(source.stopCalls[0].time, at);
      close(source.stopCalls[0].at, at + 0.05);
      assert.deepEqual(envelope.gain.records.slice(0, -2), automation);
      const [hold, ramp] = envelope.gain.records.slice(-2);
      assert.equal(hold.type, 'hold'); close(hold.time, at); close(hold.value, held);
      assert.equal(ramp.type, 'linear'); close(ramp.time, at + 0.05); close(ramp.value, 0.001);
      assert.equal(envelope.gain.timeline.filter(event => event.time > at).length, 1, 'old ramp/plateau/tail events canceled');
      close(envelope.gain.value, held, 'interruption does not jump gain');
      h.elapse(0.025);
      close(envelope.gain.value, (held + 0.001) / 2);
      close(h.renderer.bossAudioDebug().gain, envelope.gain.value * gain.gain.value);
      h.renderer.setBossSoundMuted(true); // a second stop must not extend the deadline
      assert.equal(source.stopCalls.length, 1);
      assert.equal(envelope.gain.records.length, automation.length + 2);
      assert.deepEqual(gain.gain.records, gainAutomation, 'stop changes only the envelope stage');
      h.elapse(0.024);
      assertFading(h, source);
      h.elapse(0.001);
      close(envelope.gain.value, 0.001);
      close(source.endedAt, at + 0.05);
      assertDisposed(h, source);
      h.elapse(4);
      assert.equal(h.renderer.bossAudioDebug().starts, 1);
      assert.equal(h.sources.length, 1);
    });
  }
}

test('interruption in the last 20ms ends naturally before the 50ms stop deadline', async () => {
  const h = await ready();
  const source = start(h);
  h.elapse(1.98);
  const at = h.contexts[0].currentTime;
  h.renderer.setBossSoundMuted(true);
  assertFading(h, source);
  close(source.stopCalls[0].at, at + 0.05);
  h.elapse(0.019);
  assertFading(h, source);
  h.elapse(0.001);
  close(source.endedAt, source.at + 2);
  assertDisposed(h, source);
  h.elapse(0.03);
  assertDisposed(h, source);
});

test('suspension during an existing fade immediately disconnects and never resumes its delayed stop', async () => {
  const h = await ready();
  const source = start(h);
  h.elapse(0.1);
  h.renderer.setBossSoundMuted(true);
  h.elapse(0.02);
  const at = h.contexts[0].currentTime;
  h.contexts[0].suspend();
  assertDisposed(h, source);
  assert.equal(source.stopCalls.length, 2);
  close(source.stopCalls[1].at, at);
  h.renderer.setBossSoundMuted(false);
  h.unlock('keydown'); await flush();
  h.advance(4);
  assertDisposed(h, source);
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.sources.length, 1);
});

for (const reason of ['reset', 'removal']) test(`${reason}: new boss lifetime resets counters but cannot overlap an old fading source`, async () => {
  const h = await ready();
  const boss = h.snap.boss, source = start(h);
  cancel(h, reason);
  h.snap.boss = boss; h.renderer.update(h.snap, 0);
  assert.equal(h.renderer.bossAudioDebug().starts, 0);
  assert.equal(h.renderer.bossAudioDebug().startTimes.length, 0);
  assert.equal(h.renderer.bossAudioDebug().cooldown, 0);
  assertFading(h, source);
  h.renderer.triggerBossLaugh();
  assert.equal(h.renderer.bossDebug().cur, 'LaughAttack');
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.timeoutCalls.length, 1);
  h.elapse(0.049);
  h.event('rage'); h.attack('summon');
  assert.equal(h.renderer.bossAudioDebug().pending, false);
  assert.equal(h.sources.length, 1);
  assert.equal(source.stopCalls.length, 1, 'makeBossView does not restart the fade');
  h.elapse(0.001);
  assertDisposed(h, source);
  h.advance(0.3);
  assert.equal(h.sources.length, 1, 'blocked new-lifetime trigger was not queued');
  const replacement = start(h);
  assert.notEqual(source, replacement);
  assert.equal(h.renderer.bossAudioDebug().starts, 1);
  assert.equal(h.renderer.bossAudioDebug().startTimes.length, 1);
  assert.equal(h.maxPlaying, 1);
  assert.equal(h.gains.length, 4);
  assert.equal(h.decodeCalls, 1);
  assert.equal(h.parses.length, 2);
  source.finish(); // an old completion cannot disconnect the replacement voice
  assert.equal(h.renderer.bossAudioDebug().active, 1);
  assert.equal(replacement.disconnected, 0);
  assert.equal(nodes(replacement).envelope.disconnected, 0);
  assert.equal(nodes(replacement).gain.disconnected, 0);
});
