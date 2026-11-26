// OVERHAUL-4：音浪放宽、墨迹闪避 Dash、伤害来源透传、评级与红弧方位角。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import CONFIG from '../shared/config.mjs';
import { createMatch, createPlayer, stepPlayer, stepMatch, snapshot, drainEvents } from '../shared/sim.mjs';
import { damagePlayer, fireProjectile, stepProjectiles } from '../shared/combat.mjs';
import { createBoss, stepBoss, stepHazards } from '../shared/boss.mjs';
import { computeRank, damageAngle } from '../client/hud.mjs';

const DT = CONFIG.net.dt;
const B = CONFIG.boss;
const P = CONFIG.player;
const eye = P.eyeHeight;

function ctx(events, walls = []) {
  return { elapsed: 0, staticColliders: [], walls, foldWalls: [], folds: [], events };
}

test('overhaul4: waveJumpHeight is 0.55; a hop at 0.56 clears the ring, 0.54 is hit', () => {
  assert.equal(B.waveJumpHeight, 0.55);
  assert.equal(P.jumpVelocity, 6.8);
  for (const mode of ['clear', 'hit']) {
    const m = createMatch({ seed: 5, playerIds: [0] });
    const p = m.players[0];
    p.pos.x = 2.5; p.pos.z = 0;
    p.pos.y = eye + (mode === 'clear' ? 0.56 : 0.54);
    m.hazards.push({ id: m.nextId++, kind: 'wave', x: 0, z: 0, r: 2.5, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] });
    stepHazards(m, DT);
    if (mode === 'clear') {
      assert.equal(p.hp, 100);
      assert.equal(p.velX, 0);
    } else {
      assert.equal(p.hp, 88);
      assert.ok(p.velX > 5);
    }
  }
});

test('overhaul4: dash fires only on explicit edge, sets exact velocity/timers and emits one event', () => {
  const events = [];
  const p = createPlayer(0, { x: 0, z: 0 });
  stepPlayer(p, { dash: true }, DT, ctx(events));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].type, 'dash');
  assert.ok(Math.abs(events[0].data.dx) < 1e-9 && Math.abs(events[0].data.dz + 1) < 1e-9, 'forward dash -z');
  assert.ok(Math.abs(p.dashT - (P.dash.duration - DT)) < 1e-9);
  assert.equal(p.dashCd, P.dash.cooldown);
  assert.ok(Math.abs(p.velX) < 1e-12); assert.equal(p.velZ, -P.dash.speed);
  assert.ok(Math.abs(p.pos.z + P.dash.speed * DT) < 1e-9);
  // 按住同方向不重复触发
  for (let i = 0; i < 3; i++) stepPlayer(p, { dash: true }, DT, ctx(events));
  assert.equal(events.length, 1);
  // 冲刺结束、冷却期间不可再触发
  p.dashT = 0;
  stepPlayer(p, { dash: true }, DT, ctx(events));
  assert.equal(events.length, 1);
  const snap = snapshot(createMatch({ seed: 1 }));
  assert.ok('dc' in snap.players[0] && 'da' in snap.players[0]);
});

test('overhaul4: dash direction follows input vector and normalizes diagonals', () => {
  const events = [];
  const p = createPlayer(0, { x: 0, z: 0 });
  stepPlayer(p, { dash: true, f: 1, r: 1 }, DT, ctx(events));
  const d = events[0].data;
  assert.ok(Math.abs(Math.hypot(d.dx, d.dz) - 1) < 1e-9);
  assert.ok(Math.abs(d.dx - Math.SQRT1_2) < 1e-9 && Math.abs(d.dz + Math.SQRT1_2) < 1e-9);
});

test('overhaul4: dash respects wall collision and never phases through blockers', () => {
  const events = [];
  const p = createPlayer(0, { x: 0, z: 0 });
  const wall = { id: 9, x: 0, z: -1.4, len: 6, ux: 1, uz: 0, nx: 0, nz: 1, halfThickness: CONFIG.wall.halfThickness, hp: 120, life: 18, owner: 0, dead: false };
  for (let i = 0; i < 8; i++) stepPlayer(p, { dash: true }, DT, ctx(events, [wall]));
  assert.ok(p.pos.z > -1.4 + CONFIG.wall.halfThickness + P.radius - 0.02, 'player z=' + p.pos.z);
  assert.ok(Math.abs(p.pos.x) < 1e-9);
});

test('overhaul4: inputs without dash keep legacy sprint movement and consume no dash state', () => {
  const run = dashField => {
    const m = createMatch({ seed: 21, playerIds: [0] });
    m.players[0].pos.z = 0;
    const input = { f: 1, r: 0, sprint: true, seq: 1 };
    if (dashField !== undefined) input.dash = dashField;
    for (let i = 0; i < 20; i++) stepMatch(m, { 0: { ...input, seq: i } });
    return { snap: snapshot(m), events: m.events.filter(e => e.type === 'dash'), p: m.players[0] };
  };
  const a = run(undefined), b = run(false);
  assert.deepEqual(a.snap, b.snap);
  assert.equal(a.events.length, 0);
  assert.equal(a.p.dashCd, 0);
  assert.equal(a.p.dashT, 0);
  assert.ok(Math.abs(a.p.pos.z + 20 * 7 * DT) < 0.9, 'legacy sprint distance preserved: ' + a.p.pos.z);
});

