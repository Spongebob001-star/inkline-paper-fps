import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { damageBoss } from '../shared/boss.mjs';
import { applyShot } from '../shared/combat.mjs';
import { EXIT, ANCHORS } from '../shared/world.mjs';

const ticks = (m, n, inputs = {}) => { for (let i = 0; i < n; i++) stepMatch(m, inputs); };
const atAnchor = (m, i = 0) => { const p = m.players[0]; p.pos.x = ANCHORS[i].x; p.pos.z = ANCHORS[i].z; };
const hold = { 0: { hold: true } };

test('单人按住 2.2s 完成锚点：active/anchorsDone/事件/增援 +3', () => {
  const m = createMatch({ seed: 3 });
  atAnchor(m);
  ticks(m, 43, hold);
  assert.equal(m.anchors[0].active, false);
  ticks(m, 2, hold);
  assert.equal(m.anchors[0].active, true);
  assert.equal(m.anchorsDone, 1);
  assert.ok(m.events.some(e => e.type === 'anchorDone' && e.data.label === 'A1'));
  assert.equal(m.enemies.length, CONFIG.scaling[1].reinforce);
  assert.ok(m.enemies.every(e => e.attackCd >= 1.4));
});

test('共持 1.1s：两人同按减半时长', () => {
  const m = createMatch({ seed: 3, playerIds: [0, 1] });
  for (const p of m.players) { p.pos.x = ANCHORS[0].x; p.pos.z = ANCHORS[0].z; }
  ticks(m, 21, { 0: { hold: true }, 1: { hold: true } });
  assert.equal(m.anchors[0].active, false);
  ticks(m, 2, { 0: { hold: true }, 1: { hold: true } });
  assert.equal(m.anchors[0].active, true);
});

test('松开 3 倍速回退：持 1.1s 进度 .5，松 0.1s 退 .1364', () => {
  const m = createMatch({ seed: 3 });
  atAnchor(m);
  ticks(m, 22, hold);
  assert.ok(Math.abs(m.anchors[0].progress - 0.5) < 0.01);
  ticks(m, 2, {});
  const expect = 0.5 - 0.1 * CONFIG.anchor.decayMul / CONFIG.anchor.holdTime;
  assert.ok(Math.abs(m.anchors[0].progress - expect) < 0.01, 'progress=' + m.anchors[0].progress);
});

test('范围外 / 倒地玩家按住无效', () => {
  const m = createMatch({ seed: 3 });
  const p = m.players[0];
  p.pos.x = ANCHORS[0].x + 3; p.pos.z = ANCHORS[0].z;
  ticks(m, 30, hold);
  assert.equal(m.anchors[0].progress, 0);
  p.pos.x = ANCHORS[0].x; p.pos.z = ANCHORS[0].z;
  p.st = 1;
  ticks(m, 30, hold);
  assert.equal(m.anchors[0].progress, 0);
});

test('三锚点完成 → boss 阶段 +120s + Boss 480hp + 出口仍锁定', () => {
  const m = createMatch({ seed: 3 });
  const before = m.timeLeft;
  for (let i = 0; i < 3; i++) {
    atAnchor(m, i);
    ticks(m, 45, hold);
    assert.equal(m.anchors[i].active, true);
  }
  assert.equal(m.phase, 'boss');
  assert.ok(m.boss && m.boss.hp === CONFIG.scaling[1].bossHp);
  assert.ok(Math.abs(m.timeLeft - (before - 45 * 3 * 0.05 + 120)) < 0.2);
  assert.equal(m.exitUnlocked, false);
  assert.ok(m.events.some(e => e.type === 'phase' && e.data.phase === 'boss'));
});

test('增援离玩家 ≥3.5m（站在生成点附近也被推远）', () => {
  const m = createMatch({ seed: 3 });
  const p = m.players[0];
  p.pos.x = ANCHORS[0].x + 1.5; p.pos.z = ANCHORS[0].z + 1; // 持锚范围内且贴近偏移 spot
  ticks(m, 45, hold);
  assert.equal(m.anchors[0].active, true);
  for (const e of m.enemies) {
    assert.ok(Math.hypot(e.x - p.pos.x, e.z - p.pos.z) >= 3.4, 'enemy dist=' + Math.hypot(e.x - p.pos.x, e.z - p.pos.z));
  }
});

