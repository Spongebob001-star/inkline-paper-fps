import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import * as world from '../shared/world.mjs';
import { perkMods } from '../shared/perks.mjs';
import { createRuntime } from '../host/runtime.mjs';

// Run actual modules/handlers; replace browser hardware and clocks only.
const script = (file, name) => new vm.Script(readFileSync(new URL('../client/' + file, import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function ' + name, 'function ' + name), { filename: file });
const inputScript = script('input.mjs', 'createInput');
const renderScript = script('render.mjs', 'createRenderer');
const audioScript = script('audio.mjs', 'createAudio');
const threeScript = new vm.Script(readFileSync(new URL('../src/three/three.min.js', import.meta.url), 'utf8'));
const flush = () => new Promise(resolve => setImmediate(resolve));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const invalid = [NaN, Infinity, -Infinity, undefined, null, '0.5', true, {}, [], Symbol('value'), 1n];
class Target {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, fields = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...fields };
    for (const fn of this.listeners.get(type) || []) { fn(event); if (event.stopped) break; }
    return event;
  }
}
function inputHarness(fallback = false) {
  const document = new Target(), window = new Target(), canvas = new Target();
  const state = { blocked: false, weapon: 2 }, intents = [], shots = [], actions = [], locks = [];
  let tick, now = 10000, requests = 0;
  if (!fallback) canvas.requestPointerLock = () => { requests++; return Promise.resolve(); };
  const runtime = createRuntime();
  const context = vm.createContext({ CONFIG, document, window, performance: { now: () => now },
    setInterval: fn => { tick = fn; } });
  inputScript.runInContext(context);
  const input = context.createInput(canvas, {
    isBlocked: () => state.blocked, getWeapon: () => state.weapon,
    onIntent: intent => { intents.push(intent); runtime.setInput(0, intent); },
    onShot: dir => shots.push(dir), onLock: (...args) => locks.push(args),
    ...Object.fromEntries(['Reload', 'Draw', 'CancelDraw', 'Erase', 'Fold', 'QuickWall', 'Weapon']
      .map(action => ['on' + action, () => actions.push(action)])),
  });
  return { input, state, document, window, canvas, intents, shots, actions, locks, runtime,
    get requests() { return requests; },
    activate() {
      if (fallback) canvas.emit('click');
      else { document.pointerLockElement = canvas; document.emit('pointerlockchange'); }
    },
    key: code => document.emit('keydown', { code }),
    mouse: button => document.emit('mousedown', { button, target: canvas }),
    move: (x, y) => document.emit('mousemove', { movementX: x, movementY: y, target: canvas }),
    tick() { now += 1000; tick(); return intents.at(-1); },
  };
}
function neutral(intent) {
  assert.deepEqual([intent.f, intent.r, intent.sprint, intent.jump, intent.hold], [0, 0, false, false, false]);
}
for (const fallback of [false, true]) {
  test(`C sensitivity preserves default and ADS multiplier (${fallback ? 'fallback' : 'locked'})`, () => {
    const h = inputHarness(fallback); h.activate();
    assert.equal(h.input.setSensitivity(undefined), 0.0022);
    for (const [value, expected] of [[0.0022, 0.0022], [-1, 0.0008], [0.004, 0.004], [1, 0.005]]) {
      assert.equal(h.input.setSensitivity(value), expected);
      for (const ads of [false, true]) {
        h.input.cancelADS(); if (ads) h.mouse(2);
        h.input.setView(0, 0); h.move(10, -20);
        close(h.input.yaw, -10 * expected * (ads ? 0.42 : 1));
        close(h.tick().pitch, 20 * expected * (ads ? 0.42 : 1));
      }
    }
    for (const value of invalid) assert.equal(h.input.setSensitivity(value), 0.005);
    assert.equal(h.shots.length, 0);
  });

  test(`C modal suppresses gameplay, aim and held state without consuming global keys (${fallback ? 'fallback' : 'locked'})`, () => {
    const h = inputHarness(fallback); h.activate();
    for (const code of ['KeyW', 'KeyD', 'ShiftLeft', 'KeyF', 'Space']) h.key(code);
    h.mouse(0); h.mouse(2); assert.equal(h.input.ads, true);
    h.state.blocked = true;
    const globals = [];
    h.document.addEventListener('keydown', e => { if (['KeyO', 'KeyH', 'KeyZ', 'KeyX', 'KeyV'].includes(e.code)) globals.push(e.code); });
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'ShiftLeft', 'ShiftRight', 'KeyF', 'Space', 'KeyR', 'KeyQ', 'KeyG', 'KeyE', 'KeyC', 'Digit1', 'Digit2', 'Digit3',
      'KeyO', 'KeyH', 'KeyZ', 'KeyX', 'KeyV']) {
      const event = h.key(code);
      assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false);
    }
    h.mouse(0); h.mouse(2); h.move(30, 40);
    assert.equal(h.document.emit('wheel', { deltaY: 1 }).defaultPrevented, false);
    assert.equal(h.input.ads, false); close(h.input.yaw, 0);
    neutral(h.tick()); neutral(h.tick());
    assert.equal(h.intents[1].seq, h.intents[0].seq + 1, 'neutral intents still flow');
    assert.deepEqual(h.actions, []); assert.deepEqual(h.shots, []);
    assert.deepEqual(globals, ['KeyO', 'KeyH', 'KeyZ', 'KeyX', 'KeyV']);
    h.state.blocked = false; neutral(h.tick()); assert.equal(h.shots.length, 0);
    h.key('KeyW'); assert.equal(h.tick().f, 1, 'fresh input resumes normally');
    h.key('KeyR'); assert.deepEqual(h.actions, ['Reload']);
  });
}