test('overhaul4: dash + boss brawl double run is bit-identical', () => {
  const run = () => {
    const m = createMatch({ seed: 404, playerIds: [0] });
    m.statics = []; m.folds = []; m.foldWalls = [];
    createBoss(m);
    for (let i = 0; i < 260; i++) {
      const input = { f: 1, r: (i % 40 < 12) ? 1 : 0, sprint: true, dash: i === 20 || i === 90 || i === 200, seq: i };
      stepMatch(m, { 0: input });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});

test('overhaul4: damagePlayer forwards source (sx, sx) on playerHit and stays 3-arg compatible', () => {
  const m = createMatch({ seed: 3 });
  const p = m.players[0];
  drainEvents(m);
  damagePlayer(m, p, 10, { x: 1.234, z: -5.678 });
  const ev = drainEvents(m)[0];
  assert.deepEqual(ev.data, { id: 0, dmg: 10, hp: 90, sx: 1.23, sz: -5.68 });
  damagePlayer(m, p, 5);
  const ev2 = drainEvents(m)[0];
  assert.deepEqual(ev2.data, { id: 0, dmg: 5, hp: 85 });
  assert.equal('sx' in ev2.data, false);
});

test('overhaul4: projectile and wave hits attach real source coordinates', () => {
  const m = createMatch({ seed: 6 });
  const p = m.players[0];
  p.pos.x = 0; p.pos.z = 0; p.pos.y = eye;
  fireProjectile(m, { x: 0, y: 1.3, z: -3 }, { x: 0, y: 1.3, z: 1 }, 9, 8);
  for (let i = 0; i < 20 && p.hp === 100; i++) stepProjectiles(m, DT);
  const hit = m.events.find(e => e.type === 'playerHit');
  assert.ok(hit && Number.isFinite(hit.data.sx) && Number.isFinite(hit.data.sz));
  assert.ok(Math.abs(hit.data.sx) < 0.01 && hit.data.sz < -1.2, 'projectile trail point');
  const m2 = createMatch({ seed: 7 });
  const p2 = m2.players[0];
  p2.pos.x = 2.5; p2.pos.z = -1;
  m2.hazards.push({ id: m2.nextId++, kind: 'wave', x: 0, z: 0, r: 2.5, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] });
  stepHazards(m2, DT);
  const wh = m2.events.find(e => e.type === 'playerHit');
  assert.deepEqual([wh.data.sx, wh.data.sz], [0, 0]);
});

test('overhaul4: all enemy/boss damage call sites pass finite source coordinates', () => {
  const enemies = readFileSync(new URL('../shared/enemies.mjs', import.meta.url), 'utf8');
  const boss = readFileSync(new URL('../shared/boss.mjs', import.meta.url), 'utf8');
  const combat = readFileSync(new URL('../shared/combat.mjs', import.meta.url), 'utf8');
  assert.match(enemies, /damagePlayer\(match, p, S\.biteDamage, \{ x: e\.x, z: e\.z \}\)/);
  assert.match(enemies, /damagePlayer\(match, p, S\.diveDamage, \{ x: e\.x, z: e\.z \}\)/);
  assert.match(boss, /cfg\.chargeDamage, \{ x: b\.x, z: b\.z \}/);
  assert.match(boss, /B\.slamDamage, \{ x: b\.x, z: b\.z \}/);
  assert.equal((boss.match(/h\.damage, \{ x: h\.x, z: h\.z \}/g) || []).length, 2);
  assert.match(boss, /damagePlayer\(match, p, 1, \{ x: h\.x, z: h\.z \}\)/);
  assert.match(combat, /p\.damage, \{ x: p\.x - p\.vx \* 0\.2, z: p\.z - p\.vz \* 0\.2 \}/);
});

test('overhaul4: rank thresholds S/A/B and failure null', () => {
  assert.equal(computeRank({ won: true, time: 150, hp: 60, crits: 0, interrupts: 0 }), 'S');
  assert.equal(computeRank({ won: true, time: 149.9, hp: 60 }), 'S');
  assert.equal(computeRank({ won: true, time: 300, hp: 40, crits: 4, interrupts: 2 }), 'S');
  assert.equal(computeRank({ won: true, time: 151, hp: 59, crits: 5, interrupts: 0 }), 'A');
  assert.equal(computeRank({ won: true, time: 210, hp: 39 }), 'A');
  assert.equal(computeRank({ won: true, time: 211, hp: 40 }), 'A');
  assert.equal(computeRank({ won: true, time: 211, hp: 39 }), 'B');
  assert.equal(computeRank({ won: false, time: 60, hp: 90 }), null);
});

test('overhaul4: damage direction angle maps front 0 / right +90 / back 180 / left -90', () => {
  const me = { x: 0, z: 0, yaw: 0 };
  assert.equal(damageAngle(me, 0, -1), 0);
  assert.equal(damageAngle(me, 1, 0), 90);
  assert.equal(Math.abs(damageAngle(me, 0, 1)), 180);
  assert.equal(damageAngle(me, -1, 0), -90);
  const turned = { x: 2, z: 2, yaw: Math.PI / 2 };
  assert.equal(damageAngle(turned, 1, 2), 0, 'facing -x means source at -x is front');
  assert.equal(damageAngle(turned, 2, 1), 90);
});
