// 重铸包 2 · 任务 3：奶龙三阶段与五大技能全覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot, drainEvents } from '../shared/sim.mjs';
import { createBoss, damageBoss, stepBoss, stepHazards } from '../shared/boss.mjs';
import { applyErase } from '../shared/erase.mjs';

const B = CONFIG.boss;
const DT = CONFIG.net.dt;
const eye = CONFIG.player.eyeHeight;

function arena(ids = [0], seed = 41) {
  const m = createMatch({ seed, playerIds: ids });
  m.statics = [];
  m.folds = [];
  m.foldWalls = [];
  return m;
}

function bossArena(ids = [0]) {
  const m = arena(ids);
  const b = createBoss(m);
  b.slamCd = 99;
  drainEvents(m);
  return { m, b, p: m.players[0] };
}

test('overhaul2 boss: HP is 1100/1650/2200/2750 for 1-4 players', () => {
  const expected = [1100, 1650, 2200, 2750];
  for (let n = 1; n <= 4; n++) {
    const m = arena(Array.from({ length: n }, (_, i) => i));
    const b = createBoss(m);
    assert.equal(b.hp, expected[n - 1], 'n=' + n);
    assert.equal(b.maxHp, expected[n - 1]);
    assert.equal(b.phase, 1);
  }
});

test('overhaul2 boss: 65%/30% phase ladder emits bossPhase and applies 0.40/0.72/1.00 shields', () => {
  const { m, b } = bossArena();
  b.hp = Math.floor(b.maxHp * B.phase2At) + 1;
  damageBoss(m, 10);
  assert.equal(b.phase, 2);
  assert.equal(b.raged, true);
  assert.deepEqual(m.events.filter(ev => ev.type === 'rage').length, 1);
  assert.deepEqual(m.events.filter(ev => ev.type === 'bossPhase').map(ev => ev.data.phase), [2]);
  b.hp = 700;
  assert.equal(damageBoss(m, 100), Math.ceil(100 * 0.72));
  b.hp = Math.floor(b.maxHp * B.phase3At) + 1;
  damageBoss(m, 10);
  assert.equal(b.phase, 3);
  assert.deepEqual(m.events.filter(ev => ev.type === 'bossPhase').map(ev => ev.data.phase), [2, 3]);
  b.hp = 300;
  assert.equal(damageBoss(m, 100), 100, 'phase 3 shield is fully broken');
});

test('overhaul2 boss: armor_pierce pierces 0.62 in phase 1, 0.90 in phase 2, capped in phase 3', () => {
  const { m, b } = bossArena();
  assert.equal(damageBoss(m, 24, null, { shieldMulOverride: 0.62 }), 15);
  b.phase = 2; b.raged = true;
  assert.equal(damageBoss(m, 24, null, { shieldMulOverride: 0.62 }), 22);
  b.phase = 3;
  assert.equal(damageBoss(m, 24, null, { shieldMulOverride: 0.62 }), 24);
});

test('overhaul2 boss: phase 2/3 fan fires a second staggered row of count+1 at half angle', () => {
  const { m, b, p } = bossArena();
  b.phase = 2; b.raged = true;
  b.nextAttack = 0; b.attackCd = 0;
  p.pos.x = 8; p.pos.z = 5.5;
  stepBoss(m, DT);
  assert.equal(b.state, 'fan');
  for (let i = 0; i < 12; i++) stepBoss(m, DT);
  assert.equal(m.projectiles.length, 7, 'row 1');
  assert.ok(b.fanPending > 0 && b.state === 'fan');
  for (let i = 0; i < 7; i++) stepBoss(m, DT);
  assert.equal(m.projectiles.length, 15, 'row 2 adds fanCount+1');
  const speeds = m.projectiles.map(pr => Math.hypot(pr.vx, pr.vy, pr.vz));
  assert.ok(speeds.every(sp => Math.abs(sp - B.phases[1].fanSpeed) < 1e-9));
  const first = Math.atan2(m.projectiles[3].vx, m.projectiles[3].vz);
  const secondFirst = Math.atan2(m.projectiles[7].vx, m.projectiles[7].vz);
  const secondLast = Math.atan2(m.projectiles[14].vx, m.projectiles[14].vz);
  const secondMid = (secondFirst + secondLast) / 2;
  assert.ok(Math.abs(secondMid - first - B.fanSpread / 2) < 1e-6, 'second row offset by half spread');
  assert.equal(b.state, 'idle');
});

