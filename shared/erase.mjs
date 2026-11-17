// 能力 B 擦除脉冲（规格 §3.6）：E / 35 墨 / 3.5s CD / 6m 半径。
// 剥甲 + 眩晕 1s + 打断蓄力；无直接生命伤害。自原型 erase() 移植（渲染/音效剥离）。
import CONFIG from './config.mjs';
import { useInk } from './sim.mjs';

export function applyErase(match, playerId) {
  const p = match.players.find(pl => pl.id === playerId);
  if (!p || p.st !== 0) return { ok: false, reason: 'dead' };
  if (p.eraseCd > 0) return { ok: false, reason: 'cooldown', cd: p.eraseCd };
  if (p.ink < CONFIG.ink.eraseCost) return { ok: false, reason: 'ink', need: CONFIG.ink.eraseCost };
  useInk(p, CONFIG.ink.eraseCost, match.elapsed);
  p.eraseCd = CONFIG.ink.eraseCooldown;
  p.stats.erases++;
  let stripped = 0;
  const hit = [];
  for (const e of match.enemies) {
    if (e.dead) continue;
    if (Math.hypot(e.x - p.pos.x, e.z - p.pos.z) > CONFIG.ink.eraseRadius) continue;
    if (e.armor > 0) { e.armor = 0; stripped++; }
    e.stun = CONFIG.ink.eraseStun;
    // 内核在眩晕期间也递减 slow：计时含眩晕段，保证眩晕结束后足额 2.5s 减速（规格"此后"）
    e.slow = CONFIG.ink.eraseStun + CONFIG.ink.eraseSlow;
    e.telegraph = 0;
    hit.push(e.id);
  }
  match.events.push({ type: 'erase', data: { owner: p.id, x: p.pos.x, z: p.pos.z, stripped, hit } });
  return { ok: true, stripped, hit };
}