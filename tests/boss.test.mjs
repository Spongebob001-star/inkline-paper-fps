import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createBoss, damageBoss, stepBoss, hateTarget, farthestTarget } from '../shared/boss.mjs';

const DT = CONFIG.net.dt;
const B = CONFIG.boss;

function setup(opts = {}) {
  const m = createMatch({ seed: 3, playerIds: opts.ids || [0] });
  const b = createBoss(m);
  return { m, b };
}

function makeWall(m, x, z, len = 4, rot = 0) {
  const ux = Math.cos(rot), uz = -Math.sin(rot);
  const w = {
    id: m.nextId++, x, z, len, ux, uz, nx: -uz, nz: ux,
    halfThickness: CONFIG.wall.halfThickness,
    hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, dead: false,
  };
  m.walls.push(w);
  return w;
}

test('涂改护盾：阶段 1 扣血 ceil(伤×0.40)，24→10', () => {
  const { m, b } = setup();
  assert.equal(damageBoss(m, 24), Math.ceil(24 * B.shieldMul));
  assert.equal(b.hp, b.maxHp - 10);
  assert.equal(b.raged, false);
  assert.equal(b.phase, 1);
});

test('暴走：≤65% 触发一次、护盾升到 0.72、全队事件保留 bossPhase', () => {
  const { m, b } = setup();
  b.hp = b.maxHp * B.phase2At + 1;
  damageBoss(m, 2);
  assert.equal(b.raged, true);
  assert.equal(b.phase, 2);
  assert.equal(m.events.filter(e => e.type === 'rage').length, 1);
  assert.equal(m.events.filter(e => e.type === 'bossPhase' && e.data.phase === 2).length, 1);
  const dealt = damageBoss(m, 24);
  assert.equal(dealt, Math.ceil(24 * 0.72));
  damageBoss(m, 24);
  assert.equal(m.events.filter(e => e.type === 'rage').length, 1);
});

test('扇形：0.5s 蓄力 → 7 发 × 22° 散布，弹速 11 / 10 伤（阶段 1 单层）', () => {
  const { m, b } = setup();
  m.players[0].pos.x = 8; m.players[0].pos.z = 5.5;
  b.nextAttack = 0; b.attackCd = 0;
  stepBoss(m, DT);
  assert.equal(b.state, 'fan');
  for (let i = 0; i < 12; i++) stepBoss(m, DT);
  const prs = m.projectiles;
  assert.equal(prs.length, 7);
  for (const p of prs) {
    const sp = Math.hypot(p.vx, p.vy, p.vz);
    assert.ok(Math.abs(sp - 11) < 1e-9, `speed=${sp}`);
    assert.equal(p.damage, 10);
  }
  // 中间一发朝向玩家 +X
  const mid = prs[3];
  assert.ok(Math.abs(mid.vx / Math.hypot(mid.vx, mid.vy, mid.vz) - 1) < 1e-6);
});

test('仇恨：扇形瞄准近 5s 伤害最高者，超窗回退', () => {
  const { m, b } = setup({ ids: [0, 1] });
  m.players[0].pos.x = 5; m.players[0].pos.z = 5.5;
  m.players[1].pos.x = -5; m.players[1].pos.z = 5.5;
  damageBoss(m, 24, 1);
  assert.equal(hateTarget(m, b).id, 1);
  m.elapsed = B.hateWindow + 1;
  damageBoss(m, 24, 0);
  assert.equal(hateTarget(m, b).id, 0);
});

test('冲撞：瞄准当前距离最远者，方向锁定', () => {
  const { m, b } = setup({ ids: [0, 1] });
  m.players[0].pos.x = 2; m.players[0].pos.z = 5.5;
  m.players[1].pos.x = -10; m.players[1].pos.z = 5.5;
  assert.equal(farthestTarget(m, b).id, 1);
  b.slamCd = 99; // 隔离近身砸地优先级，专测折返冲锋锁头
  b.nextAttack = 3; b.attackCd = 0;
  stepBoss(m, DT);
  assert.equal(b.state, 'charge');
  assert.ok(Math.abs(b.aimX + 10) < 0.01);
  for (let i = 0; i < 14; i++) stepBoss(m, DT);
  assert.equal(b.state, 'charging');
  assert.ok(Math.abs(b.dirX + 1) < 1e-6 && Math.abs(b.dirZ) < 1e-6);
});

