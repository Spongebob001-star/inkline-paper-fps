import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';

// Exercise the actual input module, replacing only browser globals and time.
const inputScript = new vm.Script(readFileSync(new URL('../client/input.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export function createInput', 'function createInput'));
const COOLDOWN_HINT = '请稍等 1 秒后再次点击画面锁定鼠标';
const SENS = 0.0022;
const flush = () => new Promise(resolve => setImmediate(resolve));
const namedError = name => Object.assign(new Error(name), { name });

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    event.defaultPrevented ??= false;
    event.preventDefault ??= function () { this.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }
  emit(type, fields = {}) {
    const event = { type, ...fields };
    this.dispatchEvent(event);
    return event;
  }
}

function harness({ missingAPI = false, stateful = false } = {}) {
  const canvas = new FakeTarget(), document = new FakeTarget(), window = new FakeTarget();
  const state = { weapon: 0, drawing: false, st: 0, reload: 0, allowed: true, fireInterval: null };
  const weapons = [];
  let intervalReads = 0;
  document.pointerLockElement = null;
  let now = 10000, nextTimer = 1, fallback = false;
  const timeouts = new Map(), intervals = new Map();
  const locks = [], requests = [], intents = [], shots = [], actions = [];
  function requestWith(implementation) {
    canvas.requestPointerLock = function (...args) {
      requests.push({ receiver: this, args });
      return implementation.apply(this, args);
    };
  }
  if (!missingAPI) requestWith(() => Promise.resolve());
  const context = vm.createContext({
    CONFIG, canvas, document, window, performance: { now: () => now },
    setTimeout(fn, delay = 0) {
      const id = nextTimer++;
      timeouts.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: id => timeouts.delete(id),
    // Input cadence is driven explicitly by tick(), never by a live interval.
    setInterval(fn, delay) {
      const id = nextTimer++;
      intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval: id => intervals.delete(id),
  });
  inputScript.runInContext(context);
  const input = context.createInput(canvas, {
    onIntent: intent => intents.push({ ...intent }),
    onShot: direction => shots.push({ ...direction }),
    onLock(locked, message, compat) {
      fallback = Boolean(compat);
      locks.push({ locked, message, fallback });
    },
    onReload: () => actions.push('reload'),
    onDraw: () => actions.push('draw'),
    onCancelDraw: () => { actions.push('cancel'); state.drawing = false; },
    onErase: () => actions.push('erase'),
    onFold: () => actions.push('fold'),
    // Leave the new callbacks absent in every pre-existing test to retain default-path coverage.
    ...(stateful ? {
      onWeapon: idx => { weapons.push(idx); state.weapon = idx; },
      onQuickWall: () => { actions.push('quickWall'); state.drawing = false; },
      getWeapon: () => state.weapon,
      getFireInterval: () => { intervalReads++; return state.fireInterval ?? CONFIG.player.weapons[state.weapon].fireInterval; },
      isDrawing: () => state.drawing,
      canADS: () => state.allowed && state.st === 0 && state.reload === 0,
    } : {}),
  });
  return {
    canvas, document, window, input, locks, requests, intents, shots, actions, requestWith, state, weapons,
    get intervalReads() { return intervalReads; },
    get fallback() { return fallback; },
    get messages() { return locks.filter(event => event.message).map(event => event.message); },
    click() { canvas.emit('click'); },
    lock(locked = true) {
      document.pointerLockElement = locked ? canvas : null;
      document.emit('pointerlockchange');
    },
    move(x, y, target = canvas) { document.emit('mousemove', { movementX: x, movementY: y, target }); },
    tick() { for (const { fn } of intervals.values()) fn(); return intents.at(-1); },
    advance(ms) {
      const end = now + ms;
      let remaining = 1000;
      while (true) {
        const next = [...timeouts].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(remaining-- > 0, 'fake timeouts must settle');
        const [id, timer] = next;
        now = timer.at;
        timeouts.delete(id);
        timer.fn();
      }
      now = end;
    },
  };
}

function assertRequests(h, count) {
  assert.equal(h.requests.length, count, 'every unlocked click must request pointer lock');
  for (const { receiver, args } of h.requests) {
    assert.equal(receiver, h.canvas, 'requestPointerLock keeps the canvas receiver');
    assert.deepEqual(args, [], 'use standard requestPointerLock() with no options');
  }
}
function assertNoFallback(h) {
  assert.equal(h.fallback, false);
  assert.equal(h.locks.some(event => event.fallback), false, 'failure must not enable compatibility mode');
}
function assertRetry(h) {
  assertNoFallback(h);
  assert.ok(h.messages.length > 0, 'failure should show a retry hint');
  assert.match(h.messages.at(-1), /点击|重试|再试|retry/i);
  assert.notEqual(h.messages.at(-1), COOLDOWN_HINT, 'ordinary failure is not the unlock cooldown');
}
function view(h) { return { yaw: h.input.yaw, direction: { ...h.input.dir() } }; }
function close(actual, expected, label = 'value') {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

for (const returnType of ['promise', 'void']) {
  test(`${returnType} request: every unlocked click retries, no timeout fallback, locked clicks do not request`, async () => {
    const h = harness(), pending = deferred();
    h.requestWith(() => returnType === 'promise' ? pending.promise : undefined);
    h.click(); h.click();
    assertRequests(h, 2);
    h.advance(5000);
    await flush();
    assertNoFallback(h);
    assert.equal(h.messages.length, 0, 'elapsed time alone must not report lock failure');
    const before = view(h);
    h.move(20, 10);
    assert.deepEqual(view(h), before, 'a pending request is not permission to aim');
    h.click();
    assertRequests(h, 3);
    h.lock();
    assert.equal(h.input.locked, true);
    h.click();
    assertRequests(h, 3);
    h.lock(false);
    h.click();
    assertRequests(h, 4);
  });
}

test('missing API enables canvas-only fallback, but an API appearing later is requested and success clears fallback', async () => {
  const h = harness({ missingAPI: true });
  h.click();
  assert.equal(h.fallback, true);
  assert.equal(h.input.locked, false);
  const before = view(h);
  h.move(10, 5, h.document);
  assert.deepEqual(view(h), before);
  h.move(10, 5);
  close(h.input.yaw, -10 * SENS);
  h.requestWith(() => Promise.resolve());
  h.click();
  assertRequests(h, 1);
  await flush();
  h.lock();
  assert.equal(h.fallback, false);
  assert.equal(h.input.locked, true);
  h.lock(false);
  const unlocked = view(h);
  h.move(10, 5);
  assert.deepEqual(view(h), unlocked, 'successful locking must clear the old fallback permanently');
  h.click();
  assertRequests(h, 2);
});

for (const delivery of ['reject', 'throw']) {
  test(`explicit NotSupportedError (${delivery}) enables fallback but does not prevent later success`, async () => {
    const h = harness();
    h.requestWith(() => {
      if (delivery === 'throw') throw namedError('NotSupportedError');
      return Promise.reject(namedError('NotSupportedError'));
    });
    h.click();
    await flush();
    assert.equal(h.fallback, true);
    h.move(1, 0);
    close(h.input.yaw, -SENS);
    h.requestWith(() => Promise.resolve());
    h.click();
    assertRequests(h, 2);
    h.lock();
    await flush();
    assert.equal(h.fallback, false);
    h.lock(false);
    const before = view(h);
    h.move(1, 1);
    assert.deepEqual(view(h), before);
    h.click();
    assertRequests(h, 3);
  });
}

for (const [label, error] of [
  ['SecurityError without a prior unlock', namedError('SecurityError')],
  ['NotAllowedError', namedError('NotAllowedError')],
  ['generic Error', new Error('request failed')],
  ['untyped rejection', undefined],
]) {
  test(`${label} shows retry without fallback and does not poison future requests`, async () => {
    const h = harness();
    h.requestWith(() => Promise.reject(error));
    h.click();
    await flush();
    assertRetry(h);
    h.advance(5000);
    assertNoFallback(h);
    const before = view(h);
    h.move(5, 2);
    assert.deepEqual(view(h), before);
    h.requestWith(() => Promise.resolve());
    h.click();
    assertRequests(h, 2);
    h.lock();
    await flush();
    assert.equal(h.input.locked, true);
    assertNoFallback(h);
  });
}

test('synchronous ordinary failure shows retry and remains retryable', () => {
  const h = harness();
  h.requestWith(() => { throw new Error('blocked'); });
  assert.doesNotThrow(() => h.click());
  assertRetry(h);
  h.requestWith(() => undefined);
  h.click();
  assertRequests(h, 2);
  h.lock();
  assert.equal(h.input.locked, true);
});

test('legacy void-return pointerlockerror shows retry, never fallback, and permits another request', () => {
  const h = harness();
  h.requestWith(() => undefined);
  h.click();
  h.document.emit('pointerlockerror');
  assertRetry(h);
  h.advance(5000);
  assertNoFallback(h);
  h.click();
  assertRequests(h, 2);
  h.lock();
  assert.equal(h.input.locked, true);
});

test('promise request ignores pointerlockerror and uses the typed NotSupportedError rejection only', async () => {
  const h = harness(), pending = deferred();
  h.requestWith(() => pending.promise);
  h.click();
  h.document.emit('pointerlockerror');
  assert.equal(h.messages.length, 0, 'untyped event must not race the typed promise result');
  assertNoFallback(h);
  pending.reject(namedError('NotSupportedError'));
  await flush();
  assert.equal(h.fallback, true);
  assert.equal(h.messages.length, 1);
  h.document.emit('pointerlockerror');
  assert.equal(h.messages.length, 1, 'the duplicate event must not report a second failure');
});

for (const delay of [0, 1249, 1250]) {
  test(`SecurityError at ${delay}ms after unlock respects the 1250ms cooldown boundary`, async () => {
    const h = harness();
    h.lock(); h.lock(false);
    h.advance(delay);
    h.requestWith(() => Promise.reject(namedError('SecurityError')));
    h.click();
    await flush();
    assertNoFallback(h);
    assertRequests(h, 1);
    if (delay < 1250) assert.deepEqual(h.messages, [COOLDOWN_HINT]);
    else assertRetry(h);
  });
}

test('cooldown toast is deduplicated per unlock cycle, ignores promise error events, and never blocks retries', async () => {
  const h = harness();
  h.lock(); h.lock(false);
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = deferred();
    h.requestWith(() => pending.promise);
    h.click();
    const before = h.messages.length;
    h.document.emit('pointerlockerror');
    assert.equal(h.messages.length, before);
    pending.reject(namedError('SecurityError'));
    await flush();
    assert.deepEqual(h.messages, [COOLDOWN_HINT]);
    assertNoFallback(h);
    h.advance(100);
  }
  assertRequests(h, 3);
  h.requestWith(() => Promise.resolve());
  h.click(); h.lock();
  await flush();
  assertRequests(h, 4);
  h.lock(false);
  h.requestWith(() => Promise.reject(namedError('SecurityError')));
  h.click();
  await flush();
  assert.deepEqual(h.messages, [COOLDOWN_HINT, COOLDOWN_HINT], 'a new release allows exactly one new cooldown toast');
  assertRequests(h, 5);
  assertNoFallback(h);
});

test('ordinary rejection immediately after unlock is a retry, not a SecurityError cooldown', async () => {
  const h = harness();
  h.lock(); h.lock(false);
  h.requestWith(() => Promise.reject(new Error('ordinary failure')));
  h.click();
  await flush();
  assertRetry(h);
});

for (const end of ['locked', 'unlocked']) {
  for (const errorName of ['NotSupportedError', 'SecurityError']) {
    test(`obsolete ${errorName} after a newer success (${end}) cannot change state or warn`, async () => {
      const h = harness(), old = deferred(), current = deferred();
      h.requestWith(() => old.promise);
      h.click();
      h.requestWith(() => current.promise);
      h.click();
      assertRequests(h, 2);
      h.lock();
      current.resolve();
      await flush();
      if (end === 'unlocked') h.lock(false);
      const notices = h.locks.length, before = view(h);
      old.reject(namedError(errorName));
      await flush();
      assert.equal(h.input.locked, end === 'locked');
      assertNoFallback(h);
      assert.equal(h.locks.length, notices, 'stale completion must be silent');
      assert.deepEqual(view(h), before);
      if (end === 'unlocked') {
        h.move(10, 10);
        assert.deepEqual(view(h), before, 'stale failure must not restore fallback aiming');
        h.click();
        assertRequests(h, 3);
      }
    });
  }
}

test('a successful lock/unlock also invalidates its own still-pending rejection', async () => {
  const h = harness(), pending = deferred();
  h.requestWith(() => pending.promise);
  h.click();
  h.lock(); h.lock(false);
  const notices = h.locks.length;
  pending.reject(namedError('NotSupportedError'));
  await flush();
  assertNoFallback(h);
  assert.equal(h.locks.length, notices);
  assert.equal(h.input.locked, false);
});

test('unlocked document and canvas mouse motion do not aim', () => {
  const h = harness();
  h.input.setView(0.4, -0.2);
  const before = view(h);
  h.move(20, -10);
  h.move(20, -10, h.document);
  assert.deepEqual(view(h), before);
  h.lock(); h.lock(false);
  h.move(20, -10);
  assert.deepEqual(view(h), before);
});

for (const mode of ['locked', 'fallback']) {
  test(`${mode} aiming ignores nonfinite movement and either-axis spikes without corrupting direction`, () => {
    const h = harness({ missingAPI: mode === 'fallback' });
    if (mode === 'locked') h.lock(); else h.click();
    h.input.setView(0.4, -0.2);
    const before = view(h);
    for (const [x, y] of [
      [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], [-Infinity, 1], [1, -Infinity],
      [undefined, 1], [1, undefined], [301, 1], [-301, 1], [1, 301], [1, -301], [10000, -10000],
    ]) {
      h.move(x, y);
      assert.deepEqual(view(h), before, `invalid movement (${x}, ${y}) must discard the whole event`);
    }
    h.move(0.25, -0.5);
    close(h.input.yaw, 0.4 - 0.25 * SENS, 'small yaw');
    close(h.tick().pitch, -0.2 + 0.5 * SENS, 'small pitch');
  });

  test(`${mode} normal movement keeps yaw direction, accepts 300px, and clamps pitch at both limits`, () => {
    const h = harness({ missingAPI: mode === 'fallback' });
    if (mode === 'locked') h.lock(); else h.click();
    // Locked movement can originate anywhere; fallback movement must originate on canvas.
    const target = mode === 'locked' ? h.document : h.canvas;
    h.move(10, -20, target);
    const yaw = -10 * SENS, pitch = 20 * SENS;
    close(h.input.yaw, yaw, 'yaw');
    close(h.tick().pitch, pitch, 'pitch');
    const direction = h.input.dir();
    close(direction.x, -Math.sin(yaw) * Math.cos(pitch), 'direction.x');
    close(direction.y, Math.sin(pitch), 'direction.y');
    close(direction.z, -Math.cos(yaw) * Math.cos(pitch), 'direction.z');
    h.input.setView(0, 0);
    h.move(300, -300, target);
    close(h.input.yaw, -300 * SENS, '300px yaw is valid');
    close(h.tick().pitch, 300 * SENS, '300px pitch is valid');
    for (let i = 0; i < 3; i++) h.move(0, -300, target);
    close(h.tick().pitch, 1.5, 'upper pitch clamp');
    for (let i = 0; i < 6; i++) h.move(0, 300, target);
    close(h.tick().pitch, -1.5, 'lower pitch clamp');
    if (mode === 'fallback') {
      const before = view(h);
      h.move(20, 20, h.document);
      h.move(20, 20, new FakeTarget());
      assert.deepEqual(view(h), before, 'fallback ignores motion over other targets');
    }
  });
}

test('existing key intents, action keys, jump consumption and blur reset remain intact', () => {
  const h = harness();
  h.lock();
  for (const code of ['KeyW', 'KeyD', 'ShiftLeft', 'KeyF']) h.document.emit('keydown', { code });
  const space = h.document.emit('keydown', { code: 'Space' });
  assert.equal(space.defaultPrevented, true);
  const first = h.tick();
  assert.equal(first.f, 1); assert.equal(first.r, 1);
  assert.equal(first.sprint, true); assert.equal(first.hold, true); assert.equal(first.jump, true);
  const second = h.tick();
  assert.equal(second.seq, first.seq + 1);
  assert.equal(second.jump, false, 'jump is consumed by one intent');
  for (const code of ['KeyR', 'KeyQ', 'KeyE', 'KeyC']) {
    h.document.emit('keydown', { code });
    h.document.emit('keydown', { code, repeat: true });
  }
  assert.deepEqual(h.actions, ['reload', 'draw', 'erase', 'fold']);
  h.document.emit('keyup', { code: 'KeyW' });
  assert.equal(h.tick().f, 0);
  h.window.emit('blur');
  const reset = h.tick();
  assert.equal(reset.f, 0); assert.equal(reset.r, 0);
  assert.equal(reset.sprint, false); assert.equal(reset.hold, false);
});

for (const mode of ['locked', 'fallback']) {
  test(`${mode} keeps mouse fire cadence, mouseup, cancel drawing and blur behavior`, () => {
    const h = harness({ missingAPI: mode === 'fallback' });
    h.document.emit('mousedown', { button: 0, target: h.canvas });
    h.tick();
    assert.equal(h.shots.length, 0, 'unlocked without fallback cannot fire');
    if (mode === 'locked') h.lock(); else h.click();
    h.document.emit('keydown', { code: 'KeyF' });
    h.document.emit('mousedown', { button: 0, target: h.canvas });
    assert.equal(h.tick().hold, false, 'firing prevents the existing hold intent');
    assert.equal(h.shots.length, 1);
    assert.deepEqual(h.shots[0], { ...h.input.dir() });
    const interval = CONFIG.player.gun.fireInterval * 1000;
    h.advance(interval - 1); h.tick();
    assert.equal(h.shots.length, 1);
    h.advance(1); h.tick();
    assert.equal(h.shots.length, 2);
    h.document.emit('mouseup', { button: 0 });
    h.advance(interval); h.tick();
    assert.equal(h.shots.length, 2);
    h.document.emit('mousedown', { button: 2, target: h.canvas });
    assert.deepEqual(h.actions, ['cancel']);
    assert.equal(h.canvas.emit('contextmenu').defaultPrevented, true);
    h.document.emit('mousedown', { button: 0, target: h.canvas });
    h.window.emit('blur');
    h.advance(interval); h.tick();
    assert.equal(h.shots.length, 2);
    if (mode === 'locked') {
      h.document.emit('mousedown', { button: 0, target: h.canvas });
      h.lock(false); h.lock();
      h.advance(interval); h.tick();
      assert.equal(h.shots.length, 2, 'unlock stops held fire');
    }
  });
}

function activeHarness(mode) {
  const h = harness({ missingAPI: mode === 'fallback', stateful: true });
  if (mode === 'locked') h.lock(); else h.click();
  return h;
}
function rmb(h) { h.document.emit('mousedown', { button: 2, target: h.canvas }); }
function key(h, code, repeat = false) { return h.document.emit('keydown', { code, repeat }); }
function wheel(h, deltaY) { return h.document.emit('wheel', { deltaY, target: h.canvas }); }
function beginADS(h) {
  h.state.weapon = 2;
  rmb(h);
  assert.equal(h.input.ads, true, 'fresh RMB should enter liner ADS');
}

test('new optional callbacks remain optional and cannot introduce extra firing', () => {
  const h = harness();
  h.lock();
  assert.equal(h.input.ads, false);
  assert.doesNotThrow(() => {
    key(h, 'Digit2'); key(h, 'KeyG'); wheel(h, 1); h.input.cancelADS();
  });
  rmb(h);
  assert.deepEqual(h.actions, ['cancel'], 'default weapon retains old RMB cancellation');
  assert.equal(h.input.ads, false);
  h.tick();
  assert.equal(h.shots.length, 0);
});

test('unlocked wheel, including after unlock, neither switches nor consumes debounce; RMB cannot ADS', () => {
  const h = harness({ stateful: true });
  h.state.weapon = 2;
  assert.equal(wheel(h, 1).defaultPrevented, false);
  assert.equal(wheel(h, -1).defaultPrevented, false);
  rmb(h);
  assert.equal(h.input.ads, false);
  assert.deepEqual(h.weapons, []);
  h.lock();
  wheel(h, 1);
  assert.deepEqual(h.weapons, [0]);
  h.lock(false);
  h.advance(120);
  assert.equal(wheel(h, 1).defaultPrevented, false);
  assert.deepEqual(h.weapons, [0]);
  h.lock();
  wheel(h, 1);
  assert.deepEqual(h.weapons, [0, 1]);
  h.tick();
  assert.equal(h.shots.length, 0);
});

for (const mode of ['locked', 'fallback']) {
  test(`${mode} Digit1/2/3 select zero-based weapons, ignoring same, repeated and unrelated keys`, () => {
    const h = activeHarness(mode);
    assert.equal(key(h, 'Digit1').defaultPrevented, true);
    assert.deepEqual(h.weapons, []);
    for (const code of ['Digit2', 'Digit3', 'Digit1']) {
      assert.equal(key(h, code).defaultPrevented, true);
      key(h, code);
      key(h, code, true);
    }
    for (const code of ['Digit0', 'Digit4', 'Numpad1']) assert.equal(key(h, code).defaultPrevented, false);
    key(h, 'Digit3', true);
    assert.deepEqual(h.weapons, [1, 2, 0]);
    key(h, 'KeyG'); key(h, 'KeyG', true);
    assert.deepEqual(h.actions, ['quickWall']);
    h.tick();
    assert.equal(h.shots.length, 0);
  });

  test(`${mode} wheel direction, three-weapon wrapping, zero delta and exact 120ms debounce`, () => {
    const h = activeHarness(mode);
    assert.equal(wheel(h, 0).defaultPrevented, false);
    assert.equal(wheel(h, 1).defaultPrevented, true);
    assert.deepEqual(h.weapons, [1], 'zero delta must not start the debounce');
    assert.equal(wheel(h, 1).defaultPrevented, true);
    h.advance(119);
    wheel(h, -1);
    assert.deepEqual(h.weapons, [1]);
    h.advance(1);
    wheel(h, 999);
    assert.deepEqual(h.weapons, [1, 2], 'debounced events must not extend the deadline');
    h.advance(120); wheel(h, 1);
    h.advance(120); wheel(h, -1);
    h.advance(120); wheel(h, -999);
    h.advance(120); wheel(h, -1);
    assert.deepEqual(h.weapons, [1, 2, 0, 2, 1, 0]);
    h.advance(120); wheel(h, -0); wheel(h, -0.01);
    assert.deepEqual(h.weapons, [1, 2, 0, 2, 1, 0, 2]);
    h.tick();
    assert.equal(h.shots.length, 0);
  });

  for (const weapon of [0, 1, 2]) {
    test(`${mode} ${CONFIG.player.weapons[weapon].id} held fire uses its dynamic interval and stops on release`, () => {
      const h = activeHarness(mode);
      h.state.weapon = weapon;
      const interval = CONFIG.player.weapons[weapon].fireInterval * 1000;
      h.document.emit('mousedown', { button: 0, target: h.canvas });
      assert.equal(h.shots.length, 0, 'mousedown only queues held fire');
      h.tick();
      assert.equal(h.shots.length, 1);
      for (let expected = 2; expected <= 4; expected++) {
        h.advance(interval - 1); h.tick();
        assert.equal(h.shots.length, expected - 1);
        h.advance(1); h.tick(); h.tick();
        assert.equal(h.shots.length, expected, 'one shot, not catch-up or duplicate shots');
      }
      assert.ok(h.intervalReads >= 7, 'the callback is re-read while held');
      h.document.emit('mouseup', { button: 0 });
      h.advance(interval * 2); h.tick();
      assert.equal(h.shots.length, 4);
      for (const direction of h.shots) assert.deepEqual(direction, { ...h.input.dir() });
    });
  }

  test(`${mode} held fire immediately respects a changed weapon or interval without resetting last-shot time`, () => {
    const h = activeHarness(mode);
    h.document.emit('mousedown', { button: 0, target: h.canvas });
    h.tick();
    key(h, 'Digit3');
    h.advance(140); h.tick();
    assert.equal(h.shots.length, 1, 'liner must not inherit the pen interval');
    h.advance(710); h.tick();
    assert.equal(h.shots.length, 2);
    h.advance(139); key(h, 'Digit1'); h.tick();
    assert.equal(h.shots.length, 2);
    h.advance(1); h.tick();
    assert.equal(h.shots.length, 3, 'switching to pen uses 140ms since the previous shot');
    h.state.fireInterval = 0.5;
    h.advance(499); h.tick();
    assert.equal(h.shots.length, 3);
    h.advance(1); h.tick();
    assert.equal(h.shots.length, 4, 'cadence must call getFireInterval, not hard-code the weapon table');
  });

  test(`${mode} RMB prioritizes drawing cancellation for every weapon and requires a fresh press for ADS`, () => {
    const h = activeHarness(mode);
    for (const weapon of [0, 1, 2]) {
      h.state.weapon = weapon;
      h.state.drawing = true;
      rmb(h);
      assert.equal(h.state.drawing, false);
      assert.equal(h.input.ads, false, 'canceling a drawing cannot also enter ADS');
      h.tick();
      assert.equal(h.input.ads, false);
    }
    assert.deepEqual(h.actions, ['cancel', 'cancel', 'cancel']);
    h.document.emit('mouseup', { button: 2 });
    rmb(h);
    assert.equal(h.input.ads, true);
    assert.deepEqual(h.actions, ['cancel', 'cancel', 'cancel']);
    h.tick();
    assert.equal(h.shots.length, 0);
  });

  test(`${mode} ADS requires liner and canADS permission, with no shots from RMB or recovery`, () => {
    const h = activeHarness(mode);
    for (const state of [
      { weapon: 0 }, { weapon: 1 }, { weapon: 2, reload: 0.1 },
      { weapon: 2, st: 1 }, { weapon: 2, st: 2 }, { weapon: 2, allowed: false },
    ]) {
      Object.assign(h.state, { weapon: 2, reload: 0, st: 0, allowed: true }, state);
      rmb(h);
      assert.equal(h.input.ads, false, JSON.stringify(state));
      Object.assign(h.state, { weapon: 2, reload: 0, st: 0, allowed: true });
      h.tick();
      assert.equal(h.input.ads, false, 'becoming eligible does not synthesize a fresh RMB');
    }
    beginADS(h);
    h.tick();
    assert.equal(h.shots.length, 0);
  });

  test(`${mode} ADS scales both axes by 0.42, rejects invalid motion and restores hip sensitivity`, () => {
    const h = activeHarness(mode);
    beginADS(h);
    h.input.setView(0.4, -0.2);
    const target = mode === 'locked' ? h.document : h.canvas;
    h.move(10, -20, target);
    close(h.input.yaw, 0.4 - 10 * SENS * 0.42);
    close(h.tick().pitch, -0.2 + 20 * SENS * 0.42);
    const before = view(h);
    for (const [x, y] of [
      [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], [-Infinity, 0],
      [0, -Infinity], [undefined, 1], [1, undefined], [301, 1], [1, -301],
    ]) {
      h.move(x, y, target);
      assert.deepEqual(view(h), before);
    }
    if (mode === 'fallback') {
      h.move(10, 20, h.document);
      assert.deepEqual(view(h), before);
    }
    h.input.setView(0, 1.49); h.move(0, -300, target);
    close(h.tick().pitch, 1.5);
    h.input.setView(0, -1.49); h.move(0, 300, target);
    close(h.tick().pitch, -1.5);
    h.input.cancelADS();
    h.input.setView(0, 0); h.move(10, -20, target);
    close(h.input.yaw, -10 * SENS);
    close(h.tick().pitch, 20 * SENS);
    for (const value of Object.values(h.input.dir())) assert.ok(Number.isFinite(value));
    assert.equal(h.shots.length, 0);
  });

  for (const synchronizer of ['getter', 'tick', 'motion']) {
    test(`${mode} ${synchronizer} permanently clears ADS on reload, downed/dead, weapon or drawing changes`, () => {
      const h = activeHarness(mode);
      for (const invalid of [{ reload: 1 }, { st: 1 }, { st: 2 }, { weapon: 0 }, { weapon: 1 }, { drawing: true }, { allowed: false }]) {
        Object.assign(h.state, { weapon: 2, reload: 0, st: 0, drawing: false, allowed: true });
        beginADS(h);
        Object.assign(h.state, invalid);
        if (synchronizer === 'getter') assert.equal(h.input.ads, false, JSON.stringify(invalid));
        if (synchronizer === 'tick') h.tick();
        if (synchronizer === 'motion') {
          h.input.setView(0, 0); h.move(1, 1);
          close(h.input.yaw, -SENS, 'invalid ADS must use hip sensitivity immediately');
        }
        Object.assign(h.state, { weapon: 2, reload: 0, st: 0, drawing: false, allowed: true });
        assert.equal(h.input.ads, false, 'restoring state must not reactivate a stale RMB');
        h.tick();
        assert.equal(h.input.ads, false);
        h.document.emit('mouseup', { button: 2 });
        beginADS(h);
      }
      assert.equal(h.shots.length, 0);
    });
  }

  test(`${mode} release, R/Q/G, weapon switch, wheel, blur and cancelADS exit without extra firing`, () => {
    const exits = [
      h => h.document.emit('mouseup', { button: 2 }),
      h => key(h, 'KeyR'), h => key(h, 'KeyQ'), h => key(h, 'KeyG'),
      h => key(h, 'Digit1'), h => wheel(h, 1),
      h => h.window.emit('blur'), h => h.input.cancelADS(),
    ];
    for (const exit of exits) {
      const h = activeHarness(mode);
      beginADS(h); exit(h);
      assert.equal(h.input.ads, false);
      h.state.weapon = 2;
      h.advance(1000); h.tick();
      assert.equal(h.input.ads, false);
      assert.equal(h.shots.length, 0);
      h.document.emit('mouseup', { button: 2 }); beginADS(h);
    }
  });

  test(`${mode} selecting the current liner and non-switching wheel events do not cancel ADS`, () => {
    const h = activeHarness(mode);
    wheel(h, 1);
    beginADS(h);
    key(h, 'Digit3'); key(h, 'Digit1', true); wheel(h, 0); wheel(h, 1);
    assert.equal(h.input.ads, true);
    assert.deepEqual(h.weapons, [1]);
    h.advance(120); wheel(h, 1);
    assert.equal(h.input.ads, false);
    assert.deepEqual(h.weapons, [1, 0]);
  });

  test(`${mode} ADS toggling cannot add shots to an existing left-button firing cadence`, () => {
    const h = activeHarness(mode);
    h.state.weapon = 2;
    const interval = CONFIG.player.weapons[2].fireInterval * 1000;
    h.document.emit('mousedown', { button: 0, target: h.canvas });
    h.tick();
    rmb(h); h.tick();
    assert.equal(h.shots.length, 1);
    h.advance(interval - 1); h.tick();
    assert.equal(h.shots.length, 1);
    h.document.emit('mouseup', { button: 2 });
    h.advance(1); h.tick();
    assert.equal(h.shots.length, 2, 'RMB release must not release left-button firing');
    h.document.emit('mouseup', { button: 0 });
    rmb(h); h.advance(interval); h.tick();
    assert.equal(h.shots.length, 2, 'RMB cannot restart left-button firing');
  });
}

test('pointer unlock cancels ADS permanently across relock until another RMB press', () => {
  const h = activeHarness('locked');
  beginADS(h);
  h.lock(false);
  assert.equal(h.input.ads, false);
  h.lock(); h.tick();
  assert.equal(h.input.ads, false);
  h.input.setView(0, 0); h.move(10, 0);
  close(h.input.yaw, -10 * SENS);
  assert.equal(h.shots.length, 0);
  beginADS(h);
});
