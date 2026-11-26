import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, snapshot } from '../shared/sim.mjs';
import { applyDraw } from '../shared/walls.mjs';
import { applyErase } from '../shared/erase.mjs';
import { createGuide } from '../client/guide.mjs';
import { DEFAULT_SETTINGS, normalizeSettings, loadSettings, saveSettings, applySettings } from '../client/settings.mjs';

const copy = [
  ['切枪与开火', '左键射击敌人 · 按 1/2/3 或滚轮切换三把文具枪'],
  ['一键速墙挡弹', '按 G 瞬间立墙挡弹幕（或按 Q 两步自定义画墙）'],
  ['橡皮脉冲破甲', '贴近青绿护甲敌人按 E 擦除破甲并眩晕'],
  ['折纸登高与锚点', '靠近折页按 C 翻折 · 前往 A1 按住 F 启动（解锁强化！）'],
  ['智取奶龙 Boss', '奶龙冲锋按 G 立墙撞晕 · 大笑时射肚皮暴击或按 E 打断！'],
];
const event = (type, data = {}) => ({ type, data });
const achievements = [
  event('hit', { id: 11, point: { x: 0, y: 1, z: 2 }, armored: true }),
  event('wallDraw', { id: 12, owner: 0 }),
  event('erase', { owner: 0, x: 0, z: 0, stripped: 1, hit: [11] }),
  event('anchorDone', { i: 0, label: 'A1' }),
  event('bossStun', { reason: 'wall', duration: 2, wallId: 12 }),
];
const bossSnap = Object.freeze({ boss: Object.freeze({ hp: 500, state: 'idle', st: 0, ex: 0 }) });

function assertStep(guide, step, enabled = true) {
  assert.deepEqual(guide.state(), {
    enabled, visible: enabled, step, title: copy[step - 1][0], text: copy[step - 1][1], complete: false,
  });
}
function assertComplete(guide, visible = true, enabled = true) {
  assert.deepEqual(guide.state(), {
    enabled, visible, step: 5, title: '✓ 纸上战术已掌握', text: '', complete: true,
  });
}
function finish(guide) {
  for (const ev of achievements) guide.onEvent(ev);
}

test('guide exposes the fixed API and all five exact step titles/texts', () => {
  const guide = createGuide();
  assert.deepEqual(Object.keys(guide).sort(), ['onEvent', 'reset', 'setEnabled', 'state', 'update', 'weaponChanged']);
  for (let i = 0; i < 5; i++) {
    assertStep(guide, i + 1);
    guide.onEvent(achievements[i]);
  }
  assertComplete(guide);
});

test('accepted local weapon change or either actual combat hit shape completes step one', () => {
  const switched = createGuide();
  switched.weaponChanged();
  assertStep(switched, 2);
  switched.weaponChanged();
  assertStep(switched, 2);
  for (const data of [achievements[0].data, { id: 20, boss: true, dealt: 8, crit: false, critKind: null }]) {
    const guide = createGuide();
    guide.onEvent(event('hit', data));
    assertStep(guide, 2);
  }
});

test('unrelated events, world impacts, folding and malformed owners do not award progress', () => {
  const guide = createGuide();
  for (const ev of [undefined, null, {}, event('impact'), event('shot'), event('weapon'),
    event('weaponChanged'), event('fold'), event('anchorProgress'), event('bossLaugh'),
    event('armorStrip'), event('playerHit')]) guide.onEvent(ev);
  assertStep(guide, 1);
  for (const owner of [undefined, null, '0', 1, -1]) {
    guide.onEvent(event('wallDraw', { owner }));
    guide.onEvent(event('erase', { owner }));
  }
  guide.onEvent({ type: 'wallDraw' });
  guide.onEvent({ type: 'erase', data: null });
  guide.weaponChanged();
  assertStep(guide, 2);
  guide.onEvent(achievements[1]);
  assertStep(guide, 3);
  guide.onEvent(achievements[2]);
  assertStep(guide, 4);
});

