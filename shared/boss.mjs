// Boss「奶龙 · 涂改大王」：三阶段状态机 + 五技能（双层扇形/音浪/墨雨/折返冲锋+墨痕/近身砸地）。
// 权威随机只用 match.rand()；同种子双跑逐位一致。
import CONFIG from './config.mjs';
import { moveCircle } from './math.mjs';
import { PLAY_CLAMP } from './world.mjs';
import { createEnemy } from './enemies.mjs';
import { fireProjectile, damageWall, damagePlayer } from './combat.mjs';

const B = CONFIG.boss;
const ATTACK_ORDER = ['fan', 'mortar', 'summon', 'charge'];
const clampPos = v => Math.max(-16.5, Math.min(16.5, v));

export function createBoss(match) {
  const n = Math.min(4, Math.max(1, match.players.length));
  const hp = CONFIG.scaling[n].bossHp;
  match.boss = {
    id: match.nextId++,
    x: 0, z: 5.5, y: 0,
    hp, maxHp: hp,
    phase: 1, raged: false,
    stunT: 0, laughExposeT: 0, slowT: 0,
    attackCd: 2.5, nextAttack: 0, state: 'idle', telegraph: 0,
    dirX: 0, dirZ: 0, chargeT: 0, hitDone: false, chargeLeft: 0, puddleDist: 0,
    waveLeft: 0, waveT: 0, fanPending: 0, fanBase: 0,
    slamCd: 0,
    targetId: null, faceYaw: 0,
    aimX: 0, aimZ: 0,
    dead: false,
  };
  match.events.push({ type: 'bossSpawn', data: { hp } });
  return match.boss;
}

export function phaseCfgOf(b) {
  return B.phases[b.phase - 1];
}

function alivePlayers(match) {
  return match.players.filter(p => p.st === 0);
}

function pruneHate(p, elapsed) {
  if (!p.hate) return 0;
  const cutoff = elapsed - B.hateWindow;
  let sum = 0;
  for (const h of p.hate) if (h.t >= cutoff) sum += h.n;
  p.hate = p.hate.filter(h => h.t >= cutoff);
  return sum;
}

// 近 hateWindow 秒伤害最高者；无记录时回退最近玩家
export function hateTarget(match, b) {
  let best = null, bestDmg = 0, nearest = null, nearestD = Infinity;
  for (const p of alivePlayers(match)) {
    const dmg = pruneHate(p, match.elapsed);
    if (dmg > bestDmg) { bestDmg = dmg; best = p; }
    const d = Math.hypot(p.pos.x - b.x, p.pos.z - b.z);
    if (d < nearestD) { nearestD = d; nearest = p; }
  }
  return best || nearest;
}

export function farthestTarget(match, b) {
  let far = null, farD = -1;
  for (const p of alivePlayers(match)) {
    const d = Math.hypot(p.pos.x - b.x, p.pos.z - b.z);
    if (d > farD) { farD = d; far = p; }
  }
  return far;
}

function nearestPlayer(match, b) {
  let near = null, nd = Infinity;
  for (const p of alivePlayers(match)) {
    const d = Math.hypot(p.pos.x - b.x, p.pos.z - b.z);
    if (d < nd) { nd = d; near = p; }
  }
  return { near, dist: nd };
}

// 65% / 30% 刻度跨越：阶段 2 触发 bossPhase(2)+rage，阶段 3 触发 bossPhase(3)。
export function advanceBossPhase(match) {
  const b = match.boss;
  if (!b || b.dead) return;
  const ratio = b.hp / b.maxHp;
  const target = ratio > B.phase2At ? 1 : ratio > B.phase3At ? 2 : 3;
  while (b.phase < target) {
    b.phase++;
    b.raged = b.phase >= 2;
    if (b.phase === 2) {
      b.laughExposeT = B.laughExposeTime;
      match.events.push({ type: 'rage', data: {} });
      match.events.push({ type: 'bossPhase', data: { phase: 2, title: B.phaseTitles[1] } });
    } else {
      match.events.push({ type: 'bossPhase', data: { phase: 3, title: B.phaseTitles[2] } });
    }
  }
}

export function damageBoss(match, n, attackerId = null, opts = null) {
  const b = match.boss;
  if (!b || b.dead) return 0;
  const mul = opts?.mul || 1;
  const bypass = !!(opts?.bypassShield || b.stunT > 0);
  let shield = bypass ? 1 : phaseCfgOf(b).shieldMul;
  if (!bypass && opts && opts.shieldMulOverride != null) {
    const pierce = b.phase >= 2 ? B.shieldPierce2 : opts.shieldMulOverride;
    shield = Math.min(1, Math.max(shield, pierce));
  }
  const dealt = bypass ? Math.round(n * mul) : Math.ceil(n * mul * shield);
  b.hp = Math.max(0, b.hp - dealt);
  if (attackerId !== null) {
    const p = match.players.find(pl => pl.id === attackerId);
    if (p) {
      if (!p.hate) p.hate = [];
      p.hate.push({ t: match.elapsed, n: dealt });
      pruneHate(p, match.elapsed);
    }
  }
  advanceBossPhase(match);
  if (b.hp === 0) {
    b.dead = true;
    b.waveLeft = 0;
    b.fanPending = 0;
    match.exitUnlocked = true;
    match.events.push({ type: 'bossDown', data: {} });
  }
  return dealt;
}

