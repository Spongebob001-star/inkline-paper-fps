// OVERHAUL-5：移动端双摇杆、触控开火、纸片 HUD 点击与按住自救闭环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { damagePlayer } from '../shared/combat.mjs';
import { ANCHORS } from '../shared/world.mjs';
import { createHud } from '../client/hud.mjs';

const MAIN = readFileSync(new URL('../client/main.mjs', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../dev/client.html', import.meta.url), 'utf8');
const HUD = readFileSync(new URL('../client/hud.mjs', import.meta.url), 'utf8');
const SENS = 0.0022;
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
  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    event.defaultPrevented ??= false;
    event.preventDefault ??= function () { this.defaultPrevented = true; };
    event.stopPropagation ??= function () {};
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }
  emit(type, fields = {}) {
    const event = { type, ...fields };
    this.dispatchEvent(event);
    return event;
  }
}

function classList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach(name => set.add(name)),
    remove: (...names) => names.forEach(name => set.delete(name)),
    contains: name => set.has(name),
    toggle(name, yes) {
      if (yes === undefined ? !set.has(name) : yes) set.add(name);
      else set.delete(name);
      return set.has(name);
    },
  };
}

const rect = (left = 0, top = 0, width = 100, height = 100) =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

function fakeNode(id, box = rect()) {
  const node = new FakeTarget();
  Object.assign(node, {
    id, style: {}, dataset: {}, hidden: false, className: '', textContent: '', value: '0',
    valueAsNumber: 0, classList: classList(), getBoundingClientRect: () => box,
    setPointerCapture() {}, setAttribute() {}, contains: other => other === node,
  });
  return node;
}

const touch = (identifier, clientX, clientY, target) => ({ identifier, clientX, clientY, target });

function inputHarness() {
  const doc = new FakeTarget();
  const canvas = fakeNode('view', rect(0, 0, 844, 390));
  const zone = fakeNode('touch-stick-zone', rect(0, 0, 118, 118));
  const knob = fakeNode('touch-stick-knob');
  zone.contains = other => other === zone || other === knob;
  const fire = fakeNode('touch-fire', rect(732, 280, 96, 96));
  const hint = fakeNode('lock-hint');
  hint.style.display = 'flex';
  const body = fakeNode('body');
  const html = fakeNode('html');
  const nodes = { 'lock-hint': hint, 'touch-stick-zone': zone, 'touch-stick-knob': knob, 'touch-fire': fire };
  doc.body = body;
  doc.documentElement = html;
  doc.pointerLockElement = null;
  doc.getElementById = id => nodes[id] || null;
  const window = new FakeTarget();
  window.innerWidth = 844; window.innerHeight = 390;
  const intents = [], looks = [], modes = [];
  let now = 10000, nextTimer = 1;
  const intervals = new Map();
  const context = vm.createContext({
    CONFIG, document: doc, window, performance: { now: () => now },
    setTimeout(fn, delay = 0) { const id = nextTimer++; intervals.set('t' + id, { fn, delay }); return id; },
    clearTimeout: id => intervals.delete('t' + id),
    setInterval(fn, delay) { const id = nextTimer++; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
  });
  inputScript.runInContext(context);
  const input = context.createInput(canvas, {
    onIntent: intent => intents.push({ ...intent }),
    onShot: dir => looks.push({ shot: dir }),
    onLook: (yaw, pitch) => looks.push({ yaw, pitch }),
    onTouchMode: on => modes.push(on),
  });
  return {
    doc, canvas, zone, knob, fire, hint, body, html, window, input, intents, looks, modes,
    tick() { for (const { fn } of intervals.values()) fn(); return intents.at(-1); },
    end(ids) { doc.emit('touchend', { changedTouches: ids.map(id => ({ identifier: id })) }); },
  };
}

function hudHarness(callbacks = {}) {
  const doc = new FakeTarget();
  doc.pointerLockElement = null;
  const nodes = new Map();
  const ctx = new Proxy({}, { get: (o, k) => o[k] || (() => {}), set: (o, k, v) => { o[k] = v; return true; } });
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const n = fakeNode(id);
    Object.assign(n, {
      style: { setProperty(k, v) { this[k] = v; } },
      getContext: () => ctx,
      querySelector: sel => node(id + ' ' + sel),
      querySelectorAll: () => [],
      replaceChildren(...items) { this.children = items; },
      append(...items) { (this.children ||= []).push(...items); },
      children: [],
    });
    nodes.set(id, n);
    return n;
  }
  let created = 0;
  doc.createElement = () => node('created' + created++);
  doc.body = node('body');
  doc.getElementById = id => node(id);
  const root = node('root');
  root.ownerDocument = doc;
  root.querySelector = sel => node(sel[0] === '#' ? sel.slice(1) : 'root ' + sel);
  root.querySelectorAll = () => [];
  const tags = [0, 1, 2].map(i => node('weapon-tag' + i));
  node('weapon-bar').querySelectorAll = sel => sel === '.weapon-tag' ? tags : [];
  const hud = createHud(root, callbacks);
  return { hud, doc, tags, get: id => node(id) };
}

