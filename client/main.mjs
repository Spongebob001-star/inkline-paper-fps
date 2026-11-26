// D4 开发入口：单人 = 房主运行时本地特例（零插值直读最新快照）。
// 完整闭环：初始波次 → 画墙 → 锚点共持 → Boss → 撤离胜负 → 再来一局。
import CONFIG from '../shared/config.mjs';
import { drainEvents, createPlayer, weaponOf } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { createBoss } from '../shared/boss.mjs';
import { validateDraw } from '../shared/walls.mjs';
import { nearestFold } from '../shared/folds.mjs';
import { SPAWNS, ANCHORS, EXIT, groundHeightAt } from '../shared/world.mjs';
import { losBlocker, HITBOX } from '../shared/combat.mjs';
import { createRuntime } from '../host/runtime.mjs';
import { createRenderer } from './render.mjs';
import { createInput } from './input.mjs';
import { createHud, computeRank } from './hud.mjs';
import { createAudio } from './audio.mjs';
import { createBgm } from './bgm.mjs';
import { rollPerkChoices } from '../shared/perks.mjs';
import { createGuide } from './guide.mjs';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, applySettings } from './settings.mjs';

const THREE = window.THREE;
if (!THREE) {
  document.body.innerHTML = '<p style="padding:2em;font-family:sans-serif">3D 引擎未载入（需要 /src/three/three.min.js）。</p>';
  throw new Error('THREE missing');
}

const envWarn = document.getElementById('env-warn');
if (envWarn) {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
  const mobile = !!mq && mq('(pointer: coarse)').matches && mq('(max-width: 900px)').matches;
  if (mobile || /MicroMessenger|QQ\//i.test(ua)) envWarn.classList.toggle('on', true);
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
let seed = Number(params.get('seed')) || ((Date.now() & 0x7fffffff) >>> 0);
let runtime = null, match = null;
let drawStart = null;
let ended = false;
let perkPaused = false, settingsPaused = false, perkVisible = false, pauseOffset = 0;
let offer = null, perkQueue = [], crits = 0, interrupts = 0;
let killCombo = 0, lastKillAt = -Infinity;
let stepAccum = 0, lastStepX = 0, lastStepZ = 0, prevGrounded = true, prevVelY = 0;
let heartT = 0, anchorBucket = 0, laughDuck = false;
const enemyTele = new Map();
let godMode = false; // 无敌观测：I 键切换，重开保持
let godUsed = false; // 本局是否开过无敌（用于结算标注）
let settings = loadSettings();
const guide = createGuide({ enabled: settings.showGuide });

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas);
const hud = createHud(document.getElementById('hud'), {
  onRestart: () => restart(), onToggleMute: () => audio.toggleMute(),
  onSettings: () => toggleSettings(), onSettingsClose: () => toggleSettings(false),
  onSettingsReset: () => changeSettings(DEFAULT_SETTINGS),
  onSettingChange: (key, value) => changeSettings({ ...settings, [key]: value }),
  onGuideToggle: () => changeSettings({ ...settings, showGuide: !settings.showGuide }),
  onPickPerk: id => pickPerk(id), onSkipPerk: () => skipPerk(), onNewSeed: () => restart(true),
  onWeapon: idx => handleWeapon(idx),
  onQuickWall: () => handleQuickWall(), onErase: () => handleErase(), onFold: () => handleFold(),
  onDash: () => input.triggerDash(), onReload: () => handleReload(),
  onTouchFire: on => input.setTouchFire(on), onTouchHold: on => input.setTouchHold(on),
  onTouchJump: () => input.triggerJump(), onTouchWall: () => handleQuickWall(),
  onTouchADS: () => input.toggleADS(),
});
const bgm = createBgm();
const audio = createAudio({ onMuteChange: muted => {
  renderer.setBossSoundMuted(muted); hud.setMuted(muted);
  bgm.setMuted(muted);
} });
renderer.setBossSoundMuted(audio.isMuted());
hud.setMuted(audio.isMuted());
bgm.setMuted(audio.isMuted());
const hitFeedback = new WeakMap();
// 20Hz 权威步进 → 原生刷新率帧间插值：记录每步之前的位姿，渲染时 prev + (curr-prev)*alpha。
let prevPose = null;
const POSE_JUMP_MAX = 2.5;
function poseNow() {
  const p = match.players[0];
  return {
    px: p.pos.x, py: p.pos.y, pz: p.pos.z,
    enemies: match.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, z: e.z })),
    boss: match.boss && !match.boss.dead ? { x: match.boss.x, z: match.boss.z } : null,
    projectiles: match.projectiles.map(pr => ({ id: pr.id, x: pr.x, y: pr.y, z: pr.z })),
  };
}
const mix = (a, b, t) => a + (b - a) * t;
const closeStep = (a, b) => Math.abs(b - a) <= POSE_JUMP_MAX;
function viewSnapshot() {
  const snap = runtime.snapshot();
  const p0 = match.players[0];
  // 本地视角用未截断的精确浮点（协议快照的 toFixed(4) 只服务联机）
  snap.players[0].yaw = p0.yaw;
  snap.players[0].pitch = p0.pitch;
  snap.players[0].vx = p0.velX;
  snap.players[0].vz = p0.velZ;
  snap.players[0].ads = input.ads;
  snap.players[0].god = !!p0.god;
  const prev = prevPose;
  if (prev) {
    const a = runtime.alpha();
    const me = snap.players[0];
    if (closeStep(prev.px, me.x) && closeStep(prev.py, me.y) && closeStep(prev.pz, me.z)) {
      me.x = mix(prev.px, me.x, a);
      me.y = mix(prev.py, me.y, a);
      me.z = mix(prev.pz, me.z, a);
    }
    if (prev.enemies.length) {
      const byId = new Map(prev.enemies.map(e => [e.id, e]));
      for (const e of snap.enemies) {
        const q = byId.get(e.id);
        if (q && closeStep(q.x, e.x) && closeStep(q.y, e.y) && closeStep(q.z, e.z)) {
          e.x = mix(q.x, e.x, a); e.y = mix(q.y, e.y, a); e.z = mix(q.z, e.z, a);
        }
      }
    }
    if (prev.boss && snap.boss && closeStep(prev.boss.x, snap.boss.x) && closeStep(prev.boss.z, snap.boss.z)) {
      snap.boss.x = mix(prev.boss.x, snap.boss.x, a);
      snap.boss.z = mix(prev.boss.z, snap.boss.z, a);
    }
    if (prev.projectiles.length) {
      const byId = new Map(prev.projectiles.map(pr => [pr.id, pr]));
      for (const pr of snap.projectiles) {
        const q = byId.get(pr.id);
        if (q && closeStep(q.x, pr.x) && closeStep(q.y, pr.y) && closeStep(q.z, pr.z)) {
          pr.x = mix(q.x, pr.x, a); pr.y = mix(q.y, pr.y, a); pr.z = mix(q.z, pr.z, a);
        }
      }
    }
  }
  for (const w of snap.walls) {
    const source = match.walls.find(wall => wall.id === w.id);
    w.ux = source.ux; w.uz = source.uz;
  }
  return snap;
}

