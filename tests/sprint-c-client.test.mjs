import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import { drainEvents, createPlayer, weaponOf } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { createBoss } from '../shared/boss.mjs';
import { validateDraw } from '../shared/walls.mjs';
import { nearestFold } from '../shared/folds.mjs';
import { SPAWNS, ANCHORS, EXIT, groundHeightAt } from '../shared/world.mjs';
import { losBlocker, HITBOX } from '../shared/combat.mjs';
import { createRuntime } from '../host/runtime.mjs';
import { rollPerkChoices } from '../shared/perks.mjs';
import { createGuide } from '../client/guide.mjs';
import { computeRank } from '../client/hud.mjs';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, applySettings } from '../client/settings.mjs';

const source = readFileSync(new URL('../client/main.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
function harness() {
  const nodes = new Map(), handlers = new Map(), store = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { toggle() {} }, textContent: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, blur() {} });
    return nodes.get(id);
  };
  const screen = { cards: [], settings: false, guide: null, settlement: null, toast: '', snap: null };
  const renderer = {
    setBossSoundMuted() {}, reset() {}, setDrawStart() {}, setDrawPreview() {}, onEvent() {},
    update() {}, project() {}, setBaseFov(v) { this.fov = v; }, setBossLaughVolume(v) { this.volume = v; },
    bossAudioDebug: () => ({ active: 0, pending: false }),
  };
  const hud = {
    setMuted() {}, hideSettlement() { screen.settlement = null; }, drawHint() {}, resetCache() {},
    setGod() {}, showPhaseBanner() {}, dashFlash() {}, damageFrom() {},
    hidePerks() { screen.cards = []; }, showPerks(ids) { screen.cards = [...ids]; },
    hideSettings() { screen.settings = false; }, showSettings(s) { screen.settings = true; screen.values = s; },
    syncSettings(s) { screen.values = s; }, updateGuide(s) { screen.guide = s; },
    toast(s) { screen.toast = s; }, update(s) { screen.snap = s; }, showSettlement(s) { screen.settlement = s; },
    shot() {}, hitmarker() {}, spawnDmgNumber() {}, damage() {},
  };
  const bgm = { setMode() {}, setDuck() {}, setPaused() {}, setVolume() {}, setMuted() {}, stop() {}, debug: () => ({}) };
  const audio = new Proxy({ muted: false, volume: .85, picks: 0,
    isMuted() { return this.muted; }, toggleMute() { this.muted = !this.muted; },
    setVolume(v) { this.volume = v; }, perkPick() { this.picks++; },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  let callbacks;
  const input = {
    locked: true, ads: false, yaw: 0, clearCount: 0,
    clear() { this.clearCount++; this.ads = false; }, releaseFire() {}, cancelADS() { this.ads = false; },
    setSensitivity(v) { this.sensitivity = v; }, setView(yaw) { this.yaw = yaw; },
    requestLock() { this.locked = true; }, dir: () => ({ x: 0, y: 0, z: -1 }),
  };
  const document = {
    body: {}, pointerLockElement: {}, documentElement: {},
    getElementById: node,
    addEventListener(type, fn) { handlers.set(type, fn); },
    exitPointerLock() { this.pointerLockElement = null; input.locked = false; callbacks.onLock(false, '', false); },
  };
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const context = vm.createContext({
    CONFIG, drainEvents, createPlayer, weaponOf, createEnemy, createBoss, validateDraw, nearestFold,
    SPAWNS, ANCHORS, EXIT, groundHeightAt, losBlocker, HITBOX, createRuntime, rollPerkChoices, createGuide,
    DEFAULT_SETTINGS, loadSettings: () => loadSettings(storage), saveSettings: s => saveSettings(s, storage), applySettings,
    window: { THREE: {}, addEventListener() {}, removeEventListener() {} }, document, localStorage: storage, location: { search: '?seed=11' }, URLSearchParams,
    performance: { now: () => 0 }, requestAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {},
    crypto: { getRandomValues(a) { a[0] = 42; return a; } },
    createRenderer: () => renderer, createHud: () => hud, createAudio: () => audio, computeRank,
    createBgm: () => bgm,
    createInput: (_canvas, opts) => { callbacks = opts; return input; },
  });
  new vm.Script(source, { filename: 'main-live-module.mjs' }).runInContext(context);
  const d = context.window.__CLIENT_DEBUG__;
  const key = code => handlers.get('keydown')({ code, repeat: false, preventDefault() {} });
  const anchor = (i = 0) => { d.match.events.push({ type: 'anchorDone', data: { i, label: 'A' + (i + 1) } }); d.pump(0); };
  return { d, context, screen, input, renderer, audio, storage, key, anchor, callbacks };
}

test('C client: anchor offers independent cards and frame pause leaves tickOnce/pump unblocked', () => {
  const h = harness(), { d } = h;
  h.context.frame(0);
  h.anchor();
  assert.equal(d.panels().perkPaused, true);
  assert.equal(d.perkChoices().length, 3);
  assert.equal(new Set(d.perkChoices()).size, 3);
  const tick = d.match.tick;
  h.context.frame(5000);
  assert.equal(d.match.tick, tick);
  d.runtime.tickOnce(); d.pump(0);
  assert.equal(d.match.tick, tick + 1);
  assert.equal(h.callbacks.isBlocked(), true);
});
for (const [code, idx] of [['KeyZ', 0], ['KeyX', 1], ['KeyV', 2]]) {
  test(`C client: ${code} chooses card ${idx} without unlocking and restores frame clock`, () => {
    const h = harness(); h.context.frame(0); h.anchor();
    const id = h.d.perkChoices()[idx];
    h.context.frame(5000); h.key(code); h.d.pump(0);
    assert.equal(h.d.match.players[0].perks[0], id);
    assert.equal(h.d.panels().perkPaused, false);
    assert.equal(h.input.locked, true);
    assert.equal(h.audio.picks, 1);
    assert.match(h.screen.toast, /已装订强化/);
    const t = h.d.match.tick; h.context.frame(5051);
    assert.equal(h.d.match.tick, t + 1, 'no catch-up burst after a long selection pause');
  });
}
test('C client: invalid or repeated picks do not consume an offer', () => {
  const h = harness(); h.anchor();
  assert.equal(h.d.pickPerk('not_a_perk').ok, false);
  assert.equal(h.d.perkChoices().length, 3);
  const id = h.d.perkChoices()[0];
  assert.equal(h.d.pickPerk(id).ok, true);
  assert.equal(h.d.pickPerk(id).ok, false);
});
test('C client: Tab defers and reopens the same offer, then queued anchors exclude owned perks', () => {
  const h = harness(); h.anchor(); const ids = [...h.d.perkChoices()];
  h.key('Tab'); assert.equal(h.d.panels().perkPaused, false); assert.equal(h.screen.cards.length, 0);
  h.anchor(1); assert.deepEqual([...h.d.perkChoices()], ids);
  h.key('Tab'); assert.equal(h.d.panels().perkPaused, true);
  h.key('KeyZ');
  assert.equal(h.d.perkChoices().length, 3);
  assert.equal(h.d.perkChoices().includes(ids[0]), false);
});
test('C client: debug pause skips anchor UI without changing simulation stepping', () => {
  const h = harness(); h.d.pause(true); h.anchor();
  assert.equal(h.d.perkChoices().length, 0);
  assert.equal(h.d.panels().perkPaused, false);
  const tick = h.d.match.tick; h.d.step(2); h.d.pump(0);
  assert.equal(h.d.match.tick, tick + 2);
});
test('C client: multiplayer offers do not pause host advancement', () => {
  const h = harness(); h.d.addPlayers(1); h.context.frame(0); h.anchor();
  assert.equal(h.d.panels().perkPaused, false); assert.equal(h.screen.cards.length, 3);
  h.context.frame(51); assert.equal(h.d.match.tick, 1);
});
test('C client: O clears ADS/lock/input and pauses only frames, not manual bot ticks', () => {
  const h = harness(); h.context.frame(0); h.input.ads = true;
  h.key('KeyO'); assert.equal(h.d.panels().settingsPaused, true);
  assert.equal(h.input.ads, false); assert.equal(h.input.locked, false);
  h.context.frame(5000); assert.equal(h.d.match.tick, 0);
  h.d.runtime.tickOnce(); h.d.pump(0); assert.equal(h.d.match.tick, 1);
  h.key('KeyO'); assert.equal(h.d.panels().settingsPaused, false);
  h.context.frame(5051); assert.equal(h.d.match.tick, 2);
});
test('C client: closing settings cannot dismiss an outstanding perk pause', () => {
  const h = harness(); h.anchor(); const ids = [...h.d.perkChoices()];
  h.key('KeyO'); assert.equal(h.screen.settings, true); assert.equal(h.screen.cards.length, 0);
  h.key('KeyZ'); assert.equal(h.d.match.players[0].perks.length, 0);
  h.key('KeyO'); assert.equal(h.d.panels().perkPaused, true);
  assert.deepEqual(h.screen.cards, ids);
});
test('C client: H and settings values persist and apply without changing mute', () => {
  const h = harness(); h.key('KeyM'); h.key('KeyH');
  assert.equal(h.d.settings().showGuide, false); assert.equal(h.screen.guide.visible, false);
  h.d.setSettings({ sensitivity: .005, fov: 95, sfxVolume: 0, bossVolume: 1, showGuide: true });
  assert.equal(h.input.sensitivity, .005); assert.equal(h.renderer.fov, 95);
  assert.equal(h.audio.volume, 0); assert.equal(h.renderer.volume, 1); assert.equal(h.audio.muted, true);
  assert.equal(JSON.parse(h.storage.getItem(CONFIG.storage.settings)).fov, 95);
});
test('C client: same-seed restart clears panels, perks, counters and resets guide, preserving settings', () => {
  const h = harness(); h.anchor(); h.key('KeyZ'); h.d.pump(0); h.key('KeyO');
  h.d.setSettings({ ...h.d.settings(), fov: 80, showGuide: false });
  h.d.restart();
  assert.equal(h.d.state().seed, 11); assert.equal(h.d.match.players[0].perks.length, 0);
  assert.equal(h.d.panels().perkPaused, false); assert.equal(h.d.panels().settingsPaused, false);
  assert.equal(h.d.perkChoices().length, 0); assert.equal(h.screen.settings, false);
  assert.equal(h.d.guide.state().step, 1); assert.equal(h.d.settings().showGuide, false);
  assert.equal(h.renderer.fov, 80);
});
test('C client: settlement closes modals and includes chosen build and crit/interrupt counts', () => {
  const h = harness(); h.anchor(); h.key('KeyZ'); const id = h.d.match.players[0].perks[0]; h.key('KeyO');
  h.d.match.phase = 'won';
  h.d.match.events.push({ type: 'hit', data: { id: 1, boss: true, point: { x: 0, y: 1, z: 0 }, dealt: 38, critKind: 'belly' } },
    { type: 'bossInterrupt', data: { by: 0, duration: 2 } }, { type: 'win', data: {} });
  h.d.pump(0);
  assert.equal(h.screen.settlement.won, true); assert.equal(h.screen.settlement.perks[0], id);
  assert.equal(h.screen.settlement.crits, 1); assert.equal(h.screen.settlement.interrupts, 1);
  assert.equal(h.d.panels().perkPaused, false); assert.equal(h.d.panels().settingsPaused, false);
  assert.equal(h.screen.guide.visible, false);
});
test('C client: finishing while already unlocked hides the entry card above settlement', () => {
  const h = harness();
  h.key('KeyO'); h.key('KeyO');
  const entry = h.context.document.getElementById('lock-hint');
  assert.equal(entry.style.display, 'flex');
  h.d.match.phase = 'won';
  h.d.match.events.push({ type: 'win', data: {} }); h.d.pump(0);
  assert.equal(entry.style.display, 'none');
  assert.equal(h.screen.settlement.won, true);
});
test('C client: new seed resets run and repeated random value cannot repeat current seed', () => {
  const h = harness(); const first = h.d.newSeed(), second = h.d.newSeed();
  assert.equal(first, 42); assert.equal(second, 43); assert.equal(h.d.match.seed, 43);
});
test('Overhaul1: audio and HUD receive the same 3.5-second kill combo and reset on restart', () => {
  const h = harness(), sounds = [], marks = [];
  h.audio.kill = n => sounds.push(n);
  h.d.hud.hitmarker = (kill, crit, n) => { if (kill) marks.push(n); };
  for (const t of [1, 2, 5.5, 5.6, 9.11]) {
    h.d.match.elapsed = t;
    h.d.match.events.push({ type: 'kill', data: { id: 123, enemyType: 'crane' } });
    h.d.pump(0);
  }
  assert.deepEqual(sounds, [1, 2, 3, 4, 1]);
  assert.deepEqual(marks, sounds);
  h.d.restart();
  h.d.match.events.push({ type: 'kill', data: { id: 123, enemyType: 'crane' } }); h.d.pump(0);
  assert.equal(sounds.at(-1), 1);
});
test('Overhaul1: critical hits request the gold double-cross marker', () => {
  const h = harness(), calls = [];
  h.d.hud.hitmarker = (...args) => calls.push(args);
  h.d.match.events.push({ type: 'hit', data: { id: 123, point: { x: 0, y: 1, z: 0 }, dealt: 38, critKind: 'belly' } });
  h.d.pump(0);
  assert.deepEqual(calls[0], [false, true]);
});
test('Overhaul1: manual and empty-magazine reload sounds receive the selected weapon', () => {
  const h = harness(), calls = [];
  h.audio.reload = idx => calls.push(idx);
  for (const idx of [0, 1, 2]) {
    const p = h.d.match.players[0];
    p.reload = 0; h.d.weapon(idx); p.ammo = 0;
    h.d.reload();
    assert.equal(calls.at(-1), idx);
    p.reload = 0; p.ammo = 0; p.fireCd = 0;
    h.d.shoot();
    assert.equal(calls.at(-1), idx);
  }
  assert.equal(calls.length, 6);
});
