// 能力 C 折纸地形（规格 §3.7）：3 处折角全局共享两态 ramp ⟷ wall。
// 2.2m 内按 C 触发；0.4s 翻折动画期间不可重复触发；任何玩家可切换（房主校验距离）。
// 碰撞/地面采样即时随 state 生效（与原型一致），视觉铰链角度由 animT 平滑插值。
import CONFIG from './config.mjs';

export function foldAngle(f) {
  const target = f.state === 'ramp' ? CONFIG.folds.rampAngle : 0;
  const t = f.animT * f.animT * (3 - 2 * f.animT);
  return f.fromAngle + (target - f.fromAngle) * t;
}

export function nearestFold(match, p) {
  let best = null, bd = Infinity;
  for (const f of match.folds) {
    const d = Math.hypot(p.pos.x - f.x, p.pos.z - f.z);
    if (d < bd) { bd = d; best = f; }
  }
  return best ? { fold: best, dist: bd } : null;
}

export function applyFold(match, playerId, foldId) {
  const p = match.players.find(pl => pl.id === playerId);
  if (!p || p.st !== 0) return { ok: false, reason: 'dead' };
  const f = match.folds.find(f => f.id === foldId);
  if (!f) return { ok: false, reason: 'noFold' };
  const dist = Math.hypot(p.pos.x - f.x, p.pos.z - f.z);
  if (dist > CONFIG.folds.interactRadius) return { ok: false, reason: 'far', dist };
  if (f.animT < 1) return { ok: false, reason: 'anim' };
  f.fromAngle = foldAngle(f);
  f.state = f.state === 'ramp' ? 'wall' : 'ramp';
  f.animT = 0;
  match.events.push({ type: 'fold', data: { id: f.id, state: f.state, owner: p.id, x: f.x, z: f.z } });
  return { ok: true, state: f.state };
}

export function stepFolds(match, dt) {
  for (const f of match.folds) {
    if (f.animT >= 1) continue;
    f.animT = Math.min(1, f.animT + dt / CONFIG.folds.toggleTime);
  }
}