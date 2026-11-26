import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import CONFIG from '../shared/config.mjs';
import { perkMods, rollPerkChoices, applyPerk } from '../shared/perks.mjs';
import { createMatch, createPlayer, stepPlayer, snapshot, drainEvents, startReload, applyFire, switchWeapon } from '../shared/sim.mjs';
import { drawCost, validateDraw, applyDraw, stepWalls } from '../shared/walls.mjs';
import { applyErase } from '../shared/erase.mjs';
import { applyShot } from '../shared/combat.mjs';
import { createBoss, damageBoss } from '../shared/boss.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { createRuntime } from '../host/runtime.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const IDS = ['quick_ink', 'heavy_nib', 'armor_pierce', 'wide_erase', 'thick_wall', 'light_feet'];
const DEFAULTS = {
  speedMul: 1, inkRegenMul: 1, reloadMul: 1, drawCostMul: 1,
  wallHpMul: 1, wallLifeAdd: 0, wallHeal: 0, eraseRadiusAdd: 0,
  eraseCdMul: 1, dmgMul: 1, armorDmgMul: 1, shieldMulOverride: null,
};
const MODS = [
  { inkRegenMul: 1.45, drawCostMul: 0.8 },
  { dmgMul: 1.22 },
  { armorDmgMul: 2, shieldMulOverride: 0.62 },
  { eraseRadiusAdd: 3, eraseCdMul: 0.7 },
  { wallHpMul: 1.6, wallLifeAdd: 6, wallHeal: 8 },
  { speedMul: 1.18, reloadMul: 0.7 },
];
const forward = { x: 0, y: 0, z: 1 };
const wallEnds = [{ x: 3, z: 0 }, { x: 3, z: 2 }];

function arena(perks = [], seed = 71) {
  const m = createMatch({ seed });
  m.statics = []; m.folds = []; m.foldWalls = [];
  m.players[0].pos = { x: 0, y: 1, z: 0 };
  for (const id of perks) assert.equal(applyPerk(m, 0, id).ok, true);
  drainEvents(m);
  return m;
}

function step(p, dt, elapsed = 10, input = {}, regenRate) {
  stepPlayer(p, input, dt, { elapsed, regenRate, staticColliders: [], walls: [], foldWalls: [], folds: [] });
}

function equip(m, idx) {
  const p = m.players[0];
  if (idx !== p.weapon) assert.equal(switchWeapon(p, idx), true);
  p.fireCd = 0;
  return p;
}

function shoot(m) {
  return applyShot(m, 0, m.players[0].pos, forward);
}

function bossArena(perks = []) {
  const m = arena(perks);
  const b = createBoss(m);
  b.x = 0; b.z = 2;
  drainEvents(m);
  return { m, b, p: m.players[0] };
}

test('Sprint C: every pre-C CONFIG entry matches the fingerprint captured before edits', () => {
  // SHA-256 of JSON.stringify(CONFIG) re-baselined for the authorized OVERHAUL-2 Boss spec.
  const { perks, ...legacy } = CONFIG;
  assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    'e27ab38677a7fdcf61d5fd560c48101f1fc9327800a9ddbe3c7be7abe9587e13');
  assert.equal(Object.keys(CONFIG).at(-1), 'perks');
  assert.equal(perks, CONFIG.perks);
});