function updateLockHint() {
  const touch = input.isTouch?.() === true;
  document.getElementById('lock-hint').style.display = !touch && !input.locked && !ended && !settingsPaused && !perkVisible ? 'flex' : 'none';
  hud.setTouchVisible?.(touch && !ended && !settingsPaused && !perkVisible);
}
function clearControls() {
  input.clear();
  runtime.clearInput(0);
  lastIntent = { f: 0, r: 0 };
}
function changeSettings(next) {
  settings = saveSettings(next);
  applySettings(settings, { input, renderer, audio, guide, bgm });
  hud.syncSettings(settings);
  hud.updateGuide(guide.state());
  return { ...settings };
}
function syncBgmPause() {
  bgm.setPaused(settingsPaused || perkVisible || ended || document.hidden === true);
}
function toggleSettings(show = !settingsPaused) {
  settingsPaused = !!show;
  clearControls();
  if (settingsPaused) {
    if (document.pointerLockElement) document.exitPointerLock();
    hud.hidePerks();
    hud.showSettings(settings);
  } else {
    hud.hideSettings();
    if (perkVisible && offer) hud.showPerks(offer.ids);
  }
  updateLockHint();
  syncBgmPause();
}
function showNextPerk() {
  if (ended || !perkQueue.length) return;
  const anchorIdx = perkQueue.shift();
  const ids = rollPerkChoices(match.seed, anchorIdx, match.players[0].perks);
  if (!ids.length) return;
  offer = { anchorIdx, ids };
  perkVisible = true;
  perkPaused = match.players.length === 1;
  clearControls();
  if (!settingsPaused) hud.showPerks(ids);
  updateLockHint();
  syncBgmPause();
}
function pickPerk(perkId) {
  if (ended || !offer?.ids.includes(perkId)) return { ok: false, reason: 'choice' };
  const result = runtime.action(0, { m: 'perk', perkId });
  if (!result.ok) return result;
  offer = null;
  perkPaused = perkVisible = false;
  hud.hidePerks();
  clearControls();
  showNextPerk();
  updateLockHint();
  syncBgmPause();
  return result;
}
function skipPerk() {
  if (!offer || settingsPaused) return;
  perkPaused = perkVisible = false;
  hud.hidePerks();
  clearControls();
  hud.toast('强化已暂存，按 Tab 返回选择');
  updateLockHint();
  syncBgmPause();
}
function resetPanels() {
  perkPaused = settingsPaused = perkVisible = false;
  offer = null;
  perkQueue = [];
  hud.hidePerks();
  hud.hideSettings();
}