function useHold(h, match, ticks) {
  for (let i = 0; i < ticks; i++) {
    const intent = h.tick();
    assert.equal(intent.hold, true, 'touchHold must reach the 30Hz intent');
    stepMatch(match, { 0: intent });
  }
}

test('移动端：触屏进入、摇杆归一化与 0.82 冲刺阈值、左右手势互不串扰', () => {
  const h = inputHarness();
  h.doc.emit('touchstart', { changedTouches: [
    touch(1, 59, 59, h.zone), touch(2, 700, 195, h.canvas)] });
  assert.equal(h.input.isTouch(), true);
  assert.deepEqual(h.modes, [true]);
  assert.ok(h.body.classList.contains('touch-mode'));
  assert.equal(h.hint.style.display, 'none');

  h.doc.emit('touchmove', { changedTouches: [
    touch(1, 59, 12.2, h.zone), touch(2, 710, 195, h.canvas)] });
  let intent = h.tick();
  assert.ok(Math.abs(intent.f - 0.9) < 1e-9, 'forward=' + intent.f);
  assert.equal(intent.r, 0);
  assert.equal(intent.sprint, true);
  assert.ok(Math.abs(h.input.yaw - (-10 * SENS * 2.2)) < 1e-12);

  h.doc.emit('touchmove', { changedTouches: [touch(2, 720, 195, h.canvas)] });
  intent = h.tick();
  assert.ok(Math.abs(intent.f - 0.9) < 1e-9, 'look-only must not alter movement');
  assert.ok(Math.abs(h.input.yaw - (-20 * SENS * 2.2)) < 1e-12);
  const yaw = h.input.yaw;

  h.doc.emit('touchmove', { changedTouches: [touch(1, 7.4, 59, h.zone)] });
  intent = h.tick();
  assert.ok(Math.abs(intent.r + 51.6 / 52) < 1e-9, 'strafe=' + intent.r);
  assert.equal(intent.f, 0);
  assert.equal(h.input.yaw, yaw, 'stick-only must not turn the view');

  h.end([1, 2]);
  intent = h.tick();
  assert.deepEqual([intent.f, intent.r, intent.sprint], [0, 0, false]);

  h.doc.emit('touchstart', { changedTouches: [touch(3, 59, 59, h.zone)] });
  h.doc.emit('touchmove', { changedTouches: [touch(3, 59, 59 - 0.82 * 52, h.zone)] });
  intent = h.tick();
  assert.equal(intent.sprint, false, 'exactly 0.82 is still walk speed: ' + JSON.stringify(intent));
  h.doc.emit('touchmove', { changedTouches: [touch(3, 59, 59 - 0.83 * 52, h.zone)] });
  assert.equal(h.tick().sprint, true, 'above 0.82 sprints');
  h.doc.emit('touchmove', { changedTouches: [touch(3, 5000, -5000, h.zone)] });
  intent = h.tick();
  assert.deepEqual([intent.f, intent.r], [1, 1], 'radial overflow clamps per axis');
  h.end([3]);
});

