import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, createPlayer, weaponOf, switchWeapon, applyFire, startReload, stepPlayer, stepMatch, snapshot, drainEvents } from '../shared/sim.mjs';
import { applyShot, fireProjectile, stepProjectiles } from '../shared/combat.mjs';
import { createBoss, damageBoss, stepBoss } from '../shared/boss.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { applyErase } from '../shared/erase.mjs';
import { createRuntime } from '../host/runtime.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const B = CONFIG.boss;
const W = CONFIG.player.weapons;
const forward = { x: 0, y: 0, z: 1 };

function arena(seed = 71) {
  const m = createMatch({ seed });
  m.statics = [];
  m.folds = [];
  m.foldWalls = [];
  m.players[0].pos = { x: 0, y: 1, z: 0 };
  return m;
}

function equip(m, idx) {
  const p = m.players[0];
  if (idx !== p.weapon) assert.equal(switchWeapon(p, idx), true);
  p.fireCd = 0;
  return p;
}

function shoot(m, dir = forward, origin = m.players[0].pos) {
  return applyShot(m, m.players[0].id, origin, dir);
}

function playerStep(m, dt) {
  stepPlayer(m.players[0], {}, dt, { elapsed: m.elapsed, staticColliders: m.statics, walls: m.walls, foldWalls: m.foldWalls, folds: m.folds });
}

function bossArena() {
  const m = arena();
  const b = createBoss(m);
  b.x = 0; b.z = 5;
  drainEvents(m);
  return { m, b, p: m.players[0] };
}

function wall(m, x = 0, z = 2, len = 6, rot = 0) {
  const ux = Math.cos(rot), uz = -Math.sin(rot);
  const w = { id: m.nextId++, x, z, len, ux, uz, nx: -uz, nz: ux, halfThickness: CONFIG.wall.halfThickness, hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, owner: 0, dead: false };
  m.walls.push(w);
  return w;
}

test('Sprint B: exact weapon tables; legacy gun retains all and only original keys', () => {
  const gun = { damage: 24, armorDamage: 3, fireInterval: 0.14, magazine: 18, reloadTime: 1.25, range: 48 };
  assert.deepEqual(CONFIG.player.gun, gun);
  assert.deepEqual(W, [
    { id: 'pen', name: '中性笔', tag: '自动', ...gun, pellets: 1, spread: 0, auto: true, scopeFov: null },
    { id: 'marker', name: '荧光笔', tag: '霰弹', damage: 13, armorDamage: 4, fireInterval: 0.68, magazine: 6, reloadTime: 1.45, range: 16, pellets: 5, spread: 0.085, auto: false, scopeFov: null },
    { id: 'liner', name: '针管笔', tag: '狙击', damage: 64, armorDamage: 12, fireInterval: 0.85, magazine: 5, reloadTime: 1.55, range: 60, pellets: 1, spread: 0, auto: false, scopeFov: 28 },
  ]);
});

test('Sprint B: Boss additions upgraded to the OVERHAUL-2 three-phase baseline', () => {
  const additions = { wallStunTime: 2.2, eraseStunTime: 2, eraseSlowTime: 1.5, laughExposeTime: 2, weakpointMul: 1.6, headshotY: 1.75, headshotMul: 1.35, bellyMinY: 0.65, bellyMaxY: 1.75 };
  for (const [key, value] of Object.entries(additions)) assert.equal(B[key], value);
  assert.deepEqual([B.hp, B.shieldMul, B.speed, B.radius, B.attackInterval],
    [1100, 0.4, 2.4, 1, 1.35]);
  assert.deepEqual(B.phases.map(p => [p.shieldMul, p.speed, p.attackInterval, p.fanSpeed, p.chargeSegments, p.fanRows, p.waves, p.mortars]), [
    [0.4, 2.4, 1.35, 11, 1, 1, 2, 4],
    [0.72, 3.1, 0.95, 13, 2, 2, 3, 6],
    [1, 3.6, 0.72, 14.5, 3, 2, 3, 8],
  ]);
  assert.deepEqual(B.rage, { at: 0.65, attackInterval: 0.95, speed: 3.1, fanSpeed: 13, fanBonus: 0 });
});

test('Sprint B: player defaults, independent bags, and weaponOf fallback', () => {
  const p = createPlayer(0, { x: 0, z: 0 });
  const q = createPlayer(1, { x: 0, z: 0 });
  assert.equal(p.weapon, 0);
  assert.deepEqual(p.ammoBag, [18, 6, 5]);
  assert.notEqual(p.ammoBag, q.ammoBag);
  assert.equal(weaponOf(p), W[0]);
  for (const weapon of [1, 2]) assert.equal(weaponOf({ weapon }), W[weapon]);
  for (const weapon of [undefined, -1, 99]) assert.equal(weaponOf({ weapon }), W[0]);
});

