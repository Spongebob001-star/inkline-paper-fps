// 无头整局回归：node tests/sim-match.mjs [--players N] [--seed S]
// 机器人走完整闭环：移动→射击→锚点（共持）→Boss→撤离→won；另跑超时/倒地败局与重开快照 diff。
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, snapshot, stepMatch } from '../shared/sim.mjs';
import { createRuntime } from '../host/runtime.mjs';
import { spawnInitialEnemies } from '../shared/flow.mjs';
import { losBlocker, HITBOX } from '../shared/combat.mjs';
import { ANCHORS, EXIT, groundHeightAt } from '../shared/world.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const players = arg('--players', 1);
const seed = arg('--seed', 11);

const dist = (p, t) => Math.hypot(p.pos.x - t.x, p.pos.z - t.z);
function steer(it, p, t) {
  const dx = t.x - p.pos.x, dz = t.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = 0;
  it.f = 1;
  it.sprint = Math.hypot(dx, dz) > 6;
}
function aimAt(p, t) {
  const dx = t.x - p.pos.x, dy = t.y - p.pos.y, dz = t.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}
function aimDir(p) {
  const cp = Math.cos(p.pitch);
  return { x: -Math.sin(p.yaw) * cp, y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * cp };
}
const center = e => ({ x: e.x, y: e.type === 'plane' ? e.y : 0.75, z: e.z });

function botTick(rt, p, bs, rescueDown = null) {
  const m = rt.match;
  const it = { f: 0, r: 0, sprint: false, jump: false, hold: false };
  const moved = Math.hypot(p.pos.x - bs.lx, p.pos.z - bs.lz);
  bs.lx = p.pos.x; bs.lz = p.pos.z;
  let enemy = null, ed = 18;
  for (const e of m.enemies) {
    if (e.dead || !HITBOX[e.type]) continue; // 无 hitbox 的敌型（plane D5）不参与索敌
    const d = dist(p, e);
    if (d < ed) { ed = d; enemy = e; }
  }
  const eye = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  const clear = t => !losBlocker(m, eye, t);
  // 只有看得见的敌人才是威胁：掩体后的敌人同样打不到玩家，不应阻塞占点
  const threat = enemy && ed < 13 && clear(center(enemy));
  let aim = null;
  const fight = () => { if (enemy && clear(center(enemy))) aim = center(enemy); };
  // D7 救援优先：最近存活者前往倒地队友 1.5m 内按住 F（2s）；其余人继续目标
  if (rescueDown) {
    const rd = dist(p, rescueDown);
    if (rd <= CONFIG.player.down.reviveRange - 0.2) {
      it.hold = true;
      aimAt(p, { x: rescueDown.pos.x, y: rescueDown.pos.y, z: rescueDown.pos.z });
    } else {
      steer(it, p, rescueDown);
    }
  } else if (m.exitUnlocked) {
    if (dist(p, EXIT) < 1.8 && !threat) it.hold = true;
    else if (threat) fight();
    else steer(it, p, EXIT);
    if (!it.hold && !aim) fight();
  } else if (m.phase === 'boss' && m.boss && !m.boss.dead) {
    if (threat) fight();
    else {
      const bt = { x: m.boss.x, y: 1.1, z: m.boss.z };
      if (clear(bt)) aim = bt;
      else steer(it, p, m.boss); // 视线被挡就贴近，而非原地发呆
      if (!aim && dist(p, m.boss) > 9) steer(it, p, m.boss);
    }
  } else {
    const a = m.anchors.find(x => !x.active);
    if (a) {
      if (dist(p, a) < 1.5 && !threat) it.hold = true;
      else if (threat) fight();
      else steer(it, p, a);
      if (!it.hold && !aim) fight();
    }
  }
  // 贴脸剥甲：6m 内有甲敌人且冷却/墨量允许时先擦除再集火（规格逼迫擦除破甲）
  if (enemy && enemy.armor > 0 && ed <= CONFIG.ink.eraseRadius && p.eraseCd <= 0 && p.ink >= CONFIG.ink.eraseCost) {
    rt.action(p.id, { m: 'erase' });
  }
  // 换弹期撤离：背向看得见的敌人冲刺，躲墨弹（掩体后的敌人打不到，无需躲）
  if (!rescueDown && p.reload > 0 && enemy && clear(center(enemy))) {
    aim = null;
    const dx = p.pos.x - enemy.x, dz = p.pos.z - enemy.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = 0;
    it.f = 1; it.sprint = true; it.hold = false;
  }
  // 卡墙脱困：先倒退拉开台阶角，再侧移错开原直线，否则恢复直行会原路撞回
  if (bs.avoid > 0) {
    if (bs.avoid > 12) { it.f = -1; it.r = 0; } else { it.f = 0; it.r = bs.side; }
    it.sprint = true; it.hold = false; aim = null;
    bs.avoid--;
  } else if (it.f !== 0 && moved < 0.004) {
    if (++bs.stuck >= 5) { bs.avoid = 20; bs.side *= -1; bs.stuck = 0; }
  } else bs.stuck = 0;
  // 步高前瞻：前方 1.2m 地面高出步高（平台侧壁）时沿较低侧横移绕开，避免直撞回退死循环
  if (it.f > 0 && !it.hold) {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const foot = p.pos.y - CONFIG.player.eyeHeight;
    if (groundHeightAt(p.pos.x + fx * 1.2, p.pos.z + fz * 1.2, m.folds) - foot > CONFIG.folds.stepLimit) {
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      const hR = groundHeightAt(p.pos.x + rx * 1.2, p.pos.z + rz * 1.2, m.folds);
      const hL = groundHeightAt(p.pos.x - rx * 1.2, p.pos.z - rz * 1.2, m.folds);
      it.r = hR <= hL ? 1 : -1;
      it.f = 0.5;
    }
  }
  if (aim) {
    aimAt(p, aim);
    const d = aimDir(p);
    rt.action(p.id, { m: 'shot', ox: p.pos.x, oy: p.pos.y, oz: p.pos.z, dx: d.x, dy: d.y, dz: d.z });
  }
  rt.setInput(p.id, it);
}

