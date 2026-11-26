import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import { createRuntime } from '../host/runtime.mjs';
import { weaponOf } from '../shared/sim.mjs';

const mainSource = readFileSync(new URL('../client/main.mjs', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const a = mainSource.indexOf(start), b = mainSource.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `actual main source boundaries must exist: ${start} -> ${end}`);
  return mainSource.slice(a, b);
}
// Run the real handlers, not a second implementation of quick-wall geometry or validation.
const drawScript = new vm.Script(
  sourceBetween('function aimGround()', 'function handleErase()'),
  { filename: 'main-draw-handlers.mjs' },
);
const buttonScript = new vm.Script(
  sourceBetween('const enterButton =', 'function finish('),
  { filename: 'main-button-handlers.mjs' },
);
const inputWiringScript = new vm.Script(
  sourceBetween('const input = createInput(', "document.addEventListener('keydown', ev =>"),
  { filename: 'main-input-wiring.mjs' },
);
const close = (actual, expected, label = 'value') => assert.ok(
  Math.abs(actual - expected) < 1e-10, `${label}: expected ${expected}, got ${actual}`,
);

function drawHarness({ yaw = 0, x = 0, z = 0, ink = 100, st = 0, playerIds = [0] } = {}) {
  const runtime = createRuntime({ seed: 42, playerIds });
  const match = runtime.match, player = match.players[0];
  Object.assign(player.pos, { x, z });
  Object.assign(player, { ink, st, yaw: 1.23 }); // Deliberately stale host yaw; use input.yaw.
  const calls = [], order = [], toasts = [], previews = [], hints = [];
  const action = runtime.action.bind(runtime);
  runtime.action = (id, message) => {
    order.push(message.m);
    const result = action(id, message);
    calls.push({ id, message: { ...message }, result });
    return result;
  };
  const input = {
    yaw, ads: true,
    dir: () => ({ x: 0, y: 0, z: -1 }),
    cancelADS() { order.push('cancelADS'); this.ads = false; },
  };
  const context = vm.createContext({
    CONFIG, runtime, match, input, ended: false, drawStart: null,
    renderer: { setDrawStart: value => { previews.push(value); order.push('preview'); } },
    hud: {
      toast: message => toasts.push(message),
      drawHint: value => { hints.push(value); order.push('hint'); },
    },
  });
  drawScript.runInContext(context);
  return { runtime, match, player, context, input, calls, order, toasts, previews, hints,
    quick: () => context.handleQuickWall(), draw: () => context.handleDraw() };
}
function assertEndpoints(message, [ax, az, bx, bz]) {
  assert.equal(message.m, 'drawEnd');
  for (const [key, expected] of Object.entries({ ax, az, bx, bz })) close(message[key], expected, key);
}
function assertNoWallMutation(h, ink) {
  assert.equal(h.match.walls.length, 0);
  assert.equal(h.player.ink, ink);
  assert.equal(h.player.stats.walls, 0);
  assert.equal(h.match.events.filter(e => e.type === 'wallDraw').length, 0);
}

for (const [name, yaw, endpoints] of [
  ['north', 0, [-1.6, -3.5, 1.6, -3.5]],
  ['west', Math.PI / 2, [-3.5, 1.6, -3.5, -1.6]],
  ['south', Math.PI, [1.6, 3.5, -1.6, 3.5]],
  ['east', -Math.PI / 2, [3.5, -1.6, 3.5, 1.6]],
  ['diagonal', Math.PI / 4, [-5.1 / Math.SQRT2, -1.9 / Math.SQRT2, -1.9 / Math.SQRT2, -5.1 / Math.SQRT2]],
]) {
  test(`quick wall ${name}: actual input yaw gives perpendicular 3.2m wall 3.5m ahead and costs 32.8`, () => {
    const h = drawHarness({ yaw, x: 2, z: 3 });
    const res = h.quick();
    assert.equal(res.ok, true);
    assert.equal(res, h.calls[1].result, 'return the authoritative runtime result unchanged');
    assert.deepEqual(h.calls.map(c => [c.id, c.message.m]), [[0, 'drawStart'], [0, 'drawEnd']]);
    assert.deepEqual(h.order, ['preview', 'hint', 'cancelADS', 'drawStart', 'drawEnd']);
    const translated = endpoints.map((value, i) => value + (i % 2 === 0 ? 2 : 3));
    assertEndpoints(h.calls[1].message, translated);
    const wall = res.wall;
    assert.equal(wall, h.match.walls[0]);
    close(wall.len, 3.2);
    close(Math.hypot(wall.x - 2, wall.z - 3), 3.5);
    close((wall.x - 2) * wall.ux + (wall.z - 3) * wall.uz, 0, 'wall is perpendicular to forward');
    close(wall.x - wall.ux * wall.len / 2, translated[0]);
    close(wall.z - wall.uz * wall.len / 2, translated[1]);
    close(wall.x + wall.ux * wall.len / 2, translated[2]);
    close(wall.z + wall.uz * wall.len / 2, translated[3]);
    close(100 - h.player.ink, 32.8);
    assert.equal(h.player.stats.walls, 1);
    assert.equal(h.match.events.filter(e => e.type === 'wallDraw').length, 1);
    assert.equal(h.input.ads, false);
    assert.deepEqual(h.previews, [null]);
    assert.deepEqual(h.hints, [false]);
    assert.match(h.toasts[0], /速墙/);
  });
}

