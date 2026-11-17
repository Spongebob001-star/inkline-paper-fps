import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';

test('回合：240s + Boss 120s + 宽限 4s + 倒计时 3s', () => {
  assert.deepEqual(CONFIG.round, { timeLimit: 240, graceTime: 4, bossBonus: 120, countdown: 3 });
});

test('玩家基础数值（规格 §3.2）', () => {
  const p = CONFIG.player;
  assert.equal(p.radius, 0.34);
  assert.equal(p.eyeHeight, 1.65);
  assert.equal(p.maxHp, 100);
  assert.equal(p.walkSpeed, 4.8);
  assert.equal(p.sprintSpeed, 7);
  assert.equal(p.jumpVelocity, 6.2);
  assert.equal(p.gravity, 20);
  assert.equal(p.crawlSpeed, 0.6);
});

test('枪械数值（规格 §3.3）', () => {
  assert.deepEqual(CONFIG.player.gun, {
    damage: 24, armorDamage: 3, fireInterval: 0.14, magazine: 18, reloadTime: 1.25, range: 48,
  });
});

test('墨水：单体 10/s、抱团 15/s ≤5m、画线 20+4×len、擦除 35', () => {
  const k = CONFIG.ink;
  assert.equal(k.max, 100);
  assert.equal(k.regenDelay, 0.8);
  assert.equal(k.regenRate, 10);
  assert.equal(k.regenRateGroup, 15);
  assert.equal(k.groupRange, 5);
  assert.equal(k.drawBase, 20);
  assert.equal(k.drawPerMeter, 4);
  assert.equal(k.minDrawCost, 28);
  assert.equal(k.eraseCost, 35);
  assert.equal(k.eraseRadius, 6);
  assert.equal(k.eraseCooldown, 3.5);
  assert.equal(k.eraseStun, 1);
  assert.equal(k.eraseSlow, 2.5);
});

test('画线墙：120hp / 18s / 每人 3 / 全队 10 / 自距 0.75', () => {
  const w = CONFIG.wall;
  assert.equal(w.height, 1.65);
  assert.equal(w.thickness, 0.12);
  assert.equal(w.hp, 120);
  assert.equal(w.lifetime, 18);
  assert.equal(w.maxCount, 3);
  assert.equal(w.teamMax, 10);
  assert.equal(w.minSelfDist, 0.75);
  assert.equal(w.fadeLast, 3);
});

test('纸鹤数值（规格 §3.9）', () => {
  const e = CONFIG.enemy;
  assert.equal(e.hp, 48);
  assert.equal(e.armor, 24);
  assert.equal(e.speed, 2.25);
  assert.equal(e.attackRange, 13);
  assert.equal(e.telegraph, 0.55);
  assert.equal(e.damage, 8);
  assert.equal(e.attackCooldown, 1.65);
  assert.equal(e.projectileSpeed, 9);
  assert.equal(e.projectileLife, 1.8);
  assert.equal(e.wallDamage, 18);
  assert.equal(e.slowFactor, 0.5);
});

test('橡皮 / 纸飞机数值（规格 §3.10–3.11）', () => {
  const er = CONFIG.enemy.eraser;
  assert.equal(er.hp, 90);
  assert.equal(er.speed, 1.4);
  assert.equal(er.radius, 0.45);
  assert.equal(er.seekRange, 15);
  assert.equal(er.wallBite, 35);
  assert.equal(er.biteCooldown, 1.2);
  assert.equal(er.biteDamage, 12);
  const pl = CONFIG.enemy.plane;
  assert.equal(pl.hp, 30);
  assert.equal(pl.height, 2.4);
  assert.equal(pl.speed, 5);
  assert.equal(pl.circleDist, 6);
  assert.equal(pl.circleCd, 2.2);
  assert.equal(pl.aimTime, 0.6);
  assert.equal(pl.diveSpeed, 9);
  assert.equal(pl.diveTime, 1.2);
  assert.equal(pl.diveDamage, 10);
  assert.equal(pl.climbTime, 0.6);
});

test('人数缩放全表（规格 §3.16，n=1..4）', () => {
  const s = CONFIG.scaling;
  assert.deepEqual(s[1], { initial: 4, reinforce: 3, cap: 9, hpMul: 1.0, bossHp: 480, fan: 7 });
  assert.deepEqual(s[2], { initial: 6, reinforce: 4, cap: 12, hpMul: 1.55, bossHp: 744, fan: 8 });
  assert.deepEqual(s[3], { initial: 8, reinforce: 5, cap: 14, hpMul: 2.1, bossHp: 1008, fan: 9 });
  assert.deepEqual(s[4], { initial: 10, reinforce: 6, cap: 16, hpMul: 2.6, bossHp: 1272, fan: 10 });
  assert.deepEqual(s.spawn, { minDist: 3.5, landAnim: 0.35, attackBuffer: 1.5 });
});