function spawnInitialWave() {
  const n = CONFIG.scaling[1].initial;
  for (let i = 0; i < n; i++) {
    const type = CONFIG.waves.initial[i % CONFIG.waves.initial.length];
    const [x, z] = CONFIG.waves.spots[i % CONFIG.waves.spots.length];
    createEnemy(match, type, x, z, { spawnAnim: true });
  }
}
function initMatch() {
  runtime = createRuntime({ seed, playerIds: [0], onBeforeStep: () => { prevPose = poseNow(); } });
  match = runtime.match;
  spawnInitialWave();
  prevPose = poseNow();
  drawStart = null;
  ended = false;
  stepAccum = heartT = anchorBucket = 0;
  lastStepX = match.players[0].pos.x; lastStepZ = match.players[0].pos.z;
  prevGrounded = match.players[0].grounded; prevVelY = 0;
  laughDuck = false;
  enemyTele.clear();
  bgm.setDuck(false);
  renderer.reset();
  hud.hideSettlement();
  hud.drawHint(false);
  hud.resetCache();
  resetPanels();
  guide.reset();
  hud.updateGuide(guide.state());
  bgm.setMode('anchors');
  syncBgmPause();
  if (godMode) { runtime.action(0, { m: 'god', on: true }); }
  hud.setGod(godMode);
  crits = interrupts = pauseOffset = killCombo = 0;
  lastKillAt = -Infinity;
  godUsed = false;
}
function restart(newSeed = false) {
  if (newSeed) {
    const next = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
    seed = next === seed ? (next + 1) & 0x7fffffff : next;
  }
  audio.stop();
  initMatch();
  clearControls();
  updateLockHint();
  bgm.setMode('anchors');
  hud.toast(newSeed ? '新随机局 · 种子 ' + seed : '新的一局：同种子重开');
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
    if (!res.ok) { hud.toast('至少需要 ' + Math.ceil(CONFIG.ink.minDrawCost * (p.perks.includes('quick_ink') ? CONFIG.perks.quick_ink.mods.drawCostMul : 1)) + ' 墨量'); return; }
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

function handleQuickWall() {
  if (ended || match.phase === 'won' || match.phase === 'lost') return;
  cancelDraw();
  input.cancelADS();
  const p = match.players[0];
  const start = runtime.action(0, { m: 'drawStart' });
  if (!start.ok) { hud.toast('至少需要 ' + Math.ceil(CONFIG.ink.minDrawCost * (p.perks.includes('quick_ink') ? CONFIG.perks.quick_ink.mods.drawCostMul : 1)) + ' 墨量'); return start; }
  const yaw = input.yaw;
  const x = p.pos.x - Math.sin(yaw) * 3.5, z = p.pos.z - Math.cos(yaw) * 3.5;
  const rx = Math.cos(yaw) * 1.6, rz = -Math.sin(yaw) * 1.6;
  const clamp = v => Math.max(-16.5, Math.min(16.5, v));
  const res = runtime.action(0, { m: 'drawEnd', ax: clamp(x - rx), az: clamp(z - rz), bx: clamp(x + rx), bz: clamp(z + rz) });
  hud.toast(res.ok ? '速墙已立起!' : res.reason === 'ink' ? '需要 ' + Math.ceil(res.cost) + ' 墨量' : (DRAW_FAIL[res.reason] || '无法画线'));
  return res;
}

function handleErase() {
  if (ended || match.phase === 'won' || match.phase === 'lost') return;
  const res = runtime.action(0, { m: 'erase' });
  if (res.ok) hud.toast(res.stripped ? '擦除了 ' + res.stripped + ' 层护甲' : '脉冲已释放');
  else if (res.reason === 'cooldown') hud.toast('擦除冷却 ' + res.cd.toFixed(1) + ' 秒');
  else if (res.reason === 'ink') hud.toast('擦除需要 ' + CONFIG.ink.eraseCost + ' 墨量');
  else if (res.reason === 'dead') hud.toast('倒地中无法擦除');
  return res;
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
  const shielded = match.boss && !match.boss.raged;
  const weapon = p.weapon, w = weaponOf(p);
  const start = match.events.length, reload = p.reload;
  const result = runtime.action(0, { m: 'shot', ox: p.pos.x, oy: p.pos.y, oz: p.pos.z, dx: dir.x, dy: dir.y, dz: dir.z });
  for (let i = start; i < match.events.length; i++) {
    const ev = match.events[i];
    hitFeedback.set(ev, { shielded, weapon, w });
  }
  if (reload === 0 && p.reload > 0) { input.cancelADS(); audio.reload(weapon); }
  return result;
}
function handleWeapon(idx) {
  if (ended) return { ok: false };
  const result = runtime.action(0, { m: 'weapon', weapon: idx });
  if (result.ok) { input.cancelADS(); audio.weaponSwitch(); guide.weaponChanged(); }
  return result;
}
function handleReload() {
  input.cancelADS();
  const before = match.players[0].reload;
  const result = runtime.action(0, { m: 'reload' });
  if (before === 0 && match.players[0].reload > 0) audio.reload(match.players[0].weapon);
  return result;
}
function toggleGod(force) {
  if (ended) return { ok: false, reason: 'ended' };
  const on = force === undefined ? !match.players[0].god : !!force;
  const result = runtime.action(0, { m: 'god', on });
  if (!result.ok) return result;
  godMode = result.god;
  if (godMode) godUsed = true;
  hud.setGod(godMode);
  hud.toast(godMode ? '无敌观测已开启：免疫伤害与击退，再按 I 关闭' : '无敌观测已关闭');
  return result;
}
let lastIntent = { f: 0, r: 0 };
const input = createInput(canvas, {
  isBlocked: () => settingsPaused || perkVisible || ended,
  onIntent: it => { lastIntent = it; runtime.setInput(0, it); },
  onLook: (yaw, pitch) => {
    const p = match.players[0];
    if (!p || p.st !== 0 || ended || settingsPaused || perkVisible) return;
    p.yaw = yaw;
    p.pitch = Math.max(-1.5, Math.min(1.5, pitch));
  },
  onShot: dir => shootDir(dir),
  onReload: handleReload,
  onWeapon: handleWeapon,
  onQuickWall: handleQuickWall,
  getWeapon: () => match.players[0].weapon,
  getFireInterval: () => weaponOf(match.players[0]).fireInterval,
  isDrawing: () => drawStart !== null,
  canADS: () => !ended && match.players[0].st === 0 && match.players[0].reload === 0,
  onDraw: handleDraw,
  onCancelDraw: cancelDraw,
  onErase: handleErase,
  onFold: handleFold,
  onTouchMode: () => { syncForceLandscape(); hud.setTouchMode(true); updateLockHint(); },
  onLock: (locked, warn, fallback) => {
    const hint = document.getElementById('lock-hint');
    hint.style.display = input.isTouch?.() || locked || ended || settingsPaused || perkVisible ? 'none' : 'flex';
    hint.classList.toggle('compatibility', fallback);
    document.getElementById('lock-status').textContent = fallback
      ? '兼容模式：鼠标未锁定，仅画面内移动可转向；点击画面重试锁定'
      : '点击画面锁定鼠标继续战斗（Esc 释放 / F11 全屏）';
    if (warn) hud.toast(warn);
  },
});

document.addEventListener('keydown', ev => {
  if (ev.repeat) return;
  if (ev.code === 'KeyM') { ev.preventDefault(); audio.toggleMute(); }
  if (ev.code === 'KeyO') { ev.preventDefault(); toggleSettings(); }
  if (ev.code === 'KeyH') { ev.preventDefault(); changeSettings({ ...settings, showGuide: !settings.showGuide }); }
  if (ev.code === 'KeyI') { ev.preventDefault(); toggleGod(); }
  if (settingsPaused || ended) return;
  if (offer && ev.code === 'Tab') {
    ev.preventDefault();
    if (perkVisible) skipPerk();
    else {
      perkVisible = true;
      perkPaused = match.players.length === 1;
      clearControls();
      hud.showPerks(offer.ids);
      updateLockHint();
    }
  }
  const index = ['KeyZ', 'KeyX', 'KeyV'].indexOf(ev.code);
  if (perkVisible && index >= 0) { ev.preventDefault(); pickPerk(offer.ids[index]); }
});
document.addEventListener('visibilitychange', syncBgmPause);
window.addEventListener('blur', () => bgm.setPaused(true));
window.addEventListener('focus', () => syncBgmPause());

const enterButton = document.getElementById('enter-btn');
for (const name of ['pointerdown', 'mousedown', 'mouseup', 'keydown', 'keyup']) enterButton.addEventListener(name, ev => ev.stopPropagation());
function touchDevice() {
  if (typeof window === 'undefined') return false;
  try {
    return !!window.matchMedia?.('(pointer: coarse)').matches;
  } catch (_) { return false; }
}
function syncForceLandscape() {
  if (typeof window === 'undefined') return false;
  const on = !!((input.isTouch?.() || touchDevice()) && window.innerWidth < window.innerHeight);
  const root = document.documentElement;
  if (!root?.classList?.contains) return on;
  const changed = root.classList.contains('force-landscape') !== on;
  root.classList.toggle('force-landscape', on);
  if (changed) renderer.resize?.();
  if (on && !input.isTouch?.()) {
    const status = document.getElementById?.('lock-status');
    if (status) status.textContent = '触屏模式：点击进入战场（自动保持横屏）';
  }
  return on;
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', syncForceLandscape);
  window.addEventListener('orientationchange', () => {
    syncForceLandscape();
    setTimeout(syncForceLandscape, 120);
  });
}
syncForceLandscape();
enterButton.addEventListener('click', ev => {
  ev.stopPropagation(); enterButton.blur();
  if (input.isTouch?.() || touchDevice()) {
    const lockLandscape = () => {
      try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch (_) {}
    };
    try {
      const full = document.documentElement.requestFullscreen?.();
      if (full?.then) full.then(lockLandscape, lockLandscape);
      else lockLandscape();
    } catch (_) { lockLandscape(); }
    input.enableTouch();
    return;
  }
  input.requestLock();
});
const fullscreenButton = document.getElementById('fs-btn');
for (const name of ['pointerdown', 'mousedown', 'mouseup', 'keydown', 'keyup']) fullscreenButton.addEventListener(name, ev => ev.stopPropagation());
fullscreenButton.addEventListener('click', ev => {
  ev.stopPropagation(); fullscreenButton.blur();
  try {
    const result = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
    if (result?.catch) result.catch(() => hud.toast('浏览器未允许全屏，可按 F11'));
  } catch (_) { hud.toast('浏览器未允许全屏，可按 F11'); }
});

function finish(won, reason) {
  if (ended) return;
  ended = true;
  resetPanels();
  updateLockHint();
  hud.updateGuide({ ...guide.state(), visible: false });
  cancelDraw();
  input.releaseFire();
  input.cancelADS();
  bgm.setMode('idle');
  syncBgmPause();
  if (document.pointerLockElement) document.exitPointerLock();
  const best = loadBest();
  const isNew = won && !godUsed ? saveBest(match.elapsed) : false;
  const hp = match.players[0].hp;
  const rank = computeRank({ won, time: match.elapsed, hp, crits, interrupts });
  if (rank) audio.stamp();
  hud.showSettlement({
    won,
    reason,
    time: match.elapsed,
    kills: match.kills,
    players: match.players.map(p => ({ id: p.id, ...p.stats })),
    best: won ? (isNew ? match.elapsed : best) : best,
    isNew,
    perks: match.players[0].perks.slice(), crits, interrupts,
    rank, god: godUsed, hp,
  });
}

const startSettingsButton = document.getElementById('start-settings-btn');
for (const type of ['pointerdown', 'mousedown', 'mouseup']) startSettingsButton.addEventListener(type, ev => ev.stopPropagation());
startSettingsButton.addEventListener('click', ev => { ev.stopPropagation(); startSettingsButton.blur(); toggleSettings(true); });
applySettings(settings, { input, renderer, audio, guide, bgm });
initMatch();

let lastFrame = performance.now();
let paused = false;
function processEvents() {
  const events = drainEvents(match);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    guide.onEvent(ev);
    const armored = ev.type === 'hit' && (ev.data.armored || (events[i - 1]?.type === 'armorStrip' && events[i - 1].data.id === ev.data.id));
    const feedback = hitFeedback.get(ev);
    const weapon = ev.data.weapon ?? feedback?.weapon ?? 0;
    const visual = ev.type === 'impact' ? { ...ev, data: { ...ev.data, enemy: !feedback && ev.data.shooterId === undefined && events[i + 1]?.type !== 'shot' } }
      : ev.type === 'hit' ? { ...ev, data: { ...ev.data, armored } }
      : ev.type === 'shot' ? { ...ev, data: { ...ev.data, weapon } } : ev;
    renderer.onEvent(visual);
    if (ev.type === 'shot' && ev.data.id === 0) { audio.shot(weapon); hud.shot(); }
    if (ev.type === 'hit') {
      hud.hitmarker(false, !!ev.data.critKind);
      const shielded = ev.data.boss && (feedback?.shielded ?? !match.boss?.raged);
      const w = feedback?.w || CONFIG.player.weapons[weapon];
      const amount = ev.data.dealt ?? (armored ? w.armorDamage : shielded ? Math.ceil(w.damage * CONFIG.boss.shieldMul) : w.damage);
      const crit = ev.data.critKind;
      if (crit) {
        crits++;
        audio.crit();
        hud.spawnDmgNumber(ev.data.point, (crit === 'head' ? '爆头 -' : '暴击 -') + amount + '!', crit === 'head' ? 'head' : 'crit');
      } else {
        audio.hit(armored);
        hud.spawnDmgNumber(ev.data.point, '-' + amount, armored ? 'armor' : shielded ? 'shield' : 'damage');
      }
    }
    if (ev.type === 'bossStun' || ev.type === 'bossInterrupt') {
      audio.bossStun();
      hud.toast((ev.type === 'bossStun' ? '奶龙撞墙！' : '擦除打断奶龙蓄力！') + '破盾眩晕 ' + ev.data.duration.toFixed(1) + 's，快集火！');
    }
    if (ev.type === 'kill') {
      killCombo = match.elapsed - lastKillAt <= 3.5 ? killCombo + 1 : 1;
      lastKillAt = match.elapsed;
      hud.hitmarker(true, false, killCombo);
      audio.kill(killCombo);
      audio.paperTear();
    }
    if (ev.type === 'bite' || ev.type === 'wallBite') {
      const p0 = match.players[0];
      let d = 3;
      if (ev.type === 'bite') {
        const e = match.enemies.find(en => en.id === ev.data.id);
        if (e) d = Math.hypot(p0.pos.x - e.x, p0.pos.z - e.z);
      } else {
        d = Math.hypot(p0.pos.x - ev.data.x, p0.pos.z - ev.data.z);
      }
      if (d <= 20) audio.eraserBite(distFactor(d));
    }
    if (ev.type === 'dive') {
      const p0 = match.players[0];
      const e = match.enemies.find(en => en.id === ev.data.id);
      if (e) {
        const d = Math.hypot(p0.pos.x - e.x, p0.pos.z - e.z);
        if (d <= 20) audio.planeDive(distFactor(d));
      }
    }
    if (ev.type === 'armorStrip') {
      audio.armorStrip();
      const e = match.enemies.find(enemy => enemy.id === ev.data.id);
      if (e) hud.spawnDmgNumber({ x: e.x, y: e.y + 1.5, z: e.z }, '破甲!', 'strip');
    }
    if (ev.type === 'wallDraw') audio.wallDraw();
    if (ev.type === 'erase') audio.erase();
    if (ev.type === 'fold') audio.fold();
    if (ev.type === 'pickup' && ev.data.playerId === 0) audio.pickup();
    if (ev.type === 'playerHit' && ev.data.id === 0) {
      hud.damage();
      audio.playerHit();
      if (Number.isFinite(ev.data.sx)) hud.damageFrom(ev.data.sx, ev.data.sz);
    }
    if (ev.type === 'dash') {
      if (ev.data.id === 0) { audio.dash(); hud.dashFlash(); }
    }
    if (ev.type === 'downed') {
      if (ev.data.id === 0) {
        cancelDraw();
        input.releaseFire();
        input.cancelADS();
        if (match.players.length === 1) {
          if (match.players[0].st === 1) {
            hud.toast('你已倒地！按住 F 键 2 秒墨力自救（本局剩余 1 次）');
          }
        } else {
          hud.toast('你已倒地！' + CONFIG.player.down.time + ' 秒内等待队友救援');
        }
      } else hud.toast('P' + (ev.data.id + 1) + ' 倒地，靠近按住 F 救援');
    }
    if (ev.type === 'revive') {
      if (ev.data.id === 0 && ev.data.by === 0) {
        hud.toast('墨力自救成功！恢复 ' + CONFIG.player.down.reviveHp + ' 生命并获得 1 秒无敌');
      } else {
        hud.toast('P' + (ev.data.id + 1) + ' 已被 P' + (ev.data.by + 1) + ' 救起');
      }
    }
    if (ev.type === 'downExpire') hud.toast('P' + (ev.data.id + 1) + ' 已阵亡');
    if (ev.type === 'erase' && ev.data.owner !== 0) hud.toast('队友释放擦除：剥甲 ' + ev.data.stripped + ' 层');
    if (ev.type === 'fold' && ev.data.owner !== 0) hud.toast('队友翻折折角：' + (ev.data.state === 'wall' ? '纸墙立起' : '坡道展开'));
    if (ev.type === 'pickup' && ev.data.playerId === 0) {
      hud.toast(ev.data.ty === 'ink' ? '墨量 +' + CONFIG.pickups.inkAmount : '生命 +' + CONFIG.pickups.tapeAmount);
    }
    if (ev.type === 'bossInterrupt' && ev.data.by === 0) interrupts++;
    if (ev.type === 'perkPick' && ev.data.playerId === 0) {
      audio.perkPick();
      hud.toast('已装订强化：' + ev.data.name);
    }
    if (ev.type === 'anchorDone') {
      hud.toast(ev.data.label + ' 已锚定，增援出现');
      audio.anchorDone();
      if (!paused && !ended && match.players[0].st === 0 && match.phase !== 'won' && match.phase !== 'lost') {
        perkQueue.push(ev.data.i);
        if (!offer) showNextPerk();
      }
    }
    if (ev.type === 'phase' && ev.data.phase === 'boss') hud.toast('三处锚点完成——涂改大王现身！');
    if (ev.type === 'bossSpawn') {
      audio.bossSpawn();
      hud.showPhaseBanner(1, CONFIG.boss.phaseTitles[0]);
      bgm.setMode('boss12');
    }
    if (ev.type === 'rage') hud.toast('涂改大王进入暴走：双层交错弹幕，弹速提升');
    if (ev.type === 'bossPhase') {
      audio.bossPhase(ev.data.phase);
      hud.showPhaseBanner(ev.data.phase, ev.data.title);
      hud.toast(ev.data.phase === 2 ? '阶段 2：注意二连折返冲锋与双层弹幕' : '阶段 3：护盾尽碎，三段冲锋与墨雨齐发！');
      if (ev.data.phase === 2) bgm.setMode('boss12');
      if (ev.data.phase === 3) bgm.setMode('boss3');
    }
    if (ev.type === 'waveBurst') audio.bossWave();
    if (ev.type === 'mortarBoom') audio.mortarBoom();
    if (ev.type === 'bossSlam') audio.bossSlam();
    if (ev.type === 'bossDown') {
      hud.toast('涂改大王被修订归档——裁切线开启！');
      bgm.setMode('escape');
    }
    if (ev.type === 'win') finish(true, '三处锚点已恢复，你从裁切线安全撤离。');
    if (ev.type === 'lose') finish(false, ev.data.reason === 'time' ? '时间耗尽，纸页被涂改淹没。' : '生命值耗尽，纸页被涂改灵覆盖。');
  }
}
function updateGuide(snap, dt) {
  guide.update(snap, dt);
  hud.updateGuide({ ...guide.state(), visible: !ended && guide.state().visible });
}
function distFactor(m) {
  return 1 - Math.max(0, Math.min(1, (m - 3) / 17)) * 0.85;
}
function updateSoundscape(dt) {
  const p = match.players[0];
  if (!p) return;
  const speed = Math.hypot(p.velX, p.velZ);
  const sprint = speed > CONFIG.player.walkSpeed + 0.2;
  if (p.st === 0 && p.grounded && speed > 0.8) {
    stepAccum += Math.hypot(p.pos.x - lastStepX, p.pos.z - lastStepZ);
    if (stepAccum >= (sprint ? 1.35 : 1.65)) {
      stepAccum = 0;
      audio.footstep(sprint);
    }
  } else stepAccum = 0;
  lastStepX = p.pos.x; lastStepZ = p.pos.z;
  if (prevGrounded && !p.grounded && p.velY > 3) audio.jump();
  if (!prevGrounded && p.grounded && prevVelY < -1) audio.land(Math.abs(prevVelY));
  prevGrounded = p.grounded; prevVelY = p.velY;
  for (const e of match.enemies) {
    if (e.dead || e.type !== 'crane') continue;
    const prev = enemyTele.get(e.id) || 0;
    if (e.telegraph > 0 && prev === 0) {
      const d = Math.hypot(p.pos.x - e.x, p.pos.z - e.z);
      if (d <= 20) audio.craneCharge(distFactor(d));
    }
    enemyTele.set(e.id, e.telegraph);
  }
  if (enemyTele.size > match.enemies.length) {
    const ids = new Set(match.enemies.map(e => e.id));
    for (const id of enemyTele.keys()) if (!ids.has(id)) enemyTele.delete(id);
  }
  audio.bulletWhiz(match.projectiles, p.pos);
  let progress = 0;
  for (const a of match.anchors) if (!a.active) progress = Math.max(progress, a.progress);
  if (match.exitUnlocked) progress = Math.max(progress, match.exitProgress);
  const bucket = Math.floor(progress * 8 + 1e-6);
  if (bucket !== anchorBucket) {
    if (bucket > anchorBucket && progress > 0) audio.anchorTick(progress);
    anchorBucket = bucket;
  }
  if (p.st === 0 && p.hp > 0 && p.hp <= 30) {
    heartT -= dt;
    if (heartT <= 0) { heartT = 0.75; audio.heartbeat(); }
  } else heartT = 0;
  const laugh = renderer.bossAudioDebug();
  const active = !!(laugh && (laugh.active || laugh.pending));
  if (active !== laughDuck) { laughDuck = active; bgm.setDuck(active); }
}