for (const ink of [100, 28]) {
  test(`G cancels a real pending Q drawing before ${ink === 100 ? 'success' : 'ink rejection'}`, () => {
    const h = drawHarness({ ink });
    h.draw();
    assert.notEqual(h.context.drawStart, null);
    assert.equal(h.hints.at(-1), true);
    assert.equal(h.player.ink, ink, 'Q drawStart is only an eligibility check');
    h.calls.length = 0; h.order.length = 0;
    const result = h.quick();
    assert.equal(result.ok, ink === 100);
    assert.equal(h.context.drawStart, null);
    assert.equal(h.previews.at(-1), null);
    assert.equal(h.hints.at(-1), false);
    assert.equal(h.input.ads, false);
    assert.deepEqual(h.order, ['preview', 'hint', 'cancelADS', 'drawStart', 'drawEnd']);
    assertEndpoints(h.calls[1].message, [-1.6, -3.5, 1.6, -3.5]);
    h.player.ink = 100;
    h.calls.length = 0;
    h.draw();
    assert.deepEqual(h.calls.map(c => c.message.m), ['drawStart'], 'next Q begins a new line, not the stale line');
  });
}

for (const ink of [0, 27.99]) {
  test(`quick wall ink ${ink}: failed start returns immediately without drawEnd or charging`, () => {
    const h = drawHarness({ ink });
    const res = h.quick();
    assert.equal(res, h.calls[0].result);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ink');
    assert.deepEqual(h.calls.map(c => c.message.m), ['drawStart']);
    assertNoWallMutation(h, ink);
    assert.equal(h.input.ads, false);
    assert.match(h.toasts[0], /28/);
  });
}

for (const ink of [28, 32.79]) {
  test(`quick wall ink ${ink}: start passes but authoritative actual 32.8 cost rejects atomically`, () => {
    const h = drawHarness({ ink });
    const res = h.quick();
    assert.equal(h.calls[0].result.ok, true);
    assert.equal(res, h.calls[1].result);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ink');
    close(res.cost, 32.8);
    assertNoWallMutation(h, ink);
    assert.match(h.toasts[0], /需要 33 墨量/);
  });
}

test('quick wall accepts exactly the actual cost rather than reserving a second start fee', () => {
  const h = drawHarness({ ink: 32.8 });
  assert.equal(h.quick().ok, true);
  close(h.player.ink, 0);
  assert.equal(h.match.walls.length, 1);
});

for (const st of [1, 2]) {
  test(`quick wall rejects player state ${st} through authoritative drawEnd`, () => {
    const h = drawHarness({ st });
    const res = h.quick();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'dead');
    assertNoWallMutation(h, 100);
    assert.equal(h.input.ads, false);
    assert.match(h.toasts[0], /倒地/);
  });
}

for (const [name, state] of [['ended', { ended: true }], ['won', { phase: 'won' }], ['lost', { phase: 'lost' }]]) {
  test(`quick wall does nothing after ${name}`, () => {
    const h = drawHarness();
    if (state.ended) h.context.ended = true;
    if (state.phase) h.match.phase = state.phase;
    assert.equal(h.quick(), undefined);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.toasts, []);
    assertNoWallMutation(h, 100);
  });
}

for (const [name, x, z, yaw, endpoints] of [
  ['positive x', 15.5, 0, 0, [13.9, -3.5, 16.5, -3.5]],
  ['negative x', -15.5, 0, 0, [-16.5, -3.5, -13.9, -3.5]],
  ['positive z', 0, 15.5, Math.PI / 2, [-3.5, 16.5, -3.5, 13.9]],
  ['negative z', 0, -15.5, Math.PI / 2, [-3.5, -13.9, -3.5, -16.5]],
]) {
  test(`quick wall clamps ${name} endpoint to 16.5 and charges the shortened 2.6m length`, () => {
    const h = drawHarness({ x, z, yaw });
    const result = h.quick();
    assert.equal(result.ok, true);
    assertEndpoints(h.calls[1].message, endpoints);
    close(result.wall.len, 2.6);
    close(100 - h.player.ink, 30.4);
    for (const key of ['ax', 'az', 'bx', 'bz']) assert.ok(Math.abs(h.calls[1].message[key]) <= 16.5);
  });
}