test('overhaul2 boss: mortar places 4/6/8 telegraphs at player+lead+random spots, ignores cover on blast', () => {
  const { m, b, p } = bossArena();
  p.pos.x = 6; p.pos.z = -6; p.velX = 2; p.velZ = 0;
  b.x = 0; b.z = 5.5;
  b.nextAttack = 1; b.attackCd = 0;
  stepBoss(m, DT);
  assert.equal(b.state, 'mortar');
  for (let i = 0; i < 12; i++) stepBoss(m, DT);
  const mortars = m.hazards.filter(h => h.kind === 'mortar');
  assert.equal(mortars.length, B.phases[0].mortars, 'phase 1 count');
  assert.equal(mortars[0].x, p.pos.x);
  assert.equal(mortars[0].z, p.pos.z);
  assert.ok(Math.abs(mortars[1].x - (p.pos.x + p.velX * B.mortarLead)) < 1e-9);
  for (const h of mortars) { assert.equal(h.r, B.mortarRadius); assert.equal(h.fuse, B.mortarFuse); }
  // 站进首个红圈并放在矮掩体后面：墨雨无视掩体。先移走其余红圈，单点验证 16 伤。
  p.pos.x = mortars[0].x; p.pos.z = mortars[0].z;
  m.hazards = [mortars[0]];
  m.statics = [{ x: p.pos.x, z: p.pos.z - 0.5, hx: 2, hz: 0.1, y0: 0, y1: 1.2 }];
  drainEvents(m);
  const before = p.hp;
  for (let i = 0; i < 24; i++) stepHazards(m, DT);
  assert.equal(p.hp, before - B.mortarDamage);
  assert.ok(m.events.some(ev => ev.type === 'mortarBoom'));
  assert.ok(!m.hazards.includes(mortars[0]), 'blast consumes the telegraph');
});

test('overhaul2 boss: mortar count scales to 6 and 8 in phase 2/3', () => {
  for (const [phase, count] of [[2, 6], [3, 8]]) {
    const { m, b, p } = bossArena();
    b.phase = phase; b.raged = phase > 1;
    b.nextAttack = 1; b.attackCd = 0;
    stepBoss(m, DT);
    for (let i = 0; i < 12; i++) stepBoss(m, DT);
    assert.equal(m.hazards.filter(h => h.kind === 'mortar').length, count, 'phase ' + phase);
    assert.equal(p.hp, 100, 'telegraphs alone deal no damage');
  }
});

test('overhaul2 boss: summon emits 3 laugh-wave bursts (2/3 rings) and exposes belly 2.2s', () => {
  const { m, b, p } = bossArena();
  b.state = 'summon'; b.telegraph = 0.75;
  stepBoss(m, DT);
  assert.equal(b.laughExposeT, 2.2);
  assert.equal(b.waveLeft, B.waveBursts);
  stepBoss(m, DT);
  assert.equal(b.waveLeft, 2);
  assert.equal(m.hazards.filter(h => h.kind === 'wave').length, 2, 'phase 1: 2 rings');
  for (let i = 0; i < 24; i++) stepBoss(m, DT);
  assert.equal(m.hazards.filter(h => h.kind === 'wave').length, 6, 'three bursts accumulate');
  const wave = m.hazards.find(h => h.kind === 'wave');
  assert.equal(wave.speed, B.waveSpeed);
  assert.equal(wave.maxR, B.waveMaxRadius);
  assert.equal(p.hp, 100);
});

