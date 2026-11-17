// D4 开发入口：单人 = 房主运行时本地特例（零插值直读最新快照）。
// 完整闭环：初始波次 → 画墙 → 锚点共持 → Boss → 撤离胜负 → 再来一局。
import CONFIG from '../shared/config.mjs';
import { drainEvents } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { validateDraw } from '../shared/walls.mjs';
import { nearestFold } from '../shared/folds.mjs';
import { createRuntime } from '../host/runtime.mjs';
import { createRenderer } from './render.mjs';
import { createInput } from './input.mjs';
import { createHud } from './hud.mjs';

const THREE = window.THREE;
if (!THREE) {
  document.body.innerHTML = '<p style="padding:2em;font-family:sans-serif">3D 引擎未载入（需要 /src/three/three.min.js）。</p>';
  throw new Error('THREE missing');
}

const BEST_KEY = CONFIG.storage.bestTeam;
function loadBest() {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) || 'null');
    if (v && typeof v.time === 'number' && v.time > 0) return v.time;
  } catch { /* 忽略损坏记录 */ }
  return null;
}
function saveBest(t) {
  const best = loadBest();
  if (best !== null && t >= best) return false;
  try { localStorage.setItem(BEST_KEY, JSON.stringify({ time: t })); } catch { /* 忽略 */ }
  return true;
}

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || ((Date.now() & 0x7fffffff) >>> 0);
let runtime = null, match = null;
let drawStart = null;
let ended = false;

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas);
const hud = createHud(document.getElementById('hud'), { onRestart: () => restart() });

function spawnInitialWave() {
  const n = CONFIG.scaling[1].initial;
  for (let i = 0; i < n; i++) {
    const type = CONFIG.waves.initial[i % CONFIG.waves.initial.length];
    const [x, z] = CONFIG.waves.spots[i % CONFIG.waves.spots.length];
    createEnemy(match, type, x, z, { spawnAnim: true });
  }
}
function initMatch() {
  runtime = createRuntime({ seed, playerIds: [0] });
  match = runtime.match;
  spawnInitialWave();
  drawStart = null;
  ended = false;
  renderer.reset();
  hud.hideSettlement();
  hud.drawHint(false);
  hud.resetCache();
}
function restart() {
  initMatch();
  input.releaseFire();
  hud.toast('新的一局：同种子重开');
}

// 准星地面落点（原型 aimGround 移植）：俯角射线 13m 内，否则前方 5.5m，端点钳制 ±16.5
function aimGround() {
  const p = match.players[0];
  const d = input.dir();
  let pt = null;
  if (d.y < -0.06) {
    const t = (0.03 - p.pos.y) / d.y;
    if (t > 0 && t < 13) pt = { x: p.pos.x + d.x * t, z: p.pos.z + d.z * t };
  }
  if (!pt) pt = { x: p.pos.x - Math.sin(p.yaw) * 5.5, z: p.pos.z - Math.cos(p.yaw) * 5.5 };
  return {
    x: Math.max(-16.5, Math.min(16.5, pt.x)),
    z: Math.max(-16.5, Math.min(16.5, pt.z)),
  };
}
function cancelDraw() {
  drawStart = null;
  renderer.setDrawStart(null);
  hud.drawHint(false);
}
const DRAW_FAIL = {
  short: '线条太短，至少 2 米',
  long: '线条太长，最多 6 米',
  self: '不能把墙画在自己身上',
  dead: '倒地中无法画线',
};
function handleDraw() {
  if (ended || match.phase === 'won' || match.phase === 'lost') return;
  const p = match.players[0];
  if (!drawStart) {
    const res = runtime.action(0, { m: 'drawStart' });
    if (!res.ok) { hud.toast('至少需要 ' + CONFIG.ink.minDrawCost + ' 墨量'); return; }
    drawStart = aimGround();
    renderer.setDrawStart(drawStart);
    hud.drawHint(true);
    return;
  }
  const end = aimGround();
  const res = runtime.action(0, { m: 'drawEnd', ax: drawStart.x, az: drawStart.z, bx: end.x, bz: end.z });
  if (res.ok) {
    cancelDraw();
    hud.toast('掩体已实体化');
  } else {
    hud.toast(res.reason === 'ink' ? '需要 ' + Math.ceil(res.cost) + ' 墨量' : (DRAW_FAIL[res.reason] || '无法画线'));
  }
}

