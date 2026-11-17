// 拾取物（规格 §3.10）：全局共享先到先得；1m 接触；墨水瓶 +40 墨 / 胶带 +30 生命，封顶；每局刷新。
// 位置来自 CONFIG.pickups（与 world.pickupList 同源）。
import CONFIG from './config.mjs';

export function stepPickups(match) {
  for (const pk of match.pickups) {
    if (pk.taken) continue;
    for (const p of match.players) {
      if (p.st !== 0) continue;
      if (Math.hypot(p.pos.x - pk.x, p.pos.z - pk.z) >= CONFIG.pickups.radius) continue;
      pk.taken = true;
      if (pk.ty === 'ink') p.ink = Math.min(CONFIG.ink.max, p.ink + CONFIG.pickups.inkAmount);
      else p.hp = Math.min(CONFIG.player.maxHp, p.hp + CONFIG.pickups.tapeAmount);
      match.events.push({ type: 'pickup', data: { id: pk.id, ty: pk.ty, playerId: p.id, x: pk.x, z: pk.z } });
      break;
    }
  }
}