test('overhaul2 boss: wave hits grounded players for 12 + 5.5 push, jumping and platforms are immune', () => {
  for (const mode of ['ground', 'jump', 'platform']) {
    const { m, b, p } = bossArena();
    b.state = 'summon'; b.telegraph = 0.75;
    stepBoss(m, DT);
    stepBoss(m, DT);
    const wave = m.hazards.find(h => h.kind === 'wave');
    b.waveLeft = 0;
    p.pos.x = wave.x + wave.r + 0.4; p.pos.z = wave.z;
    p.pos.y = eye + (mode === 'jump' ? B.waveJumpHeight + 0.01 : mode === 'platform' ? 1.5 : 0);
    const before = p.hp;
    stepHazards(m, DT);
    if (mode === 'ground') {
      assert.equal(p.hp, before - B.waveDamage);
      assert.ok(Math.abs(p.velX - B.wavePush) < 1e-9, 'outward push matches 5.5 m/s');
      assert.ok(wave.hit.includes(0));
      stepHazards(m, DT);
      assert.equal(p.hp, before - B.waveDamage, 'each ring hits a player once');
    } else {
      assert.equal(p.hp, before, mode + ' must be immune');
    }
  }
});

test('overhaul2 boss: erase during the laugh cancels pending waves, stuns 2s and keeps the belly window closed', () => {
  const { m, b, p } = bossArena();
  b.state = 'summon'; b.telegraph = 0.75;
  stepBoss(m, DT);
  stepBoss(m, DT);
  assert.ok(m.hazards.some(h => h.kind === 'wave'));
  p.pos.x = b.x + 4; p.pos.z = b.z;
  const result = applyErase(m, 0);
  assert.equal(result.bossInterrupted, true);
  assert.equal(b.stunT, B.eraseStunTime);
  assert.equal(b.waveLeft, 0);
  assert.equal(b.laughExposeT, 0);
  assert.ok(m.events.some(ev => ev.type === 'bossInterrupt'));
});

test('overhaul2 boss: phase-2 charge relocks twice and paints burning puddles every 2.4m', () => {
  const { m, b, p } = bossArena();
  b.phase = 2; b.raged = true;
  p.pos.x = -14; p.pos.z = 5.5; // 最远目标，避开掩体
  b.nextAttack = 3; b.attackCd = 0;
  stepBoss(m, DT);
  assert.equal(b.state, 'charge');
  assert.equal(b.chargeLeft, 2);
  for (let i = 0; i < 10; i++) stepBoss(m, DT);
  assert.equal(b.state, 'charging');
  for (let i = 0; i < 22; i++) stepBoss(m, DT);
  assert.equal(b.state, 'charge', 'second segment relocks with a fresh telegraph');
  assert.equal(b.chargeLeft, 1);
  assert.ok(b.telegraph >= 0 && b.telegraph < B.chargeTelegraph);
  const puddles = m.hazards.filter(h => h.kind === 'puddle');
  assert.ok(puddles.length >= 5, 'charge paints puddles every 2.4m');
  for (const h of puddles) { assert.equal(h.r, B.puddleRadius); assert.ok(h.t <= B.puddleLife); }
});

test('overhaul2 boss: charge wall collision clears all remaining segments and stuns 2.2s', () => {
  const { m, b, p } = bossArena();
  b.phase = 3; b.raged = true;
  p.pos.x = 14; p.pos.z = 5.5;
  const w = { id: m.nextId++, x: 1.2, z: 5.5, len: 6, ux: 0, uz: 1, nx: -1, nz: 0, halfThickness: CONFIG.wall.halfThickness, hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, owner: 0, dead: false };
  m.walls.push(w);
  b.nextAttack = 3; b.attackCd = 0;
  stepBoss(m, DT);
  assert.equal(b.chargeLeft, 3);
  for (let i = 0; i < 10; i++) stepBoss(m, DT);
  assert.equal(b.state, 'charging');
  for (let i = 0; i < 3; i++) stepBoss(m, DT);
  assert.ok(b.stunT >= 2 && b.stunT <= B.wallStunTime);
  assert.equal(b.chargeLeft, 0);
  assert.equal(b.state, 'idle');
  assert.equal(w.hp, CONFIG.wall.hp - B.chargeWallDamage);
  assert.ok(m.events.some(ev => ev.type === 'bossStun' && ev.data.reason === 'wall'));
});

