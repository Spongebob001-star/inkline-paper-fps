// 战局状态机：锚点共持/衰减 → 三锚点触发 Boss（+120s）→ 出口锁定至 Boss 死 → 撤离 2s → 胜负。
// 规格 §3.6/§3.11/§3.12：单人 2.2s、共持 1.1s、松开 3 倍速回退；失败=超时或全队倒地。
import CONFIG from './config.mjs';
import { EXIT } from './world.mjs';
import { createEnemy } from './enemies.mjs';
import { createBoss } from './boss.mjs';

// 增援生成点自原型 spawnReinforcements 移植：锚点偏移 + 离玩家太近推远到 5m + 远点优先。
export function spawnReinforcements(match, anchor) {
  if (match.boss) return;
  const table = match.anchorsDone === 1 ? CONFIG.waves.afterA1 : CONFIG.waves.afterA2;
  const cap = CONFIG.scaling[match.players.length].cap;
  const offsets = [[3, 2], [-2.5, -3], [3, -2], [-3, 2.5]];
  const spots = offsets.map(([ox, oz]) => {
    let x = Math.max(-15, Math.min(15, anchor.x + ox));
    let z = Math.max(-15, Math.min(15, anchor.z + oz));
    let nearest = null, d = Infinity;
    for (const p of match.players) {
      if (p.st !== 0) continue;
      const dd = Math.hypot(x - p.pos.x, z - p.pos.z);
      if (dd < d) { d = dd; nearest = p; }
    }
    if (nearest && d < CONFIG.scaling.spawn.minDist) {
      let dx = x - nearest.pos.x, dz = z - nearest.pos.z;
      if (d < 0.001) { dx = 1; dz = 0; d = 1; }
      const k = 5 / d;
      x = Math.max(-15, Math.min(15, nearest.pos.x + dx * k));
      z = Math.max(-15, Math.min(15, nearest.pos.z + dz * k));
      d = Math.hypot(x - nearest.pos.x, z - nearest.pos.z);
    }
    return { x, z, d };
  }).sort((a, b) => b.d - a.d);
  for (let i = 0; i < table.length; i++) {
    if (match.enemies.filter(e => !e.dead).length >= cap) break;
    const s = spots[i % spots.length];
    const e = createEnemy(match, table[i], s.x, s.z, { spawnAnim: true });
    e.attackCd = CONFIG.scaling.spawn.attackBuffer;
  }
}

function holdersAt(match, inputs, x, z, radius) {
  return match.players.filter(p =>
    p.st === 0 && inputs[p.id] && inputs[p.id].hold &&
    Math.hypot(p.pos.x - x, p.pos.z - z) < radius);
}

export function stepFlow(match, inputs, dt) {
  if (match.phase === 'won' || match.phase === 'lost') return;

  for (const a of match.anchors) {
    if (a.active) continue;
    const holders = holdersAt(match, inputs, a.x, a.z, CONFIG.anchor.radius);
    if (holders.length > 0) {
      const req = holders.length >= 2 ? CONFIG.anchor.groupHoldTime : CONFIG.anchor.holdTime;
      a.progress = Math.min(1, a.progress + dt / req);
      if (a.progress >= 1) {
        a.active = true;
        match.anchorsDone++;
        match.events.push({ type: 'anchorDone', data: { i: a.i, label: a.label } });
        spawnReinforcements(match, a);
        if (match.anchorsDone === match.anchors.length) {
          match.phase = 'boss';
          match.timeLeft += CONFIG.round.bossBonus;
          createBoss(match);
          match.events.push({ type: 'phase', data: { phase: 'boss' } });
        }
      }
    } else {
      a.progress = Math.max(0, a.progress - dt * CONFIG.anchor.decayMul / CONFIG.anchor.holdTime);
    }
  }

  if (match.exitUnlocked) {
    const holders = holdersAt(match, inputs, EXIT.x, EXIT.z, CONFIG.anchor.exitRadius);
    if (holders.length > 0) {
      match.exitProgress = Math.min(1, match.exitProgress + dt / CONFIG.anchor.exitHoldTime);
      if (match.exitProgress >= 1) {
        match.phase = 'won';
        match.events.push({ type: 'win', data: { time: match.elapsed } });
        return;
      }
    } else {
      match.exitProgress = 0;
    }
  }

  if (match.timeLeft <= 0) {
    match.phase = 'lost';
    match.events.push({ type: 'lose', data: { reason: 'time' } });
    return;
  }
  if (match.players.every(p => p.st !== 0)) {
    match.phase = 'lost';
    match.events.push({ type: 'lose', data: { reason: 'down' } });
  }
}