test('Sprint B: switch rejects same, noninteger, coerced and out-of-bounds indices without mutation', () => {
  const p = arena().players[0];
  p.ammo = 7; p.reload = 0.7; p.fireCd = 0.2;
  const before = structuredClone(p);
  for (const idx of [0, -1, 3, 1.5, NaN, Infinity, -Infinity, '1', null, undefined, true, false, [], {}, 1n, Symbol('weapon')]) {
    assert.equal(switchWeapon(p, idx), false);
    assert.deepEqual(p, before);
  }
  for (const st of [1, 2]) {
    p.st = st;
    const down = structuredClone(p);
    assert.equal(switchWeapon(p, 1), false);
    assert.deepEqual(p, down);
  }
});

test('Sprint B: authoritative ammo survives switching; reload is canceled and cooldown never shortened', () => {
  const m = arena();
  const p = m.players[0];
  p.ammo = 7; p.ammoBag[0] = 18;
  assert.equal(startReload(p), true);
  p.fireCd = 0.6;
  assert.equal(switchWeapon(p, 1), true);
  assert.deepEqual(p.ammoBag, [7, 6, 5]);
  assert.equal(p.ammo, 6);
  assert.equal(p.reload, 0);
  assert.equal(p.fireCd, 0.6);
  p.ammo = 2; p.fireCd = 0;
  assert.equal(switchWeapon(p, 2), true);
  assert.equal(p.ammo, 5);
  assert.equal(p.fireCd, 0.15);
  p.ammo = 1;
  switchWeapon(p, 0);
  assert.equal(p.ammo, 7);
  assert.deepEqual(p.ammoBag, [7, 2, 1]);
  switchWeapon(p, 1);
  assert.equal(p.ammo, 2);
  assert.equal(applyFire(p), 'cooldown');
  playerStep(m, 0.15);
  assert.equal(applyFire(p), 'fired');
  assert.equal(p.ammo, 1);
  assert.equal(startReload(p), true);
  switchWeapon(p, 2);
  playerStep(m, 2);
  assert.equal(p.ammo, 1, 'canceled marker reload must not fill liner');
  switchWeapon(p, 1);
  assert.equal(p.ammo, 1, 'canceled magazine remains partially empty');
});

for (const idx of [0, 1, 2]) {
  test(`Sprint B: weapon ${idx} fire cadence, ammo authority and reload completion`, () => {
    const m = arena();
    const p = equip(m, idx);
    const w = W[idx];
    assert.equal(startReload(p), false);
    p.ammo = 1;
    assert.equal(applyFire(p), 'fired');
    assert.equal(p.ammo, 0);
    assert.equal(p.fireCd, w.fireInterval);
    assert.equal(p.reload, w.reloadTime);
    assert.equal(applyFire(p), 'cooldown');
    assert.equal(startReload(p), false);
    playerStep(m, w.reloadTime - 0.01);
    assert.equal(p.ammo, 0);
    playerStep(m, 0.02);
    assert.equal(p.reload, 0);
    assert.equal(p.ammo, w.magazine);
    p.ammoBag[idx] = 0;
    assert.equal(applyFire(p), 'fired', 'bag cannot override live ammo');
    assert.equal(p.ammo, w.magazine - 1);
    p.fireCd = 0; p.ammo = 0;
    assert.equal(applyFire(p), 'autoReload');
    assert.equal(p.reload, w.reloadTime);
    p.st = 1;
    assert.equal(applyFire(p), 'dead');
    assert.equal(startReload(p), false);
  });
}

test('Sprint B: runtime weapon action validates and snapshots wp', () => {
  const rt = createRuntime();
  assert.deepEqual(rt.action(0, { m: 'weapon', weapon: '1' }), { ok: false, weapon: 0 });
  assert.deepEqual(rt.action(0, { m: 'weapon', weapon: 1.2 }), { ok: false, weapon: 0 });
  assert.deepEqual(rt.action(0, { m: 'weapon', weapon: 2 }), { ok: true, weapon: 2 });
  assert.equal(rt.snapshot().players[0].wp, 2);
  assert.equal(rt.snapshot().players[0].ammo, 5);
  assert.deepEqual(rt.action(0, { m: 'weapon', weapon: 2 }), { ok: false, weapon: 2 });
  rt.match.players[0].st = 1;
  assert.deepEqual(rt.action(0, { m: 'weapon', weapon: 1 }), { ok: false, weapon: 2 });
  assert.deepEqual(rt.action(99, { m: 'weapon', weapon: 1 }), { ok: false, reason: 'noPlayer' });
});