test('Sprint C: exact six-key metadata object, names, CSS colors and sparse modifier contract', () => {
  assert.equal(Array.isArray(CONFIG.perks), false);
  assert.deepEqual(Object.keys(CONFIG.perks), IDS);
  const names = ['速干墨囊', '加粗笔尖', '腐蚀墨水', '强力橡皮', '双层卡纸墙', '折纸轻功'];
  IDS.forEach((id, i) => {
    const meta = CONFIG.perks[id];
    assert.deepEqual(Object.keys(meta).sort(), ['color', 'effect', 'mods', 'name']);
    assert.equal(meta.name, names[i]);
    assert.match(meta.color, /^#[0-9a-f]{6}$/i);
    assert.match(meta.effect, /[\u4e00-\u9fff]/u);
    assert.ok(meta.effect.length <= 32);
    assert.deepEqual(meta.mods, MODS[i]);
    assert.deepEqual(perkMods({ perks: [id] }), { ...DEFAULTS, ...MODS[i] });
  });
  assert.equal(new Set(Object.values(CONFIG.perks).map(meta => meta.color)).size, 6);
});

test('Sprint C: no-perk modifiers share an immutable allocation-free identity', () => {
  const identity = perkMods();
  assert.deepEqual(identity, DEFAULTS);
  for (const p of [null, {}, { perks: [] }, createPlayer(0, { x: 0, z: 0 })]) {
    assert.equal(perkMods(p), identity);
  }
  assert.equal(Object.isFrozen(identity), true);
  assert.throws(() => { identity.speedMul = 99; }, TypeError);
});

test('Sprint C: modifier composition is order-independent, immutable and tracks subsequent picks', () => {
  const p = arena(['heavy_nib']).players[0];
  const first = perkMods(p);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { first.dmgMul = 99; }, TypeError);
  p.perks.push('light_feet');
  assert.deepEqual(perkMods(p), { ...DEFAULTS, ...MODS[1], ...MODS[5] });
  assert.equal(first.speedMul, 1);
  const all = { ...DEFAULTS, ...Object.assign({}, ...MODS) };
  const owned = Object.freeze([...IDS]);
  assert.deepEqual(perkMods({ perks: owned }), all);
  assert.deepEqual(perkMods({ perks: [...IDS].reverse() }), all);
  assert.deepEqual(perkMods({ perks: [...IDS, ...IDS, 'unknown', '__proto__'] }), all);
  assert.deepEqual(perkMods({ perks: ['unknown', 'constructor'] }), DEFAULTS);
});

test('Sprint C: players and every snapshot own independent perk arrays, including legacy fallback', () => {
  const m = createMatch({ playerIds: [0, 1] });
  const [p, q] = m.players;
  assert.deepEqual(p.perks, []);
  assert.deepEqual(q.perks, []);
  assert.notEqual(p.perks, q.perks);
  const before = snapshot(m);
  applyPerk(m, 0, 'quick_ink');
  const after = snapshot(m);
  assert.deepEqual(before.players[0].pk, []);
  assert.deepEqual(after.players[0].pk, ['quick_ink']);
  after.players[0].pk.push('heavy_nib');
  assert.deepEqual(p.perks, ['quick_ink']);
  assert.deepEqual(q.perks, []);
  delete q.perks;
  assert.deepEqual(snapshot(m).players[1].pk, []);
});

test('Sprint C: direct picks require no offer or anchor and emit the exact contract', () => {
  const m = createMatch({ playerIds: ['solo'] });
  for (const perkId of IDS) {
    assert.deepEqual(applyPerk(m, 'solo', perkId), { ok: true, perkId });
    assert.deepEqual(drainEvents(m), [{ type: 'perkPick', data: { playerId: 'solo', perkId, name: CONFIG.perks[perkId].name } }]);
  }
  assert.deepEqual(m.players[0].perks, IDS);
  assert.equal(m.anchorsDone, 0);
  const legacy = createMatch();
  delete legacy.players[0].perks;
  assert.equal(applyPerk(legacy, 0, 'heavy_nib').ok, true);
});

test('Sprint C: invalid, missing, downed, dead and duplicate picks cannot mutate state', () => {
  const m = arena(['quick_ink']);
  const p = m.players[0];
  const before = structuredClone(p);
  for (const id of ['unknown', '__proto__', 'constructor', 'toString', '', null, undefined, 1, true, {}, [], ['heavy_nib'], Symbol('perk')]) {
    assert.deepEqual(applyPerk(m, 0, id), { ok: false, reason: 'invalidPerk' });
    assert.deepEqual(p, before);
  }
  assert.deepEqual(applyPerk(m, 0, 'quick_ink'), { ok: false, reason: 'owned' });
  assert.deepEqual(applyPerk(m, 99, 'quick_ink'), { ok: false, reason: 'noPlayer' });
  for (const st of [1, 2]) {
    p.st = st;
    assert.deepEqual(applyPerk(m, 0, 'heavy_nib'), { ok: false, reason: 'dead' });
    assert.deepEqual(p, { ...before, st });
  }
  assert.deepEqual(m.events, []);
});