function fanCountOf(match) {
  const n = Math.min(4, Math.max(1, match.players.length));
  return CONFIG.scaling[n].fan + (match.boss.raged ? B.rage.fanBonus : 0);
}

function fireFanRow(match, b, count, speed, damage, base, offset) {
  for (let i = 0; i < count; i++) {
    const ang = base + offset + (i - (count - 1) / 2) * B.fanSpread;
    fireProjectile(
      match,
      { x: b.x, y: 1.4, z: b.z },
      { x: b.x + Math.sin(ang) * 10, y: 1.4, z: b.z + Math.cos(ang) * 10 },
      speed,
      damage
    );
  }
}

// 天降墨雨：玩家位置 + 移速预判点 + match.rand() 近身随机点；只走确定随机流。
function spawnMortars(match, base, count) {
  const px = base ? base.pos.x : 0, pz = base ? base.pos.z : 0;
  const vx = base ? base.velX : 0, vz = base ? base.velZ : 0;
  const spots = [
    { x: px, z: pz },
    { x: clampPos(px + vx * B.mortarLead), z: clampPos(pz + vz * B.mortarLead) },
  ];
  while (spots.length < count) {
    const ang = match.rand() * Math.PI * 2;
    const rad = 2.5 + match.rand() * 4.5;
    spots.push({ x: clampPos(px + Math.sin(ang) * rad), z: clampPos(pz + Math.cos(ang) * rad) });
  }
  for (const s of spots) {
    match.hazards.push({
      id: match.nextId++, kind: 'mortar', x: s.x, z: s.z,
      r: B.mortarRadius, fuse: B.mortarFuse, t: B.mortarFuse, damage: B.mortarDamage,
    });
  }
}

function emitWaveBurst(match, b, cfg) {
  for (let i = 0; i < cfg.waves; i++) {
    match.hazards.push({
      id: match.nextId++, kind: 'wave', x: b.x, z: b.z,
      r: 0.7 + i * B.waveStagger, speed: B.waveSpeed, maxR: B.waveMaxRadius,
      damage: B.waveDamage, push: B.wavePush, hit: [],
    });
  }
  match.events.push({ type: 'waveBurst', data: { x: b.x, z: b.z, count: cfg.waves } });
}

function spawnPuddle(match, b) {
  match.hazards.push({
    id: match.nextId++, kind: 'puddle', x: b.x, z: b.z,
    r: B.puddleRadius, t: B.puddleLife, tick: 0.25,
  });
}

function bossCtx(match) {
  return {
    isPlayer: false,
    staticColliders: match.statics,
    walls: match.walls,
    foldWalls: match.foldWalls,
    clamp: PLAY_CLAMP,
  };
}

