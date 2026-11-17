// 画线掩体：校验自原型 handleDraw 移植，数量上限按规格 §3.4（每人 3 / 团队 10，超出移除最旧）。
// 预览与最终墙共用 validateDraw，保证"预览即所得"。
import CONFIG from './config.mjs';
import { pointSegmentDistance } from './math.mjs';
import { useInk } from './sim.mjs';

const CLAMP = 16.5; // 原型 aimGround 端点钳制
const clampPt = p => ({ x: Math.max(-CLAMP, Math.min(CLAMP, p.x)), z: Math.max(-CLAMP, Math.min(CLAMP, p.z)) });

export function drawCost(len) {
  return CONFIG.ink.drawBase + CONFIG.ink.drawPerMeter * len;
}

export function validateDraw(match, p, a, b) {
  const A = clampPt(a), B = clampPt(b);
  const len = Math.hypot(B.x - A.x, B.z - A.z);
  const cost = drawCost(len);
  const base = { len, cost, a: A, b: B };
  if (len < CONFIG.ink.drawMinLen) return { ok: false, reason: 'short', ...base };
  if (len > CONFIG.ink.drawMaxLen) return { ok: false, reason: 'long', ...base };
  if (pointSegmentDistance(p.pos, A, B) < CONFIG.wall.minSelfDist) return { ok: false, reason: 'self', ...base };
  if (p.ink < cost) return { ok: false, reason: 'ink', ...base };
  return { ok: true, ...base };
}

export function applyDraw(match, playerId, a, b) {
  const p = match.players.find(pl => pl.id === playerId);
  if (!p || p.st !== 0) return { ok: false, reason: 'dead' };
  const v = validateDraw(match, p, a, b);
  if (!v.ok) return v;
  useInk(p, v.cost, match.elapsed);
  const dx = (v.b.x - v.a.x) / v.len, dz = (v.b.z - v.a.z) / v.len;
  const w = {
    id: match.nextId++,
    x: (v.a.x + v.b.x) / 2, z: (v.a.z + v.b.z) / 2,
    len: v.len, ux: dx, uz: dz, nx: -dz, nz: dx,
    halfThickness: CONFIG.wall.halfThickness,
    hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime,
    owner: p.id, dead: false,
  };
  match.walls.push(w);
  p.stats.walls++;
  const mine = match.walls.filter(x => !x.dead && x.owner === p.id);
  if (mine.length > CONFIG.wall.maxCount) killWall(match, mine[0], 'cap');
  const team = match.walls.filter(x => !x.dead);
  if (team.length > CONFIG.wall.teamMax) killWall(match, team[0], 'cap');
  if (match.walls.some(x => x.dead)) match.walls = match.walls.filter(x => !x.dead);
  match.events.push({ type: 'wallDraw', data: { id: w.id, owner: p.id } });
  return { ok: true, wall: w };
}

function killWall(match, w, reason) {
  if (!w || w.dead) return;
  w.dead = true;
  match.events.push({ type: reason === 'cap' ? 'wallRemove' : 'wallExpire', data: { id: w.id } });
}

export function stepWalls(match, dt) {
  for (const w of match.walls) {
    if (w.dead) continue;
    w.life -= dt;
    if (w.life <= 0) killWall(match, w, 'expire');
  }
  if (match.walls.some(w => w.dead)) match.walls = match.walls.filter(w => !w.dead);
}