test('C modal rejects canvas/programmatic pointer lock before compatibility fallback is entered', async () => {
  for (const fallback of [false, true]) {
    const h = inputHarness(fallback); h.state.blocked = true;
    h.canvas.emit('click'); h.input.requestLock(); h.move(10, 10);
    await flush();
    assert.equal(h.requests, 0); assert.equal(h.locks.length, 0); close(h.input.yaw, 0);
    h.state.blocked = false; h.canvas.emit('click'); await flush();
    assert.equal(h.requests, fallback ? 0 : 1);
    if (fallback) assert.equal(h.locks.at(-1)[2], true);
  }
});

test('C clear/releaseFire remove latent input without changing view, sensitivity, sequence or simulation time', () => {
  const h = inputHarness(); h.activate(); h.input.setSensitivity(0.003); h.input.setView(0.4, -0.2);
  h.key('KeyW'); h.key('Space'); h.mouse(0); h.mouse(2); h.input.clear();
  const first = h.tick(); neutral(first); assert.equal(h.input.ads, false); assert.equal(h.shots.length, 0);
  close(first.yaw, 0.4); close(first.pitch, -0.2); assert.equal(h.input.setSensitivity(undefined), 0.003);
  h.input.pressFire(); h.input.releaseFire(); h.tick(); assert.equal(h.shots.length, 0);
  h.state.blocked = true; h.input.pressFire(); h.state.blocked = false; h.tick(); assert.equal(h.shots.length, 0);
  h.state.blocked = true; h.tick();
  const before = h.runtime.snapshot();
  h.runtime.tickOnce(); h.runtime.tickOnce();
  assert.equal(h.runtime.snapshot().tick, before.tick + 2);
  close(h.runtime.snapshot().timeLeft, before.timeLeft - CONFIG.net.dt * 2);
  h.input.setView(0.8, 0.1); close(h.input.yaw, 0.8);
});