function frame(now) {
  const elapsed = now - lastFrame;
  const dt = Math.min(0.1, elapsed / 1000);
  lastFrame = now;
  if (paused || (match.players.length === 1 && (perkPaused || settingsPaused))) pauseOffset += elapsed;
  else runtime.advance(now - pauseOffset);
  processEvents();
  updateSoundscape(dt);
  if (drawStart && match.players[0].st !== 0) cancelDraw();
  if (drawStart) {
    const v = validateDraw(match, match.players[0], drawStart, aimGround());
    renderer.setDrawPreview(v.a, v.b, v.ok);
  }
  const snap = viewSnapshot();
  renderer.update(snap, dt);
  hud.update(snap, match.grace, dt, renderer.project);
  updateGuide(snap, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 自动化验收钩子（仅开发页；生产单文件 D9 决定是否保留）
window.__CLIENT_DEBUG__ = {
  get runtime() { return runtime; },
  get match() { return match; },
  renderer, hud, input, audio, guide,
  bgm,
  perkChoices() { return offer ? offer.ids.slice() : []; },
  pickPerk,
  settings() { return { ...settings }; },
  setSettings: changeSettings,
  toggleSettings,
  panels() { return { perkPaused, settingsPaused, perkVisible, paused }; },
  newSeed() { restart(true); return seed; },
  state() {
    const p = match.players[0];
    return {
      tick: match.tick, seed, grace: +match.grace.toFixed(2), kills: match.kills,
      phase: match.phase, anchorsDone: match.anchorsDone,
      anchors: match.anchors.map(a => ({ i: a.i, active: a.active, progress: +a.progress.toFixed(2) })),
      exitUnlocked: match.exitUnlocked, exitProgress: +match.exitProgress.toFixed(2),
      walls: match.walls.map(w => ({ id: w.id, len: +w.len.toFixed(2), hp: w.hp, life: +w.life.toFixed(2), owner: w.owner })),
      boss: match.boss ? { hp: match.boss.hp, raged: match.boss.raged, dead: match.boss.dead, state: match.boss.state, t: +match.boss.telegraph.toFixed(2) } : null,
      hp: p.hp, ink: +p.ink.toFixed(1), ammo: p.ammo, reload: +p.reload.toFixed(2), eraseCd: +p.eraseCd.toFixed(2),
      god: !!p.god,
      pos: { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) },
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      players: match.players.map(pl => ({
        id: pl.id, hp: +pl.hp.toFixed(1), st: pl.st, dt: +pl.downT.toFixed(2),
        rv: +pl.reviveProgress.toFixed(2), iv: +pl.invuln.toFixed(2),
        x: +pl.pos.x.toFixed(2), z: +pl.pos.z.toFixed(2),
      })),
      stats: { ...p.stats },
      folds: match.folds.map(f => ({ id: f.id, state: f.state, anim: +f.animT.toFixed(2) })),
      enemies: match.enemies.filter(e => !e.dead).map(e => ({ id: e.id, type: e.type, x: +e.x.toFixed(2), z: +e.z.toFixed(2), hp: e.hp, armor: e.armor, stun: +e.stun.toFixed(2), slow: +e.slow.toFixed(2), telegraph: +e.telegraph.toFixed(2) })),
      projectiles: match.projectiles.length,
    };
  },
  teleport(x, z) { const p = match.players[0]; p.pos.x = x; p.pos.z = z; p.pos.y = 1.65; p.velX = p.velZ = p.velY = 0; prevPose = poseNow(); },
  god: (on) => toggleGod(on),
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
  quickWall: handleQuickWall,
  weapon: handleWeapon,
  reload: handleReload,
  cancelDraw,
  erase: handleErase,
  fold: handleFold,
  step(n = 1) { for (let i = 0; i < n; i++) runtime.tickOnce(); },
  // 隐藏面板会停 rAF：验收手动泵事件+渲染+HUD（与 frame 同路径）
  pump(dt = 0.05) {
    processEvents();
    updateSoundscape(dt);
    prevPose = poseNow();
    const snap = viewSnapshot();
    renderer.update(snap, dt);
    hud.update(snap, match.grace, dt, renderer.project);
    updateGuide(snap, dt);
    return snap;
  },
  pause(v = true) { paused = v; },
  restart,
  spawnCrane(x, z) { return createEnemy(match, 'crane', x, z, { spawnAnim: true }).id; },
  spawnBoss() { return match.boss || createBoss(match); },
  // D7 UI 验收：多人注入（上限 4）、定点倒地、bot 输入
  addPlayers(n = 1) {
    const added = [];
    while (added.length < n && match.players.length < 4) {
      const id = match.players.length;
      match.players.push(createPlayer(id, SPAWNS[id % SPAWNS.length]));
      added.push(id);
    }
    return added;
  },
  downPlayer(id = 1) {
    const p = match.players.find(pl => pl.id === id);
    if (!p || p.st !== 0) return false;
    p.hp = 0;
    p.st = 1;
    p.downT = CONFIG.player.down.time;
    p.reviveProgress = 0;
    p.reviveBy = null;
    match.events.push({ type: 'downed', data: { id } });
    return true;
  },
  botInput(id, input) { runtime.setInput(id, input); return true; },
  // T7.5 离线整局验收：页内 bot 复用与 tests/sim-match.mjs 同一份内核判定
  kernel: { CONFIG, ANCHORS, EXIT, groundHeightAt, losBlocker, HITBOX, createEnemy },
  teleportTo(id, x, z) {
    const p = match.players.find(pl => pl.id === id);
    if (!p) return false;
    p.pos.x = x; p.pos.z = z; p.pos.y = CONFIG.player.eyeHeight;
    p.velX = p.velZ = p.velY = 0;
    if (id === 0) prevPose = poseNow();
    return true;
  },
};