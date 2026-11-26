// 模拟内核：玩家物理自原型 src/game.js §6 移植（渲染/音效/输入设备剥离）。
// 纯函数式状态推进：同种子同输入 → 逐位相同的快照。
import CONFIG from './config.mjs';
import { moveCircle } from './math.mjs';
import { FOLDS, ANCHORS, SPAWNS, PLAY_CLAMP, groundHeightAt, foldWallBox, staticColliders, pickupList } from './world.mjs';
import { stepEnemies } from './enemies.mjs';
import { stepBoss, stepHazards } from './boss.mjs';
import { stepProjectiles } from './combat.mjs';
import { stepWalls } from './walls.mjs';
import { stepFolds } from './folds.mjs';
import { stepPickups } from './pickups.mjs';
import { stepRevive, invulnGuard } from './revive.mjs';
import { stepFlow } from './flow.mjs';
import { perkMods } from './perks.mjs';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPlayer(id, spawn, yaw = 0) {
  return {
    id,
    pos: { x: spawn.x, y: CONFIG.player.eyeHeight, z: spawn.z },
    yaw, pitch: 0,
    velX: 0, velZ: 0, velY: 0,
    hp: CONFIG.player.maxHp,
    ink: CONFIG.ink.max,
    ammo: CONFIG.player.gun.magazine,
    weapon: 0,
    perks: [],
    ammoBag: CONFIG.player.weapons.map(w => w.magazine),
    fireCd: 0, eraseCd: 0, reload: 0,
    dashT: 0, dashCd: 0, dashX: 0, dashZ: 0,
    lastSkill: -1e9,
    grounded: true,
    st: 0,
    god: false, // 无敌观测模式（I 键）：仅表现/调试开关，不改变确定性随机流
    downT: -1, // 倒地剩余秒数（st=1 时 20→0；-1=未进入倒地/无倒计时）
    reviveProgress: 0,
    reviveBy: null,
    invuln: 0, // 救起后 1s 无敌（伤害由 stepMatch 的 invulnGuard 拦截）
    hate: [],
    stats: { kills: 0, walls: 0, erases: 0, rescues: 0 },
  };
}

export function weaponOf(p) {
  return CONFIG.player.weapons[p.weapon] || CONFIG.player.weapons[0];
}

export function switchWeapon(p, idx) {
  if (p.st !== 0 || !Number.isInteger(idx) || idx < 0 || idx >= CONFIG.player.weapons.length || idx === p.weapon) return false;
  // ammo is authoritative while equipped; the bag stores only holstered magazines.
  p.ammoBag[p.weapon] = p.ammo;
  p.weapon = idx;
  p.ammo = p.ammoBag[idx];
  p.reload = 0;
  p.fireCd = Math.max(p.fireCd, 0.15);
  return true;
}

export function createMatch({ seed = 1, playerIds = [0] } = {}) {
  return {
    seed,
    rand: rng(seed),
    tick: 0,
    elapsed: 0,
    timeLeft: CONFIG.round.timeLimit,
    grace: CONFIG.round.graceTime,
    phase: 'anchors',
    events: [],
    nextId: 1,
    players: playerIds.map((id, i) => createPlayer(id, SPAWNS[i % SPAWNS.length])),
    walls: [],
    foldWalls: [],
    enemies: [],
    projectiles: [],
    hazards: [],
    folds: FOLDS.map(f => ({ ...f, animT: 1, fromAngle: CONFIG.folds.rampAngle })),
    pickups: pickupList().map(p => ({ ...p, taken: false })),
    anchors: ANCHORS.map(a => ({ ...a, active: false, progress: 0 })),
    boss: null,
    kills: 0,
    anchorsDone: 0,
    exitUnlocked: false,
    exitProgress: 0,
    statics: staticColliders(),
    ack: {},
  };
}

function foldWallsOf(match) {
  return match.folds.filter(f => f.state === 'wall').map(foldWallBox);
}