test('Sprint C: runtime perk dispatch preserves validation and exposes copied pk', () => {
  const rt = createRuntime();
  assert.deepEqual(rt.action(0, { m: 'perk', perkId: 'light_feet' }), { ok: true, perkId: 'light_feet' });
  assert.deepEqual(rt.snapshot().players[0].pk, ['light_feet']);
  assert.deepEqual(rt.action(0, { m: 'perk', perkId: 'light_feet' }), { ok: false, reason: 'owned' });
  assert.deepEqual(rt.action(0, { m: 'perk', perkId: 'bad' }), { ok: false, reason: 'invalidPerk' });
  assert.deepEqual(rt.action(99, { m: 'perk', perkId: 'quick_ink' }), { ok: false, reason: 'noPlayer' });
});

test('Sprint C: all ownership subsets offer up to three distinct unowned IDs without mutation', () => {
  for (let mask = 0; mask < 64; mask++) {
    const owned = Object.freeze(IDS.filter((id, i) => mask & (1 << i)));
    for (const seed of [0, 1, -1, 71, 20261111, 0xffffffff]) {
      for (const anchorIdx of [0, 1, 2]) {
        const choices = rollPerkChoices(seed, anchorIdx, owned);
        assert.equal(choices.length, Math.min(3, 6 - owned.length));
        assert.equal(new Set(choices).size, choices.length);
        assert.ok(choices.every(id => IDS.includes(id) && !owned.includes(id)));
        assert.deepEqual(choices, rollPerkChoices(seed, anchorIdx, [...owned].reverse()));
      }
    }
  }
  assert.deepEqual(rollPerkChoices(1, 0, IDS), []);
  assert.deepEqual(rollPerkChoices(1, 0, IDS.slice(0, 5)), ['light_feet']);
});

test('Sprint C: offer hash depends on seed and anchor; owned filtering and caller mutation are isolated', () => {
  const choices = rollPerkChoices(71, 0);
  assert.deepEqual(choices, rollPerkChoices(71, 0, []));
  assert.deepEqual(choices, rollPerkChoices(71, 0, ['unknown', 'unknown']));
  assert.ok(new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(rollPerkChoices(i, 0)))).size > 10);
  assert.ok(new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(rollPerkChoices(71, i)))).size > 5);
  assert.deepEqual(rollPerkChoices(71, 0, [choices[0]]).slice(0, 2), choices.slice(1));
  const original = [...choices];
  choices.pop();
  assert.deepEqual(rollPerkChoices(71, 0), original);
});

