// 战斗结算：射击解析射线 / 墨弹推进 / 墙与玩家伤害。
// 命中面与原型 solidMeshes 一致：掩体+围墙+平台+玩家墙+折纸墙（平台仅豁免玩家碰撞）。
import CONFIG from './config.mjs';
import { rayVsAABB, rayVsOBB, rayVsCylinder, aabbOf } from './math.mjs';
import { applyFire } from './sim.mjs';
import { damageBoss } from './boss.mjs';

// 圆柱 hitbox 等价原型模型轮廓：规格约束半径，高度取原型几何。
// 橡皮擦虫高度 .87 / 纸飞机厚度 ±.15 由 D5 模型包围盒核定；飞机 hitbox 随 e.y 动态（dy）。
export const HITBOX = {
  crane: { r: CONFIG.enemy.radius, y0: 0, y1: 1.49 },
  eraser: { r: CONFIG.enemy.eraser.radius, y0: 0, y1: 0.87 },
  plane: { r: 0.55, y0: -0.15, y1: 0.15, dy: true },
};

export function wallOBB(w, height) {
  return {
    cx: w.x, cz: w.z,
    hx: w.len / 2, hz: w.halfThickness,
    rot: Math.atan2(-w.uz, w.ux),
    y0: 0, y1: height,
  };
}

function norm(d) {
  const l = Math.hypot(d.x, d.y, d.z) || 1;
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

// 视线阻挡：返回最近阻挡 {kind:'wall'|'fold'|'static', wall?, point, t} 或 null
export function losBlocker(match, from, to) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 0.001) return null;
  const dir = norm(d);
  let best = null;
  const consider = (t, kind, wall) => {
    if (t === null || t <= 0.02 || t >= len - 0.02) return;
    if (best === null || t < best.t) {
      best = { kind, wall, t, point: { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t } };
    }
  };
  for (const b of match.statics) {
    const { min, max } = aabbOf(b);
    consider(rayVsAABB(from, dir, min, max), 'static');
  }
  for (const w of match.walls) {
    if (w.dead) continue;
    consider(rayVsOBB(from, dir, wallOBB(w, CONFIG.wall.height)), 'wall', w);
  }
  for (const w of match.foldWalls) {
    consider(rayVsOBB(from, dir, wallOBB(w, CONFIG.folds.wallHeight)), 'fold');
  }
  return best;
}

// favor-the-shooter：客机报射线，房主校验后权威结算（不信任客机命中结果）
export function applyShot(match, shooterId, origin, dir) {
  const p = match.players.find(pl => pl.id === shooterId);
  if (!p || p.st !== 0) return { ok: false, reason: 'dead' };
  const gate = applyFire(p);
  if (gate !== 'fired') return { ok: false, reason: gate };
  const d = norm(dir);
  const range = CONFIG.player.gun.range;
  let best = { t: range, kind: 'none', point: { x: origin.x + d.x * range, y: origin.y + d.y * range, z: origin.z + d.z * range } };
  const consider = (t, kind, ref) => {
    if (t !== null && t > 0.05 && t < best.t) {
      best = { t, kind, ref, point: { x: origin.x + d.x * t, y: origin.y + d.y * t, z: origin.z + d.z * t } };
    }
  };
  for (const b of match.statics) {
    const { min, max } = aabbOf(b);
    consider(rayVsAABB(origin, d, min, max), 'static');
  }
  for (const w of match.walls) {
    if (w.dead) continue;
    consider(rayVsOBB(origin, d, wallOBB(w, CONFIG.wall.height)), 'wall', w);
  }
  for (const w of match.foldWalls) {
    consider(rayVsOBB(origin, d, wallOBB(w, CONFIG.folds.wallHeight)), 'fold');
  }
  for (const e of match.enemies) {
    if (e.dead) continue;
    const hb = HITBOX[e.type];
    if (!hb) continue;
    const y0 = hb.dy ? e.y + hb.y0 : hb.y0;
    const y1 = hb.dy ? e.y + hb.y1 : hb.y1;
    consider(rayVsCylinder(origin, d, { x: e.x, z: e.z, r: hb.r, y0, y1 }), 'enemy', e);
  }
  if (match.boss && !match.boss.dead) {
    const b = match.boss;
    consider(rayVsCylinder(origin, d, { x: b.x, z: b.z, r: CONFIG.boss.radius, y0: 0, y1: 2.2 }), 'boss', b);
  }

  if (best.kind === 'enemy') {
    const e = best.ref;
    if (e.armor > 0) {
      e.armor = Math.max(0, e.armor - CONFIG.player.gun.armorDamage);
      if (e.armor === 0) match.events.push({ type: 'armorStrip', data: { id: e.id } });
    } else {
      e.hp -= CONFIG.player.gun.damage;
    }
    match.events.push({ type: 'hit', data: { id: e.id, point: best.point, armored: e.armor > 0 } });
    if (e.hp <= 0) {
      e.dead = true;
      match.kills++;
      p.stats.kills++;
      match.events.push({ type: 'kill', data: { id: e.id, enemyType: e.type } });
    }
  } else if (best.kind === 'boss') {
    damageBoss(match, CONFIG.player.gun.damage);
    match.events.push({ type: 'hit', data: { id: match.boss.id, point: best.point, boss: true } });
  } else if (best.kind !== 'none') {
    match.events.push({ type: 'impact', data: { point: best.point, kind: best.kind, wallId: best.ref ? best.ref.id : null } });
  }
  match.events.push({ type: 'shot', data: { id: shooterId, end: best.point, kind: best.kind } });
  return { ok: true, kind: best.kind, end: best.point };
}