// input: {f, r, sprint, jump}（f/r 为意图向量，模长>1 时归一）
// ctx 由 stepMatch 提供；单测可直接构造。
export function stepPlayer(p, input, dt, ctx) {
  const P = CONFIG.player;
  const mods = perkMods(p);
  p.fireCd = Math.max(0, p.fireCd - dt);
  p.eraseCd = Math.max(0, p.eraseCd - dt);
  p.dashCd = Math.max(0, p.dashCd - dt);
  if (p.eraseCd < 1e-9) p.eraseCd = 0; // 浮点残差会在 3.5s 边界误拒一次释放
  if (p.reload > 0) {
    p.reload = Math.max(0, p.reload - dt);
    if (p.reload === 0) p.ammo = weaponOf(p).magazine;
  }
  if (ctx.elapsed - p.lastSkill > CONFIG.ink.regenDelay) {
    const rate = (ctx.regenRate ?? CONFIG.ink.regenRate) * mods.inkRegenMul;
    p.ink = Math.min(CONFIG.ink.max, p.ink + rate * dt);
  }

  let f = input.f || 0, r = input.r || 0;
  const il = Math.hypot(f, r);
  if (il > 1) { f /= il; r /= il; }
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  // 倒地（st=1）只能 0.6m/s 爬行，禁冲刺/跳跃；阵亡（st=2）不再移动（规格 §3.13）。
  const downed = p.st === 1, dead = p.st === 2;
  // 墨迹闪避：仅由显式 input.dash 边沿触发；不传 dash 的旧输入逐位保持不变。
  if (!downed && !dead && input.dash && p.dashCd <= 0 && p.dashT <= 0) {
    const mx = fx * f + rx * r, mz = fz * f + rz * r;
    const ml = Math.hypot(mx, mz);
    const dx = ml > 1e-6 ? mx / ml : fx, dz = ml > 1e-6 ? mz / ml : fz;
    p.dashT = P.dash.duration;
    p.dashCd = P.dash.cooldown;
    p.dashX = dx; p.dashZ = dz;
    p.velX = dx * P.dash.speed;
    p.velZ = dz * P.dash.speed;
    ctx.events?.push({ type: 'dash', data: { id: p.id, x: p.pos.x, z: p.pos.z, dx, dz } });
  }
  if (!downed && !dead && p.dashT > 0) {
    p.dashT = Math.max(0, p.dashT - dt);
    p.velX = p.dashX * P.dash.speed;
    p.velZ = p.dashZ * P.dash.speed;
  } else {
    const speed = (dead ? 0 : downed ? P.crawlSpeed : (input.sprint ? P.sprintSpeed : P.walkSpeed) * mods.speedMul) * (p.hazardSlow || 1);
    const blend = 1 - Math.exp(-14 * dt);
    p.velX += (fx * f + rx * r) * speed * blend - p.velX * blend;
    p.velZ += (fz * f + rz * r) * speed * blend - p.velZ * blend;
  }

  if (!downed && !dead && input.jump && p.grounded) {
    p.velY = P.jumpVelocity;
    p.grounded = false;
  }

  const oldFoot = p.pos.y - P.eyeHeight;
  const oldX = p.pos.x, oldZ = p.pos.z;
  const moveCtx = {
    isPlayer: true,
    staticColliders: ctx.staticColliders,
    walls: ctx.walls,
    foldWalls: ctx.foldWalls,
    clamp: PLAY_CLAMP,
  };
  const displace = Math.hypot(p.velX, p.velZ) * dt;
  const sub = displace > 0.36 ? Math.ceil(displace / 0.1) : 1;
  for (let i = 0; i < sub; i++) moveCircle(p.pos, p.velX * dt / sub, p.velZ * dt / sub, P.radius, moveCtx);
  const movedGround = groundHeightAt(p.pos.x, p.pos.z, ctx.folds);
  if (movedGround - oldFoot > CONFIG.folds.stepLimit) {
    p.pos.x = oldX;
    p.pos.z = oldZ;
  }

  p.velY -= P.gravity * dt;
  p.pos.y += p.velY * dt;
  const ground = groundHeightAt(p.pos.x, p.pos.z, ctx.folds);
  const eye = ground + P.eyeHeight;
  if (p.pos.y <= eye) {
    p.pos.y = eye;
    p.velY = 0;
    p.grounded = true;
  } else {
    p.grounded = false;
  }
}

// 开火结算（射线命中 D3 接入）；返回 'fired' | 'cooldown' | 'reload' | 'autoReload' | 'dead'
export function applyFire(p) {
  if (p.st !== 0) return 'dead'; // 倒地/阵亡禁射击（房主权威闸门）
  if (p.fireCd > 0 || p.reload > 0) return 'cooldown';
  if (p.ammo <= 0) { startReload(p); return 'autoReload'; }
  p.ammo--;
  p.fireCd = weaponOf(p).fireInterval;
  if (p.ammo === 0) { startReload(p); return 'fired'; }
  return 'fired';
}

export function startReload(p) {
  if (p.st !== 0) return false; // 倒地/阵亡禁换弹
  const w = weaponOf(p);
  if (p.reload > 0 || p.ammo === w.magazine) return false;
  p.reload = w.reloadTime * perkMods(p).reloadMul;
  return true;
}

export function useInk(p, cost, elapsed) {
  if (p.ink < cost) return false;
  p.ink -= cost;
  p.lastSkill = elapsed;
  return true;
}

