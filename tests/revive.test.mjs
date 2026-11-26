// D7 T7.1：倒地 / 救援 / 无敌帧全分支（规格 §3.13）。
// 覆盖：救援成功、中断归零、超距拒绝、自救拒绝、计时阵亡、1s 无敌、全队倒地、倒地禁行动。
import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot, startReload } from '../shared/sim.mjs';
import { applyShot, damagePlayer } from '../shared/combat.mjs';
import { applyDraw } from '../shared/walls.mjs';
import { applyErase } from '../shared/erase.mjs';
import { applyFold } from '../shared/folds.mjs';
import { ANCHORS, EXIT } from '../shared/world.mjs';

const DT = CONFIG.net.dt;
const D = CONFIG.player.down;
const ticks = (m, n, inputs = {}) => { for (let i = 0; i < n; i++) stepMatch(m, inputs); };
const place = (p, x, z) => { p.pos.x = x; p.pos.z = z; };

function down(m, id = 0, x = 0, z = -4) {
  const p = m.players.find(q => q.id === id);
  p.hp = CONFIG.player.maxHp;
  damagePlayer(m, p, CONFIG.player.maxHp); // 走真实倒地路径（st=1 + downed 事件）
  place(p, x, z);
  return p;
}
function twoPlayer(seed = 5) {
  const m = createMatch({ seed, playerIds: [0, 1] });
  place(m.players[1], 8, 8); // 远离锚点/出口/倒地者
  return m;
}
function projectileAt(m, p, damage = 8) {
  const pr = {
    id: m.nextId++, x: p.pos.x, y: p.pos.y - 0.35, z: p.pos.z,
    vx: 0, vy: 0, vz: 0, life: 1, damage,
  };
  m.projectiles.push(pr);
  return pr;
}

test('救援成功：1.5m 内按住 2s → st=0 / hp50 / ink50 / 1s 无敌 / rescues++ / revive 事件', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  a.ink = 10;
  place(m.players[1], 1, -4);
  ticks(m, 39, { 1: { hold: true } });
  assert.equal(a.st, 1);
  assert.ok(a.reviveProgress > 0.9 && a.reviveProgress < 1, 'progress=' + a.reviveProgress);
  ticks(m, 1, { 1: { hold: true } });
  assert.equal(a.st, 0);
  assert.equal(a.hp, D.reviveHp);
  assert.equal(a.ink, D.reviveInk);
  assert.equal(a.invuln, D.reviveInvuln);
  assert.equal(a.downT, 0);
  assert.equal(m.players[1].stats.rescues, 1);
  assert.ok(m.events.some(e => e.type === 'revive' && e.data.id === 0 && e.data.by === 1));
  const s = snapshot(m).players[0];
  assert.equal(s.st, 0);
  assert.equal(s.iv, 1);
  assert.equal(s.rv, 0);
});

test('救援中断：松开即进度归零，重新按从头累计', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  place(m.players[1], 1, -4);
  ticks(m, 20, { 1: { hold: true } });
  assert.ok(a.reviveProgress > 0.45 && a.reviveProgress < 0.55);
  ticks(m, 1, {});
  assert.equal(a.reviveProgress, 0);
  assert.equal(a.reviveBy, null);
  ticks(m, 10, { 1: { hold: true } });
  assert.ok(a.reviveProgress > 0.2 && a.reviveProgress < 0.3, 'progress=' + a.reviveProgress);
  assert.equal(a.st, 1);
});

test('超距拒绝：救援者 2m 外按住 F 无进度', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  place(m.players[1], 2, -4);
  ticks(m, 60, { 1: { hold: true } });
  assert.equal(a.st, 1);
  assert.equal(a.reviveProgress, 0);
  assert.equal(m.players[1].stats.rescues, 0);
});

test('自救拒绝：倒地者自己按住 F 不算，进度恒 0', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  place(m.players[1], 8, 8);
  ticks(m, 60, { 0: { hold: true } });
  assert.equal(a.st, 1);
  assert.equal(a.reviveProgress, 0);
  assert.equal(a.stats.rescues, 0);
});

test('计时阵亡：20s 无人救援 → st=2 + downExpire 事件（仍有存活队友不判负）', () => {
  const m = twoPlayer(7);
  const a = down(m, 0, 0, -4);
  ticks(m, 399);
  assert.equal(a.st, 1);
  assert.ok(a.downT > 0 && a.downT < 0.1, 'downT=' + a.downT);
  ticks(m, 1);
  assert.equal(a.st, 2);
  assert.equal(a.downT, 0);
  assert.ok(m.events.some(e => e.type === 'downExpire' && e.data.id === 0));
  assert.equal(m.phase, 'anchors');
});