export function stepBoss(match, dt) {
  const b = match.boss;
  if (!b || b.dead) return;
  b.laughExposeT = Math.max(0, b.laughExposeT - dt);
  b.slowT = Math.max(0, b.slowT - dt);
  b.slamCd = Math.max(0, b.slamCd - dt);
  if (b.stunT > 0) {
    b.stunT = Math.max(0, b.stunT - dt);
    b.waveLeft = 0;
    b.waveT = 0;
    b.fanPending = 0;
    return;
  }
  const alive = alivePlayers(match);
  if (!alive.length) return;

  advanceBossPhase(match);
  const cfg = phaseCfgOf(b);
  const interval = cfg.attackInterval;

  const face = (x, z) => {
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz > 1e-6) b.faceYaw = Math.atan2(dx, dz);
  };

  if (b.waveLeft > 0) {
    b.waveT -= dt;
    if (b.waveT <= 0) {
      b.waveT = B.waveInterval;
      b.waveLeft--;
      emitWaveBurst(match, b, cfg);
    }
  }

  if (b.state === 'idle') {
    const t = hateTarget(match, b);
    b.targetId = t ? t.id : null;
    const { near, dist } = nearestPlayer(match, b);
    if (near && dist < B.slamRange && b.slamCd <= 0) {
      b.state = 'slam';
      b.telegraph = 0;
      b.targetId = near.id;
      b.slamCd = B.slamCooldown;
      face(near.pos.x, near.pos.z);
      return;
    }
    if (t) {
      face(t.pos.x, t.pos.z);
      const dx = t.pos.x - b.x, dz = t.pos.z - b.z;
      const target = Math.max(0.001, Math.hypot(dx, dz));
      if (target > 3.5) {
        const step = cfg.speed * (b.slowT > 0 ? 0.5 : 1) * dt;
        moveCircle(b, dx / target * step, dz / target * step, B.radius, bossCtx(match));
      }
    }
    b.attackCd -= dt;
    if (b.attackCd <= 0) {
      b.state = ATTACK_ORDER[b.nextAttack % ATTACK_ORDER.length];
      b.nextAttack++;
      b.telegraph = 0;
      if (b.state === 'charge') {
        const far = farthestTarget(match, b);
        b.targetId = far ? far.id : null;
        b.chargeLeft = cfg.chargeSegments;
        if (far) { b.aimX = far.pos.x; b.aimZ = far.pos.z; face(far.pos.x, far.pos.z); }
      }
    }
    return;
  }

  b.telegraph += dt;

  if (b.state === 'fan') {
    const t = hateTarget(match, b);
    if (t) { b.targetId = t.id; face(t.pos.x, t.pos.z); }
    if (b.fanPending > 0) {
      b.fanPending -= dt;
      if (b.fanPending <= 0) {
        b.fanPending = 0;
        const count = fanCountOf(match) + 1;
        fireFanRow(match, b, count, cfg.fanSpeed, cfg.fanDamage, b.fanBase, B.fanSpread / 2);
        match.events.push({ type: 'bossAttack', data: { attack: 'fan', count, row: 2 } });
        b.state = 'idle';
        b.attackCd = interval;
      }
    } else if (b.telegraph >= B.fanTelegraph) {
      const base = t ? Math.atan2(t.pos.x - b.x, t.pos.z - b.z) : b.faceYaw;
      b.fanBase = base;
      const count = fanCountOf(match);
      fireFanRow(match, b, count, cfg.fanSpeed, cfg.fanDamage, base, 0);
      match.events.push({ type: 'bossAttack', data: { attack: 'fan', count, row: 1 } });
      if (cfg.fanRows > 1) b.fanPending = B.fanSecondGap;
      else { b.state = 'idle'; b.attackCd = interval; }
    }
  } else if (b.state === 'mortar') {
    if (b.telegraph >= B.mortarTelegraph) {
      const base = hateTarget(match, b);
      if (base) face(base.pos.x, base.pos.z);
      spawnMortars(match, base, cfg.mortars);
      match.events.push({ type: 'bossAttack', data: { attack: 'mortar', count: cfg.mortars } });
      b.state = 'idle';
      b.attackCd = interval;
    }
  } else if (b.state === 'summon') {
    if (b.telegraph >= B.summonTelegraph) {
      const n = Math.min(4, Math.max(1, match.players.length));
      const cap = CONFIG.scaling[n].cap;
      const want = n >= 3 ? B.summonCountBig : B.summonCount;
      let made = 0;
      for (let i = 0; i < want; i++) {
        if (match.enemies.filter(e => !e.dead).length >= cap) break;
        const ang = match.rand() * Math.PI * 2;
        const e = createEnemy(
          match, 'crane',
          Math.max(-15, Math.min(15, b.x + Math.sin(ang) * 3)),
          Math.max(-15, Math.min(15, b.z + Math.cos(ang) * 3)),
          { spawnAnim: true }
        );
        e.attackCd = 1.5;
        made++;
      }
      b.laughExposeT = B.waveExposeTime;
      b.waveLeft = B.waveBursts;
      b.waveT = 0;
      match.events.push({ type: 'bossAttack', data: { attack: 'summon', count: made } });
      b.state = 'idle';
      b.attackCd = interval;
    }
  } else if (b.state === 'charge') {
    const far = farthestTarget(match, b);
    if (far) { b.aimX = far.pos.x; b.aimZ = far.pos.z; face(far.pos.x, far.pos.z); }
    if (b.telegraph >= B.chargeTelegraph) {
      const tx = far ? far.pos.x : b.x + Math.sin(b.faceYaw);
      const tz = far ? far.pos.z : b.z + Math.cos(b.faceYaw);
      const dx = tx - b.x, dz = tz - b.z;
      const d = Math.max(0.001, Math.hypot(dx, dz));
      b.dirX = dx / d; b.dirZ = dz / d;
      b.chargeT = 0;
      b.hitDone = false;
      b.puddleDist = 0;
      b.state = 'charging';
      match.events.push({ type: 'bossAttack', data: { attack: 'charge', segment: cfg.chargeSegments - b.chargeLeft + 1, segments: cfg.chargeSegments } });
    }
  } else if (b.state === 'charging') {
    b.faceYaw = Math.atan2(b.dirX, b.dirZ);
    b.chargeT += dt;
    const step = cfg.chargeSpeed * dt;
    moveCircle(b, b.dirX * step, b.dirZ * step, B.radius, bossCtx(match));
    b.puddleDist += step;
    while (b.puddleDist >= B.puddleSpacing) {
      b.puddleDist -= B.puddleSpacing;
      spawnPuddle(match, b);
    }
    for (const w of match.walls) {
      if (w.dead) continue;
      if (Math.hypot(w.x - b.x, w.z - b.z) < 1.4) {
        damageWall(match, w, B.chargeWallDamage);
        b.hitDone = true;
        b.chargeT = B.chargeTime;
        b.chargeLeft = 0;
        b.waveLeft = b.waveT = 0;
        b.stunT = B.wallStunTime;
        match.events.push({ type: 'bossStun', data: { reason: 'wall', duration: b.stunT, wallId: w.id } });
        break;
      }
    }
    if (!b.hitDone) {
      for (const p of alive) {
        if (p.god) continue; // 无敌观测：冲锋穿过而不触发命中
        const pdx = p.pos.x - b.x, pdz = p.pos.z - b.z;
        if (pdx * pdx + pdz * pdz < 1.25 * 1.25) {
          damagePlayer(match, p, cfg.chargeDamage, { x: b.x, z: b.z });
          b.hitDone = true;
          b.chargeT = B.chargeTime;
          break;
        }
      }
    }
    if (b.chargeT >= B.chargeTime) {
      if (b.chargeLeft > 1 && b.stunT <= 0) {
        b.chargeLeft--;
        b.state = 'charge';
        b.telegraph = 0;
      } else {
        b.chargeLeft = 0;
        b.state = 'idle';
        b.attackCd = interval;
      }
    }
  } else if (b.state === 'slam') {
    const { near } = nearestPlayer(match, b);
    if (near) face(near.pos.x, near.pos.z);
    if (b.telegraph >= B.slamTelegraph) {
      for (const p of alive) {
        const dx = p.pos.x - b.x, dz = p.pos.z - b.z;
        const d = Math.hypot(dx, dz);
        if (d <= B.slamRadius) {
          damagePlayer(match, p, B.slamDamage, { x: b.x, z: b.z });
          if (p.god) continue;
          const l = Math.max(0.001, d);
          p.velX = dx / l * B.slamPush;
          p.velZ = dz / l * B.slamPush;
          p.velY = B.slamLift;
          p.grounded = false;
        }
      }
      match.events.push({ type: 'bossSlam', data: { x: b.x, z: b.z, radius: B.slamRadius } });
      b.state = 'idle';
      b.attackCd = interval;
    }
  }
}