test('Sprint B: pen miss and rejected shot preserve exact legacy shapes and consume no randomness', () => {
  const m = arena();
  m.rand = () => assert.fail('single ray must not consume RNG');
  const end = { x: 0, y: 1, z: 48 };
  assert.deepEqual(shoot(m), { ok: true, kind: 'none', end });
  assert.deepEqual(drainEvents(m), [{ type: 'shot', data: { id: 0, end, kind: 'none' } }]);
  assert.deepEqual(shoot(m), { ok: false, reason: 'cooldown' });
  m.players[0].fireCd = 0; m.players[0].ammo = 0;
  assert.deepEqual(shoot(m), { ok: false, reason: 'autoReload' });
  m.players[0].st = 1;
  assert.deepEqual(shoot(m), { ok: false, reason: 'dead' });
  assert.deepEqual(applyShot(m, 99, m.players[0].pos, forward), { ok: false, reason: 'dead' });
  assert.deepEqual(m.events, []);
});

test('Sprint B: pen armor, strip, flesh and kill event sequences remain legacy-shaped', () => {
  const m = arena();
  const e = createEnemy(m, 'crane', 0, 2);
  e.armor = 3;
  let result = shoot(m);
  const point = result.end;
  assert.deepEqual(result, { ok: true, kind: 'enemy', end: point });
  assert.deepEqual(drainEvents(m), [
    { type: 'armorStrip', data: { id: e.id } },
    { type: 'hit', data: { id: e.id, point, armored: false } },
    { type: 'shot', data: { id: 0, end: point, kind: 'enemy' } },
  ]);
  assert.equal(e.hp, 48);
  e.hp = 24; m.players[0].fireCd = 0;
  result = shoot(m);
  assert.deepEqual(drainEvents(m), [
    { type: 'hit', data: { id: e.id, point: result.end, armored: false } },
    { type: 'kill', data: { id: e.id, enemyType: 'crane' } },
    { type: 'shot', data: { id: 0, end: result.end, kind: 'enemy' } },
  ]);
  assert.equal(m.kills, 1);
  assert.equal(m.players[0].stats.kills, 1);
});

for (const kind of ['static', 'wall', 'fold']) {
  test(`Sprint B: ${kind} independently blocks five pellets; only multi impacts add shooterId`, () => {
    for (const idx of [0, 1]) {
      const m = arena();
      let wallId = null;
      if (kind === 'static') m.statics.push({ x: 0, z: 2, hx: 4, hz: 0.1, y0: 0, y1: 3 });
      else {
        const w = wall(m);
        if (kind === 'fold') { m.walls = []; m.foldWalls = [w]; }
        else wallId = w.id;
      }
      const e = createEnemy(m, 'crane', 0, 4);
      const b = createBoss(m); b.x = 0; b.z = 6;
      equip(m, idx); drainEvents(m);
      const r = shoot(m);
      assert.equal(r.kind, kind);
      assert.equal(e.armor, 24);
      assert.equal(b.hp, b.maxHp);
      const events = drainEvents(m);
      const impacts = events.filter(ev => ev.type === 'impact');
      assert.equal(impacts.length, idx === 1 ? 5 : 1);
      for (const ev of impacts) {
        const expected = { point: ev.data.point, kind, wallId };
        if (idx === 1) expected.shooterId = 0;
        assert.deepEqual(ev.data, expected);
      }
      assert.equal(events.filter(ev => ev.type === 'shot').length, 1);
      assert.equal(events.at(-1).type, 'shot');
      if (idx === 0) assert.deepEqual(events.at(-1).data, { id: 0, end: r.end, kind });
      else assert.deepEqual(events.at(-1).data, { id: 0, end: r.end, ends: r.ends, weapon: 1, kind });
    }
  });
}

test('Sprint B: enemy projectile impacts remain untagged', () => {
  const m = arena();
  const w = wall(m);
  fireProjectile(m, { x: 0, y: 1, z: 3 }, { x: 0, y: 1, z: 0 }, 10, 8);
  stepProjectiles(m, 0.1);
  assert.deepEqual(m.events, [{ type: 'impact', data: { point: { x: 0, y: 1, z: 2 }, kind: 'wall', wallId: w.id } }]);
});

for (const dir of [forward, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0.0001, y: 1, z: 0.0002 }, { x: 3, y: 4, z: 5 }]) {
  test(`Sprint B: five deterministic cone rays stay finite and at range for ${JSON.stringify(dir)}`, () => {
    const run = seed => {
      const m = arena(seed);
      const p = equip(m, 1);
      const rand = m.rand;
      let calls = 0;
      m.rand = () => { calls++; return rand(); };
      const result = shoot(m, dir);
      assert.equal(calls, 8);
      assert.equal(p.ammo, 5);
      assert.equal(p.fireCd, 0.68);
      assert.equal(result.ends.length, 5);
      assert.equal(result.end, result.ends[0]);
      assert.equal(m.events.length, 1);
      assert.deepEqual(m.events[0].data, { id: 0, end: result.end, ends: result.ends, weapon: 1, kind: 'none' });
      const len = Math.hypot(dir.x, dir.y, dir.z);
      const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
      const origin = p.pos;
      near(result.end.x, origin.x + d.x * 16);
      near(result.end.y, origin.y + d.y * 16);
      near(result.end.z, origin.z + d.z * 16);
      for (const end of result.ends) {
        const v = { x: end.x - origin.x, y: end.y - origin.y, z: end.z - origin.z };
        assert.ok(Object.values(end).every(Number.isFinite));
        near(Math.hypot(v.x, v.y, v.z), 16);
        const along = v.x * d.x + v.y * d.y + v.z * d.z;
        assert.ok(along > 0);
        const side = Math.hypot(v.x - along * d.x, v.y - along * d.y, v.z - along * d.z);
        assert.ok(side / along <= W[1].spread + 1e-12);
      }
      assert.equal(new Set(result.ends.map(end => JSON.stringify(end))).size, 5);
      return { result, events: m.events };
    };
    assert.deepEqual(run(123), run(123));
    assert.notDeepEqual(run(123).result.ends.slice(1), run(124).result.ends.slice(1));
  });
}

