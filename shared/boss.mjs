// Boss 状态与伤害（规格 §3.13）；三招状态机 D6 接入 stepBoss。
import CONFIG from './config.mjs';

export function createBoss(match) {
  const n = Math.min(4, Math.max(1, match.players.length));
  const hp = CONFIG.scaling[n].bossHp;
  match.boss = {
    id: match.nextId++,
    x: 0, z: 5.5, y: 0,
    hp, maxHp: hp,
    raged: false,
    attackCd: 2.5, nextAttack: 0, state: 'idle', telegraph: 0,
    dirX: 0, dirZ: 0, chargeT: 0, hitDone: false,
    dead: false,
  };
  match.events.push({ type: 'bossSpawn', data: { hp } });
  return match.boss;
}

export function damageBoss(match, n) {
  const b = match.boss;
  if (!b || b.dead) return 0;
  const dealt = b.raged ? n : Math.ceil(n * CONFIG.boss.shieldMul);
  b.hp = Math.max(0, b.hp - dealt);
  if (!b.raged && b.hp <= b.maxHp * CONFIG.boss.rage.at) {
    b.raged = true;
    match.events.push({ type: 'rage', data: {} });
  }
  if (b.hp === 0) {
    b.dead = true;
    match.exitUnlocked = true;
    match.events.push({ type: 'bossDown', data: {} });
  }
  return dealt;
}