test('强制横屏：竖屏触控坐标按 CSS 90° 旋转逆映射到逻辑横屏', () => {
  const h = inputHarness();
  h.window.innerWidth = 390; h.window.innerHeight = 844;
  h.html.classList.add('force-landscape');
  h.zone.getBoundingClientRect = () => rect(16, 16, 118, 118);

  h.doc.emit('touchstart', { changedTouches: [touch(1, 75, 75, h.zone)] });
  h.doc.emit('touchmove', { changedTouches: [touch(1, 85, 75, h.zone)] });
  const intent = h.tick();
  assert.ok(Math.abs(intent.f - 10 / 52) < 1e-9, 'physical right => logical forward: ' + intent.f);
  assert.equal(intent.r, 0);
  assert.equal(h.input.yaw, 0, 'stick gesture must not rotate the view');
  h.end([1]);

  h.doc.emit('touchstart', { changedTouches: [touch(2, 50, 500, h.canvas)] });
  h.doc.emit('touchmove', { changedTouches: [touch(2, 50, 510, h.canvas)] });
  assert.ok(Math.abs(h.input.yaw - (-10 * SENS * 2.2)) < 1e-12, 'mapped yaw=' + h.input.yaw);
  h.end([2]);
});

test('移动端：触控按住 → 30Hz hold 意图 → 单人 2s 自救与锚点共持', () => {
  const h = inputHarness();
  h.doc.emit('touchstart', { changedTouches: [touch(1, 59, 59, h.zone)] });
  h.end([1]);
  h.input.setTouchHold(true);
  const m = createMatch({ seed: 11 });
  const p = m.players[0];
  const hp = CONFIG.player.maxHp;
  p.hp = hp;
  damagePlayer(m, p, hp);
  useHold(h, m, 39);
  assert.equal(p.st, 1);
  assert.ok(p.reviveProgress > 0.9 && p.reviveProgress < 1, 'progress=' + p.reviveProgress);
  useHold(h, m, 1);
  assert.equal(p.st, 0);
  assert.equal(p.hp, CONFIG.player.down.reviveHp);
  assert.equal(p.stats.rescues, 1);

  const a = createMatch({ seed: 12 });
  const q = a.players[0];
  q.pos.x = ANCHORS[0].x; q.pos.z = ANCHORS[0].z;
  useHold(h, a, 45);
  assert.equal(a.anchors[0].active, true, '2.2s touch hold must anchor');
  h.input.setTouchHold(false);
  const intent = h.tick();
  assert.equal(intent.hold, false);
});