test('全队倒地/阵亡：st=1 或 st=2 都计入 → lost(down)', () => {
  const a = createMatch({ seed: 5, playerIds: [0, 1] });
  a.players[0].st = 1; a.players[0].hp = 0;
  a.players[1].st = 1; a.players[1].hp = 0;
  ticks(a, 1);
  assert.equal(a.phase, 'lost');
  assert.ok(a.events.some(e => e.type === 'lose' && e.data.reason === 'down'));

  const b = createMatch({ seed: 5, playerIds: [0, 1] });
  b.players[0].st = 2; b.players[0].hp = 0;
  b.players[1].st = 1; b.players[1].hp = 0;
  ticks(b, 1);
  assert.equal(b.phase, 'lost');
  assert.ok(b.events.some(e => e.type === 'lose' && e.data.reason === 'down'));
});

test('1s 无敌：救起后 20 tick 内伤害为 0 且无 playerHit 事件，第 21 tick 起正常受伤', () => {
  const m = twoPlayer(9);
  const a = down(m, 0, 0, -4);
  place(m.players[1], 1, -4);
  ticks(m, 40, { 1: { hold: true } });
  assert.equal(a.st, 0);
  assert.equal(a.invuln, 1);
  m.events.length = 0; // 清掉倒地阶段的 playerHit/downed/revive，只统计无敌期
  for (let i = 0; i < 20; i++) {
    projectileAt(m, a, 8);
    ticks(m, 1);
    assert.equal(a.hp, D.reviveHp, `tick ${i + 1} hp=${a.hp}`);
    assert.equal(a.st, 0);
  }
  assert.equal(m.events.filter(e => e.type === 'playerHit' && e.data.id === 0).length, 0);
  assert.equal(a.invuln, 0);
  projectileAt(m, a, 8);
  ticks(m, 1);
  assert.equal(a.hp, D.reviveHp - 8);
  assert.equal(m.events.filter(e => e.type === 'playerHit' && e.data.id === 0).length, 1);
});

test('多人同时救援：按最近者，统计只记实际救援者；"先到者"锁定后不被更近者抢走', () => {
  const m = createMatch({ seed: 5, playerIds: [0, 1, 2] });
  const a = down(m, 0, 0, -4);
  place(m.players[1], 1.2, -4); // id1 较远
  place(m.players[2], 0.5, -4); // id2 最近
  ticks(m, 1, { 1: { hold: true }, 2: { hold: true } });
  assert.equal(a.reviveBy, 2);
  place(m.players[1], 0.6, -4); // id1 更近但已在救（先到）
  ticks(m, 39, { 1: { hold: true }, 2: { hold: true } });
  assert.equal(a.st, 0);
  assert.equal(m.players[2].stats.rescues, 1);
  assert.equal(m.players[1].stats.rescues, 0);

  const n = createMatch({ seed: 5, playerIds: [0, 1, 2] });
  const b = down(n, 0, 0, -4);
  place(n.players[1], 1.2, -4);
  place(n.players[2], 5, -4);
  ticks(n, 20, { 1: { hold: true } });
  assert.equal(b.reviveBy, 1);
  place(n.players[2], 0.5, -4);
  ticks(n, 1, { 1: { hold: true }, 2: { hold: true } });
  assert.equal(b.reviveBy, 1);
  assert.ok(b.reviveProgress > 0.5, 'progress=' + b.reviveProgress);
});

test('救援者倒地/离开 → 进度归零，不能继续救', () => {
  const m = createMatch({ seed: 5, playerIds: [0, 1, 2] });
  const a = down(m, 0, 0, -4);
  place(m.players[1], 1, -4);
  place(m.players[2], 8, 8);
  ticks(m, 20, { 1: { hold: true } });
  assert.ok(a.reviveProgress > 0.45);
  m.players[1].st = 1;
  m.players[1].hp = 0;
  ticks(m, 1, { 1: { hold: true } });
  assert.equal(a.reviveProgress, 0);
  assert.equal(a.reviveBy, null);
  ticks(m, 20, { 1: { hold: true } });
  assert.equal(a.reviveProgress, 0);
  assert.equal(a.st, 1);
});

test('倒地禁行动：射击/换弹/画线/擦除/折纸/共持/撤离全部拒绝', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  place(m.players[1], 8, 8);
  a.ammo = 10;

  const shot = applyShot(m, 0, { x: a.pos.x, y: a.pos.y, z: a.pos.z }, { x: 0, y: 0, z: 1 });
  assert.equal(shot.ok, false);
  assert.equal(shot.reason, 'dead');
  assert.equal(a.ammo, 10);
  assert.equal(startReload(a), false);
  assert.equal(a.reload, 0);
  assert.equal(applyDraw(m, 0, { x: 0, z: -6 }, { x: 0, z: -9 }).reason, 'dead');
  assert.equal(applyErase(m, 0).reason, 'dead');
  assert.equal(applyFold(m, 0, 0).reason, 'dead');

  place(a, ANCHORS[0].x, ANCHORS[0].z);
  ticks(m, 20, { 0: { hold: true } });
  assert.equal(m.anchors[0].progress, 0);
  assert.equal(m.anchors[0].active, false);

  m.exitUnlocked = true;
  place(a, EXIT.x, EXIT.z);
  ticks(m, 20, { 0: { hold: true } });
  assert.equal(m.exitProgress, 0);
  assert.equal(m.phase, 'anchors');
});