test('real shared wall/erase events award only owner 0; guide never mutates gameplay or snapshots', () => {
  const match = createMatch({ seed: 5, playerIds: [0, 1] });
  const guide = createGuide();
  for (const id of [1, 0]) {
    assert.equal(applyDraw(match, id, { x: 10, z: -12 }, { x: 10, z: -8 }).ok, true);
    assert.equal(applyErase(match, id).ok, true);
  }
  const before = JSON.stringify(match);
  const snap = snapshot(match);
  const originalSnap = structuredClone(snap);
  for (const ev of match.events.filter(ev => ev.data.owner === 1)) guide.onEvent(ev);
  guide.weaponChanged();
  assertStep(guide, 2);
  guide.onEvent(match.events.find(ev => ev.type === 'wallDraw' && ev.data.owner === 0));
  assertStep(guide, 3);
  guide.onEvent(match.events.find(ev => ev.type === 'erase' && ev.data.owner === 0));
  assertStep(guide, 4); // Accepted erase counts even with no nearby armor to strip.
  guide.update(snap, 1);
  guide.setEnabled(false);
  guide.update(snap, 1);
  guide.reset();
  assert.equal(JSON.stringify(match), before);
  assert.deepEqual(snap, originalSnap);
});

function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++) {
    for (const rest of permutations(values.filter((_, index) => index !== i))) yield [values[i], ...rest];
  }
}

test('all 120 action orderings retain prior achievements and skip already learned steps', () => {
  let count = 0;
  for (const order of permutations([0, 1, 2, 3, 4])) {
    const guide = createGuide();
    const done = new Set();
    for (const index of order) {
      guide.onEvent(achievements[index]);
      done.add(index);
      const missing = [0, 1, 2, 3, 4].find(i => !done.has(i));
      if (missing === undefined) assertComplete(guide);
      else assertStep(guide, missing + 1);
    }
    count++;
  }
  assert.equal(count, 120);
});

const bossAchievements = [
  event('hit', { id: 20, boss: true, dealt: 40, crit: true, critKind: 'belly' }),
  achievements[4],
  event('bossInterrupt', { by: 0, reason: 'erase', duration: 2 }),
  event('bossDown'),
];
for (let start = 1; start <= 4; start++) {
  for (const ev of bossAchievements) {
    test(`fast Boss at step ${start}: ${ev.type} completes despite unfinished earlier steps`, () => {
      const guide = createGuide();
      for (let i = 0; i < start - 1; i++) guide.onEvent(achievements[i]);
      assertStep(guide, start);
      guide.update(bossSnap, 0.016);
      assertStep(guide, 5);
      guide.update({ boss: null }, 0.016);
      assertStep(guide, 5);
      guide.onEvent(event('hit', { boss: true, crit: false }));
      assertStep(guide, 5);
      guide.onEvent(ev);
      assertComplete(guide);
    });
  }
}

test('Boss achievement before its first snapshot is retained, with a full completion interval', () => {
  for (const ev of bossAchievements) {
    const guide = createGuide();
    guide.onEvent(ev);
    assert.equal(guide.state().complete, false);
    guide.update(bossSnap, 10);
    assertComplete(guide);
    guide.update(bossSnap, 2.5);
    assertComplete(guide);
    guide.update(bossSnap, 0.5);
    assertComplete(guide, false);
  }
});

test('Boss selection uses presence, not phase alone, and stays selected until restart', () => {
  const guide = createGuide();
  for (const snap of [undefined, null, {}, { phase: 'boss', boss: null }, { boss: { dead: true } }]) {
    guide.update(snap, 1);
    assertStep(guide, 1);
  }
  guide.update(bossSnap, 0);
  for (const ev of achievements.slice(0, 4)) {
    guide.onEvent(ev);
    assertStep(guide, 5);
  }
  guide.update({ boss: null }, 10);
  assertStep(guide, 5);
});

test('all reported critical-hit kinds count, but a noncritical hit does not finish step five', () => {
  for (const critKind of ['head', 'stun', 'belly']) {
    const guide = createGuide();
    guide.update(bossSnap, 0);
    guide.onEvent(event('hit', { boss: true, crit: false, critKind: null }));
    assertStep(guide, 5);
    guide.onEvent(event('hit', { boss: true, crit: true, critKind }));
    assertComplete(guide);
  }
});

test('hide/show changes visibility only, including achievements and Boss selection while disabled', () => {
  const guide = createGuide({ enabled: false });
  assertStep(guide, 1, false);
  guide.weaponChanged();
  guide.onEvent(achievements[2]);
  assertStep(guide, 2, false);
  guide.setEnabled(true);
  assertStep(guide, 2);
  guide.setEnabled(false);
  guide.onEvent(achievements[1]);
  assertStep(guide, 4, false);
  guide.update(bossSnap, 1);
  assertStep(guide, 5, false);
  guide.onEvent(achievements[4]);
  assertComplete(guide, false, false);
  guide.setEnabled(true);
  assertComplete(guide);
});