test('移动端：HUD 卡片点击、触控开火、提示条按住自救与触控层显隐', () => {
  const h = inputHarness();
  h.doc.emit('touchstart', { changedTouches: [touch(1, 59, 59, h.zone)] });
  h.end([1]);
  const calls = { weapons: [], walls: 0, erase: 0, fold: 0, dash: 0, fire: [], hold: [], jump: 0, reload: 0, ads: 0 };
  const hud = hudHarness({
    onWeapon: i => calls.weapons.push(i),
    onQuickWall: () => calls.walls++, onErase: () => calls.erase++, onFold: () => calls.fold++,
    onDash: () => calls.dash++, onTouchWall: () => calls.walls++,
    onTouchFire: on => { calls.fire.push(on); h.input.setTouchFire(on); },
    onTouchHold: on => { calls.hold.push(on); h.input.setTouchHold(on); },
    onTouchJump: () => calls.jump++, onReload: () => calls.reload++, onTouchADS: () => calls.ads++,
  });
  hud.hud.setTouchMode(true);
  assert.ok(hud.doc.body.classList.contains('touch-mode'));
  assert.equal(hud.get('touch-layer').hidden, false);
  assert.equal(hud.hud.touchDebug().visible, true);

  hud.tags.forEach((tag, i) => { tag.emit('pointerdown'); assert.equal(calls.weapons.at(-1), i); });
  hud.get('ab-wall').emit('pointerdown');
  hud.get('ab-erase').emit('pointerdown');
  hud.get('ab-fold').emit('pointerdown');
  hud.get('ab-dash').emit('pointerdown');
  assert.deepEqual([calls.walls, calls.erase, calls.fold, calls.dash], [1, 1, 1, 1]);
  hud.get('touch-jump').emit('pointerdown');
  hud.get('touch-reload').emit('pointerdown');
  hud.get('touch-wall').emit('pointerdown');
  hud.get('touch-ads').emit('pointerdown');
  assert.deepEqual([calls.jump, calls.reload, calls.walls, calls.ads], [1, 1, 2, 1]);

  const fire = hud.get('touch-fire');
  fire.emit('pointerdown', { pointerId: 7 });
  assert.deepEqual(calls.fire, [true]);
  assert.equal(h.tick().hold, false);
  hud.doc.emit('pointerup');
  assert.deepEqual(calls.fire, [true, false]);

  const m = createMatch({ seed: 21 });
  const p = m.players[0];
  p.hp = CONFIG.player.maxHp;
  damagePlayer(m, p, p.hp);
  const downed = hud.get('downed-banner');
  downed.emit('pointerdown');
  assert.deepEqual(calls.hold, [true]);
  assert.ok(downed.classList.contains('holding'));
  useHold(h, m, 40);
  assert.equal(p.st, 0, 'downed-banner touch hold must complete solo self-revive, progress=' + p.reviveProgress);
  hud.doc.emit('pointerup');
  assert.deepEqual(calls.hold, [true, false]);
  assert.equal(downed.classList.contains('holding'), false);

  hud.hud.setTouchVisible(false);
  assert.equal(hud.get('touch-layer').hidden, true);
  hud.hud.setTouchMode(false);
  assert.equal(hud.doc.body.classList.contains('touch-mode'), false);
});

test('移动端：HUD 提示文案随触控模式切换，速射武器显示开镜按钮状态', () => {
  const hud = hudHarness();
  const m = createMatch({ seed: 31 });
  const p = m.players[0];
  p.pos.x = ANCHORS[0].x; p.pos.z = ANCHORS[0].z;
  hud.hud.setTouchMode(true);
  hud.hud.update(snapshot(m), 0, 0.016);
  assert.match(hud.get('prompt-text').textContent, /^按住此处启动 /);
  assert.equal(hud.get('prompt').style.display, 'block');

  hud.hud.setTouchMode(false);
  hud.hud.update(snapshot(m), 0, 0.016);
  assert.match(hud.get('prompt-text').textContent, /^按住 F 启动 /);
  hud.hud.setTouchMode(true);

  p.weapon = 2;
  const snap = snapshot(m);
  snap.players[0].ads = true;
  hud.hud.update(snap, 0, 0.016);
  assert.ok(hud.get('touch-ads').classList.contains('ready'));
  assert.ok(hud.get('touch-ads').classList.contains('active'));

  p.hp = CONFIG.player.maxHp;
  damagePlayer(m, p, p.hp);
  hud.hud.update(snapshot(m), 0, 0.016);
  assert.match(hud.get('downed-sub').textContent, /按住此处 2 秒墨力自救/);
  assert.equal(hud.get('downed-banner').style.display, 'block');
  assert.equal(hud.hud.touchDebug().holding, false);
});