test('折页：触发 2.2m / 动画 0.4s / 平台 1.5 / 墙 2.2 / 台阶 0.55', () => {
  const f = CONFIG.folds;
  assert.equal(f.interactRadius, 2.2);
  assert.equal(f.toggleTime, 0.4);
  assert.equal(f.platformHeight, 1.5);
  assert.equal(f.wallHeight, 2.2);
  assert.equal(f.stepLimit, 0.55);
  assert.equal(f.platformSize, 3.2);
  assert.equal(f.wallLen, 3.9);
  assert.equal(f.positions.length, 3);
});

test('拾取物：墨水×3 + 胶带×3（含规格修正的第三处 (0,10)）', () => {
  assert.deepEqual(CONFIG.pickups.ink, [{ x: 14, z: 8 }, { x: -14, z: 10 }, { x: 12, z: -12 }]);
  assert.deepEqual(CONFIG.pickups.tape, [{ x: -13, z: -6 }, { x: 7, z: 13 }, { x: 0, z: 10 }]);
  assert.equal(CONFIG.pickups.inkAmount, 40);
  assert.equal(CONFIG.pickups.tapeAmount, 30);
  assert.equal(CONFIG.pickups.radius, 1);
});

test('Boss：护盾 ceil(dmg×0.35)、狂暴阈值 50%、仇恨窗 5s', () => {
  const b = CONFIG.boss;
  assert.equal(b.hp, 480);
  assert.equal(b.shieldMul, 0.35);
  assert.equal(b.speed, 1.8);
  assert.equal(b.attackInterval, 1.7);
  assert.equal(b.fanCount, 7);
  assert.equal(b.fanSpeed, 8);
  assert.equal(b.fanTelegraph, 0.6);
  assert.equal(b.summonTelegraph, 0.8);
  assert.equal(b.summonCount, 3);
  assert.equal(b.summonCountBig, 4);
  assert.equal(b.chargeTelegraph, 0.7);
  assert.equal(b.chargeSpeed, 14);
  assert.equal(b.chargeTime, 1.1);
  assert.equal(b.chargeDamage, 18);
  assert.equal(b.chargeWallDamage, 45);
  assert.equal(b.hateWindow, 5);
  assert.equal(b.rage.at, 0.5);
  assert.equal(b.rage.attackInterval, 1.15);
  assert.equal(b.rage.speed, 2.4);
  assert.equal(b.rage.fanSpeed, 9.5);
  assert.equal(Math.ceil(24 * b.shieldMul), 9); // 护甲期每发实际扣血
});

test('锚点：单人 2.2s / 共持 1.1s / 衰减 3× / 撤离按住 2s（规格修正）', () => {
  const a = CONFIG.anchor;
  assert.equal(a.radius, 2);
  assert.equal(a.holdTime, 2.2);
  assert.equal(a.groupHoldTime, 1.1);
  assert.equal(a.decayMul, 3);
  assert.equal(a.exitRadius, 2.25);
  assert.equal(a.exitHoldTime, 2);
  assert.equal(a.reinforceCount, 3);
  assert.equal(a.pillarHeight, 9);
  assert.equal(a.arrowHideDist, 3);
});

test('倒地救援（规格 §3.17）', () => {
  assert.deepEqual(CONFIG.player.down, {
    time: 20, reviveRange: 1.5, reviveHold: 2, reviveHp: 50, reviveInk: 50, reviveInvuln: 1,
  });
});

test('网络常量（规格 §4，Δ1/Δ2）', () => {
  const n = CONFIG.net;
  assert.equal(n.tickHz, 20);
  assert.equal(n.dt, 0.05);
  assert.equal(n.inputHz, 30);
  assert.equal(n.inputMax, 60);
  assert.equal(n.interpMs, 100);
  assert.equal(n.catchupMax, 3);
  assert.equal(n.shotOriginTol, 0.6);
  assert.equal(n.reconnectHold, 30);
});

test('墨渍视觉：池 90 / 20s / 淡出 2.5s / 40% 溅射 / 6 色', () => {
  const s = CONFIG.visual.splat;
  assert.equal(s.max, 90);
  assert.equal(s.life, 20);
  assert.equal(s.fadeTime, 2.5);
  assert.equal(s.splashChance, 0.4);
  assert.equal(s.palette.length, 6);
});

test('存储键（规格 §3.18）', () => {
  assert.deepEqual(CONFIG.storage, {
    sound: 'inkline-sound',
    settings: 'inkline-settings',
    bestTeam: 'inkline-best-team',
    name: 'inkline-name',
    token: 'inkline-token',
  });
});

test('色板（规格 §3.12）', () => {
  assert.equal(CONFIG.colors.paper, 'F3F1E7');
  assert.equal(CONFIG.colors.ink, '20242A');
  assert.equal(CONFIG.colors.playerMarks.length, 4);
});