test('倒地爬行 0.6m/s：冲刺/跳跃失效，速度收敛到爬行值', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  place(m.players[1], 8, 8);
  const z0 = a.pos.z;
  ticks(m, 40, { 0: { f: 1, sprint: true, jump: true } });
  assert.ok(Math.abs(Math.hypot(a.velX, a.velZ) - CONFIG.player.crawlSpeed) < 0.02,
    'speed=' + Math.hypot(a.velX, a.velZ));
  assert.ok(Math.abs(a.pos.z - z0) < 2.5, 'z=' + a.pos.z);
  assert.equal(a.pos.y, CONFIG.player.eyeHeight);
  assert.equal(a.grounded, true);
});

test('单人真实倒地：不立即判负，20s 倒计时结束转 st=2 后失败', () => {
  const m = createMatch({ seed: 5 });
  const p = m.players[0];
  p.hp = CONFIG.player.maxHp;
  damagePlayer(m, p, CONFIG.player.maxHp);
  ticks(m, 1);
  assert.equal(m.phase, 'anchors');
  assert.ok(p.downT > 19.9 && p.downT <= 20, 'downT=' + p.downT);
  ticks(m, 398);
  assert.equal(p.st, 1);
  assert.equal(m.phase, 'anchors');
  ticks(m, 1);
  assert.equal(p.st, 2);
  assert.equal(m.phase, 'lost');
  assert.ok(m.events.some(e => e.type === 'lose' && e.data.reason === 'down'));
});

test('快照含倒地倒计时（dt）：倒地后 20s 起算并递减', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  ticks(m, 1);
  const s = snapshot(m).players[0];
  assert.equal(s.st, 1);
  assert.ok(s.dt > 19.9 && s.dt <= 20, 'dt=' + s.dt);
  ticks(m, 19);
  const s2 = snapshot(m).players[0];
  assert.ok(s2.dt > 18.9 && s2.dt < 20, 'dt=' + s2.dt);
  assert.ok(Math.abs(a.downT - s2.dt) < 0.005);
});

test('确定性：倒地/爬行/救援/无敌同种子 120 步双跑快照逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 4242, playerIds: [0, 1] });
    const a = m.players[0];
    a.hp = CONFIG.player.maxHp;
    damagePlayer(m, a, CONFIG.player.maxHp);
    place(a, 0, -4);
    place(m.players[1], 1, -4);
    for (let i = 0; i < 120; i++) {
      stepMatch(m, {
        0: { f: i % 20 < 10 ? 1 : 0, r: 0.2, seq: i },
        1: { hold: i < 60, f: i >= 60 ? 1 : 0, seq: i },
      });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});

test('二次倒地：救起后再次倒地重新获得 20s 倒计时', () => {
  const m = twoPlayer();
  const a = down(m, 0, 0, -4);
  place(m.players[1], 1, -4);
  ticks(m, 40, { 1: { hold: true } });
  assert.equal(a.st, 0);
  assert.equal(a.downT, 0);
  a.hp = CONFIG.player.maxHp;
  damagePlayer(m, a, CONFIG.player.maxHp);
  ticks(m, 1);
  assert.equal(a.st, 1);
  assert.ok(a.downT > 19.9 && a.downT <= 20, 'downT=' + a.downT);
});

test('单人墨力自救：首次倒地按住 F 2s 可自救起身（50血/1s无敌），自救用尽后二次倒地立即战败结算', () => {
  const m = createMatch({ seed: 11 });
  const p = m.players[0];
  p.hp = CONFIG.player.maxHp;
  damagePlayer(m, p, CONFIG.player.maxHp);
  ticks(m, 39, { 0: { hold: true } });
  assert.equal(p.st, 1);
  assert.ok(p.reviveProgress > 0.9 && p.reviveProgress < 1);
  ticks(m, 1, { 0: { hold: true } });
  assert.equal(p.st, 0);
  assert.equal(p.hp, D.reviveHp);
  assert.equal(p.ink, D.reviveInk);
  assert.equal(p.invuln, D.reviveInvuln);
  assert.equal(p.stats.rescues, 1);
  assert.ok(m.events.some(e => e.type === 'revive' && e.data.id === 0 && e.data.by === 0));

  // 消耗完 1s 无敌帧后再次倒地 → 不再等待 20s，当 tick 立即转 st=2 并触发 lost(down)
  ticks(m, 21);
  assert.equal(p.invuln, 0);
  m.events.length = 0;
  damagePlayer(m, p, p.hp);
  ticks(m, 1, { 0: { hold: true } });
  assert.equal(p.st, 2);
  assert.equal(p.downT, 0);
  assert.equal(m.phase, 'lost');
  assert.ok(m.events.some(e => e.type === 'lose' && e.data.reason === 'down'));
});