test('移动端：入口尝试全屏与横屏锁定，触屏样式和强制横屏约束存在', () => {
  assert.match(MAIN, /screen\.orientation\?\.lock\?\.\('landscape'\)/);
  assert.match(MAIN, /document\.documentElement\.requestFullscreen/);
  assert.match(MAIN, /if \(input\.isTouch\?\.\(\) \|\| touchDevice\(\)\)/);
  assert.match(MAIN, /input\.enableTouch\(\);/);
  assert.match(MAIN, /window\.innerWidth < window\.innerHeight/);
  assert.match(MAIN, /root\.classList\.toggle\('force-landscape', on\)/);
  assert.match(MAIN, /window\.addEventListener\('resize', syncForceLandscape\)/);
  for (const id of ['touch-layer', 'touch-stick-zone', 'touch-stick-knob', 'touch-fire', 'touch-jump', 'touch-reload', 'touch-wall', 'touch-ads']) {
    assert.ok(HUD.includes('id="' + id + '"'), id);
  }
  assert.ok(PAGE.includes('html,body,#view,#hud { touch-action:none;'));
  assert.ok(PAGE.includes('body.touch-mode #prompt,body.touch-mode #downed-banner { pointer-events:auto;'));
  assert.ok(PAGE.includes('body.touch-mode #minimap,html.force-landscape #minimap{width:64px;height:64px}'));
  assert.ok(PAGE.includes('建议横屏游玩'));
  assert.ok(PAGE.includes('html.force-landscape body{position:fixed;top:0;left:100vw;width:100vh;height:100vw;width:100dvh;height:100dvw;transform-origin:0 0;transform:rotate(90deg);overflow:hidden;}'));
  for (const width of [500, 620, 760, 900, 1000, 1100]) {
    assert.ok(PAGE.includes('@media (max-width:' + width + 'px) and (pointer:fine)'), 'narrow query ' + width + ' must be fine-pointer only');
  }
  assert.ok(!PAGE.includes('(pointer:coarse) and (orientation:portrait)'), 'portrait compromise layout must be removed');
  assert.ok(PAGE.includes('html.force-landscape #hud-top{top:8px;left:8px;right:8px}'));
  assert.ok(PAGE.includes('html.force-landscape #perk-cards{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}'));
  assert.ok(PAGE.includes('html.force-landscape #hud-hint{display:none}'), 'forced landscape hides desktop HUD hint');
  assert.ok(PAGE.includes('html.force-landscape #lock-hint .keys{display:none}'), 'forced landscape hides desktop key hints');
  assert.match(MAIN, /触屏模式：点击进入战场（自动保持横屏）/);
  assert.ok(PAGE.includes('html.force-landscape #lock-card{padding:17px 26px 16px;max-height:calc(100vw - 32px);max-height:calc(100dvw - 32px);overflow:auto}'), 'rotated entry card must clamp to logical height');
});

test('移动端 5C：浅色纸艺与紧凑 HUD 布局约束存在', () => {
  assert.ok(PAGE.includes('<meta name="color-scheme" content="light only">'), 'system night mode must not invert paper cards');
  assert.ok(PAGE.includes(':root{color-scheme:light only;'), 'root declares light-only color scheme');
  assert.ok(PAGE.includes('#touch-stick-zone{pointer-events:auto;position:absolute;left:12px;bottom:12px;width:100px;height:100px;'), 'stick is tightened for 640x360');
  assert.ok(PAGE.includes('#touch-stick-knob{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;'), 'stick knob is 44px');
  assert.ok(PAGE.includes('#touch-actions{position:absolute;right:10px;bottom:10px;display:grid;grid-template-columns:38px 38px 78px;grid-template-rows:38px 38px;gap:6px}'), 'touch action grid is tightened');
  assert.ok(PAGE.includes('#touch-actions #touch-fire{grid-area:1/3/3/4;width:78px;height:78px;border-radius:50%;border:3px double #8F2B25;background:#E34B3F;color:#FFFDF4;'), 'fire seal out-specifies the generic touch button');
  for (const rule of [
    'body.touch-mode #vitals-stack,html.force-landscape #vitals-stack{width:142px;gap:4px}',
    'body.touch-mode #hud-mid,html.force-landscape #hud-mid{width:220px}',
    'body.touch-mode #hud-right,html.force-landscape #hud-right{width:184px;display:grid;',
    'body.touch-mode #minimap-card,html.force-landscape #minimap-card{grid-column:2;grid-row:1;width:72px;',
    'body.touch-mode #hud-abilities,html.force-landscape #hud-abilities{left:124px;bottom:44px;gap:5px}',
    'body.touch-mode #weapon-bar,html.force-landscape #weapon-bar{left:124px;right:auto;bottom:8px;gap:4px}',
    'body.touch-mode #hud-ammo,html.force-landscape #hud-ammo{left:332px;right:auto;bottom:8px;'
  ]) {
    assert.ok(PAGE.includes(rule), rule);
  }
});
