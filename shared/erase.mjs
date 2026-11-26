// 能力 B 擦除脉冲（规格 §3.6）：E / 35 墨 / 3.5s CD / 6m 半径。
// 剥甲 + 眩晕 1s + 打断蓄力；无直接生命伤害。自原型 erase() 移植（渲染/音效剥离）。
import CONFIG from './config.mjs';
import { useInk } from './sim.mjs';
import { perkMods } from './perks.mjs';

export function applyErase(match, playerId) {
  const p = match.players.find(pl => pl.id === playerId);
  if (!p || p.st !== 0) return { ok: false, reason: 'dead' };
  if (p.eraseCd > 0) return { ok: false, reason: 'cooldown', cd: p.eraseCd };
  if (p.ink < CONFIG.ink.eraseCost) return { ok: false, reason: 'ink', need: CONFIG.ink.eraseCost };
  const mods = perkMods(p);
  const radius = CONFIG.ink.eraseRadius + mods.eraseRadiusAdd;
  useInk(p, CONFIG.ink.eraseCost, match.elapsed);
  p.eraseCd = CONFIG.ink.eraseCooldown * mods.eraseCdMul;
  p.stats.erases++;
  let stripped = 0;
  const hit = [];
  for (const e of match.enemies) {
    if (e.dead) continue;
    if (Math.hypot(e.x - p.pos.x, e.z - p.pos.z) > radius) continue;
    if (e.armor > 0) { e.armor = 0; stripped++; }
    e.stun = CONFIG.ink.eraseStun;
    // 内核在眩晕期间也递减 slow：计时含眩晕段，保证眩晕结束后足额 2.5s 减速（规格"此后"）
    e.slow = CONFIG.ink.eraseStun + CONFIG.ink.eraseSlow;
    e.telegraph = 0;
    hit.push(e.id);
  }
  const result = { ok: true, stripped, hit };
  const b = match.boss;
  if (b && !b.dead && Math.hypot(b.x - p.pos.x, b.z - p.pos.z) <= radius) {
    const interruptible = b.state === 'fan' || b.state === 'summon' || b.state === 'charge' ||
      b.state === 'mortar' || b.state === 'slam' || b.laughExposeT > 0 || b.waveLeft > 0;
    if (interruptible) {
      b.state = 'idle';
      b.telegraph = 0;
      b.attackCd = 2.0;
      b.laughExposeT = 0;
      b.waveLeft = 0;
      b.waveT = 0;
      b.fanPending = 0;
      b.stunT = CONFIG.boss.eraseStunTime;
      match.events.push({ type: 'bossInterrupt', data: { by: p.id, reason: 'erase', duration: b.stunT } });
      result.bossInterrupted = true;
    } else {
      b.slowT = CONFIG.boss.eraseSlowTime;
      result.bossSlowed = true;
    }
  }
  match.events.push({ type: 'erase', data: { owner: p.id, x: p.pos.x, z: p.pos.z, stripped, hit } });
  return result;
}