test('同屏上限：满 cap 时锚点完成不再增援', () => {
  const m = createMatch({ seed: 3 });
  for (let i = 0; i < CONFIG.scaling[1].cap; i++) createEnemy(m, 'crane', -15 + i * 0.5, 15);
  atAnchor(m);
  ticks(m, 45, hold);
  assert.equal(m.anchors[0].active, true);
  assert.equal(m.enemies.filter(e => !e.dead).length, CONFIG.scaling[1].cap);
});

test('Boss 死亡解锁出口；撤离按住 2s → won + win 事件', () => {
  const m = createMatch({ seed: 3 });
  for (let i = 0; i < 3; i++) { atAnchor(m, i); ticks(m, 45, hold); }
  damageBoss(m, 10000);
  assert.equal(m.exitUnlocked, true);
  const p = m.players[0];
  p.pos.x = EXIT.x; p.pos.z = EXIT.z;
  ticks(m, 39, hold);
  assert.equal(m.phase, 'boss');
  ticks(m, 2, hold);
  assert.equal(m.phase, 'won');
  assert.ok(m.events.some(e => e.type === 'win'));
});

test('撤离松开即清零（不同于锚点渐退）', () => {
  const m = createMatch({ seed: 3 });
  for (let i = 0; i < 3; i++) { atAnchor(m, i); ticks(m, 45, hold); }
  damageBoss(m, 10000);
  const p = m.players[0];
  p.pos.x = EXIT.x; p.pos.z = EXIT.z;
  ticks(m, 20, hold);
  assert.ok(Math.abs(m.exitProgress - 0.5) < 0.01);
  ticks(m, 1, {});
  assert.equal(m.exitProgress, 0);
});

test('出口锁定期间按住无效', () => {
  const m = createMatch({ seed: 3 });
  const p = m.players[0];
  p.pos.x = EXIT.x; p.pos.z = EXIT.z;
  ticks(m, 60, hold);
  assert.equal(m.exitProgress, 0);
  assert.equal(m.phase, 'anchors');
});

test('倒计时归零 → lost(time)；结算后仿真冻结', () => {
  const m = createMatch({ seed: 3 });
  m.timeLeft = 0.04;
  ticks(m, 1);
  assert.equal(m.phase, 'lost');
  assert.ok(m.events.some(e => e.type === 'lose' && e.data.reason === 'time'));
  const t = m.tick;
  ticks(m, 10);
  assert.equal(m.tick, t);
});

test('单人倒地 = 全队倒地 → lost(down)', () => {
  const m = createMatch({ seed: 3 });
  m.players[0].st = 1; m.players[0].hp = 0;
  ticks(m, 1);
  assert.equal(m.phase, 'lost');
  assert.ok(m.events.some(e => e.type === 'lose' && e.data.reason === 'down'));
});

test('击杀计入射手个人统计（结算用）', () => {
  const m = createMatch({ seed: 3 });
  const e = createEnemy(m, 'crane', 10, -9);
  e.stun = 999;
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = -13;
  for (let i = 0; i < 10; i++) {
    applyShot(m, 0, { x: 10, y: 1.65, z: -13 }, { x: 0, y: -0.18, z: 0.98 });
    ticks(m, 3);
  }
  assert.equal(e.dead, true);
  assert.equal(p.stats.kills, 1);
  assert.equal(snapshot(m).players[0].sc[0], 1);
});

test('快照含锚点进度/出口进度/墙存续（HUD 消费）', () => {
  const m = createMatch({ seed: 3 });
  atAnchor(m);
  ticks(m, 22, hold);
  const s = snapshot(m);
  assert.ok(Math.abs(s.anchors[0].progress - 0.5) < 0.02);
  assert.equal(s.exit, 0);
  assert.equal(typeof s.kills, 'number');
});