export function stepMatch(match, inputs, dt = CONFIG.net.dt) {
  if (match.phase === 'won' || match.phase === 'lost') return match;
  match.tick++;
  match.elapsed += dt;
  match.grace = Math.max(0, match.grace - dt);
  if (match.phase === 'anchors' || match.phase === 'boss') {
    match.timeLeft = Math.max(0, match.timeLeft - dt);
  }
  const ctx = {
    elapsed: match.elapsed,
    staticColliders: match.statics,
    walls: match.walls,
    foldWalls: foldWallsOf(match),
    folds: match.folds,
    regenRate: CONFIG.ink.regenRate,
    events: match.events,
  };
  match.foldWalls = ctx.foldWalls;
  for (const p of match.players) {
    p.hazardSlow = 1;
    if (p.st === 0 && p.pos.y - CONFIG.player.eyeHeight <= 0.6) {
      for (const h of match.hazards) {
        if (h.kind === 'puddle' && Math.hypot(p.pos.x - h.x, p.pos.z - h.z) <= h.r) {
          p.hazardSlow = CONFIG.boss.puddleSlow;
          break;
        }
      }
    }
    const input = inputs[p.id] || { f: 0, r: 0 };
    stepPlayer(p, input, dt, ctx);
    if (input.seq !== undefined) match.ack[p.id] = input.seq;
  }
  // 敌人/Boss/弹丸/地面警示域的伤害段包在无敌拦截里（1s 无敌期实际掉血为 0，见 revive.invulnGuard）
  invulnGuard(match, () => {
    stepEnemies(match, dt);
    stepBoss(match, dt);
    stepProjectiles(match, dt);
    stepHazards(match, dt);
  });
  stepWalls(match, dt);
  stepFolds(match, dt);
  stepPickups(match);
  stepRevive(match, inputs, dt);
  stepFlow(match, inputs, dt);
  return match;
}

export function drainEvents(match) {
  return match.events.splice(0, match.events.length);
}

// 规格 §4.3 短键快照（D2 最小集；敌人/弹丸/Boss 字段 D3+ 填充）
export function snapshot(match) {
  return {
    m: 'snapshot',
    tick: match.tick,
    ack: match.ack[0] ?? 0,
    timeLeft: +match.timeLeft.toFixed(2),
    phase: match.phase,
    kills: match.kills,
    players: match.players.map(p => ({
      id: p.id,
      x: +p.pos.x.toFixed(3), z: +p.pos.z.toFixed(3), y: +p.pos.y.toFixed(3),
      yaw: +p.yaw.toFixed(4), pitch: +p.pitch.toFixed(4),
      hp: p.hp, ink: +p.ink.toFixed(1), ammo: p.ammo, wp: p.weapon, rl: +p.reload.toFixed(2), ec: +p.eraseCd.toFixed(2), st: p.st,
      dc: +p.dashCd.toFixed(2), da: p.dashT > 0 ? 1 : 0,
      dt: +Math.max(0, p.downT).toFixed(2), iv: +p.invuln.toFixed(2), rv: +p.reviveProgress.toFixed(2),
      sc: [p.stats.kills, p.stats.walls, p.stats.erases, p.stats.rescues],
      pk: [...(p.perks || [])],
    })),
    enemies: match.enemies.map(e => ({
      id: e.id, type: e.type,
      x: +e.x.toFixed(3), z: +e.z.toFixed(3), y: +e.y.toFixed(3),
      hp: e.hp, armor: e.armor,
      stun: +e.stun.toFixed(2), telegraph: +e.telegraph.toFixed(2), state: e.state,
    })),
    projectiles: match.projectiles.map(p => ({
      id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
    })),
    boss: match.boss && !match.boss.dead ? {
      hp: match.boss.hp, max: match.boss.maxHp, ph: match.boss.phase, state: match.boss.state, raged: match.boss.raged,
      x: +match.boss.x.toFixed(2), z: +match.boss.z.toFixed(2),
      t: +match.boss.telegraph.toFixed(2), fy: +match.boss.faceYaw.toFixed(3),
      st: +match.boss.stunT.toFixed(2), ex: +match.boss.laughExposeT.toFixed(2), sl: +match.boss.slowT.toFixed(2),
      ax: +match.boss.aimX.toFixed(2), az: +match.boss.aimZ.toFixed(2),
    } : null,
    hazards: match.hazards.map(h => ({
      id: h.id, k: h.kind === 'wave' ? 'w' : h.kind === 'mortar' ? 'm' : 'p',
      x: +h.x.toFixed(2), z: +h.z.toFixed(2), r: +h.r.toFixed(2),
      t: h.kind === 'wave' ? 0 : +h.t.toFixed(2),
    })),
    walls: match.walls.filter(w => !w.dead).map(w => ({ id: w.id, x: w.x, z: w.z, len: w.len, hp: w.hp, life: +w.life.toFixed(2), owner: w.owner })),
    folds: match.folds.map(f => ({ id: f.id, state: f.state, anim: +f.animT.toFixed(2) })),
    pickups: match.pickups.map(p => ({ id: p.id, taken: p.taken })),
    anchors: match.anchors.map(a => ({ i: a.i, active: a.active, progress: +a.progress.toFixed(2) })),
    exit: +match.exitProgress.toFixed(2),
  };
}