// Shared fake WebAudio tracks actual graph routing, automation and source cleanup.
function mediaHarness({ reduced = false, stored = 'on', unsupported = false } = {}) {
  const window = new Target(), media = new Target(), contexts = [], sources = [], gains = [], nodes = [], timers = new Map();
  let now = 10000, nextTimer = 0;
  const storage = new Map(stored === null ? [] : [['inkline-sound', stored]]), writes = [];
  media.matches = reduced;
  const schedule = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; };
  function advance(ms) {
    const end = now + ms;
    const move = at => { for (const c of contexts) if (c.state === 'running') c.currentTime += (at - now) / 1000; now = at; };
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end + 1e-8).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, t] = next; timers.delete(id); move(t.at); t.fn();
    }
    move(end);
  }
  class Param {
    value = 1; records = [];
    record(type, value, time, constant) { this.value = value; this.records.push({ type, value, time, constant }); }
    setValueAtTime(v, t) { this.record('set', v, t); }
    linearRampToValueAtTime(v, t) { this.record('linear', v, t); }
    exponentialRampToValueAtTime(v, t) { this.record('exp', v, t); }
    setTargetAtTime(v, t, c) { this.record('target', v, t, c); }
    cancelAndHoldAtTime(t) { this.record('hold', this.value, t); }
  }
  class Node {
    connections = []; disconnected = false;
    constructor() { nodes.push(this); }
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.disconnected = true; }
  }
  class Source extends Node {
    frequency = new Param(); ended = false; stopCalls = [];
    constructor(ctx, kind) { super(); this.ctx = ctx; this.kind = kind; sources.push(this); }
    finish() { if (!this.ended) { this.ended = true; this.onended?.(); } }
    start(at) { this.at = at; if (this.buffer) this.endAt(at + this.buffer.duration); }
    endAt(at) { timers.delete(this.timer); this.timer = schedule(() => this.finish(), Math.max(0, at - this.ctx.currentTime) * 1000); }
    stop(at = this.ctx.currentTime) { this.stopCalls.push(at); if (!this.ended) this.endAt(at); }
  }
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {}; sampleRate = 8000;
    constructor() { contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; this.onstatechange?.(); }
    createGain() { const g = new Node(); g.gain = new Param(); gains.push(g); return g; }
    createBufferSource() { return new Source(this, 'buffer'); }
    createOscillator() { return new Source(this, 'oscillator'); }
    createBiquadFilter() { const n = new Node(); n.Q = new Param(); n.frequency = new Param(); return n; }
    createWaveShaper() { return new Node(); }
    createDynamicsCompressor() {
      const n = new Node();
      for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[name] = new Param();
      n.reduction = 0;
      return n;
    }
    createBuffer(_channels, count, rate) { return { duration: count / rate, getChannelData: () => new Float32Array(count) }; }
    decodeAudioData() { return Promise.resolve({ duration: 2 }); }
  }
  Object.assign(window, {
    matchMedia: () => media, innerWidth: 1280, innerHeight: 720, location: { search: '' },
    navigator: { userActivation: { isActive: true } },
    localStorage: { getItem: k => storage.get(k), setItem(k, v) { writes.push([k, v]); storage.set(k, v); } },
    ...(unsupported ? {} : { AudioContext }),
  });
  const context = vm.createContext({ CONFIG, ...world, perkMods, window,
    console: { ...console, warn() {} }, performance: { now: () => now },
    document: { createElement: () => ({ getContext: () => ({ clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, strokeRect() {}, setLineDash() {}, closePath() {} }) }) },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    fetch: path => Promise.resolve({ ok: path.endsWith('.mp3'), arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
  });
  return { context, window, media, storage, writes, contexts, sources, gains, nodes, timers, advance,
    unlock: (isTrusted = true) => window.emit('pointerdown', { isTrusted }),
    reduce(value) { media.matches = value; media.emit('change', { matches: value }); },
    audio(options) { audioScript.runInContext(context); return context.createAudio(options); },
  };
}
async function renderHarness(options) {
  const h = mediaHarness(options);
  threeScript.runInContext(h.context);
  h.window.THREE = h.context.THREE;
  h.window.THREE.WebGLRenderer = class { shadowMap = {}; setPixelRatio() {} setSize() {} render() {} };
  h.context.GLTFLoader = class {};
  renderScript.runInContext(h.context);
  const renderer = h.context.createRenderer({ clientWidth: 1280, clientHeight: 720 });
  const snap = { players: [{ id: 0, st: 0, x: 0, y: 1.7, z: -14, yaw: 0, pitch: 0, wp: 0, rl: 0 }],
    enemies: [], projectiles: [], folds: [], pickups: [], walls: [], anchors: [], phase: 'boss',
    boss: { x: 0, z: 0, fy: 0, hp: 100, raged: false, state: 'idle', t: 0, ax: 1, az: 1 } };
  await flush(); renderer.update(snap, 0);
  return { ...h, renderer, snap, update: dt => renderer.update(snap, dt) };
}

for (const reduced of [false, true]) {
  test(`C custom FOV restores after ADS/reload/death and reset; default easing preserved (reduced=${reduced})`, async () => {
    const h = await renderHarness({ reduced }), r = h.renderer, me = h.snap.players[0];
    assert.equal(r.modelDebug().baseFov, 68); assert.equal(r.camera.fov, 68);
    Object.assign(me, { wp: 2, ads: true }); h.update(0.05);
    close(r.camera.fov, reduced ? 28 : 68 + (28 - 68) * (1 - Math.exp(-0.9)));
    assert.equal(r.setBaseFov(84), 84); h.update(2); close(r.camera.fov, 28);
    for (const exit of [{ ads: false }, { ads: true, rl: 0.2 }, { ads: true, st: 1 }]) {
      Object.assign(me, { ads: true, rl: 0, st: 0 }); h.update(2); close(r.camera.fov, 28);
      Object.assign(me, exit); h.update(2); close(r.camera.fov, 84);
    }
    for (const [value, expected] of [[-1, 60], [120, 95], [79, 79]]) assert.equal(r.setBaseFov(value), expected);
    for (const value of invalid) assert.equal(r.setBaseFov(value), 79);
    r.reset(); assert.equal(r.camera.fov, 79); assert.equal(r.modelDebug().baseFov, 79);
  });
}

test('C reload dip uses real shared light-feet modifiers and retains unperked weapon durations', async () => {
  const h = await renderHarness(), me = h.snap.players[0];
  for (const wp of [0, 1, 2]) {
    for (const pk of [undefined, [], ['light_feet']]) {
      Object.assign(me, { wp, pk, rl: 0 }); h.update(0.2);
      const duration = CONFIG.player.weapons[wp].reloadTime * perkMods({ perks: pk || [] }).reloadMul;
      for (const fraction of [1, 0.5, 0.25, 0]) {
        me.rl = duration * fraction; h.update(0);
        close(h.renderer.modelDebug().gun.tilt, -Math.sin(Math.PI * (1 - fraction)) * 0.65);
      }
    }
  }
});

test('C boss volume preserves M5 envelope/delay and applies 0..1 independently of mute and distance', async () => {
  const h = await renderHarness(), r = h.renderer;
  assert.equal(r.bossAudioDebug().volume, 0.35);
  h.unlock(); await flush(); r.triggerBossLaugh(); h.advance(219);
  assert.equal(h.sources.length, 0); h.advance(1); assert.equal(h.sources.length, 1);
  const envelope = h.sources[0].connections[0], gain = envelope.connections[0];
  const automation = envelope.gain.records.slice();
  for (const [value, expected] of [[-5, 0], [0, 0], [1, 1], [5, 1], [0.35, 0.35]]) {
    assert.equal(r.setBossLaughVolume(value), expected);
    const debug = r.bossAudioDebug(); close(debug.distanceFactor, 0.64); close(debug.targetGain, expected * 0.64);
    close(gain.gain.records.at(-1).value, expected / 0.35 * 0.64);
    close(gain.gain.records.at(-1).constant, 0.05);
    assert.equal(debug.muted, false); assert.deepEqual(envelope.gain.records, automation);
  }
  for (const value of invalid) assert.equal(r.setBossLaughVolume(value), 0.35);
  r.setBossSoundMuted(true); r.setBossLaughVolume(1);
  assert.equal(r.bossAudioDebug().muted, true); assert.equal(h.storage.get('inkline-sound'), 'off');
  h.advance(50); assert.equal(r.bossAudioDebug().active, 0);
});

test('C master volume preserves the default mix, scales every synth through one live bus, and never toggles mute', () => {
  const h = mediaHarness(), audio = h.audio(), initial = audio.debug();
  assert.equal(initial.volume, 0.85); assert.equal(initial.masterPeak, 0.62); close(initial.maxMasterPeak, 0.62 / 0.85);
  audio.setVolume(0); assert.equal(h.contexts.length, 0, 'volume never unlocks audio');
  h.unlock(); const master = h.gains[0]; assert.equal(master.gain.value, 0);
  for (const method of ['shot', 'weaponSwitch', 'crit', 'bossStun', 'reload', 'hit', 'armorStrip', 'kill',
    'wallDraw', 'erase', 'fold', 'pickup', 'perkPick', 'playerHit']) {
    const first = h.gains.length; audio[method]();
    const punch = h.gains[first].connections[0], compressor = punch.connections[0];
    assert.ok(punch.curve, method + ' must route through punch');
    assert.equal(compressor.connections[0], master, method + ' must route through compressor/master');
    h.advance(1000);
  }
  audio.perkPick(); const voiceNodes = h.nodes.filter(n => n !== master && !n.disconnected);
  const envelopes = voiceNodes.filter(n => n.gain).map(n => n.gain.records.slice());
  for (const [value, expected] of [[0, 0], [0.85, 0.85], [1, 1], [-5, 0], [5, 1]]) {
    assert.equal(audio.setVolume(value), expected); close(master.gain.value, 0.62 * expected / 0.85);
    close(audio.debug().masterPeak, master.gain.value); assert.equal(audio.isMuted(), false);
    assert.deepEqual(voiceNodes.filter(n => n.gain).map(n => n.gain.records), envelopes);
  }
  for (const value of invalid) assert.equal(audio.setVolume(value), 1);
  assert.deepEqual(h.writes, []);
  audio.setMuted(true); audio.setVolume(0.85); assert.equal(audio.isMuted(), true);
  assert.equal(h.storage.get('inkline-sound'), 'off');
  h.advance(50); assert.equal(audio.debug().active, 0);
});

test('C perk chord requires trusted unlock, respects voice cap eighteen, and fully cleans up on completion', async () => {
  const h = mediaHarness(), audio = h.audio();
  audio.perkPick(); h.unlock(false); audio.perkPick(); assert.equal(h.contexts.length, 0);
  h.window.navigator.userActivation.isActive = false; h.unlock(); assert.equal(h.contexts.length, 0);
  h.window.navigator.userActivation.isActive = true; h.unlock(); await flush();
  assert.equal(audio.debug().starts, 0, 'unlock never replays skipped events');
  audio.perkPick();
  assert.deepEqual(h.sources.map(s => s.frequency.records[0].value), [523.25, 659.25, 783.99]);
  for (const source of h.sources) { assert.equal(source.type, 'sine'); assert.ok(source.stopCalls[0] <= 0.3); }
  for (let i = 0; i < 20; i++) audio.perkPick();
  assert.equal(audio.debug().active, 18); assert.equal(audio.debug().maxVoices, 18); assert.equal(audio.debug().sources, 54);
  h.advance(300);
  assert.equal(audio.debug().active, 0); assert.equal(audio.debug().sources, 0); assert.equal(audio.debug().nodes, 3);
  assert.ok(h.sources.every(s => s.ended && s.disconnected && s.onended === null));
  assert.ok(h.nodes.slice(3).every(n => n.disconnected));
});

for (const reason of ['stop', 'mute', 'suspend']) {
  test(`C perk cleanup also works on ${reason}`, () => {
    const h = mediaHarness(), audio = h.audio(); h.unlock(); audio.perkPick();
    if (reason === 'stop') audio.stop();
    else if (reason === 'mute') audio.setMuted(true);
    else h.contexts[0].suspend();
    h.advance(50);
    assert.equal(audio.debug().active, 0); assert.equal(audio.debug().nodes, 3);
    assert.ok(h.nodes.slice(3).every(n => n.disconnected));
    assert.ok(h.sources.every(s => s.onended === null));
  });
}

test('C reduced-motion mute sync remains orthogonal to synth/boss volumes and requires explicit opt-in', async () => {
  const h = await renderHarness(), r = h.renderer, changes = [];
  const audio = h.audio({ onMuteChange: muted => { changes.push(muted); r.setBossSoundMuted(muted); } });
  r.setBossSoundMuted(audio.isMuted()); h.unlock(); await flush();
  audio.perkPick(); r.triggerBossLaugh(); h.advance(220);
  h.reduce(true); audio.setVolume(1); r.setBossLaughVolume(1);
  assert.equal(audio.setMuted(false), true); assert.equal(audio.isMuted(), true); assert.equal(r.bossAudioDebug().muted, true);
  assert.equal(audio.debug().volume, 1); assert.equal(r.bossAudioDebug().volume, 1);
  assert.equal(h.storage.get('inkline-sound'), 'off'); h.advance(50);
  assert.equal(audio.debug().active, 0); assert.equal(r.bossAudioDebug().active, 0);
  const starts = audio.debug().starts; audio.perkPick(); assert.equal(audio.debug().starts, starts);
  h.reduce(false); assert.equal(audio.isMuted(), true); assert.equal(audio.setMuted(false), false);
  assert.equal(r.bossAudioDebug().muted, false); assert.deepEqual(changes, [true, false]);
  const fresh = mediaHarness({ reduced: true }), quiet = fresh.audio(); fresh.unlock();
  assert.equal(quiet.isMuted(), true); assert.equal(fresh.contexts.length, 0); assert.equal(quiet.setMuted(false), true);
});

test('C sound defaults open, honors stored off, and unsupported audio accepts settings without playback', () => {
  for (const stored of [null, 'on', 'unknown', 'off']) assert.equal(mediaHarness({ stored }).audio().isMuted(), stored === 'off');
  const h = mediaHarness({ unsupported: true }), audio = h.audio();
  assert.equal(audio.setVolume(0.5), 0.5); h.unlock(); audio.perkPick();
  assert.equal(audio.debug().state, 'unsupported'); assert.equal(audio.debug().active, 0);
});