for (const x of [-16.5, 16.5]) {
  test(`quick wall at side x=${x} rejects a clamped 1.6m segment without ink loss`, () => {
    const h = drawHarness({ x });
    const result = h.quick();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'short');
    close(result.len, 1.6);
    assertNoWallMutation(h, 100);
    assert.match(h.toasts[0], /至少 2 米/);
  });
}

for (const [z, ok] of [[-16, false], [-15.7501, false], [-15.75, true]]) {
  test(`quick wall at z=${z} honors authoritative 0.75m self-distance after clamping`, () => {
    const h = drawHarness({ z });
    const res = h.quick();
    assert.equal(res.ok, ok);
    assertEndpoints(h.calls[1].message, [-1.6, -16.5, 1.6, -16.5]);
    if (ok) close(100 - h.player.ink, 32.8);
    else {
      assert.equal(res.reason, 'self');
      assertNoWallMutation(h, 100);
      assert.match(h.toasts[0], /自己身上/);
    }
  });
}

test('quick walls enforce own cap of three by removing the oldest, never bypassing runtime', () => {
  const h = drawHarness(), ids = [];
  for (let i = 0; i < 4; i++) {
    h.player.ink = 100;
    const res = h.quick();
    assert.equal(res.ok, true);
    ids.push(res.wall.id);
  }
  assert.equal(CONFIG.wall.maxCount, 3);
  assert.deepEqual(h.match.walls.map(w => w.id), ids.slice(1));
  assert.deepEqual(h.match.events.filter(e => e.type === 'wallRemove').map(e => e.data.id), [ids[0]]);
  assert.equal(h.player.stats.walls, 4);
  close(h.player.ink, 67.2);
});

for (const ownFirst of [false, true]) {
  test(`quick wall honors team cap ten ${ownFirst ? 'without a second eviction after own cap' : 'by evicting the oldest teammate wall'}`, () => {
    const h = drawHarness({ playerIds: [0, 1, 2, 3] });
    const owners = ownFirst ? [0, 0, 0, 1, 1, 1, 2, 2, 2, 3] : [1, 1, 1, 2, 2, 2, 3, 3, 3, 0];
    const ids = [];
    for (const id of owners) {
      const player = h.match.players.find(p => p.id === id);
      Object.assign(player.pos, { x: 0, z: 0 });
      player.ink = 100;
      assert.equal(h.runtime.action(id, { m: 'drawStart' }).ok, true);
      const res = h.runtime.action(id, { m: 'drawEnd', ax: -1.6, az: -3.5, bx: 1.6, bz: -3.5 });
      assert.equal(res.ok, true);
      ids.push(res.wall.id);
    }
    assert.equal(CONFIG.wall.teamMax, 10);
    assert.equal(h.match.walls.length, 10);
    h.player.ink = 100;
    const res = h.quick();
    assert.equal(res.ok, true);
    assert.deepEqual(h.match.walls.map(w => w.id), [...ids.slice(1), res.wall.id]);
    assert.deepEqual(h.match.events.filter(e => e.type === 'wallRemove').map(e => e.data.id), [ids[0]]);
    assert.ok(h.match.walls.filter(w => w.owner === 0).length <= 3);
    close(h.player.ink, 67.2);
  });
}

test('actual main input callbacks read live weapon cadence, drawing, living/reload and ended state', () => {
  const runtime = createRuntime(), match = runtime.match, player = match.players[0];
  const noop = () => {};
  const context = vm.createContext({
    runtime, match, ended: false, drawStart: null, weaponOf, canvas: {},
    createInput: (_canvas, callbacks) => callbacks,
    shootDir: noop, handleReload: noop, handleWeapon: noop, handleQuickWall: noop,
    handleDraw: noop, cancelDraw: noop, handleErase: noop, handleFold: noop,
  });
  inputWiringScript.runInContext(context);
  const callbacks = vm.runInContext('input', context);
  assert.equal(callbacks.onQuickWall, context.handleQuickWall);
  assert.equal(callbacks.onWeapon, context.handleWeapon);
  assert.equal(callbacks.onReload, context.handleReload);
  assert.equal(callbacks.isDrawing(), false);
  context.drawStart = { x: 1, z: 1 };
  assert.equal(callbacks.isDrawing(), true);
  context.drawStart = null;
  assert.equal(callbacks.isDrawing(), false);
  for (const weapon of [0, 1, 2]) {
    if (player.weapon !== weapon) assert.equal(runtime.action(0, { m: 'weapon', weapon }).ok, true);
    assert.equal(callbacks.getWeapon(), weapon);
    assert.equal(callbacks.getFireInterval(), CONFIG.player.weapons[weapon].fireInterval);
  }
  for (const st of [0, 1, 2]) {
    for (const reload of [0, 0.01, 1]) {
      for (const ended of [false, true]) {
        Object.assign(player, { st, reload }); context.ended = ended;
        assert.equal(callbacks.canADS(), st === 0 && reload === 0 && !ended);
      }
    }
  }
  Object.assign(player, { st: 0, reload: 0 }); context.ended = false;
  assert.equal(callbacks.canADS(), true);
});