test('completion is visible for three seconds; repeated achievements do not restart its clock', () => {
  const guide = createGuide();
  finish(guide);
  for (let i = 0; i < 11; i++) {
    guide.update(bossSnap, 0.25);
    guide.onEvent(achievements[4]);
    guide.weaponChanged();
    assertComplete(guide);
  }
  guide.update(bossSnap, 0.25);
  assertComplete(guide, false);
  guide.onEvent(event('bossDown'));
  guide.setEnabled(false);
  guide.setEnabled(true);
  guide.update(bossSnap, 1);
  assertComplete(guide, false);
});

test('completion clock rejects invalid/negative dt and keeps counting while disabled', () => {
  const guide = createGuide();
  finish(guide);
  for (const dt of [undefined, null, NaN, Infinity, -Infinity, -1, '3']) guide.update(null, dt);
  guide.update(null, 2.5);
  assertComplete(guide);
  guide.setEnabled(false);
  guide.update(null, 0.5);
  assertComplete(guide, false, false);
  guide.setEnabled(true);
  assertComplete(guide, false);
  guide.update(null, 100);
  assertComplete(guide, false);
});

test('reset clears all progress, Boss selection and completion time while preserving configured enabled', () => {
  const guide = createGuide();
  for (const enabled of [false, true]) {
    guide.setEnabled(enabled);
    finish(guide);
    guide.update(bossSnap, 10);
    guide.reset();
    assertStep(guide, 1, enabled);
    guide.weaponChanged();
    assertStep(guide, 2, enabled);
    guide.onEvent(achievements[1]);
    assertStep(guide, 3, enabled);
    guide.onEvent(achievements[2]);
    assertStep(guide, 4, enabled);
    guide.onEvent(achievements[3]);
    assertStep(guide, 5, enabled);
    guide.update(bossSnap, 10);
    assertStep(guide, 5, enabled);
    guide.onEvent(achievements[4]);
    assertComplete(guide, enabled, enabled);
    guide.update(null, 2.5);
    assertComplete(guide, enabled, enabled);
    guide.reset();
    assertStep(guide, 1, enabled);
  }
});

test('guide instances and returned state objects are independent', () => {
  const first = createGuide();
  const second = createGuide({ enabled: false });
  Object.assign(first.state(), { step: 5, title: 'changed', complete: true, enabled: false });
  assertStep(first, 1);
  finish(first);
  assertStep(second, 1, false);
});

const defaults = { sensitivity: 0.0022, fov: 68, sfxVolume: 0.85, bossVolume: 0.35, bgmVolume: 0.65, showGuide: true };
const changed = { sensitivity: 0.0031, fov: 83, sfxVolume: 0.4, bossVolume: 0.7, bgmVolume: 0.3, showGuide: false };

test('settings defaults are exact, frozen, and normalized results are independent objects', () => {
  assert.deepEqual(DEFAULT_SETTINGS, defaults);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
  const value = normalizeSettings();
  assert.deepEqual(value, defaults);
  assert.notEqual(value, DEFAULT_SETTINGS);
  value.fov = 95;
  assert.equal(DEFAULT_SETTINGS.fov, 68);
  assert.deepEqual(normalizeSettings(Object.freeze({ ...changed, extra: 9 })), changed);
});

test('normalization defaults invalid roots, fills partial data and accepts only boolean showGuide', () => {
  for (const raw of [undefined, null, false, true, 12, 'data', [], [changed]]) {
    assert.deepEqual(normalizeSettings(raw), defaults);
  }
  assert.deepEqual(normalizeSettings({ fov: 80, showGuide: false }), { ...defaults, fov: 80, showGuide: false });
  for (const showGuide of [null, undefined, 'false', 'true', 0, 1, NaN, {}, []]) {
    assert.equal(normalizeSettings({ showGuide }).showGuide, true);
  }
});