test('Sprint B: disk sampling uses sqrt radius and orthogonal quarter-turn offsets', () => {
  const m = arena();
  equip(m, 1);
  const values = [0.25, 0, 0.25, 0.25, 0.25, 0.5, 0.25, 0.75];
  m.rand = () => values.shift();
  const r = shoot(m);
  const slope = 0.5 * W[1].spread;
  const scale = 16 / Math.hypot(1, slope);
  const offsets = [[slope, 0], [0, slope], [-slope, 0], [0, -slope]];
  r.ends.slice(1).forEach((end, i) => {
    near(end.x, offsets[i][0] * scale);
    near(end.y, 1 + offsets[i][1] * scale);
    near(end.z, scale);
  });
  assert.equal(values.length, 0);
});

test('Sprint B: marker nearest-hit tracing skips a center-killed enemy for later pellets', () => {
  const m = arena();
  const front = createEnemy(m, 'crane', 0, 2);
  const back = createEnemy(m, 'crane', 0, 3);
  front.armor = 0; front.hp = 13;
  back.armor = 0; back.hp = 100;
  equip(m, 1);
  const r = shoot(m);
  assert.equal(front.dead, true);
  assert.equal(back.hp, 48);
  const hits = m.events.filter(ev => ev.type === 'hit');
  assert.deepEqual(hits.map(ev => ev.data.id), [front.id, back.id, back.id, back.id, back.id]);
  assert.deepEqual(hits.map(ev => ev.data.dealt), [13, 13, 13, 13, 13]);
  assert.equal(m.events.filter(ev => ev.type === 'kill').length, 1);
  assert.equal(r.kind, 'enemy');
  assert.equal(m.kills, 1);
  assert.equal(m.players[0].stats.kills, 1);
});

test('Sprint B: marker can deal 65 flesh damage or strip 20 armor per shell', () => {
  for (const armored of [false, true]) {
    const m = arena();
    const e = createEnemy(m, 'crane', 0, 2);
    e.hp = 100; e.armor = armored ? 24 : 0;
    equip(m, 1);
    shoot(m);
    assert.equal(e.hp, armored ? 100 : 35);
    assert.equal(e.armor, armored ? 4 : 0);
    assert.deepEqual(m.events.filter(ev => ev.type === 'hit').map(ev => ev.data.dealt), Array(5).fill(armored ? 4 : 13));
  }
});

test('Sprint B: mixed marker result favors damage while end stays on the center obstacle', () => {
  const m = arena();
  wall(m, 0, 2, 0.1);
  const e = createEnemy(m, 'crane', 0, 3);
  e.armor = 0; e.hp = 100;
  equip(m, 1);
  let call = 0;
  m.rand = () => call++ % 2 === 0 ? 0.99 : 0;
  const r = shoot(m);
  assert.equal(r.kind, 'enemy');
  assert.equal(e.hp, 48);
  assert.equal(r.end, r.ends[0]);
  near(r.end.z, 2 - CONFIG.wall.halfThickness);
  assert.equal(m.events[0].type, 'impact');
  assert.equal(m.events[0].data.shooterId, 0);
  assert.equal(m.events.filter(ev => ev.type === 'hit').length, 4);
  assert.equal(m.events.at(-1).data.kind, 'enemy');
});

test('Sprint B: armor break consumes one whole pellet before subsequent flesh damage', () => {
  const m = arena();
  const e = createEnemy(m, 'crane', 0, 2);
  e.armor = 2; e.hp = 100;
  equip(m, 1);
  shoot(m);
  assert.equal(e.armor, 0);
  assert.equal(e.hp, 48);
  assert.equal(m.events.filter(ev => ev.type === 'armorStrip').length, 1);
  assert.deepEqual(m.events.filter(ev => ev.type === 'hit').map(ev => ev.data.dealt), [2, 13, 13, 13, 13]);
  const ammo = m.players[0].ammo;
  const events = m.events.length;
  m.rand = () => assert.fail('rejected marker shell must not sample spread');
  assert.deepEqual(shoot(m), { ok: false, reason: 'cooldown' });
  assert.equal(m.players[0].ammo, ammo);
  assert.equal(m.events.length, events);
});