class Button {
  listeners = new Map();
  blurs = 0;
  bubbled = [];
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  blur() { this.blurs++; }
  emit(type) {
    const event = { type, code: 'Space', button: 0, stopped: false,
      stopPropagation() { this.stopped = true; } };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    if (!event.stopped) this.bubbled.push(type);
    return event;
  }
}
function buttonHarness() {
  const enter = new Button(), fullscreen = new Button(), calls = [], toasts = [];
  const document = {
    fullscreenElement: null,
    getElementById: id => ({ 'enter-btn': enter, 'fs-btn': fullscreen })[id],
    documentElement: {},
    exitFullscreen() { calls.push('exitFullscreen'); this.fullscreenElement = null; },
  };
  document.documentElement.requestFullscreen = function () {
    assert.equal(this, document.documentElement);
    calls.push('requestFullscreen'); document.fullscreenElement = this;
  };
  buttonScript.runInContext(vm.createContext({
    document, input: { requestLock: () => calls.push('requestLock') },
    hud: { toast: message => toasts.push(message) },
  }));
  return { enter, fullscreen, document, calls, toasts };
}

test('actual enter button first click requests only pointer lock, without fullscreen or a second click', () => {
  const h = buttonHarness();
  assert.equal(h.enter.emit('click').stopped, true);
  assert.deepEqual(h.calls, ['requestLock']);
  assert.equal(h.enter.blurs, 1);
  assert.equal(h.fullscreen.blurs, 0);
  h.enter.emit('click');
  assert.deepEqual(h.calls, ['requestLock', 'requestLock']);
  assert.deepEqual(h.enter.bubbled, []);
});

test('actual fullscreen button toggles request/exit without pointer lock and blurs itself', () => {
  const h = buttonHarness();
  assert.equal(h.fullscreen.emit('click').stopped, true);
  assert.equal(h.document.fullscreenElement, h.document.documentElement);
  assert.deepEqual(h.calls, ['requestFullscreen']);
  h.fullscreen.emit('click');
  assert.equal(h.document.fullscreenElement, null);
  assert.deepEqual(h.calls, ['requestFullscreen', 'exitFullscreen']);
  assert.equal(h.fullscreen.blurs, 2);
  assert.equal(h.enter.blurs, 0);
  assert.deepEqual(h.fullscreen.bubbled, []);
});

test('both actual buttons stop gameplay pointer/key propagation without activating on down/up', () => {
  const h = buttonHarness();
  for (const button of [h.enter, h.fullscreen]) {
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'keydown', 'keyup']) {
      assert.equal(button.emit(type).stopped, true, type);
    }
    assert.deepEqual(button.bubbled, []);
    assert.equal(button.blurs, 0);
  }
  assert.deepEqual(h.calls, []);
});

for (const operation of ['requestFullscreen', 'exitFullscreen']) {
  for (const failure of ['throw', 'reject']) {
    test(`actual fullscreen ${operation} ${failure} is contained with a toast and no pointer lock`, async () => {
      const h = buttonHarness();
      const owner = operation === 'requestFullscreen' ? h.document.documentElement : h.document;
      if (operation === 'exitFullscreen') h.document.fullscreenElement = {};
      owner[operation] = () => {
        h.calls.push(operation);
        if (failure === 'throw') throw new Error('denied');
        return Promise.reject(new Error('denied'));
      };
      assert.doesNotThrow(() => h.fullscreen.emit('click'));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(h.calls, [operation]);
      assert.equal(h.toasts.length, 1);
      assert.match(h.toasts[0], /F11/);
      assert.equal(h.fullscreen.blurs, 1);
      assert.deepEqual(h.fullscreen.bubbled, []);
    });
  }
}
