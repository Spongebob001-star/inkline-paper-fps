// 战局状态机：锚点共持/衰减 → 三锚点触发 Boss（+120s）→ 出口锁定至 Boss 死 → 撤离 2s → 胜负。
// 规格 §3.6/§3.11/§3.12：单人 2.2s、共持 1.1s、松开 3 倍速回退；失败=超时或全队倒地。
// 人数缩放（规格 §3.9）：开局 4/6/8/10、每锚点增援 +3/+4/+5/+6、同屏上限 9/12/14/16。
import CONFIG from './config.mjs';
import { EXIT } from './world.mjs';
import { createEnemy } from './enemies.mjs';
import { createBoss } from './boss.mjs';

export function scalingOf(match) {
  const n = Math.min(4, Math.max(1, match.players.length));
  return CONFIG.scaling[n];
}

const clampSpawn = v => Math.max(-15, Math.min(15, v));

function nearestPlayerDist(match, x, z) {
  let min = Infinity;
  for (const p of match.players) {
    const d = Math.hypot(x - p.pos.x, z - p.pos.z);
    if (d < min) min = d;
  }
  return min;
}

// 开局波次（规格 §3.9）：4=3+1 / 6=4+2 / 8=6+2 / 10=7+3，按人数取构成。
// 单人客户端仍自行生成 4 只（n=1 同构）；联机房主应调用本函数。
export function spawnInitialEnemies(match) {
  const n = Math.min(4, Math.max(1, match.players.length));
  const mix = CONFIG.waves.initialMix[n];
  const types = [];
  for (let i = 0; i < mix[0]; i++) types.push('crane');
  for (let i = 0; i < mix[1]; i++) types.push('eraser');
  for (let i = 0; i < types.length; i++) {
    const [x, z] = CONFIG.waves.spots[i % CONFIG.waves.spots.length];
    createEnemy(match, types[i], x, z, { spawnAnim: true });
  }
  return types.length;
}

// 增援候选点：锚点环 + 原型固定点 + 3m 网格；统一按"离最近玩家最远"排序（规格 §3.9）。
// 过近候选沿远离最近玩家方向推到 ≥3.5m，再过滤；全程确定性（不使用随机，若有随机也只走 match.rand）。
function spawnCandidates(match, anchor) {
  const minDist = CONFIG.scaling.spawn.minDist;
  const margin = minDist + 0.5; // 推离目标 + 碰撞回弹余量（createEnemy 会 resolveCircle 最多推 r）
  const pts = [];
  for (const r of [3.5, 5.5]) {
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      pts.push({ x: clampSpawn(anchor.x + Math.sin(ang) * r), z: clampSpawn(anchor.z + Math.cos(ang) * r) });
    }
  }
  for (const [x, z] of CONFIG.waves.spots) pts.push({ x, z });
  for (let x = -15; x <= 15; x += 3) {
    for (let z = -15; z <= 15; z += 3) pts.push({ x, z });
  }
  const seen = new Set();
  const scored = [];
  for (const pt of pts) {
    let { x, z } = pt;
    for (let iter = 0; iter < 6; iter++) {
      let nearest = null, nd = Infinity;
      for (const p of match.players) {
        const d = Math.hypot(x - p.pos.x, z - p.pos.z);
        if (d < nd) { nd = d; nearest = p; }
      }
      if (!nearest || nd >= margin) break;
      let dx = x - nearest.pos.x, dz = z - nearest.pos.z;
      if (nd < 1e-3) {
        dx = -nearest.pos.x || 1;
        dz = -nearest.pos.z || 0;
      }
      const l = Math.hypot(dx, dz) || 1;
      x = clampSpawn(nearest.pos.x + dx / l * margin);
      z = clampSpawn(nearest.pos.z + dz / l * margin);
    }
    const d = nearestPlayerDist(match, x, z);
    if (d < minDist + 0.2) continue;
    const key = x.toFixed(2) + ',' + z.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ x, z, d });
  }
  scored.sort((a, b) => b.d - a.d || a.x - b.x || a.z - b.z);
  return scored;
}

// 每锚点增援：数量按 scaling.reinforce，构成沿用 afterA1/afterA2 循环补齐；受同屏 cap 截断。
// 选点距任意玩家 ≥3.5m，落地动画 0.35s（createEnemy spawnAnim），首攻缓冲 1.5s。
export function spawnReinforcements(match, anchor) {
  if (match.boss) return [];
  const S = scalingOf(match);
  const table = match.anchorsDone === 1 ? CONFIG.waves.afterA1 : CONFIG.waves.afterA2;
  const aliveCount = () => match.enemies.filter(e => !e.dead).length;
  const made = [];
  if (aliveCount() >= S.cap) return made;
  const spots = spawnCandidates(match, anchor);
  for (let i = 0; i < S.reinforce && aliveCount() < S.cap; i++) {
    const s = spots.length ? spots[i % spots.length] : { x: clampSpawn(anchor.x), z: clampSpawn(anchor.z) };
    const e = createEnemy(match, table[i % table.length], s.x, s.z, { spawnAnim: true });
    e.attackCd = CONFIG.scaling.spawn.attackBuffer;
    made.push(e);
  }
  return made;
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
  const anyAlive = match.players.some(p => p.st === 0);
  if (!anyAlive) {
    // 多人全倒/阵亡立即失败（规格 §3.13，st=1/2 均计入）；
    // 单人倒地无人可救：保留 20s 爬行/倒计时，计时归零转 st=2 后失败（T7.1）。
    const soloWaiting = match.players.length === 1 &&
      match.players[0].st === 1 && match.players[0].downT > 0;
    if (!soloWaiting) {
      match.phase = 'lost';
      match.events.push({ type: 'lose', data: { reason: 'down' } });
    }
  }
}