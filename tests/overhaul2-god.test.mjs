// 无敌观测模式（I）：伤害/击退免疫与运行时开关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, createPlayer, stepMatch, snapshot, drainEvents } from '../shared/sim.mjs';
import { createBoss, stepBoss, stepHazards } from '../shared/boss.mjs';
import { damagePlayer } from '../shared/combat.mjs';
import { createRuntime } from '../host/runtime.mjs';

const B = CONFIG.boss;
const DT = CONFIG.net.dt;
const eye = CONFIG.player.eyeHeight;

function arena(seed = 61) {
  const m = createMatch({ seed, playerIds: [0] });
  m.statics = [];
  m.folds = [];
  m.foldWalls = [];
  const p = m.players[0];
  p.god = true;
  return { m, p };
}

test('overhaul2 god: damagePlayer is a total no-op while god is on', () => {
  const { m, p } = arena();
  drainEvents(m);
  damagePlayer(m, p, 999);
  assert.equal(p.hp, 100);
  assert.equal(p.st, 0);
  assert.deepEqual(m.events, []);
  p.god = false;
  damagePlayer(m, p, 12);
  assert.equal(p.hp, 88);
});

test('overhaul2 god: boss charge passes through without damage or segment end', () => {
  const { m, p } = arena();
  const b = createBoss(m);
  b.x = 0; b.z = 5.5; b.slamCd = 99;
  p.pos.x = -3; p.pos.z = 5.5;
  b.state = 'charging'; b.dirX = -1; b.dirZ = 0; b.chargeT = 0; b.hitDone = false;
  for (let i = 0; i < 20; i++) stepBoss(m, DT);
  assert.equal(p.hp, 100);
  assert.equal(b.hitDone, false);
  assert.equal(m.events.filter(ev => ev.type === 'playerHit').length, 0);
});

test('overhaul2 god: waves mark the hit ring but deal no damage and no push', () => {
  const { m, p } = arena();
  p.pos.x = 3; p.pos.z = 0;
  const wave = { id: m.nextId++, kind: 'wave', x: 0, z: 0, r: 2.5, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] };
  m.hazards.push(wave);
  stepHazards(m, DT);
  assert.equal(p.hp, 100);
  assert.equal(p.velX, 0);
  assert.ok(wave.hit.includes(0));
});

test('overhaul2 god: slam, mortar and puddle deal no damage or knockback', () => {
  const { m, p } = arena();
  const b = createBoss(m);
  b.x = 0; b.z = 5.5; b.slamCd = 0;
  p.pos.x = 0; p.pos.z = b.z + 2.5;
  b.attackCd = 10;
  stepBoss(m, DT);
  assert.equal(b.state, 'slam');
  for (let i = 0; i < 10; i++) stepBoss(m, DT);
  assert.equal(p.hp, 100);
  assert.equal(p.velY, 0);
  assert.equal(p.velZ, 0);
  m.hazards.push({ id: m.nextId++, kind: 'mortar', x: p.pos.x, z: p.pos.z, r: B.mortarRadius, fuse: B.mortarFuse, t: 0.01, damage: B.mortarDamage });
  m.hazards.push({ id: m.nextId++, kind: 'puddle', x: p.pos.x, z: p.pos.z, r: B.puddleRadius, t: 2, tick: 0.01 });
  for (let i = 0; i < 40; i++) stepMatch(m, { 0: { f: 0, r: 0, seq: i } });
  assert.equal(p.hp, 100);
  assert.equal(p.st, 0);
});

test('overhaul2 god: runtime action toggles god, keeps protocol snapshot clean and defaults off', () => {
  const rt = createRuntime({ seed: 7 });
  const p = rt.match.players[0];
  assert.equal(p.god, false);
  assert.deepEqual(rt.action(0, { m: 'god', on: true }), { ok: true, god: true });
  assert.equal(p.god, true);
  assert.equal('god' in snapshot(rt.match).players[0], false, 'god is a local presentation switch, not protocol state');
  assert.deepEqual(rt.action(0, { m: 'god', on: false }), { ok: true, god: false });
  assert.equal(createPlayer(3, { x: 0, z: 0 }).god, false);
  rt.tickOnce();
  assert.equal(p.god, false);
});