test('Sprint B: liner can hit beyond the pen range and cannot hit past 60m', () => {
  for (const distance of [55, 61]) {
    const m = arena();
    const e = createEnemy(m, 'crane', 0, 10);
    e.z = distance; e.armor = 0; e.hp = 100;
    equip(m, 2);
    const r = shoot(m);
    assert.equal(r.kind, distance < 60 ? 'enemy' : 'none');
    assert.equal(e.hp, distance < 60 ? 36 : 100);
    assert.ok(r.end.z <= 60);
  }
});

test('Sprint B: marker range stops at 16; liner range is 60 and deals 64 HP or 12 armor', () => {
  const marker = arena();
  marker.statics.push({ x: 0, z: 17, hx: 5, hz: 0.1, y0: 0, y1: 4 });
  equip(marker, 1);
  assert.equal(shoot(marker).kind, 'none');
  for (const armored of [false, true]) {
    const m = arena();
    const e = createEnemy(m, 'crane', 0, 10);
    e.armor = armored ? 24 : 0;
    e.hp = 100;
    equip(m, 2);
    m.rand = () => assert.fail('liner must not consume RNG');
    const r = shoot(m);
    assert.deepEqual(Object.keys(r).sort(), ['end', 'kind', 'ok']);
    assert.equal(r.kind, 'enemy');
    assert.equal(e.hp, armored ? 100 : 36);
    assert.equal(e.armor, armored ? 12 : 0);
    assert.equal(m.events[0].data.dealt, armored ? 12 : 64);
    assert.deepEqual(m.events.at(-1).data, { id: 0, end: r.end, kind: 'enemy' });
  }
  const m = arena();
  equip(m, 2);
  assert.deepEqual(shoot(m), { ok: true, kind: 'none', end: { x: 0, y: 1, z: 60 } });
});

test('Sprint B: Boss timers start at zero and snapshot adds only rounded short fields', () => {
  const { m, b } = bossArena();
  assert.deepEqual([b.stunT, b.laughExposeT, b.slowT], [0, 0, 0]);
  b.stunT = 1.234; b.laughExposeT = 1.876; b.slowT = 0.456;
  const s = snapshot(m);
  assert.deepEqual([s.boss.st, s.boss.ex, s.boss.sl], [1.23, 1.88, 0.46]);
  assert.equal(s.players[0].wp, 0);
  b.dead = true;
  assert.equal(snapshot(m).boss, null);
});

test('Sprint B: damageBoss phase-1/phase-2 fractions, opts rounding, shield bypass and hate use exact dealt', () => {
  const cases = [
    { n: 24, dealt: 10 },
    { n: 1.25, dealt: 1 },
    { n: 1.25, raged: true, dealt: 1 },
    { n: 1.25, raged: true, opts: {}, dealt: 1 },
    { n: 24, opts: { mul: 1.35, bypassShield: false }, dealt: 13 },
    { n: 24, raged: true, opts: { mul: 1.35 }, dealt: 24 },
    { n: 24, opts: { mul: 1.6, bypassShield: true }, dealt: 38 },
    { n: 24, opts: { mul: 1.6 }, dealt: 16 },
    { n: 24, stun: 1, dealt: 24 },
    { n: 24, stun: 1, opts: { mul: 1.6, bypassShield: false }, dealt: 38 },
    { n: 1.6, stun: 1, dealt: 2 },
    { n: 24, opts: { mul: 0, bypassShield: true }, dealt: 24 },
    { n: 24, opts: { bypassShield: true }, dealt: 24 },
  ];
  for (const c of cases) {
    const { m, b, p } = bossArena();
    if (c.raged) { b.phase = 2; b.raged = true; }
    b.stunT = c.stun || 0;
    assert.equal(damageBoss(m, c.n, p.id, c.opts ?? null), c.dealt, JSON.stringify(c));
    assert.equal(b.hp, b.maxHp - c.dealt);
    assert.deepEqual(p.hate, [{ t: 0, n: c.dealt }]);
  }
  const { m, b } = bossArena();
  b.dead = true;
  assert.equal(damageBoss(m, 24), 0);
  m.boss = null;
  assert.equal(damageBoss(m, 24), 0);
});