test('冲撞命中玩家 22 伤，一次后结束', () => {
  const { m, b } = setup();
  m.statics = []; // 清空掩体，隔离冲撞判定（实战冲撞会被掩体挡住，与原型一致）
  const p = m.players[0];
  p.pos.x = -6; p.pos.z = 5.5;
  b.slamCd = 99; // 隔离近身砸地，专注冲锋命中
  b.nextAttack = 3; b.attackCd = 0;
  stepBoss(m, DT);
  for (let i = 0; i < 14; i++) stepBoss(m, DT);
  for (let i = 0; i < 22; i++) stepBoss(m, DT);
  assert.equal(p.hp, CONFIG.player.maxHp - B.chargeDamage);
  assert.equal(b.state, 'idle');
});

test('冲撞撞碎玩家墙 45 并终止冲撞', () => {
  const { m, b } = setup();
  m.statics = [];
  m.players[0].pos.x = 14; m.players[0].pos.z = 5.5;
  const w = makeWall(m, 2, 5.5, 6, Math.PI / 2);
  b.nextAttack = 3; b.attackCd = 0;
  stepBoss(m, DT);
  for (let i = 0; i < 14; i++) stepBoss(m, DT);
  for (let i = 0; i < 22; i++) stepBoss(m, DT);
  assert.equal(w.hp, CONFIG.wall.hp - B.chargeWallDamage);
  assert.equal(b.state, 'idle');
});

test('召唤：3 只涂改灵（3/4 人 4 只），受同屏上限约束', () => {
  const { m, b } = setup();
  b.nextAttack = 2; b.attackCd = 0;
  stepBoss(m, DT);
  assert.equal(b.state, 'summon');
  for (let i = 0; i < 16; i++) stepBoss(m, DT);
  assert.equal(m.enemies.filter(e => !e.dead).length, 3);
  assert.ok(m.enemies.every(e => e.spawnT === 0));

  const big = setup({ ids: [0, 1, 2] });
  big.b.nextAttack = 2; big.b.attackCd = 0;
  stepBoss(big.m, DT);
  for (let i = 0; i < 16; i++) stepBoss(big.m, DT);
  assert.equal(big.m.enemies.filter(e => !e.dead).length, 4);

  const full = setup();
  for (let i = 0; i < CONFIG.scaling[1].cap; i++) full.m.enemies.push({ id: 100 + i, dead: false });
  full.b.nextAttack = 2; full.b.attackCd = 0;
  stepBoss(full.m, DT);
  for (let i = 0; i < 16; i++) stepBoss(full.m, DT);
  assert.equal(full.m.enemies.length, CONFIG.scaling[1].cap);
});

test('暴走强化：弹速 13、间隔 0.95、移速 3.1、双层交错第二排 count+1', () => {
  const { m, b } = setup();
  m.players[0].pos.x = 8; m.players[0].pos.z = 5.5;
  b.phase = 2; b.raged = true;
  b.nextAttack = 0; b.attackCd = 0;
  stepBoss(m, DT);
  for (let i = 0; i < 18; i++) stepBoss(m, DT);
  const speeds = m.projectiles.map(p => Math.hypot(p.vx, p.vz));
  assert.ok(speeds.every(sp => Math.abs(sp - B.rage.fanSpeed) < 1e-9));
  assert.equal(m.projectiles.length, 7 + 8);
  assert.equal(b.attackCd, B.rage.attackInterval);
  assert.equal(B.phases[1].speed, 3.1);
});

test('面部始终朝向当前目标', () => {
  const { m, b } = setup();
  m.players[0].pos.x = 5; m.players[0].pos.z = 5.5;
  stepBoss(m, DT);
  assert.ok(Math.abs(b.faceYaw - Math.PI / 2) < 1e-6);
});

test('出战流程：Boss 死亡解锁出口', () => {
  const { m, b } = setup();
  b.hp = 1;
  damageBoss(m, 100);
  assert.equal(b.dead, true);
  assert.equal(m.exitUnlocked, true);
  assert.ok(m.events.some(e => e.type === 'bossDown'));

  const loop = createMatch({ seed: 9 });
  createBoss(loop);
  stepMatch(loop, {});
  assert.ok(loop.boss);
  assert.equal(loop.boss.attackCd < 2.5, true);
});

test('确定性：带 Boss 与玩家 300 步双跑快照逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 777 });
    createBoss(m);
    for (let i = 0; i < 300; i++) {
      stepMatch(m, { 0: { f: i % 60 < 30 ? 1 : 0, r: 0, seq: i } });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});