test('numeric settings reject strings, NaN, infinities, booleans and boxed/coercible numbers', () => {
  for (const value of ['0.004', '', null, undefined, NaN, Infinity, -Infinity, true, false,
    [], {}, new Number(80), { valueOf: () => 80 }, 1n]) {
    assert.deepEqual(normalizeSettings({ sensitivity: value, fov: value, sfxVolume: value, bossVolume: value, bgmVolume: value }), defaults);
  }
});

test('numeric settings clamp exactly to both boundaries, retain zero volumes, and never mutate input', () => {
  const low = Object.freeze({ sensitivity: -1, fov: 0, sfxVolume: -2, bossVolume: -1, bgmVolume: -1, showGuide: false });
  const high = Object.freeze({ sensitivity: 1, fov: 120, sfxVolume: 2, bossVolume: 2, bgmVolume: 2, showGuide: true });
  const min = { sensitivity: 0.0008, fov: 60, sfxVolume: 0, bossVolume: 0, bgmVolume: 0, showGuide: false };
  const max = { sensitivity: 0.005, fov: 95, sfxVolume: 1, bossVolume: 1, bgmVolume: 1, showGuide: true };
  assert.deepEqual(normalizeSettings(low), min);
  assert.deepEqual(normalizeSettings(high), max);
  assert.deepEqual(normalizeSettings(min), min);
  assert.deepEqual(normalizeSettings(max), max);
  assert.equal(low.sensitivity, -1);
  assert.equal(high.fov, 120);
});

function memoryStorage(initial = null) {
  return {
    values: new Map(initial === null ? [] : [[CONFIG.storage.settings, initial]]),
    reads: [], writes: [],
    getItem(key) { this.reads.push(key); return this.values.get(key) ?? null; },
    setItem(key, value) { this.writes.push([key, value]); this.values.set(key, value); },
  };
}

// Replacing the descriptor avoids invoking Node/browser localStorage getters during setup.
function withLocalStorage(descriptor, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor });
  try { run(); }
  finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

test('load reads CONFIG storage key without writes; save normalizes JSON and round-trips', () => {
  const storage = memoryStorage(JSON.stringify(changed));
  assert.deepEqual(loadSettings(storage), changed);
  assert.deepEqual(storage.reads, [CONFIG.storage.settings]);
  assert.deepEqual(storage.writes, []);
  const raw = Object.freeze({ sensitivity: 0.1, fov: '90', sfxVolume: NaN, bossVolume: -1, bgmVolume: -2, voiceVolume: 0.2, showGuide: false, extra: 'discard' });
  const expected = { ...defaults, sensitivity: 0.005, bossVolume: 0, bgmVolume: 0, showGuide: false };
  const saved = saveSettings(raw, storage);
  assert.deepEqual(saved, expected);
  assert.notEqual(saved, raw);
  assert.deepEqual(storage.writes, [[CONFIG.storage.settings, JSON.stringify(expected)]]);
  assert.deepEqual(loadSettings(storage), expected);
  assert.equal(raw.extra, 'discard');
  saved.fov = 95;
  assert.deepEqual(loadSettings(storage), expected);
});

test('load handles missing values, invalid JSON and non-object JSON without throwing', () => {
  for (const raw of [null, '', '{broken', 'undefined', 'NaN', 'null', 'true', '2', '"string"', '[]']) {
    const storage = memoryStorage(raw);
    assert.deepEqual(loadSettings(storage), defaults);
    assert.deepEqual(storage.writes, []);
  }
  const storage = memoryStorage('{"sensitivity":"0.003","fov":999,"sfxVolume":null,"bossVolume":0,"voiceVolume":0.2,"bgmVolume":null,"showGuide":"false"}');
  assert.deepEqual(loadSettings(storage), { ...defaults, fov: 95, bossVolume: 0 });
});

test('storage failures and absent storage silently fall back and still return normalized saves', () => {
  const fail = () => { throw new Error('storage unavailable'); };
  for (const storage of [null, {}, { getItem: fail, setItem: fail },
    { get getItem() { return fail(); }, get setItem() { return fail(); } }]) {
    assert.deepEqual(loadSettings(storage), defaults);
    assert.deepEqual(saveSettings(changed, storage), changed);
    assert.deepEqual(saveSettings({ fov: 200, bossVolume: NaN, voiceVolume: -1, bgmVolume: 2 }, storage), { ...defaults, fov: 95, bgmVolume: 1 });
  }
});