for (const c of [
  { label: 'normal torso', y: 1, dealt: 10, critKind: null },
  { label: 'below head boundary', y: 1.74999, dealt: 10, critKind: null },
  { label: 'head inclusive boundary', y: 1.75, dealt: 13, critKind: 'head' },
  { label: 'head above boundary', y: 2.1, dealt: 13, critKind: 'head' },
  { label: 'exposed belly lower boundary', y: 0.65, ex: 1, dealt: 38, critKind: 'belly' },
  { label: 'exposed belly upper boundary before head', y: 1.75, ex: 1, dealt: 38, critKind: 'belly' },
  { label: 'below belly boundary', y: 0.64999, ex: 1, dealt: 10, critKind: null },
  { label: 'above belly boundary', y: 1.75001, ex: 1, dealt: 13, critKind: 'head' },
  { label: 'stun overrides belly', y: 1, ex: 1, stun: 1, dealt: 38, critKind: 'stun' },
  { label: 'stun overrides head', y: 2, stun: 1, dealt: 38, critKind: 'stun' },
  { label: 'stun overrides normal', y: 0.2, stun: 1, dealt: 38, critKind: 'stun' },
  { label: 'expired timers', y: 1, ex: 0, stun: 0, dealt: 10, critKind: null },
  { label: 'raged head rounding', y: 2, raged: true, dealt: 24, critKind: 'head' },
  { label: 'liner torso', y: 1, weapon: 2, dealt: 26, critKind: null },
  { label: 'liner head', y: 2, weapon: 2, dealt: 35, critKind: 'head' },
  { label: 'liner belly', y: 1, weapon: 2, ex: 1, dealt: 102, critKind: 'belly' },
]) {
  test(`Sprint B: Boss ${c.label}`, () => {
    const { m, b, p } = bossArena();
    b.stunT = c.stun || 0; b.laughExposeT = c.ex || 0;
    if (c.raged) { b.phase = 2; b.raged = true; }
    p.pos.y = c.y;
    equip(m, c.weapon || 0);
    const r = shoot(m);
    assert.deepEqual(r, { ok: true, kind: 'boss', end: r.end });
    assert.equal(b.hp, b.maxHp - c.dealt);
    assert.deepEqual(m.events, [
      { type: 'hit', data: { id: b.id, point: r.end, boss: true, dealt: c.dealt, crit: c.critKind !== null, critKind: c.critKind } },
      { type: 'shot', data: { id: 0, end: r.end, kind: 'boss' } },
    ]);
  });
}

test('Sprint B: all five marker pellets independently resolve Boss shield and stunned weakness', () => {
  for (const stun of [0, 2]) {
    const { m, b } = bossArena();
    b.z = 2; b.stunT = stun;
    equip(m, 1);
    const result = shoot(m);
    const hits = m.events.filter(ev => ev.type === 'hit');
    assert.equal(hits.length, 5);
    const dealt = stun ? 21 : 6;
    assert.equal(b.hp, b.maxHp - dealt * 5);
    for (const ev of hits) {
      assert.equal(ev.data.dealt, dealt);
      assert.equal(ev.data.critKind, stun ? 'stun' : null);
      assert.equal(ev.data.crit, !!stun);
    }
    assert.equal(result.kind, 'boss');
    assert.equal(m.events.at(-1).data.ends.length, 5);
  }
});

test('Sprint B: wall collision naturally returns idle and sets exactly 2.2s stun once', () => {
  const { m, b, p } = bossArena();
  b.x = 0; b.z = 0; p.pos.x = 14; p.pos.z = 0;
  const w = wall(m, 2, 0, 6, Math.PI / 2);
  b.state = 'charging'; b.dirX = 1; b.dirZ = 0;
  stepBoss(m, 0.05);
  assert.equal(b.state, 'idle');
  assert.equal(b.stunT, 2.2);
  assert.equal(b.chargeT, B.chargeTime);
  assert.equal(b.hitDone, true);
  assert.equal(b.attackCd, B.attackInterval);
  assert.equal(w.hp, 75);
  assert.deepEqual(m.events, [{ type: 'bossStun', data: { reason: 'wall', duration: 2.2, wallId: w.id } }]);
  const x = b.x;
  stepBoss(m, 0.05);
  assert.equal(b.x, x);
  assert.equal(w.hp, 75);
  assert.equal(m.events.length, 1);
});

for (const state of ['idle', 'fan', 'summon', 'charge', 'charging']) {
  test(`Sprint B: stun pauses ${state} progression while all orthogonal timers decay`, () => {
    const { m, b } = bossArena();
    b.state = state; b.stunT = 0.2; b.laughExposeT = 0.3; b.slowT = 0.4;
    b.telegraph = 0.3; b.chargeT = 0.4; b.attackCd = 0.8;
    const before = { ...b };
    stepBoss(m, 0.1);
    near(b.stunT, 0.1); near(b.laughExposeT, 0.2); near(b.slowT, 0.3);
    for (const key of ['state', 'x', 'z', 'telegraph', 'chargeT', 'attackCd', 'nextAttack', 'faceYaw']) assert.equal(b[key], before[key]);
    assert.equal(m.events.length, 0);
    assert.equal(m.projectiles.length, 0);
    assert.equal(m.enemies.length, 0);
    stepBoss(m, 0.4);
    assert.deepEqual([b.stunT, b.laughExposeT, b.slowT], [0, 0, 0]);
    assert.equal(b.telegraph, before.telegraph, 'expiry step is still paused');
    stepBoss(m, 0.05);
    assert.ok(b.attackCd !== before.attackCd || b.telegraph !== before.telegraph);
  });
}