// 地面警示域推进：音浪环扩张 / 墨雨引爆 / 墨痕持续伤害。伤害段由 invulnGuard 包裹。
export function stepHazards(match, dt) {
  const H = match.hazards;
  const P = CONFIG.player;
  for (let i = H.length - 1; i >= 0; i--) {
    const h = H[i];
    let dead = false;
    if (h.kind === 'wave') {
      h.r += h.speed * dt;
      for (const p of match.players) {
        if (p.st !== 0 || h.hit.includes(p.id)) continue;
        if (p.pos.y - P.eyeHeight >= B.waveJumpHeight) continue;
        const dx = p.pos.x - h.x, dz = p.pos.z - h.z;
        const d = Math.hypot(dx, dz);
        if (Math.abs(d - h.r) <= B.waveRing) {
          h.hit.push(p.id);
          damagePlayer(match, p, h.damage, { x: h.x, z: h.z });
          if (p.god) continue;
          const l = Math.max(0.001, d);
          p.velX = dx / l * B.wavePush;
          p.velZ = dz / l * B.wavePush;
        }
      }
      if (h.r >= h.maxR) dead = true;
    } else if (h.kind === 'mortar') {
      h.t -= dt;
      if (h.t <= 0) {
        for (const p of match.players) {
          if (p.st !== 0) continue;
          if (Math.hypot(p.pos.x - h.x, p.pos.z - h.z) <= h.r + 0.3) damagePlayer(match, p, h.damage, { x: h.x, z: h.z });
        }
        match.events.push({ type: 'mortarBoom', data: { x: h.x, z: h.z, r: h.r } });
        dead = true;
      }
    } else {
      h.t -= dt;
      if (h.t <= 0) dead = true;
      else {
        h.tick -= dt;
        if (h.tick <= 0) {
          h.tick = 0.25;
          for (const p of match.players) {
            if (p.st !== 0 || p.pos.y - P.eyeHeight > 0.6) continue;
            if (Math.hypot(p.pos.x - h.x, p.pos.z - h.z) <= h.r) damagePlayer(match, p, 1, { x: h.x, z: h.z });
          }
        }
      }
    }
    if (dead) H.splice(i, 1);
  }
}