function runMatch(n, s) {
  const ids = Array.from({ length: n }, (_, i) => i);
  const rt = createRuntime({ seed: s, playerIds: ids });
  const m = rt.match;
  const initial = JSON.stringify(snapshot(m));
  spawnInitialEnemies(m); // 规格 §3.9：开局 4/6/8/10 + 构成 3+1 / 4+2 / 6+2 / 7+3
  const log = [];
  const bs = new Map(ids.map(id => [id, { stuck: 0, avoid: 0, side: 1, lx: 0, lz: 0 }]));
  let lastPhase = m.phase;
  while (m.phase !== 'won' && m.phase !== 'lost' && m.tick < 20000) {
    // 倒地队友：最近的存活机器人去救（按住 F 2s），其余继续推进目标
    const downed = m.players.find(q => q.st === 1);
    let rescueId = null;
    if (downed) {
      let best = null, bd = Infinity;
      for (const q of m.players) {
        if (q.st !== 0) continue;
        const d = dist(q, downed);
        if (d < bd) { bd = d; best = q; }
      }
      rescueId = best ? best.id : null;
    }
    for (const p of m.players) {
      if (p.st === 0) botTick(rt, p, bs.get(p.id), rescueId === p.id ? downed : null);
    }
    rt.tickOnce();
    if (m.phase !== lastPhase) { log.push([m.tick, m.phase]); lastPhase = m.phase; }
  }
  return { rt, m, initial, log };
}

// 主闭环
const { rt, m, initial, log } = runMatch(players, seed);
const diag = `anchors=${m.anchorsDone}/${m.anchors.map(a => a.active ? 1 : 0).join('')} boss=${m.boss ? m.boss.hp + (m.boss.dead ? '(dead)' : '') : 'null'} exit=${m.exitUnlocked}:${m.exitProgress.toFixed(2)} pos=${m.players.map(p => `${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`).join('|')} enemies=${m.enemies.filter(e => !e.dead).map(e => `${e.type}@${e.x.toFixed(1)},${e.z.toFixed(1)}`).join('|')} phaseLog=${JSON.stringify(log)}`;
assert.equal(m.phase, 'won', `players=${players} seed=${seed} phase=${m.phase} tick=${m.tick} hp=${m.players.map(p => p.hp)}\n${diag}`);
assert.equal(m.anchorsDone, 3);
assert.ok(m.boss && m.boss.dead);
assert.ok(m.exitUnlocked);
const stats = m.players.map(p => ({ id: p.id, ...p.stats, hp: p.hp }));
console.log(JSON.stringify({ players, seed, result: 'won', elapsed: +m.elapsed.toFixed(2), kills: m.kills, phaseLog: log, stats }, null, 1));

// 确定性：同种子双跑逐位一致
const again = runMatch(players, seed);
assert.equal(again.m.tick, m.tick);
assert.equal(again.m.kills, m.kills);
assert.equal(JSON.stringify(snapshot(again.m)), JSON.stringify(snapshot(m)));

// 重开全清：新 match 快照与首帧快照逐位相等
const fresh = createMatch({ seed, playerIds: Array.from({ length: players }, (_, i) => i) });
assert.equal(JSON.stringify(snapshot(fresh)), initial);

// 败局：超时
const t = createMatch({ seed, playerIds: [0] });
t.timeLeft = 0.04;
stepMatch(t, {});
assert.equal(t.phase, 'lost');
// 败局：单人倒地
const d = createMatch({ seed, playerIds: [0] });
d.players[0].st = 1; d.players[0].hp = 0;
stepMatch(d, {});
assert.equal(d.phase, 'lost');

console.log('sim-match OK: won + determinism + reset-diff + lose(time) + lose(down)');