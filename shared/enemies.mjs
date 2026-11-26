// 敌人 AI（房主权威）。涂改灵/S 橡皮擦虫/纸飞机。随机一律走 match.rand（种子化）。
import CONFIG from './config.mjs';
import { moveCircle } from './math.mjs';
import { PLAY_CLAMP } from './world.mjs';
import { losBlocker, fireProjectile, damageWall, damagePlayer } from './combat.mjs';

export function createEnemy(match, type, x, z, opts = {}) {
  const rand = match.rand;
  const spec = type === 'eraser' ? CONFIG.enemy.eraser : type === 'plane' ? CONFIG.enemy.plane : null;
  // 人数缩放（规格 §3.9）：敌人生命 ×1.0/1.55/2.1/2.6，生成时应用；护甲不变。
  const n = Math.min(4, Math.max(1, match.players.length));
  const hpMul = CONFIG.scaling[n].hpMul;
  const e = {
    id: match.nextId++,
    type,
    x, z,
    y: type === 'plane' ? CONFIG.enemy.plane.height : 0,
    hp: Math.round((spec ? spec.hp : CONFIG.enemy.hp) * hpMul),
    armor: type === 'crane' ? CONFIG.enemy.armor : 0,
    attackCd: opts.attackCd ?? 0.7 + rand(),
    telegraph: 0, stun: 0, slow: 0,
    strafe: rand() < 0.5 ? -1 : 1,
    phase: rand() * Math.PI * 2,
    circleCd: 1 + rand(),
    diveDirX: 0, diveDirZ: 0, diveT: 0,
    stuckTimer: 0,
    losTimer: rand() * CONFIG.enemy.losInterval,
    blocked: null,
    spawnT: opts.spawnAnim ? 0 : 1,
    state: type === 'plane' ? 'circle' : '',
    dead: false,
  };
  match.enemies.push(e);
  if (type !== 'plane') {
    moveCircle(e, 0, 0, spec ? spec.radius : CONFIG.enemy.radius, ctxOf(match, false));
  }
  return e;
}

function ctxOf(match, isPlayer) {
  return {
    isPlayer,
    staticColliders: match.statics,
    walls: match.walls,
    foldWalls: match.foldWalls,
    clamp: PLAY_CLAMP,
  };
}