function handleErase() {
  if (ended || match.phase === 'won' || match.phase === 'lost') return;
  const res = runtime.action(0, { m: 'erase' });
  if (res.ok) hud.toast(res.stripped ? '擦除了 ' + res.stripped + ' 层护甲' : '脉冲已释放');
  else if (res.reason === 'cooldown') hud.toast('擦除冷却 ' + res.cd.toFixed(1) + ' 秒');
  else if (res.reason === 'ink') hud.toast('擦除需要 ' + CONFIG.ink.eraseCost + ' 墨量');
  else if (res.reason === 'dead') hud.toast('倒地中无法擦除');
}
function handleFold() {
  if (ended || match.phase === 'won' || match.phase === 'lost') return;
  const n = nearestFold(match, match.players[0]);
  if (!n || n.dist > CONFIG.folds.interactRadius) {
    hud.toast('靠近折角 ' + CONFIG.folds.interactRadius + ' 米内才能翻折');
    return;
  }
  const res = runtime.action(0, { m: 'fold', foldId: n.fold.id });
  if (res.ok) hud.toast(res.state === 'wall' ? '纸墙立起，坡道收起' : '坡道展开，可登上平台');
  else if (res.reason === 'anim') hud.toast('折页翻折中…');
  else if (res.reason === 'far') hud.toast('距离折角太远');
  else if (res.reason === 'dead') hud.toast('倒地中无法翻折');
}

function shootDir(dir) {
  const p = match.players[0];
  return runtime.action(0, { m: 'shot', ox: p.pos.x, oy: p.pos.y, oz: p.pos.z, dx: dir.x, dy: dir.y, dz: dir.z });
}
let lastIntent = { f: 0, r: 0 };
const input = createInput(canvas, {
  onIntent: it => { lastIntent = it; runtime.setInput(0, it); },
  onShot: dir => shootDir(dir),
  onReload: () => runtime.action(0, { m: 'reload' }),
  onDraw: handleDraw,
  onCancelDraw: cancelDraw,
  onErase: handleErase,
  onFold: handleFold,
  onLock: (locked, warn, fallback) => {
    document.getElementById('lock-hint').style.display = (locked || fallback) ? 'none' : 'flex';
    if (warn) hud.toast(warn);
  },
});

function finish(won, reason) {
  if (ended) return;
  ended = true;
  cancelDraw();
  input.releaseFire();
  if (document.pointerLockElement) document.exitPointerLock();
  const best = loadBest();
  const isNew = won ? saveBest(match.elapsed) : false;
  hud.showSettlement({
    won,
    reason,
    time: match.elapsed,
    kills: match.kills,
    players: match.players.map(p => ({ id: p.id, ...p.stats })),
    best: won ? (isNew ? match.elapsed : best) : best,
    isNew,
  });
}

initMatch();