test('omitted storage resolves global getter inside try, including explicit undefined and getter exceptions', () => {
  const storage = memoryStorage(JSON.stringify(changed));
  withLocalStorage({ get: () => storage }, () => {
    assert.deepEqual(loadSettings(), changed);
    assert.deepEqual(saveSettings(defaults), defaults);
    assert.deepEqual(loadSettings(undefined), defaults);
    assert.equal(storage.writes.length, 1);
  });
  withLocalStorage({ get() { throw new Error('SecurityError'); } }, () => {
    assert.deepEqual(loadSettings(), defaults);
    assert.deepEqual(loadSettings(undefined), defaults);
    assert.deepEqual(saveSettings(changed), changed);
    assert.deepEqual(saveSettings(changed, undefined), changed);
    const explicit = memoryStorage(JSON.stringify(changed));
    assert.deepEqual(loadSettings(explicit), changed);
    assert.deepEqual(saveSettings(changed, explicit), changed);
    assert.equal(explicit.writes.length, 1);
  });
  withLocalStorage({ value: undefined }, () => {
    assert.deepEqual(loadSettings(), defaults);
    assert.deepEqual(saveSettings(changed), changed);
  });
});

function settingsTargets() {
  const calls = [];
  const input = {
    setSensitivity(value) { assert.equal(this, input); this.sensitivity = value; calls.push(['setSensitivity', value]); },
  };
  const renderer = {
    muted: true,
    setBaseFov(value) { assert.equal(this, renderer); this.fov = value; calls.push(['setBaseFov', value]); },
    setBossLaughVolume(value) { assert.equal(this, renderer); this.volume = value; calls.push(['setBossLaughVolume', value]); },
    setBossSoundMuted() { assert.fail('settings must not alter Boss mute'); },
  };
  const audio = {
    muted: true,
    setVolume(value) { assert.equal(this, audio); this.volume = value; calls.push(['setVolume', value]); },
    setMuted() { assert.fail('settings must not alter SFX mute'); },
    toggleMute() { assert.fail('settings must not toggle SFX mute'); },
  };
  const bgm = {
    setVolume(value) { assert.equal(this, bgm); this.volume = value; calls.push(['bgmVolume', value]); },
    setMuted() { assert.fail('settings must not alter BGM mute'); },
  };
  const guide = {
    setEnabled(value) { assert.equal(this, guide); this.enabled = value; calls.push(['setEnabled', value]); },
  };
  return { input, renderer, audio, bgm, guide, calls };
}

test('applySettings synchronously calls actual realtime interface methods with normalized values and intact receivers', () => {
  const targets = settingsTargets();
  for (const raw of [changed, { sensitivity: 1, fov: 120, sfxVolume: -1, bossVolume: 0, showGuide: false }, {}]) {
    targets.calls.length = 0;
    const expected = normalizeSettings(raw);
    const result = applySettings(raw, targets);
    assert.deepEqual(result, expected);
    assert.deepEqual(targets.calls, [
      ['setSensitivity', expected.sensitivity], ['setBaseFov', expected.fov],
      ['setVolume', expected.sfxVolume], ['setBossLaughVolume', expected.bossVolume],
      ['bgmVolume', expected.bgmVolume],
      ['setEnabled', expected.showGuide],
    ]);
    assert.equal(targets.input.sensitivity, expected.sensitivity);
    assert.equal(targets.renderer.fov, expected.fov);
    assert.equal(targets.audio.volume, expected.sfxVolume);
    assert.equal(targets.renderer.volume, expected.bossVolume);
    assert.equal(targets.bgm.volume, expected.bgmVolume);
    assert.equal(targets.guide.enabled, expected.showGuide);
    assert.equal(targets.audio.muted, true);
    assert.equal(targets.renderer.muted, true);
  }
});

test('applying settings changes real guide visibility immediately without resetting it or persisting anything', () => {
  const targets = settingsTargets();
  targets.guide = createGuide();
  targets.guide.weaponChanged();
  const storage = memoryStorage();
  withLocalStorage({ value: storage }, () => {
    applySettings({ showGuide: false }, targets);
    assertStep(targets.guide, 2, false);
    targets.guide.onEvent(achievements[1]);
    applySettings({ showGuide: true, sfxVolume: 0, bossVolume: 0, bgmVolume: 0 }, targets);
    assertStep(targets.guide, 3);
    assert.deepEqual(storage.reads, []);
    assert.deepEqual(storage.writes, []);
  });
});