function nearestPlayer(match, e) {
  let best = null, bd = Infinity;
  for (const p of match.players) {
    if (p.st !== 0) continue;
    const d = Math.hypot(p.pos.x - e.x, p.pos.z - e.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function stepCrane(match, e, dt) {
  const E = CONFIG.enemy;
  const player = nearestPlayer(match, e);
  if (!player) return;
  const dx = player.pos.x - e.x, dz = player.pos.z - e.z;
  const dist = Math.max(0.001, Math.hypot(dx, dz));

  const origin = { x: e.x, y: 0.86, z: e.z };
  const target = { x: player.pos.x, y: Math.min(player.pos.y, 1.8), z: player.pos.z };
  e.losTimer -= dt;
  if (e.losTimer <= 0) {
    e.losTimer = E.losInterval;
    e.blocked = losBlocker(match, origin, target);
  }

  const canAct = e.spawnT >= 1;
  const blocker = e.blocked;
  let mx = 0, mz = 0, attackPlayer = false, attackWall = null;
  if (blocker && blocker.kind === 'wall' && !blocker.wall.dead) {
    const bd = Math.hypot(blocker.point.x - e.x, blocker.point.z - e.z);
    if (bd > 1.05) {
      mx = (blocker.point.x - e.x) / bd;
      mz = (blocker.point.z - e.z) / bd;
    } else attackWall = blocker.wall;
  } else if (blocker) {
    const side = e.strafe;
    mx = -dz / dist * side + dx / dist * (dist > 8 ? 0.55 : 0.1);
    mz = dx / dist * side + dz / dist * (dist > 8 ? 0.55 : 0.1);
  } else if (dist < E.attackRange && canAct) {
    attackPlayer = true;
    if (dist < 4) { mx = -dx / dist; mz = -dz / dist; }
    else { mx = -dz / dist * e.strafe * 0.48; mz = dx / dist * e.strafe * 0.48; }
  } else {
    mx = dx / dist;
    mz = dz / dist;
  }

  if (attackPlayer || attackWall) {
    if (e.attackCd <= 0) {
      e.telegraph += dt;
      if (e.telegraph >= E.telegraph) {
        if (attackPlayer) {
          const check = losBlocker(match, origin, target);
          if (!check && dist < E.attackRange + 0.4) {
            fireProjectile(
              match,
              { x: e.x, y: 0.88, z: e.z },
              { x: player.pos.x, y: player.pos.y, z: player.pos.z },
              E.projectileSpeed,
              E.damage
            );
          }
        } else {
          damageWall(match, attackWall, E.wallDamage);
        }
        e.telegraph = 0;
        e.attackCd = E.attackCooldown;
      }
    } else {
      e.telegraph = 0;
    }
  } else {
    e.telegraph = 0;
  }

  const ml = Math.hypot(mx, mz);
  if (ml > 0.01) {
    const mul = (e.telegraph > 0 ? 0.32 : 1) * (e.slow > 0 ? E.slowFactor : 1);
    const step = E.speed * mul * dt;
    const bx = e.x, bz = e.z;
    moveCircle(e, mx / ml * step, mz / ml * step, E.radius, ctxOf(match, false));
    const moved = Math.hypot(e.x - bx, e.z - bz);
    if (moved < step * 0.3) e.stuckTimer += dt;
    else e.stuckTimer = Math.max(0, e.stuckTimer - dt * 2);
    if (e.stuckTimer > E.stuckFlipTime) {
      e.strafe *= -1;
      e.stuckTimer = 0;
    }
  }
}

// 橡皮擦虫（规格 §3.9）：15m 内优先追最近玩家墙，1.15m 每 1.2s 咬 35；无墙贴身咬玩家 12/1.2s
function stepEraser(match, e, dt) {
  const S = CONFIG.enemy.eraser;
  const mul = e.slow > 0 ? CONFIG.enemy.slowFactor : 1;
  const canAct = e.spawnT >= 1;
  let wall = null, wd = Infinity;
  for (const w of match.walls) {
    if (w.dead) continue;
    const d = Math.hypot(w.x - e.x, w.z - e.z);
    if (d < wd) { wd = d; wall = w; }
  }
  let mx = 0, mz = 0;
  if (wall && wd < S.seekRange) {
    if (wd > 1.15) { mx = (wall.x - e.x) / wd; mz = (wall.z - e.z) / wd; }
    else if (canAct && e.attackCd <= 0) {
      damageWall(match, wall, S.wallBite);
      e.attackCd = S.biteCooldown;
      match.events.push({ type: 'wallBite', data: { wallId: wall.id, x: wall.x, z: wall.z } });
    }
  } else {
    const p = nearestPlayer(match, e);
    if (!p) return;
    const dx = p.pos.x - e.x, dz = p.pos.z - e.z;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    if (d > 0.95) { mx = dx / d; mz = dz / d; }
    else if (canAct && e.attackCd <= 0) {
      damagePlayer(match, p, S.biteDamage, { x: e.x, z: e.z });
      e.attackCd = S.biteCooldown;
      match.events.push({ type: 'bite', data: { id: e.id, playerId: p.id } });
    }
  }
  const ml = Math.hypot(mx, mz);
  if (ml > 0.01) {
    const step = S.speed * mul * dt;
    moveCircle(e, mx / ml * step, mz / ml * step, S.radius, ctxOf(match, false));
  }
}

// 纸飞机（规格 §3.9）：环绕(6m/2.2s) → 瞄准 0.6s → 俯冲 9m/s×1.2s 或命中 → 爬升 0.6s
// 全程无视墙体/掩体（飞行高度 2.4m）；减速仅作用于环绕段（俯冲为锁定攻击）
function stepPlane(match, e, dt) {
  const S = CONFIG.enemy.plane;
  const p = nearestPlayer(match, e);
  if (!p) return;
  const dx = p.pos.x - e.x, dz = p.pos.z - e.z;
  const dist = Math.max(0.001, Math.hypot(dx, dz));
  const hoverY = S.height;
  const mul = e.slow > 0 ? CONFIG.enemy.slowFactor : 1;
  if (e.state === 'circle') {
    e.y = hoverY + Math.sin(match.elapsed * 3 + e.phase) * 0.25;
    const tx = -dz / dist * e.strafe + dx / dist * (dist > S.circleDist ? 0.6 : -0.4);
    const tz = dx / dist * e.strafe + dz / dist * (dist > S.circleDist ? 0.6 : -0.4);
    e.x = Math.max(-16, Math.min(16, e.x + tx * S.speed * mul * dt));
    e.z = Math.max(-16, Math.min(16, e.z + tz * S.speed * mul * dt));
    e.telegraph = 0;
    e.circleCd -= dt;
    if (e.circleCd <= 0 && dist < 12) { e.state = 'aim'; e.telegraph = 0; }
  } else if (e.state === 'aim') {
    e.y = hoverY + Math.sin(match.elapsed * 3 + e.phase) * 0.15;
    e.telegraph += dt;
    if (e.telegraph >= S.aimTime) {
      e.state = 'dive';
      e.diveT = 0;
      e.diveDirX = dx / dist;
      e.diveDirZ = dz / dist;
      e.diveY = p.pos.y - 0.4; // 俯冲目标：玩家躯干高度（机体中心）
      match.events.push({ type: 'dive', data: { id: e.id } });
    }
  } else if (e.state === 'dive') {
    e.diveT += dt;
    e.x += e.diveDirX * S.diveSpeed * dt;
    e.z += e.diveDirZ * S.diveSpeed * dt;
    const dy = e.diveY - e.y;
    e.y += Math.max(-S.diveSpeed * dt * 0.8, Math.min(S.diveSpeed * dt * 0.8, dy));
    const pd = Math.hypot(p.pos.x - e.x, p.pos.z - e.z);
    const band = Math.abs(e.y - (p.pos.y - 0.35)) < 0.8;
    if (pd < 0.6 && band) {
      damagePlayer(match, p, S.diveDamage, { x: e.x, z: e.z });
      e.state = 'climb';
      e.diveT = 0;
    } else if (e.diveT >= S.diveTime) {
      e.state = 'climb';
      e.diveT = 0;
    }
  } else { // climb：3.5 m/s 回到环绕高度（原型常量）
    e.diveT += dt;
    e.y = Math.min(hoverY, e.y + 3.5 * dt);
    if (e.diveT >= S.climbTime) {
      e.state = 'circle';
      e.circleCd = S.circleCd;
      e.telegraph = 0;
    }
  }
}

export function stepEnemies(match, dt) {
  for (const e of match.enemies) {
    if (e.dead) continue;
    if (e.spawnT < 1) e.spawnT = Math.min(1, e.spawnT + dt / CONFIG.enemy.spawnAnimTime);
    e.slow = Math.max(0, e.slow - dt);
    e.attackCd -= dt;
    if (match.grace > 0) e.attackCd = Math.max(e.attackCd, 0.5);
    if (e.stun > 0) {
      e.stun -= dt;
      e.telegraph = 0;
      continue;
    }
    if (e.type === 'crane') stepCrane(match, e, dt);
    else if (e.type === 'eraser') stepEraser(match, e, dt);
    else if (e.type === 'plane') stepPlane(match, e, dt);
  }

  // 地面敌人分离（飞行单位不参与）
  const ground = match.enemies.filter(e => !e.dead && e.type !== 'plane');
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      const a = ground[i], b = ground[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0 && d < 0.72) {
        const p = (0.72 - d) / d * 0.25;
        a.x -= dx * p; a.z -= dz * p;
        b.x += dx * p; b.z += dz * p;
      }
    }
  }
  for (let i = match.enemies.length - 1; i >= 0; i--) {
    if (match.enemies[i].dead) match.enemies.splice(i, 1);
  }
}