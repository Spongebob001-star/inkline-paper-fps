// 重铸包 2 · 任务 1：原生刷新率转头与 20Hz 帧间插值支撑层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import { createRuntime } from '../host/runtime.mjs';

const inputScript = new vm.Script(readFileSync(new URL('../client/input.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export function createInput', 'function createInput'));

class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, fields = {}) {
    const event = { type, ...fields };
    event.target ??= this;
    event.preventDefault ??= function () { this.defaultPrevented = true; };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

function inputHarness({ blocked = false } = {}) {
  const canvas = new FakeTarget(), document = new FakeTarget(), window = new FakeTarget();
  document.pointerLockElement = null;
  const looks = [], intents = [];
  let now = 10000;
  const intervals = [];
  const ctx = vm.createContext({
    CONFIG, canvas, document, window, performance: { now: () => now },
    setTimeout: () => 0, clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
  });
  inputScript.runInContext(ctx);
  const input = ctx.createInput(canvas, {
    onIntent: it => intents.push(it),
    onShot() {}, onReload() {}, onLock() {}, onDraw() {}, onCancelDraw() {},
    onErase() {}, onFold() {}, onLook: (yaw, pitch) => looks.push({ yaw, pitch }),
    isBlocked: () => blocked,
  });
  return {
    input, looks, intents, canvas, document,
    lock(locked = true) {
      document.pointerLockElement = locked ? canvas : null;
      document.emit('pointerlockchange');
    },
    move(x, y) { document.emit('mousemove', { movementX: x, movementY: y, target: canvas }); },
    tick() { for (const fn of intervals) fn(); return intents.at(-1); },
  };
}

test('overhaul2: mousemove fires onLook synchronously in the same event with exact floats', () => {
  const h = inputHarness();
  h.lock();
  h.move(10, -4);
  assert.equal(h.looks.length, 1);
  const sens = 0.0022;
  assert.ok(Math.abs(h.looks[0].yaw - (-10 * sens)) < 1e-12);
  assert.ok(Math.abs(h.looks[0].pitch - (4 * sens)) < 1e-12);
  assert.equal(h.input.yaw, h.looks[0].yaw);
  assert.equal(h.input.pitch, h.looks[0].pitch, 'pitch getter mirrors native-rate look');
  for (let i = 0; i < 3; i++) h.move(7, -300);
  assert.equal(h.looks.length, 4);
  assert.ok(Math.abs(h.input.pitch - 1.5) < 1e-12, 'pitch clamps at +1.5 rad');
  assert.equal(h.input.pitch, h.looks[3].pitch);
});

test('overhaul2: onLook is silent before pointer lock or while blocked, and legacy intents stay 30Hz', () => {
  const h = inputHarness();
  h.move(10, 10);
  assert.equal(h.looks.length, 0, 'unlocked canvas must not turn the view');
  h.lock();
  h.move(10, 10);
  assert.equal(h.looks.length, 1);
  assert.equal(h.intents.length, 0, 'look updates never push 30Hz intents by themselves');
  const it = h.tick();
  assert.equal(it.yaw, h.input.yaw);
  assert.equal(it.pitch, h.input.pitch);
  const blocked = inputHarness({ blocked: true });
  blocked.lock();
  blocked.move(12, 12);
  assert.equal(blocked.looks.length, 0, 'blocked input ignores look');
});

test('overhaul2: runtime.alpha returns the bounded 20Hz remainder after advance', () => {
  const rt = createRuntime({ seed: 5 });
  rt.advance(1000);
  assert.ok(rt.alpha() >= 0 && rt.alpha() < 1e-9);
  rt.advance(1000 + CONFIG.net.dt * 1000 * 0.4);
  assert.ok(Math.abs(rt.alpha() - 0.4) < 1e-6, 'alpha=' + rt.alpha());
  rt.advance(1000 + CONFIG.net.dt * 1000 * 1.4);
  assert.ok(Math.abs(rt.alpha() - 0.4) < 1e-6, 'consumed ticks leave the same fraction');
});

test('overhaul2: onBeforeStep observes the pose before every authoritative step', () => {
  const seen = [];
  const rt = createRuntime({ seed: 5, onBeforeStep: match => seen.push({ tick: match.tick, z: match.players[0].pos.z }) });
  rt.advance(1000);
  rt.setInput(0, { f: 1, r: 0, seq: 1 });
  const steps = rt.advance(1000 + CONFIG.net.dt * 1000 * 2.5);
  assert.equal(steps, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(s => s.tick), [0, 1]);
  assert.notEqual(seen[1].z, seen[0].z, 'second callback sees post-first-step pose');
  assert.equal(rt.match.tick, 2);
});