export function fireProjectile(match, from, to, speed, damage) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const dist = Math.hypot(d.x, d.y, d.z);
  if (dist < 0.4) return null;
  const pr = {
    id: match.nextId++,
    x: from.x, y: from.y, z: from.z,
    vx: d.x / dist * speed, vy: d.y / dist * speed, vz: d.z / dist * speed,
    life: CONFIG.enemy.projectileLife,
    damage,
  };
  match.projectiles.push(pr);
  return pr;
}

export function capsulePoint2D(px, pz, w) {
  const dx = px - w.x, dz = pz - w.z;
  const along = dx * w.ux + dz * w.uz;
  const side = dx * w.nx + dz * w.nz;
  return Math.abs(along) <= w.len / 2 && Math.abs(side) <= w.halfThickness + CONFIG.enemy.projectileRadius;
}

export function damageWall(match, w, dmg) {
  if (w.dead) return;
  w.hp -= dmg;
  if (w.hp <= 0) {
    w.dead = true;
    match.events.push({ type: 'wallBreak', data: { id: w.id } });
  }
}

export function damagePlayer(match, p, dmg) {
  if (p.st !== 0) return;
  p.hp = Math.max(0, p.hp - dmg);
  match.events.push({ type: 'playerHit', data: { id: p.id, dmg, hp: p.hp } });
  if (p.hp === 0) {
    p.st = 1;
    match.events.push({ type: 'downed', data: { id: p.id } });
  }
}

export function stepProjectiles(match, dt) {
  for (let i = match.projectiles.length - 1; i >= 0; i--) {
    const p = match.projectiles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    let hit = false;
    if (p.y < CONFIG.wall.height) {
      for (const w of match.walls) {
        if (w.dead) continue;
        if (capsulePoint2D(p.x, p.z, w)) {
          damageWall(match, w, CONFIG.enemy.wallDamage);
          match.events.push({ type: 'impact', data: { point: { x: p.x, y: p.y, z: p.z }, kind: 'wall', wallId: w.id } });
          hit = true;
          break;
        }
      }
    }
    if (!hit && p.y < CONFIG.folds.wallHeight) {
      for (const w of match.foldWalls) {
        if (capsulePoint2D(p.x, p.z, w)) {
          match.events.push({ type: 'impact', data: { point: { x: p.x, y: p.y, z: p.z }, kind: 'fold' } });
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      for (const b of match.statics) {
        if (p.y < b.y1 && Math.abs(p.x - b.x) < b.hx && Math.abs(p.z - b.z) < b.hz) {
          match.events.push({ type: 'impact', data: { point: { x: p.x, y: p.y, z: p.z }, kind: 'static' } });
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      for (const pl of match.players) {
        if (pl.st !== 0) continue;
        const dx = p.x - pl.pos.x, dz = p.z - pl.pos.z;
        if (Math.abs(p.y - (pl.pos.y - 0.35)) < 0.55 && dx * dx + dz * dz < 0.45 * 0.45) {
          damagePlayer(match, pl, p.damage);
          hit = true;
          break;
        }
      }
    }
    if (!hit && (p.life <= 0 || p.y < 0.02 || p.y > 6 || Math.abs(p.x) > 17.4 || Math.abs(p.z) > 17.4)) hit = true;
    if (hit) match.projectiles.splice(i, 1);
  }
}