test('Sprint B: Boss timers decay with no alive player; idle slow halves both normal and rage speed', () => {
  const { m, b, p } = bossArena();
  p.st = 1;
  b.stunT = 0.2; b.laughExposeT = 0.2; b.slowT = 0.2;
  stepBoss(m, 0.3);
  assert.deepEqual([b.stunT, b.laughExposeT, b.slowT], [0, 0, 0]);
  b.laughExposeT = 0.2; b.slowT = 0.2;
  stepBoss(m, 0.3);
  assert.deepEqual([b.laughExposeT, b.slowT], [0, 0]);
  for (const raged of [false, true]) {
    for (const slow of [0, 1]) {
      const s = bossArena();
      s.b.phase = raged ? 2 : 1; s.b.raged = raged; s.b.slowT = slow;
      const z = s.b.z;
      stepBoss(s.m, 0.1);
      near(z - s.b.z, (raged ? B.phases[1].speed : B.speed) * 0.1 * (slow ? 0.5 : 1));
    }
  }
});

test('Sprint B: both phase-2 entry paths keep rage and summon completion exposes belly for 2.2s', () => {
  for (const viaDamage of [true, false]) {
    const { m, b } = bossArena();
    b.hp = viaDamage ? b.maxHp * B.phase2At + 1 : b.maxHp * B.phase2At;
    if (viaDamage) damageBoss(m, 2);
    else stepBoss(m, 0.05);
    assert.equal(b.raged, true);
    assert.equal(b.phase, 2);
    assert.equal(b.laughExposeT, 2);
    assert.equal(m.events.filter(ev => ev.type === 'rage').length, 1);
    stepBoss(m, 0.1);
    near(b.laughExposeT, 1.9);
    damageBoss(m, 1);
    near(b.laughExposeT, 1.9, 1e-8);
    assert.equal(m.events.filter(ev => ev.type === 'rage').length, 1);
  }
  for (const full of [false, true]) {
    const { m, b } = bossArena();
    if (full) for (let i = 0; i < CONFIG.scaling[1].cap; i++) createEnemy(m, 'crane', 10, 10);
    b.state = 'summon'; b.telegraph = 0.75;
    stepBoss(m, 0.05);
    assert.equal(b.state, 'idle');
    assert.equal(b.laughExposeT, 2.2);
    assert.equal(b.waveLeft, B.waveBursts);
    const ev = m.events.find(e => e.type === 'bossAttack');
    assert.deepEqual(ev.data, { attack: 'summon', count: full ? 0 : 3 });
  }
});

for (const state of ['fan', 'summon', 'charge', 'idle', 'charging']) {
  test(`Sprint B: erase ${state} at inclusive planar 6m and laugh override`, () => {
    for (const laughing of [false, true]) {
      const { m, b, p } = bossArena();
      b.state = state; b.x = 3.6; b.z = 4.8; b.y = 100;
      p.pos.y = 20;
      b.telegraph = 0.4; b.attackCd = 0.7;
      b.laughExposeT = laughing ? 2 : 0;
      const result = applyErase(m, 0);
      const interrupt = laughing || ['fan', 'summon', 'charge'].includes(state);
      assert.equal(result.ok, true);
      assert.equal(b.hp, b.maxHp);
      assert.equal(p.ink, 65);
      assert.equal(p.eraseCd, 3.5);
      assert.equal(p.stats.erases, 1);
      assert.deepEqual(result, interrupt ? { ok: true, stripped: 0, hit: [], bossInterrupted: true } : { ok: true, stripped: 0, hit: [], bossSlowed: true });
      if (interrupt) {
        assert.deepEqual([b.state, b.telegraph, b.attackCd, b.laughExposeT, b.stunT], ['idle', 0, 2, 0, 2]);
        assert.deepEqual(m.events[0], { type: 'bossInterrupt', data: { by: 0, reason: 'erase', duration: 2 } });
      } else {
        assert.equal(b.state, state);
        assert.equal(b.telegraph, 0.4);
        assert.equal(b.attackCd, 0.7);
        assert.equal(b.slowT, 1.5);
        assert.equal(b.stunT, 0);
        assert.equal(m.events.length, 1);
      }
      assert.equal(m.events.at(-1).type, 'erase');
    }
  });
}

test('Sprint B: erase outside 6m, dead Boss or absent Boss preserves original return and event', () => {
  for (const mode of ['far', 'dead', 'absent']) {
    const { m, b } = bossArena();
    b.state = 'fan';
    if (mode === 'far') b.z = 6.00001;
    if (mode === 'dead') b.dead = true;
    if (mode === 'absent') m.boss = null;
    assert.deepEqual(applyErase(m, 0), { ok: true, stripped: 0, hit: [] });
    assert.deepEqual(m.events, [{ type: 'erase', data: { owner: 0, x: 0, z: 0, stripped: 0, hit: [] } }]);
    assert.deepEqual([b.stunT, b.slowT, b.laughExposeT], [0, 0, 0]);
  }
});