let lastFrame = performance.now();
let paused = false;
function processEvents() {
  for (const ev of drainEvents(match)) {
    renderer.onEvent(ev);
    if (ev.type === 'hit' || ev.type === 'kill') hud.hitmarker();
    if (ev.type === 'playerHit') hud.damage();
    if (ev.type === 'downed') hud.toast('倒地！D7 接入救援流程');
    if (ev.type === 'erase' && ev.data.owner !== 0) hud.toast('队友释放擦除：剥甲 ' + ev.data.stripped + ' 层');
    if (ev.type === 'fold' && ev.data.owner !== 0) hud.toast('队友翻折折角：' + (ev.data.state === 'wall' ? '纸墙立起' : '坡道展开'));
    if (ev.type === 'pickup' && ev.data.playerId === 0) {
      hud.toast(ev.data.ty === 'ink' ? '墨量 +' + CONFIG.pickups.inkAmount : '生命 +' + CONFIG.pickups.tapeAmount);
    }
    if (ev.type === 'anchorDone') hud.toast(ev.data.label + ' 已锚定，增援出现');
    if (ev.type === 'phase' && ev.data.phase === 'boss') hud.toast('三处锚点完成——涂改大王现身！');
    if (ev.type === 'rage') hud.toast('涂改大王进入狂暴：护盾失效，弹速提升');
    if (ev.type === 'bossDown') hud.toast('涂改大王被修订归档——裁切线开启！');
    if (ev.type === 'win') finish(true, '三处锚点已恢复，你从裁切线安全撤离。');
    if (ev.type === 'lose') finish(false, ev.data.reason === 'time' ? '时间耗尽，纸页被涂改淹没。' : '生命值耗尽，纸页被涂改灵覆盖。');
  }
}
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused) runtime.advance(now);
  processEvents();
  if (drawStart) {
    const v = validateDraw(match, match.players[0], drawStart, aimGround());
    renderer.setDrawPreview(v.a, v.b, v.ok);
  }
  const snap = runtime.snapshot();
  renderer.update(snap, dt);
  hud.update(snap, match.grace, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 自动化验收钩子（仅开发页；生产单文件 D9 决定是否保留）
window.__CLIENT_DEBUG__ = {
  get runtime() { return runtime; },
  get match() { return match; },
  renderer, hud, input,
  state() {
    const p = match.players[0];
    return {
      tick: match.tick, seed, grace: +match.grace.toFixed(2), kills: match.kills,
      phase: match.phase, anchorsDone: match.anchorsDone,
      anchors: match.anchors.map(a => ({ i: a.i, active: a.active, progress: +a.progress.toFixed(2) })),
      exitUnlocked: match.exitUnlocked, exitProgress: +match.exitProgress.toFixed(2),
      walls: match.walls.map(w => ({ id: w.id, len: +w.len.toFixed(2), hp: w.hp, life: +w.life.toFixed(2), owner: w.owner })),
      boss: match.boss ? { hp: match.boss.hp, raged: match.boss.raged, dead: match.boss.dead } : null,
      hp: p.hp, ink: +p.ink.toFixed(1), ammo: p.ammo, reload: +p.reload.toFixed(2), eraseCd: +p.eraseCd.toFixed(2),
      pos: { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) },
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      stats: { ...p.stats },
      folds: match.folds.map(f => ({ id: f.id, state: f.state, anim: +f.animT.toFixed(2) })),
      enemies: match.enemies.filter(e => !e.dead).map(e => ({ id: e.id, type: e.type, x: +e.x.toFixed(2), z: +e.z.toFixed(2), hp: e.hp, armor: e.armor, stun: +e.stun.toFixed(2), slow: +e.slow.toFixed(2), telegraph: +e.telegraph.toFixed(2) })),
      projectiles: match.projectiles.length,
    };
  },
  teleport(x, z) { const p = match.players[0]; p.pos.x = x; p.pos.z = z; p.pos.y = 1.65; p.velX = p.velZ = p.velY = 0; },
  aimAt(x, y, z) {
    const p = match.players[0];
    const dx = x - p.pos.x, dy = y - p.pos.y, dz = z - p.pos.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    p.yaw = yaw; p.pitch = pitch;
    input.setView(yaw, pitch);
    return { yaw, pitch };
  },
  shoot() {
    const p = match.players[0];
    const cp = Math.cos(p.pitch);
    return shootDir({ x: -Math.sin(p.yaw) * cp, y: Math.sin(p.pitch), z: -Math.cos(p.yaw) * cp });
  },
  drawWall(ax, az, bx, bz) {
    const start = runtime.action(0, { m: 'drawStart' });
    if (!start.ok) return start;
    return runtime.action(0, { m: 'drawEnd', ax, az, bx, bz });
  },
  setHold(v) {
    runtime.setInput(0, { ...lastIntent, hold: v });
  },
  aimGround,
  draw: handleDraw,
  cancelDraw,
  erase: handleErase,
  fold: handleFold,
  step(n = 1) { for (let i = 0; i < n; i++) runtime.tickOnce(); },
  // 隐藏面板会停 rAF：验收手动泵事件+渲染+HUD（与 frame 同路径）
  pump(dt = 0.05) {
    processEvents();
    const snap = runtime.snapshot();
    renderer.update(snap, dt);
    hud.update(snap, match.grace, dt);
    return snap;
  },
  pause(v = true) { paused = v; },
  restart,
  spawnCrane(x, z) { return createEnemy(match, 'crane', x, z, { spawnAnim: true }).id; },
};