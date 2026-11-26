// OVERHAUL-3B：语音移除 + 新 BGM + 战场生态音效单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import { createMatch } from '../shared/sim.mjs';
import { DEFAULT_SETTINGS, normalizeSettings, loadSettings } from '../client/settings.mjs';

const rootUrl = new URL('../', import.meta.url);
const audioSource = readFileSync(new URL('../client/audio.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export function createAudio', 'function createAudio');
const bgmSource = readFileSync(new URL('../client/bgm.mjs', import.meta.url), 'utf8')
  .replace('export function createBgm', 'function createBgm');
const audioScript = new vm.Script(audioSource + '\n;globalThis.__createAudio = createAudio;');
const bgmScript = new vm.Script(bgmSource + '\n;globalThis.__createBgm = createBgm;');

function fakeHost({ reduced = false, running = true } = {}) {
  const listeners = new Map(), intervals = new Map(), made = [];
  let clock = 1000, nextId = 1;
  const param = value => {
    const p = { value, history: [] };
    p.setValueAtTime = v => { p.value = v; p.history.push(v); return p; };
    p.linearRampToValueAtTime = v => { p.value = v; p.history.push(v); return p; };
    p.exponentialRampToValueAtTime = v => { p.value = v; p.history.push(v); return p; };
    p.cancelScheduledValues = () => p;
    p.setTargetAtTime = v => { p.value = v; p.target = v; p.history.push(v); return p; };
    return p;
  };
  const node = (kind, extra = {}) => {
    const n = { kind, connect() {}, disconnect() {}, ...extra };
    made.push(n); return n;
  };
  const ctx = {
    state: running ? 'running' : 'suspended', currentTime: 0, sampleRate: 44100, destination: {}, made,
    onstatechange: null,
    resume() { this.state = 'running'; return Promise.resolve(); },
    createGain() { return node('gain', { gain: param(1) }); },
    createOscillator() {
      return node('osc', { type: 'sine', frequency: param(440), detune: param(0), started: null, stopped: null,
        start(at) { this.started = at; }, stop(at) { this.stopped = at; }, onended: null });
    },
    createBufferSource() {
      return node('source', { buffer: null, started: null, stopped: null, start(at) { this.started = at; }, stop(at) { this.stopped = at; }, onended: null });
    },
    createBiquadFilter() { return node('filter', { type: 'lowpass', frequency: param(1000), Q: param(1), gain: param(0) }); },
    createWaveShaper() { return node('shaper', { curve: null, oversample: 'none' }); },
    createDynamicsCompressor() {
      return node('comp', { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25), reduction: 0 });
    },
    createDelay() { return node('delay', { delayTime: param(0.25) }); },
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; },
    decodeAudioData() { return Promise.resolve({}); },
  };
  function FakeAudio() { return ctx; }
  const win = {
    AudioContext: FakeAudio, matchMedia: () => ({ matches: reduced, addEventListener() {}, addListener() {} }),
    localStorage: { getItem: () => null }, navigator: { userActivation: { isActive: true } },
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
    setInterval(fn) { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    performance: { now: () => clock },
  };
  const context = vm.createContext({
    window: win, CONFIG, performance: win.performance, console, setTimeout, clearTimeout,
  });
  win.window = win;
  return {
    ctx, made, intervals, win, listeners,
    unlock() { listeners.get('pointerdown')?.({ isTrusted: true }); },
    advance(ms) { clock += ms; },
    runIntervals(dt = 0.1) { ctx.currentTime += dt; for (const fn of intervals.values()) fn(); },
    newNodesSince(n) { return made.slice(n); },
    maxRampSince(n) {
      let max = 0;
      for (const node of made.slice(n)) {
        if (node.kind !== 'gain') continue;
        for (const v of node.gain.history || []) max = Math.max(max, Math.abs(v));
      }
      return max;
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('overhaul3b: 中文语音文件/接入彻底移除，bs.json 与 5 个模型内联保持不变', () => {
  assert.equal(existsSync(new URL('../client/voice.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/audio/voice_pack.mp3', import.meta.url)), false);
  assert.equal(existsSync(new URL('../tools/build_voice_pack.py', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/models/bs.json', import.meta.url)), true);
  const build = readFileSync(new URL('../client/build.mjs', import.meta.url), 'utf8');
  for (const name of ['__inlineVoice', '__VOICE_B64', '__VOICE_BUF', 'voice_pack.mp3', 'inlineVoiceFetches']) {
    assert.ok(!build.includes(name), name + ' must be gone from build.mjs');
  }
  const render = readFileSync(new URL('../client/render.mjs', import.meta.url), 'utf8');
  assert.ok(!render.includes('/src/models/bs.json'));
  assert.ok(!readFileSync(new URL('../client/main.mjs', import.meta.url), 'utf8').includes('createVoice'));
  const html = readFileSync(new URL('../dev/client.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('voice-comms'));
  const hud = readFileSync(new URL('../client/hud.mjs', import.meta.url), 'utf8');
  assert.ok(!hud.includes('showComms') && !hud.includes('战术语音'));
});

test('overhaul3b: settings exposes six keys, default bgm 0.65, legacy voiceVolume silently ignored', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    sensitivity: 0.0022, fov: 68, sfxVolume: 0.85, bossVolume: 0.35, bgmVolume: 0.65, showGuide: true,
  });
  const raw = { sensitivity: 0.003, fov: 80, sfxVolume: 0.5, bossVolume: 0.2, bgmVolume: 0.4, voiceVolume: 0.9, showGuide: false, extra: 1 };
  assert.deepEqual(normalizeSettings(raw), {
    sensitivity: 0.003, fov: 80, sfxVolume: 0.5, bossVolume: 0.2, bgmVolume: 0.4, showGuide: false,
  });
  const legacy = { getItem: () => JSON.stringify({ ...raw, voiceVolume: 0.77 }) };
  assert.deepEqual(loadSettings(legacy), normalizeSettings(raw));
  const storage = new Map();
  const bad = { sensitivity: Infinity, fov: 0, sfxVolume: 2, bossVolume: -1, bgmVolume: 9, voiceVolume: 9 };
  assert.deepEqual(normalizeSettings(bad), { ...DEFAULT_SETTINGS, fov: 60, sfxVolume: 1, bossVolume: 0, bgmVolume: 1 });
});

test('overhaul3b: eleven soundscape effects exist, emit voices and respect cooldowns', async () => {
  const h = fakeHost();
  const context = vm.createContext({ window: h.win, CONFIG, performance: h.win.performance, console, setTimeout, clearTimeout });
  audioScript.runInContext(context);
  const audio = context.__createAudio({});
  h.unlock(); await flush(); await flush();
  const methods = ['footstep', 'jump', 'land', 'craneCharge', 'eraserBite', 'planeDive', 'bulletWhiz', 'anchorTick', 'anchorDone', 'heartbeat', 'bossSpawn', 'paperTear'];
  for (const name of methods) assert.equal(typeof audio[name], 'function', name);
  assert.equal(audio.debug().maxVoices, 18);
  const kinds = () => audio.debug().voices.map(v => v.kind);
  audio.footstep(false);
  assert.ok(kinds().includes('footstep'));
  const voicesBefore = audio.debug().voices.length;
  assert.equal(audio.footstep(true), false, 'footstep cooldown');
  assert.equal(audio.debug().voices.length, voicesBefore, 'cooldown emits no new voice');
  for (const [fn, kind] of [
    [() => audio.jump(), 'jump'], [() => audio.land(6), 'land'],
    [() => audio.craneCharge(0.8), 'craneCharge'], [() => audio.eraserBite(0.5), 'eraserBite'],
    [() => audio.planeDive(0.4), 'planeDive'], [() => audio.anchorTick(0.5), 'anchorTick'],
    [() => audio.anchorDone(), 'anchorDone'], [() => audio.heartbeat(), 'heartbeat'],
    [() => audio.bossSpawn(), 'bossSpawn'], [() => audio.paperTear(), 'paperTear'],
  ]) {
    audio.stop();
    fn();
    assert.ok(kinds().includes(kind), kind + ' voice');
  }
  audio.stop();
});

test('overhaul3b: distance attenuation changes envelope gain; whiz marks each projectile once', async () => {
  const h = fakeHost();
  const context = vm.createContext({ window: h.win, CONFIG, performance: h.win.performance, console, setTimeout, clearTimeout });
  audioScript.runInContext(context);
  const audio = context.__createAudio({});
  h.unlock(); await flush(); await flush();
  let mark = h.made.length;
  audio.eraserBite(1.0);
  const near = h.maxRampSince(mark);
  h.advance(400);
  mark = h.made.length;
  audio.eraserBite(0.15);
  const far = h.maxRampSince(mark);
  assert.ok(near > far * 3, `distance attenuation ${near} vs ${far}`);

  const proj = [{ id: 1, x: 0, y: 1.65, z: 0 }];
  const pos = { x: 0, y: 1.65, z: 0 };
  assert.equal(audio.bulletWhiz(proj, pos), true, 'near projectile whizes');
  assert.equal(audio.bulletWhiz(proj, pos), false, 'same projectile id never repeats');
  proj.push({ id: 2, x: 0, y: 1.65, z: 0 });
  assert.equal(audio.bulletWhiz(proj, pos), false, 'global 320ms cooldown');
  h.advance(400);
  proj.push({ id: 3, x: 0, y: 1.65, z: 0 });
  assert.equal(audio.bulletWhiz(proj, pos), true);
  proj.push({ id: 4, x: 9, y: 1.65, z: 9 });
  assert.equal(audio.bulletWhiz(proj, pos), false, 'far projectile ignored');
  assert.equal(audio.debug().whizTracked, 3, 'near ids are marked even while cooling');
  audio.stop();
});

test('overhaul3b: BGM has four modes, schedules rich layers and ducks to 0.55 during laugh', async () => {
  const h = fakeHost();
  const context = vm.createContext({ window: h.win, CONFIG, performance: h.win.performance, console, setTimeout, clearTimeout });
  bgmScript.runInContext(context);
  const bgm = context.__createBgm();
  h.unlock(); await flush();
  assert.equal(bgm.setMode('anchors'), 'anchors');
  assert.equal(bgm.debug().bpm, 120);
  for (let i = 0; i < 6; i++) h.runIntervals(0.25);
  const dbg = bgm.debug();
  assert.ok(dbg.notes > 20, 'notes=' + dbg.notes);
  assert.ok(dbg.graph.includes('delay') && dbg.graph.includes('comp') && dbg.graph.includes('toneBus'));
  const comp = h.made.find(n => n.kind === 'comp');
  assert.equal(comp.threshold.value, -16);
  assert.equal(comp.ratio.value, 4);
  assert.equal(bgm.setMode('boss12'), 'boss12');
  assert.equal(bgm.debug().bpm, 132);
  assert.equal(bgm.setMode('boss3'), 'boss3');
  assert.equal(bgm.debug().bpm, 144);
  assert.equal(bgm.setMode('escape'), 'escape');
  assert.equal(bgm.debug().bpm, 136);
  const base = bgm.debug().targetGain;
  bgm.setDuck(true);
  assert.ok(Math.abs(bgm.debug().targetGain - base * 0.55) < 1e-3, 'laugh duck 0.55x');
  bgm.setDuck(false);
  bgm.setPaused(true);
  assert.ok(Math.abs(bgm.debug().targetGain - base * 0.4) < 1e-3, 'practice pause 0.4x');
  bgm.setPaused(false);
  bgm.setMuted(true);
  assert.equal(bgm.debug().targetGain, 0);
  assert.equal(bgm.debug().running, false);
  bgm.setMuted(false);
  assert.equal(bgm.debug().running, true);
  bgm.stop();
  assert.equal(bgm.debug().mode, 'idle');
  assert.equal(h.intervals.size, 0);
});

test('overhaul3b: reduced motion forces BGM silence and idle never schedules', async () => {
  const h = fakeHost({ reduced: true });
  const context = vm.createContext({ window: h.win, CONFIG, performance: h.win.performance, console, setTimeout, clearTimeout });
  bgmScript.runInContext(context);
  const bgm = context.__createBgm();
  h.unlock();
  bgm.setMode('anchors');
  assert.equal(bgm.debug().muted, true);
  assert.equal(bgm.debug().running, false);
  bgm.setMode('idle');
  assert.equal(bgm.debug().running, false);
  assert.equal(h.intervals.size, 0);
});