test('Sprint B: erase retains enemy effects, rejects cooldown/ink/dead without Boss mutation', () => {
  const { m, b, p } = bossArena();
  const e = createEnemy(m, 'crane', 0, 2);
  b.state = 'fan';
  const result = applyErase(m, 0);
  assert.deepEqual(result, { ok: true, stripped: 1, hit: [e.id], bossInterrupted: true });
  assert.equal(e.armor, 0); assert.equal(e.stun, 1); assert.equal(e.slow, 3.5);
  const before = structuredClone(b);
  drainEvents(m);
  assert.deepEqual(applyErase(m, 0), { ok: false, reason: 'cooldown', cd: 3.5 });
  assert.equal(p.ink, 65);
  p.eraseCd = 0; p.ink = 34;
  assert.deepEqual(applyErase(m, 0), { ok: false, reason: 'ink', need: 35 });
  for (const st of [1, 2]) {
    p.st = st;
    assert.deepEqual(applyErase(m, 0), { ok: false, reason: 'dead' });
  }
  assert.deepEqual(applyErase(m, 99), { ok: false, reason: 'dead' });
  assert.deepEqual(b, before);
  assert.deepEqual(m.events, []);
  p.st = 0; p.ink = 100; p.eraseCd = 3.5;
  for (let i = 0; i < 70; i++) playerStep(m, 0.05);
  assert.equal(p.eraseCd, 0);
  assert.equal(applyErase(m, 0).ok, true);
});

test('Sprint B: deterministic double run includes weapons, reload, five rays, wall stun, erase, rage and summon', () => {
  function run() {
    const rt = createRuntime({ seed: 20261111 });
    const m = rt.match;
    m.statics = []; m.folds = []; m.foldWalls = [];
    m.players[0].pos = { x: 0, y: CONFIG.player.eyeHeight, z: -5 };
    const p = m.players[0];
    const b = createBoss(m); b.x = 0; b.z = 0;
    const snaps = [];
    const log = [];
    const tick = count => {
      for (let i = 0; i < count; i++) {
        rt.setInput(0, { f: 0, r: 0, seq: m.tick + 1 });
        snaps.push(rt.tickOnce());
        log.push(...drainEvents(m));
      }
    };
    const shot = () => rt.action(0, { m: 'shot', ox: p.pos.x, oy: p.pos.y, oz: p.pos.z, dx: b.x - p.pos.x, dy: 1 - p.pos.y, dz: b.z - p.pos.z });
    tick(1);
    assert.equal(shot().ok, true);
    assert.equal(rt.action(0, { m: 'weapon', weapon: 1 }).ok, true);
    tick(3);
    assert.equal(shot().ends.length, 5);
    assert.equal(rt.action(0, { m: 'reload' }).ok, true);
    tick(30);
    assert.equal(p.ammo, 6);
    assert.equal(rt.action(0, { m: 'weapon', weapon: 2 }).ok, true);
    tick(3);
    b.state = 'summon'; b.telegraph = 0.75;
    tick(1);
    assert.equal(b.laughExposeT, 2.2);
    assert.equal(shot().ok, true);
    assert.equal(rt.action(0, { m: 'erase' }).bossInterrupted, true);
    tick(42);
    b.hp = 240;
    tick(1);
    assert.equal(b.raged, true);
    const w = wall(m, b.x + 2, b.z, 6, Math.PI / 2);
    b.state = 'charging'; b.dirX = 1; b.dirZ = 0; b.chargeT = 0;
    tick(1);
    assert.equal(w.hp, 75);
    assert.equal(b.stunT, 2.2);
    assert.equal(shot().ok, true);
    tick(45);
    b.state = 'idle'; b.attackCd = 10; b.laughExposeT = 0;
    b.x = p.pos.x; b.z = p.pos.z + 4;
    assert.equal(rt.action(0, { m: 'erase' }).bossSlowed, true);
    tick(5);
    assert.ok(log.some(ev => ev.type === 'shot' && ev.data.ends?.length === 5));
    for (const type of ['bossStun', 'bossInterrupt', 'rage', 'bossAttack']) assert.ok(log.some(ev => ev.type === type), type);
    assert.ok(log.some(ev => ev.type === 'hit' && ev.data.critKind === 'belly'));
    assert.ok(snaps.some(s => s.boss?.st > 0));
    assert.ok(snaps.some(s => s.boss?.ex > 0));
    assert.ok(snaps.some(s => s.boss?.sl > 0));
    assert.deepEqual([...new Set(snaps.map(s => s.players[0].wp))].sort(), [0, 1, 2]);
    return JSON.stringify({ snaps, log, bag: p.ammoBag, end: snapshot(m), nextRandom: m.rand() });
  }
  assert.equal(run(), run());
});