test('Sprint C: perk operations consume zero global/simulation RNG and leave RNG streams untouched', t => {
  const m = arena();
  const control = arena();
  const rand = m.rand;
  Object.defineProperty(m, 'rand', { get() { assert.fail('perk operation accessed simulation RNG'); } });
  t.mock.method(Math, 'random', () => assert.fail('perk operation accessed global RNG'));
  for (let anchor = 0; anchor < 3; anchor++) {
    const choices = rollPerkChoices(m.seed, anchor, m.players[0].perks);
    applyPerk(m, 0, choices[0]);
    perkMods(m.players[0]);
  }
  for (let i = 0; i < 20; i++) assert.equal(rand(), control.rand());
  const source = readFileSync(new URL('../shared/perks.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\s*\.\s*random|match\s*\.\s*rand/);
});

for (const sprint of [false, true]) {
  test(`Sprint C: light_feet multiplies ${sprint ? 'sprint' : 'walk'} speed by 1.18`, () => {
    const p = arena(['light_feet']).players[0];
    const q = arena().players[0];
    const input = { f: 1, r: 0.5, sprint };
    for (let i = 0; i < 10; i++) { step(p, 0.05, 10, input); step(q, 0.05, 10, input); }
    near(p.velX, q.velX * 1.18); near(p.velZ, q.velZ * 1.18);
    near(p.pos.x, q.pos.x * 1.18); near(p.pos.z, q.pos.z * 1.18);
  });
}

test('Sprint C: light_feet preserves fixed crawl/dead and jump behavior', () => {
  for (const st of [0, 1, 2]) {
    const p = arena(['light_feet']).players[0];
    const q = arena().players[0];
    p.st = q.st = st;
    step(p, 0.05, 10, { f: 1, sprint: true, jump: true });
    step(q, 0.05, 10, { f: 1, sprint: true, jump: true });
    assert.equal(p.velY, q.velY);
    assert.equal(p.pos.y, q.pos.y);
    if (st !== 0) { assert.equal(p.velZ, q.velZ); assert.equal(p.pos.z, q.pos.z); }
  }
});

for (const rate of [undefined, 10, 15]) {
  test(`Sprint C: quick_ink multiplies regen ${rate ?? 'default'} by 1.45, respecting delay and cap`, () => {
    const p = arena(['quick_ink']).players[0];
    p.ink = 20; p.lastSkill = 0;
    step(p, 0.1, 0.8, {}, rate);
    assert.equal(p.ink, 20);
    step(p, 0.1, 0.81, {}, rate);
    near(p.ink, 20 + (rate ?? 10) * 1.45 * 0.1);
    p.ink = 99.9;
    step(p, 0.1, 1, {}, rate);
    assert.equal(p.ink, 100);
  });
}

for (const idx of [0, 1, 2]) {
  test(`Sprint C: light_feet weapon ${idx} manual/auto reload is 70%, cadence unchanged`, () => {
    const m = arena(['light_feet']);
    const p = equip(m, idx);
    const w = CONFIG.player.weapons[idx];
    assert.equal(startReload(p), false);
    p.ammo--;
    assert.equal(startReload(p), true);
    assert.equal(p.reload, w.reloadTime * 0.7);
    step(p, p.reload - 0.01);
    assert.equal(p.ammo, w.magazine - 1);
    step(p, 0.02);
    assert.equal(p.ammo, w.magazine);
    p.ammo = 1;
    assert.equal(applyFire(p), 'fired');
    assert.equal(p.reload, w.reloadTime * 0.7);
    assert.equal(p.fireCd, w.fireInterval);
    p.reload = 0; p.fireCd = 0;
    assert.equal(applyFire(p), 'autoReload');
    assert.equal(p.reload, w.reloadTime * 0.7);
  });
}

test('Sprint C: drawCost optional player preserves old exact formula and quick_ink discount', () => {
  const p = arena(['quick_ink']).players[0];
  for (const len of [0, 0.1, 2, 4, 6, 100, -1, Infinity, NaN]) {
    const old = 20 + 4 * len;
    assert.equal(drawCost(len), old);
    assert.equal(drawCost(len, {}), old);
    assert.equal(drawCost(len, { perks: [] }), old);
    assert.equal(drawCost(len, p), old * 0.8);
  }
});

test('Sprint C: drawStart, preview and commit share the discounted minimum without shape changes', () => {
  for (const perks of [[], ['quick_ink']]) {
    const rt = createRuntime();
    const p = rt.match.players[0];
    p.pos = { x: 0, y: 1, z: 0 };
    for (const id of perks) applyPerk(rt.match, 0, id);
    const cost = 28 * (perks.length ? 0.8 : 1);
    p.ink = cost - 1e-6;
    assert.deepEqual(rt.action(0, { m: 'drawStart' }), { ok: false, reason: 'ink' });
    assert.equal(validateDraw(rt.match, p, ...wallEnds).reason, 'ink');
    p.ink = cost;
    assert.deepEqual(rt.action(0, { m: 'drawStart' }), { ok: true, reason: undefined });
    assert.deepEqual(validateDraw(rt.match, p, ...wallEnds), { ok: true, len: 2, cost, a: wallEnds[0], b: wallEnds[1] });
    const result = rt.action(0, { m: 'drawEnd', ax: 3, az: 0, bx: 3, bz: 2 });
    assert.equal(result.ok, true);
    assert.equal(p.ink, 0);
  }
});

test('Sprint C: thick_wall creates 192 HP/24s walls and heals only the owner up to max HP', () => {
  const m = arena(['thick_wall', 'quick_ink']);
  const p = m.players[0];
  m.players.push(createPlayer(1, { x: -3, z: 0 }));
  m.players[1].hp = 40;
  for (const [before, after] of [[50, 58], [97, 100], [100, 100]]) {
    p.ink = 100; p.hp = before;
    const result = applyDraw(m, 0, ...wallEnds);
    assert.deepEqual(Object.keys(result), ['ok', 'wall']);
    assert.equal(result.wall.hp, 192);
    assert.equal(result.wall.life, 24);
    assert.equal(p.hp, after);
    assert.equal(m.players[1].hp, 40);
    near(p.ink, 100 - 22.4);
  }
  assert.equal(p.stats.walls, 3);
  const walls = snapshot(m).walls;
  assert.ok(walls.every(w => w.hp === 192 && w.life === 24));
  assert.ok(m.events.every(ev => ev.type === 'wallDraw'));
  stepWalls(m, 23.99);
  assert.equal(m.walls.length, 3);
  stepWalls(m, 0.02);
  assert.equal(m.walls.length, 0);
});

test('Sprint C: thick_wall never heals on failed draws or retroactively changes existing walls', () => {
  const m = arena();
  const p = m.players[0];
  p.hp = 50;
  const oldWall = applyDraw(m, 0, ...wallEnds).wall;
  assert.equal(p.hp, 50);
  applyPerk(m, 0, 'thick_wall');
  assert.deepEqual([oldWall.hp, oldWall.life], [120, 18]);
  const before = structuredClone(p);
  assert.equal(applyDraw(m, 0, wallEnds[0], { x: 3, z: 1 }).reason, 'short');
  assert.deepEqual(p, before);
  p.ink = 0;
  assert.equal(applyDraw(m, 0, ...wallEnds).reason, 'ink');
  assert.equal(p.hp, 50);
  p.ink = 100; p.st = 1;
  assert.deepEqual(applyDraw(m, 0, ...wallEnds), { ok: false, reason: 'dead' });
  assert.equal(p.hp, 50);
});

test('Sprint C: wide_erase reaches all enemy effects through planar 9m, with unchanged 35 ink cost', () => {
  const m = arena(['wide_erase', 'quick_ink']);
  const p = m.players[0];
  const inside = ['crane', 'eraser', 'plane'].map(type => createEnemy(m, type, 0, 9));
  const outside = createEnemy(m, 'crane', 0, 9.00001);
  const dead = createEnemy(m, 'crane', 0, 8); dead.dead = true;
  inside.forEach(e => { e.telegraph = 0.4; e.y = 100; });
  const hp = inside.map(e => e.hp);
  const result = applyErase(m, 0);
  assert.deepEqual(result, { ok: true, stripped: 1, hit: inside.map(e => e.id) });
  inside.forEach((e, i) => {
    assert.deepEqual([e.armor, e.stun, e.slow, e.telegraph, e.hp], [0, 1, 3.5, 0, hp[i]]);
  });
  assert.equal(outside.armor, 24); assert.equal(outside.stun, 0);
  assert.equal(dead.armor, 24); assert.equal(dead.stun, 0);
  assert.equal(p.ink, 65); near(p.eraseCd, 2.45);
  assert.equal(p.lastSkill, m.elapsed); assert.equal(p.stats.erases, 1);
  assert.deepEqual(drainEvents(m), [{ type: 'erase', data: { owner: 0, x: 0, z: 0, stripped: 1, hit: inside.map(e => e.id) } }]);
  assert.deepEqual(applyErase(m, 0), { ok: false, reason: 'cooldown', cd: p.eraseCd });
  for (let i = 0; i < 49; i++) step(p, 0.05, 0);
  assert.equal(p.eraseCd, 0);
  p.ink = 34.99;
  assert.deepEqual(applyErase(m, 0), { ok: false, reason: 'ink', need: 35 });
  p.ink = 35;
  assert.equal(applyErase(m, 0).ok, true);
  assert.equal(p.ink, 0);
});

for (const state of ['fan', 'summon', 'charge', 'idle', 'charging']) {
  test(`Sprint C: wide_erase applies Boss ${state} effects at 9m, not beyond`, () => {
    for (const laughing of [false, true]) {
      for (const distance of [9, 9.00001]) {
        const { m, b } = bossArena(['wide_erase']);
        b.state = state; b.z = distance; b.y = 100;
        b.telegraph = 0.4; b.laughExposeT = laughing ? 2 : 0;
        const result = applyErase(m, 0);
        assert.equal(b.hp, b.maxHp);
        if (distance > 9) {
          assert.deepEqual(result, { ok: true, stripped: 0, hit: [] });
          assert.deepEqual([b.state, b.stunT, b.slowT], [state, 0, 0]);
        } else if (laughing || ['fan', 'summon', 'charge'].includes(state)) {
          assert.deepEqual(result, { ok: true, stripped: 0, hit: [], bossInterrupted: true });
          assert.deepEqual([b.state, b.telegraph, b.attackCd, b.laughExposeT, b.stunT], ['idle', 0, 2, 0, 2]);
        } else {
          assert.deepEqual(result, { ok: true, stripped: 0, hit: [], bossSlowed: true });
          assert.equal(b.slowT, 1.5);
          assert.equal(b.state, state);
        }
      }
    }
  });
}

for (const idx of [0, 1, 2]) {
  for (const perks of [['heavy_nib'], ['armor_pierce'], ['heavy_nib', 'armor_pierce']]) {
    test(`Sprint C: weapon ${idx} scales health/armor once for ${perks.join('+')}`, () => {
      for (const armored of [false, true]) {
        const m = arena(perks);
        const e = createEnemy(m, 'crane', 0, 2);
        e.hp = 1000; e.armor = armored ? 1000 : 0;
        equip(m, idx);
        const w = CONFIG.player.weapons[idx];
        const dealt = armored ? w.armorDamage * (perks.includes('armor_pierce') ? 2 : 1) : w.damage * (perks.includes('heavy_nib') ? 1.22 : 1);
        shoot(m);
        const hits = m.events.filter(ev => ev.type === 'hit');
        assert.equal(hits.length, w.pellets);
        assert.deepEqual(hits.map(ev => ev.data.dealt), Array(w.pellets).fill(dealt));
        near(e.hp, armored ? 1000 : 1000 - dealt * w.pellets);
        near(e.armor, armored ? 1000 - dealt * w.pellets : 0);
        assert.equal(m.players[0].ammo, w.magazine - 1);
        assert.equal(m.players[0].fireCd, w.fireInterval);
      }
    });
  }
}

test('Sprint C: pen reports actual partial armor damage; stripping does not spill into HP', () => {
  const m = arena(['armor_pierce', 'heavy_nib']);
  const e = createEnemy(m, 'crane', 0, 2);
  e.armor = 2;
  const first = shoot(m);
  assert.equal(e.armor, 0); assert.equal(e.hp, 48);
  assert.deepEqual(drainEvents(m), [
    { type: 'armorStrip', data: { id: e.id } },
    { type: 'hit', data: { id: e.id, point: first.end, armored: false, dealt: 2 } },
    { type: 'shot', data: { id: 0, end: first.end, kind: 'enemy' } },
  ]);
  m.players[0].fireCd = 0;
  shoot(m);
  assert.equal(m.events[0].data.dealt, 24 * 1.22);
  near(e.hp, 48 - 24 * 1.22);
});

for (const c of [
  { name: 'heavy torso', perks: ['heavy_nib'], dealt: 12 },
  { name: 'piercing torso', perks: ['armor_pierce'], dealt: 15 },
  { name: 'combined torso', perks: ['heavy_nib', 'armor_pierce'], dealt: 19 },
  { name: 'combined head', perks: ['heavy_nib', 'armor_pierce'], y: 2, dealt: 25, crit: 'head' },
  { name: 'combined belly bypass', perks: ['heavy_nib', 'armor_pierce'], ex: 2, dealt: 47, crit: 'belly' },
  { name: 'combined stun bypass', perks: ['heavy_nib', 'armor_pierce'], stun: 2, dealt: 47, crit: 'stun' },
  { name: 'heavy fractional rage', perks: ['heavy_nib'], raged: true, dealt: 22 },
  { name: 'piercing rage ignores shield', perks: ['armor_pierce'], raged: true, dealt: 22 },
  { name: 'combined rage opts rounding', perks: ['heavy_nib', 'armor_pierce'], raged: true, dealt: 27 },
  { name: 'combined raged head', perks: ['heavy_nib', 'armor_pierce'], raged: true, y: 2, dealt: 36, crit: 'head' },
]) {
  test(`Sprint C: Boss ${c.name} scales damage only once and preserves crit priority`, () => {
    const { m, b, p } = bossArena(c.perks);
    p.pos.y = c.y ?? 1;
    if (c.raged) { b.phase = 2; b.raged = true; }
    b.laughExposeT = c.ex ?? 0; b.stunT = c.stun ?? 0;
    const result = shoot(m);
    assert.deepEqual(result, { ok: true, kind: 'boss', end: result.end });
    assert.equal(b.hp, b.maxHp - c.dealt);
    assert.deepEqual(p.hate, [{ t: 0, n: c.dealt }]);
    assert.deepEqual(m.events[0], { type: 'hit', data: { id: b.id, point: result.end, boss: true, dealt: c.dealt, crit: !!c.crit, critKind: c.crit ?? null } });
  });
}

test('Sprint C: direct damageBoss never reads attacker perks; override is optional and phase-aware', () => {
  const cases = [
    { n: 24, dealt: 10 },
    { n: 1.25, raged: true, dealt: 1 },
    { n: 1.25, raged: true, opts: {}, dealt: 1 },
    { n: 24, opts: { shieldMulOverride: 0.62 }, dealt: 15 },
    { n: 24, opts: { shieldMulOverride: null }, dealt: 10 },
    { n: 24, opts: { shieldMulOverride: 0.62, mul: 1.35 }, dealt: 21 },
    { n: 24, opts: { shieldMulOverride: 0.62, bypassShield: true, mul: 1.6 }, dealt: 38 },
    { n: 24, opts: { shieldMulOverride: 0.62 }, stun: 1, dealt: 24 },
    { n: 24, opts: { shieldMulOverride: 0.62 }, raged: true, dealt: 22 },
  ];
  for (const perks of [[], IDS]) {
    for (const c of cases) {
      const { m, b, p } = bossArena(perks);
      if (c.raged) { b.phase = 2; b.raged = true; }
      b.stunT = c.stun ?? 0;
      assert.equal(damageBoss(m, c.n, p.id, c.opts), c.dealt);
      assert.equal(b.hp, b.maxHp - c.dealt);
    }
  }
});

test('Sprint C: marker and liner Boss hits scale per pellet without double-applying heavy_nib', () => {
  for (const idx of [1, 2]) {
    for (const stun of [0, 1]) {
      const { m, b } = bossArena(['heavy_nib', 'armor_pierce']);
      equip(m, idx); b.stunT = stun;
      const w = CONFIG.player.weapons[idx];
      const dealt = stun ? Math.round(w.damage * 1.22 * 1.6) : Math.ceil(w.damage * 1.22 * 0.62);
      shoot(m);
      assert.equal(b.hp, b.maxHp - dealt * w.pellets);
      assert.deepEqual(m.events.filter(ev => ev.type === 'hit').map(ev => ev.data.dealt), Array(w.pellets).fill(dealt));
    }
  }
});

test('Sprint C: no-perk and missing-perks actions retain exact legacy values and event shapes', () => {
  for (const missing of [false, true]) {
    const m = arena();
    const p = m.players[0];
    if (missing) delete p.perks;
    p.hp = 80; p.ink = 100;
    const wall = applyDraw(m, 0, ...wallEnds).wall;
    assert.equal(wall.hp, 120); assert.equal(wall.life, 18);
    assert.equal(p.hp, 80); assert.equal(p.ink, 72);
    assert.deepEqual(drainEvents(m), [{ type: 'wallDraw', data: { id: wall.id, owner: 0 } }]);
    assert.deepEqual(applyErase(m, 0), { ok: true, stripped: 0, hit: [] });
    assert.equal(p.eraseCd, 3.5); assert.equal(p.ink, 37);
    assert.deepEqual(drainEvents(m), [{ type: 'erase', data: { owner: 0, x: 0, z: 0, stripped: 0, hit: [] } }]);
    const e = createEnemy(m, 'crane', 0, 2);
    const result = shoot(m);
    assert.deepEqual(result, { ok: true, kind: 'enemy', end: result.end });
    assert.equal(e.armor, 21);
    assert.deepEqual(drainEvents(m), [
      { type: 'hit', data: { id: e.id, point: result.end, armored: true } },
      { type: 'shot', data: { id: 0, end: result.end, kind: 'enemy' } },
    ]);
    p.ink = 0;
    step(p, 0.05, 10);
    assert.equal(p.ink, 10 * 0.05);
    assert.equal(startReload(p), true);
    assert.equal(p.reload, 1.25);
  }
});

test('Sprint C: deterministic runtime double run covers offers, picks, movement, walls, erase and shots', () => {
  function run() {
    const rt = createRuntime({ seed: 20261111 });
    const m = rt.match;
    m.statics = []; m.folds = []; m.foldWalls = [];
    const p = m.players[0]; p.pos = { x: 0, y: 1.65, z: 0 };
    const choices = [];
    for (let anchor = 0; anchor < 3; anchor++) {
      const offer = rollPerkChoices(m.seed, anchor, p.perks);
      choices.push(offer);
      rt.action(0, { m: 'perk', perkId: offer[0] });
    }
    for (const id of IDS.filter(id => !p.perks.includes(id))) rt.action(0, { m: 'perk', perkId: id });
    p.hp = 80;
    rt.action(0, { m: 'drawEnd', ax: 3, az: 0, bx: 3, bz: 2 });
    const b = createBoss(m); b.x = 0; b.z = 5; b.state = 'fan';
    rt.action(0, { m: 'erase' });
    rt.action(0, { m: 'weapon', weapon: 1 });
    const snaps = [];
    const events = [...drainEvents(m)];
    for (let i = 0; i < 80; i++) {
      rt.setInput(0, { f: i < 20 ? 1 : 0, r: 0.2, sprint: true, seq: i });
      if (i % 16 === 4) rt.action(0, { m: 'shot', ox: p.pos.x, oy: p.pos.y, oz: p.pos.z, dx: b.x - p.pos.x, dy: 1 - p.pos.y, dz: b.z - p.pos.z });
      if (i === 40) rt.action(0, { m: 'reload' });
      snaps.push(rt.tickOnce());
      events.push(...drainEvents(m));
    }
    assert.ok(events.some(ev => ev.type === 'perkPick'));
    assert.ok(events.some(ev => ev.type === 'hit'));
    assert.ok(events.some(ev => ev.type === 'bossInterrupt'));
    return JSON.stringify({ choices, snaps, events, nextRand: m.rand() });
  }
  assert.equal(run(), run());
});