test('overhaul2 boss: standing in a puddle slows movement to 0.65x and deals 4 dps', () => {
  const m = arena();
  const p = m.players[0];
  p.pos.x = 0; p.pos.z = 0; p.pos.y = eye;
  m.hazards.push({ id: m.nextId++, kind: 'puddle', x: 0, z: 0, r: B.puddleRadius, t: B.puddleLife, tick: 0.25 });
  stepMatch(m, { 0: { f: 0, r: 0, seq: 1 } });
  assert.equal(p.hazardSlow, B.puddleSlow);
  for (let i = 0; i < 21; i++) stepMatch(m, { 0: { f: 0, r: 0, seq: i + 2 } });
  const lost = 100 - p.hp;
  assert.ok(lost >= 3 && lost <= 4, '约 4 点/秒：' + lost);
});

test('overhaul2 boss: slam triggers inside 3.4m, hits 16 with 8.5 push and 4.2 lift', () => {
  const { m, b, p } = bossArena();
  b.slamCd = 0;
  p.pos.x = 0; p.pos.z = b.z + 2.7;
  b.attackCd = 10;
  stepBoss(m, DT);
  assert.equal(b.state, 'slam');
  assert.equal(b.slamCd, B.slamCooldown);
  for (let i = 0; i < 9; i++) stepBoss(m, DT);
  assert.equal(p.hp, 100, 'telegraph does not damage');
  stepBoss(m, DT);
  assert.equal(p.hp, 100 - B.slamDamage);
  assert.ok(Math.abs(p.velX) < 1e-9 && Math.abs(p.velZ - B.slamPush) < 1e-9);
  assert.equal(p.velY, B.slamLift);
  assert.equal(p.grounded, false);
  assert.ok(m.events.some(ev => ev.type === 'bossSlam'));
  assert.equal(b.state, 'idle');
});

test('overhaul2 boss: hazards and phase are transported in compact snapshots', () => {
  const { m, b } = bossArena();
  b.phase = 3; b.raged = true;
  m.hazards.push({ id: m.nextId++, kind: 'wave', x: 1.234, z: -2.345, r: 3.2, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] });
  m.hazards.push({ id: m.nextId++, kind: 'mortar', x: 0, z: 0, r: 2.2, fuse: 1.15, t: 0.8, damage: 16 });
  m.hazards.push({ id: m.nextId++, kind: 'puddle', x: 0, z: 0, r: 1.45, t: 2.5, tick: 0.25 });
  const s = snapshot(m);
  assert.equal(s.boss.max, b.maxHp);
  assert.equal(s.boss.ph, 3);
  assert.deepEqual(s.hazards.map(h => h.k), ['w', 'm', 'p']);
  assert.deepEqual([s.hazards[0].x, s.hazards[0].z, s.hazards[0].r], [1.23, -2.35, 3.2]);
  assert.equal(s.hazards[1].t, 0.8);
  assert.equal(s.hazards[2].t, 2.5);
});

test('overhaul2 boss: full phase-3 brawl with hazards is deterministic across double runs', () => {
  const run = () => {
    const m = arena([0, 1], 20261120);
    const b = createBoss(m);
    b.hp = b.maxHp * 0.25; // 直接进入终焉墨潮
    for (let i = 0; i < 400; i++) {
      stepMatch(m, {
        0: { f: i % 40 < 22 ? 1 : 0, r: i % 18 < 6 ? 0.6 : -0.2, seq: i },
        1: { f: i % 30 < 12 ? -1 : 0, r: 0.4, hold: i % 25 === 0, seq: i },
      });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});
