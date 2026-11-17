/* ============================================================
   INKLINE：墨线突围 · Prototype 0.2
   纸笔世界 FPS：画线造掩体、擦除破防御，锚定三处装订锚点后撤离。

   结构目录：
     0. 配置表（所有可调数值集中于此）
     1. 设置（localStorage 持久化）
     2. DOM 缓存与全局开关
     3. 游戏状态
     4. Three.js 初始化与世界构建
     5. 物理（圆体碰撞 / 射线视线）
     6. 玩家（移动 / 射击 / 换弹 / 跳跃）
     7. 画线掩体
     8. 擦除脉冲
     9. 敌人（AI / 增援 / 护甲）
     10. 敌方投射物（可躲避墨弹）
     11. 特效（对象池：粒子 / 曳光线 / 擦除光环）
     12. 导航辅助（锚点光柱 + 屏幕边缘箭头）
     13. HUD（脏检查，值变化才写 DOM）
     14. 流程（开始 / 暂停 / 结算 / 重开 / 最佳成绩）
     15. 音频（WebAudio 合成音）
     16. 输入（桌面指针锁定 + 兼容模式 + 触屏）
     17. 主循环与启动（含 ?debug=1 调试钩子）
   ============================================================ */
(() => {
'use strict';

// 尽早安装错误收集（诊断启动问题用；正常游玩无副作用）
window.addEventListener('error', e => {
  (window.__inklineErrors = window.__inklineErrors || []).push(String(e.message || e));
});

/* ================= 0. 配置表 ================= */
const CONFIG = {
  round: { timeLimit: 240, graceTime: 4 },
  player: {
    radius: .34,
    eyeHeight: 1.65,
    maxHp: 100,
    walkSpeed: 4.8,
    sprintSpeed: 7,
    jumpVelocity: 6.2,
    gravity: 20,
    gun: { damage: 24, armorDamage: 3, fireInterval: .14, magazine: 18, reloadTime: 1.25, range: 48 },
  },
  ink: {
    max: 100,
    regenDelay: .8,
    regenRate: 10,
    drawBase: 20,
    drawPerMeter: 4,
    drawMinLen: 2,
    drawMaxLen: 6,
    minDrawCost: 28,
    eraseCost: 35,
    eraseRadius: 6,
    eraseCooldown: 3.5,
    eraseStun: 1,
    eraseSlow: 2.5,
  },
  wall: { height: 1.65, thickness: .12, halfThickness: .06, hp: 120, lifetime: 18, maxCount: 3 },
  enemy: {
    hp: 48,
    armor: 24,
    speed: 2.25,
    radius: .38,
    attackRange: 13,
    telegraph: .55,
    damage: 8,
    attackCooldown: 1.65,
    projectileSpeed: 9,
    projectileRadius: .13,
    slowFactor: .5,
    maxCount: 9,
    losInterval: .12,
    wallDamage: 18,
    stuckFlipTime: 1.2,
    spawnAnimTime: .35,
    eraser: { hp: 90, speed: 1.4, radius: .45, biteCooldown: 1.2, wallBite: 35, biteDamage: 12, seekRange: 15 },
    plane: { hp: 30, height: 2.4, speed: 5, radius: .4, aimTime: .6, diveSpeed: 9, diveDamage: 10, diveTime: 1.2, circleCd: 2.2, circleDist: 6 },
  },
  folds: {
    positions: [
      { x: 8, z: -8, rotY: Math.PI },
      { x: -9, z: 4, rotY: Math.PI / 2 },
      { x: 0, z: -6, rotY: -Math.PI / 2 },
    ],
    platformSize: 3.2,
    platformHeight: 1.5,
    wallHeight: 2.2,
    halfThickness: .06,
    rampAngle: 47 * Math.PI / 180,   // 板绕底边铰链的倾角（0°=竖墙）
    rampRun: 2.2 * Math.sin(47 * Math.PI / 180),   // 坡道水平投影 ≈1.61
    toggleTime: .4,
    interactRadius: 2.2,
    stepLimit: .55,
  },
  pickups: {
    ink: [{ x: 14, z: 8 }, { x: -14, z: 10 }, { x: 12, z: -12 }],
    tape: [{ x: -13, z: -6 }, { x: 7, z: 13 }],
    inkAmount: 40,
    tapeAmount: 30,
    radius: 1,
  },
  boss: {
    hp: 480,
    speed: 1.8,
    radius: 1.0,
    attackInterval: 1.7,
    fanCount: 7,
    fanSpread: 22 * Math.PI / 180,
    fanSpeed: 8,
    fanDamage: 8,
    fanTelegraph: .6,
    summonTelegraph: .8,
    summonCount: 3,
    chargeTelegraph: .7,
    chargeSpeed: 14,
    chargeDamage: 18,
    chargeTime: 1.1,
    chargeWallDamage: 45,
    rage: { at: .5, attackInterval: 1.15, speed: 2.4, fanSpeed: 9.5, fanBonus: 2 },
  },
  waves: {
    spots: [[-13, 4], [12, 11], [3, 6], [-10, -1]],
    initial: ['crane', 'crane', 'crane', 'eraser'],
    afterA1: ['crane', 'crane', 'plane'],
    afterA2: ['eraser', 'plane'],
  },
  anchor: { radius: 2, holdTime: 1.1, exitRadius: 2.25, exitHoldTime: .65, reinforceCount: 2 },
  camera: { near: .05, far: 70 },
  visual: {
    splat: {
      max: 90,             // 同屏墨渍上限（超出移除最旧的）
      life: 20,            // 存留秒数
      fadeTime: 2.5,       // 末尾淡出秒数
      palette: ['20242A', '007F7B', 'E34B3F', 'F2C14E', '3E6FB0', 'E58F9A'], // 多彩墨水
    },
  },
};

/* ================= 1. 设置（localStorage 持久化） ================= */
const SETTINGS_KEY = 'inkline-settings';
const BEST_KEY = 'inkline-best';

function loadSettings() {
  const defaults = { sens: 1, touchSens: 1, volume: .35, fov: 68 };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const s = { ...defaults, ...raw };
      s.sens = Math.min(2, Math.max(.3, +s.sens || 1));
      s.touchSens = Math.min(2, Math.max(.3, +s.touchSens || 1));
      s.volume = Math.min(1, Math.max(0, +s.volume === 0 ? 0 : +s.volume || .35));
      s.fov = Math.min(95, Math.max(60, +s.fov || defaults.fov));
      return s;
    }
  } catch { /* 忽略损坏的本地数据 */ }
  return defaults;
}

const settings = loadSettings();

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 无痕模式等场景忽略 */ }
}

function applySettings() {
  if (camera) {
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
  }
  if (masterGain && audioCtx) masterGain.gain.value = soundOn ? settings.volume : 0;
}

function loadBestRecord() {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) || 'null');
    if (v && typeof v.time === 'number' && v.time > 0) return v;
  } catch { /* 忽略 */ }
  return null;
}

/** 记录更快的新成绩，返回是否刷新纪录 */
function updateBestRecord(timeSec) {
  const best = loadBestRecord();
  if (best && timeSec >= best.time) return false;
  try { localStorage.setItem(BEST_KEY, JSON.stringify({ time: timeSec })); } catch { /* 忽略 */ }
  return true;
}

/* ================= 2. DOM 缓存与全局开关 ================= */
const UI = {};
const UI_IDS = [
  'gameCanvas', 'soundBtn',
  'topHud', 'objective', 'timer', 'crosshair', 'bottomHud',
  'bossBar', 'bossFill',
  'hpText', 'hpFill', 'inkText', 'inkFill', 'ammo', 'ammoText', 'weaponState',
  'prompt', 'promptText', 'useTrack', 'useFill', 'drawHint', 'toast', 'damage', 'navLayer',
  'touchUI', 'movePad', 'moveThumb', 'lookPad',
  'touchFire', 'touchWall', 'touchErase', 'touchUse', 'touchReload', 'touchFold', 'touchJump', 'touchPause',
  'menu', 'startBtn', 'howBtn', 'howPanel', 'desktopHelp', 'touchHelp', 'loadError',
  'pauseOverlay', 'resumeBtn', 'pauseSettingsBtn', 'pauseRestartBtn',
  'settingsOverlay', 'settingsBtn', 'settingsBackBtn',
  'sensSlider', 'sensVal', 'touchSensRow', 'touchSensSlider', 'touchSensVal',
  'volSlider', 'volVal', 'fovSlider', 'fovVal',
  'endOverlay', 'endTitle', 'endReason',
  'statTime', 'statKills', 'statWalls', 'statErases', 'bestLine', 'restartBtn',
];
for (const id of UI_IDS) UI[id] = document.getElementById(id);

const isTouch = matchMedia('(pointer:coarse)').matches || new URLSearchParams(location.search).has('touch');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.body.classList.toggle('touch', isTouch);
UI.desktopHelp.hidden = isTouch;
UI.touchHelp.hidden = !isTouch;

let soundOn = (() => {
  try { return !isTouch && !reducedMotion && localStorage.getItem('inkline-sound') === 'on'; } catch { return false; }
})();

/* ================= 3. 游戏状态 ================= */
const C = { paper: 0xF3F1E7, ink: 0x20242A, teal: 0x007F7B, red: 0xE34B3F, yellow: 0xF2C14E };

let renderer, scene, camera, raycaster, gun, exitGroup, exitPlane;
let drawPreview, drawMarker;
let player = null;
let enemies = [], walls = [], effects = [], projectiles = [], anchors = [];
let folds = [], foldWalls = [], pickups = [], boss = null;
let staticMeshes = [], solidMeshes = [], staticColliders = [];
let mode = 'menu', clockLast = performance.now();
let timeLeft = CONFIG.round.timeLimit, elapsed = 0;
let kills = 0, wallsDrawn = 0, erases = 0, anchorsDone = 0;
let exitUnlocked = false, graceTime = 0;
let drawStart = null, useProgress = 0, useTarget = null;
let toastTime = 0, hitTime = 0, damageTime = 0, recoil = 0;
let mouseFire = false, touchFire = false, touchUse = false, fallbackAim = false;
let audioCtx = null, masterGain = null;
let godMode = false;        // ?debug=1 调试无敌开关
let noAutoPause = false;    // 调试免自动暂停（失焦/切后台不触发）
const keys = Object.create(null);
const touchMove = { x: 0, y: 0 };

let tmpV, tmpV2, tmpV3;                 // 复用临时向量，避免每帧分配
let PROJECTILE_GEO, PROJECTILE_MAT;     // 敌方墨弹共享几何 / 材质
let PARTICLE_GEO;                       // 粒子共享几何
let SPLAT_GEO;                          // 墙面墨渍共享几何
const splatPool = [], activeSplats = [];
const MODEL_GEO = {}, MODEL_EDGE_GEO = {};// Blender 模型几何 / 描边几何（启动时构建一次）
let MODEL_MAT = null;                   // 顶点色共享材质（平直着色）
let MODEL_MAT_SMOOTH = null;            // 平滑着色变体（奶龙等有机模型）
const MODEL_DATA = window.__INKLINE_MODELS__ || null;
const particlePool = [];
const tracerPool = [];
const projectilePool = [];
let navArrows = [], navExitArrow = null;

/* ================= 4. Three.js 初始化与世界构建 ================= */
function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, ...extra });
}

function lineMat(color = C.ink, opacity = 1) {
  return new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
}

function addEdges(mesh, color = C.ink, threshold = 20) {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold), lineMat(color));
  mesh.add(e);
  return e;
}

/** 程序生成纸张纹理：方格底 + 纤维杂线 */
function makePaperTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#F3F1E7';
  x.fillRect(0, 0, 512, 512);
  x.strokeStyle = 'rgba(60,100,110,.12)';
  x.lineWidth = 1;
  for (let i = 0; i <= 512; i += 32) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(512, i); x.stroke();
  }
  let seed = 8731;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  x.strokeStyle = 'rgba(45,40,30,.07)';
  for (let i = 0; i < 850; i++) {
    const px = rnd() * 512, py = rnd() * 512, l = 1 + rnd() * 5;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + l, py + (rnd() - .5) * 2); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(7, 7);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return t;
}

/** 静态方块：加入场景、碰撞列表（含高度，供投射物判断）；platform=true 时不阻挡玩家（可站立） */
function createBox(x, z, w, d, h, color = C.paper, options = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  mesh.position.set(x, h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  addEdges(mesh);
  staticMeshes.push(mesh);
  solidMeshes.push(mesh);
  staticColliders.push({ x, z, hx: w / 2, hz: d / 2, h, platform: !!options.platform });
  return mesh;
}

/** 文字贴片（锚点标签 / 出口标牌等） */
function createTextPlane(text, w, h, color = '#20242A', bg = 'rgba(243,241,231,0)') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = bg;
  x.fillRect(0, 0, 512, 256);
  x.fillStyle = color;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = '900 54px Microsoft YaHei, sans-serif';
  const lines = text.split('\n');
  lines.forEach((s, i) => x.fillText(s, 256, 128 + (i - (lines.length - 1) / 2) * 66));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide })
  );
}

function createAnchor(x, z, label) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(.72, .82, .18, 12), mat(C.ink));
  base.position.y = .09;
  base.castShadow = true;
  group.add(base);
  const ringMat = mat(C.yellow);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.48, .075, 8, 28), ringMat);
  ring.position.y = .72;
  ring.castShadow = true;
  group.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(.48, .055, 8, 28), ringMat);
  ring2.position.y = .72;
  ring2.rotation.y = Math.PI / 2;
  group.add(ring2);
  const mark = createTextPlane(label, 1.25, .62, '#20242A');
  mark.position.set(0, 1.65, 0);
  group.add(mark);
  // 导航光柱：穿透场景可见，锚定后消失
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(.22, .34, 9, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: C.yellow, transparent: true, opacity: .3,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    })
  );
  beacon.position.y = 4.5;
  beacon.renderOrder = 5;
  group.add(beacon);
  scene.add(group);
  const a = { x, z, label, group, ring, ring2, ringMat, mark, beacon, active: false };
  anchors.push(a);
  return a;
}

function createExit() {
  exitGroup = new THREE.Group();
  exitGroup.position.set(0, 0, -15.6);
  const stripeMat = new THREE.MeshBasicMaterial({ color: C.red, transparent: true, opacity: .48, side: THREE.DoubleSide });
  exitPlane = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.1), stripeMat);
  exitPlane.rotation.x = -Math.PI / 2;
  exitPlane.position.y = .025;
  exitGroup.add(exitPlane);
  for (const x of [-2.3, 2.3]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(.12, 1.3, .12), mat(C.ink));
    post.position.set(x, .65, 0);
    exitGroup.add(post);
  }
  const sign = createTextPlane('裁切线\nEXIT', 3.4, 1.3, '#E34B3F');
  sign.position.set(0, 1.55, 0);
  exitGroup.add(sign);
  exitGroup.userData.sign = sign;
  scene.add(exitGroup);
}

/** 第一人称线规笔模型 */
function createGun() {
  gun = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.035, .055, .72, 10), mat(C.ink));
  body.rotation.x = Math.PI / 2;
  body.position.z = -.12;
  gun.add(body);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(.11, .24, .13), mat(C.ink));
  grip.position.set(0, -.12, .13);
  grip.rotation.x = -.28;
  gun.add(grip);
  const nib = new THREE.Mesh(new THREE.ConeGeometry(.035, .16, 8), mat(C.teal));
  nib.rotation.x = -Math.PI / 2;
  nib.position.z = -.55;
  gun.add(nib);
  const band = new THREE.Mesh(new THREE.TorusGeometry(.057, .012, 6, 12), mat(C.yellow));
  band.position.z = .12;
  gun.add(band);
  gun.position.set(.38, -.31, -.64);
  gun.rotation.set(-.08, -.08, 0);
  camera.add(gun);
}

function buildWorld() {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat(C.paper, { map: makePaperTexture() }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  // 场地围墙
  createBox(0, -18, 36, .5, 2.8);
  createBox(0, 18, 36, .5, 2.8);
  createBox(-18, 0, .5, 36, 2.8);
  createBox(18, 0, .5, 36, 2.8);
  // 固定掩体（纸块 / 折角）
  createBox(0, 0, 4, 2, 1.3);
  createBox(-6, -4, 1.4, 5, 1.8);
  createBox(6, -5, 4, 1.2, 1.1);
  createBox(7, 6, 1.4, 4.5, 1.8);
  createBox(-8, 7, 3, 1.2, 1.1);
  createBox(0, 12, 3.2, 1.2, 1.4);
  createBox(12, -1, 1.4, 3.2, 1.5);
  createBox(-12, 1, 1.2, 3, 1.25);
  // 三处装订锚点（不对称三角分布）+ 南侧出口
  createAnchor(-11, -10, 'A1');
  createAnchor(10, 1, 'A2');
  createAnchor(-3, 9, 'A3');
  createExit();
  // 地面批注
  const margin = createTextPlane('WORK PAGE / 07\n修订区域', 5, 1.4, '#6E726F');
  margin.rotation.x = -Math.PI / 2;
  margin.position.set(11, .02, -13);
  scene.add(margin);
  // 折纸地形：平台 + 可翻折板 + 拾取物
  CONFIG.folds.positions.forEach((def, i) => createFold(def, i));
  CONFIG.pickups.ink.forEach((p, i) => createPickup('ink', p.x, p.z, i));
  CONFIG.pickups.tape.forEach((p, i) => createPickup('tape', p.x, p.z, i + 3));
  // 画线预览与起点标记
  drawPreview = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1.65, .12),
    new THREE.MeshBasicMaterial({ color: C.teal, transparent: true, opacity: .28, depthWrite: false })
  );
  drawPreview.visible = false;
  scene.add(drawPreview);
  drawMarker = new THREE.Mesh(
    new THREE.TorusGeometry(.18, .035, 6, 20),
    new THREE.MeshBasicMaterial({ color: C.teal })
  );
  drawMarker.rotation.x = Math.PI / 2;
  drawMarker.visible = false;
  scene.add(drawMarker);
  raycaster = new THREE.Raycaster();
}

/* ---------- 折纸地形 ---------- */
function createFold(def, index) {
  const pivot = new THREE.Group();
  pivot.position.set(def.x, 0, def.z);
  pivot.rotation.order = 'YXZ';
  pivot.rotation.y = def.rotY;
  pivot.rotation.x = CONFIG.folds.rampAngle;   // 默认平铺为坡道
  // 模型顶点已烘焙“底边在 y=0”，pivot 绕底边铰链旋转
  const mesh = buildModelMesh('fold', C.teal);
  pivot.add(mesh);
  scene.add(pivot);
  // 地面交互标记环
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(.55, .68, 28),
    new THREE.MeshBasicMaterial({ color: C.teal, transparent: true, opacity: .45, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(def.x, .03, def.z);
  scene.add(ring);
  // 平台（坡顶侧，固定）：不阻挡玩家，敌人与弹道仍受阻挡
  const px = def.x + Math.sin(def.rotY) * 3.2;
  const pz = def.z + Math.cos(def.rotY) * 3.2;
  createBox(px, pz, CONFIG.folds.platformSize, CONFIG.folds.platformSize, CONFIG.folds.platformHeight, C.paper, { platform: true });
  folds.push({
    id: index, x: def.x, z: def.z, rotY: def.rotY,
    state: 'ramp', animT: 1, fromAngle: CONFIG.folds.rampAngle,
    pivot, mesh, ring, wall: null,
  });
}

/** 世界坐标 → 折角局部（逆绕 Y 旋转） */
function foldLocal(f, x, z) {
  const dx = x - f.x, dz = z - f.z;
  const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/** 玩家脚下地面高度：地面 0 / 折角坡道线性 / 平台顶 */
function groundHeightAt(x, z) {
  let h = 0;
  for (const f of folds) {
    const { lx, lz } = foldLocal(f, x, z);
    if (Math.abs(lx) <= CONFIG.folds.platformSize / 2 && lz >= 1.6 && lz <= 4.8) {
      h = Math.max(h, CONFIG.folds.platformHeight);
    } else if (f.state === 'ramp' && Math.abs(lx) <= 1.95 && lz >= 0 && lz <= CONFIG.folds.rampRun) {
      h = Math.max(h, CONFIG.folds.platformHeight * (lz / CONFIG.folds.rampRun));
    }
  }
  return h;
}

/** 切换折角：坡道 ⟷ 纸墙（动画期间不可重复触发） */
function toggleFold(f) {
  if (f.animT < 1) return;
  f.fromAngle = f.pivot.rotation.x;
  f.animT = 0;
  if (f.state === 'ramp') {
    f.state = 'wall';
    // 竖墙碰撞胶囊：沿局部 x 展开 3.9m
    const ux = Math.cos(f.rotY), uz = -Math.sin(f.rotY);
    f.wall = { x: f.x, z: f.z, len: 3.9, ux, uz, nx: -uz, nz: ux, halfThickness: CONFIG.folds.halfThickness };
    foldWalls.push(f.wall);
    if (solidMeshes.indexOf(f.mesh) < 0) solidMeshes.push(f.mesh);
    toast('纸墙立起，坡道收起');
  } else {
    f.state = 'ramp';
    const si = foldWalls.indexOf(f.wall);
    if (si >= 0) foldWalls.splice(si, 1);
    f.wall = null;
    const mi = solidMeshes.indexOf(f.mesh);
    if (mi >= 0) solidMeshes.splice(mi, 1);
    toast('坡道展开，可登上平台');
  }
  playTone(200, .14, 'triangle', .05, 60);
}

function toggleNearestFold() {
  if (mode !== 'playing' || !player) return;
  let best = null, bd = Infinity;
  for (const f of folds) {
    const d = Math.hypot(player.pos.x - f.x, player.pos.z - f.z);
    if (d < bd) { bd = d; best = f; }
  }
  if (best && bd <= CONFIG.folds.interactRadius) toggleFold(best);
}

function updateFolds(dt) {
  for (const f of folds) {
    if (f.animT >= 1) continue;
    f.animT = Math.min(1, f.animT + dt / CONFIG.folds.toggleTime);
    const t = f.animT * f.animT * (3 - 2 * f.animT);   // smoothstep
    const target = f.state === 'ramp' ? CONFIG.folds.rampAngle : 0;
    f.pivot.rotation.x = f.fromAngle + (target - f.fromAngle) * t;
  }
}

/* ---------- 拾取物 ---------- */
function createPickup(type, x, z, index) {
  const mesh = buildModelMesh(type === 'ink' ? 'bottle' : 'tape', null);
  mesh.position.set(x, 0, z);
  scene.add(mesh);
  pickups.push({ id: index, type, x, z, mesh, taken: false, phase: index * 1.7 });
}

function updatePickups(dt) {
  for (const p of pickups) {
    if (p.taken) continue;
    p.mesh.rotation.y += dt * 1.6;
    p.mesh.position.y = .32 + Math.sin(elapsed * 2.4 + p.phase) * .07;
    if (Math.hypot(player.pos.x - p.x, player.pos.z - p.z) < CONFIG.pickups.radius) {
      p.taken = true;
      p.mesh.visible = false;
      if (p.type === 'ink') {
        player.ink = Math.min(CONFIG.ink.max, player.ink + CONFIG.pickups.inkAmount);
        toast('墨量 +' + CONFIG.pickups.inkAmount);
      } else {
        player.hp = Math.min(CONFIG.player.maxHp, player.hp + CONFIG.pickups.tapeAmount);
        toast('生命 +' + CONFIG.pickups.tapeAmount);
      }
      spawnImpact(p.mesh.position, p.type === 'ink' ? C.teal : C.yellow, 7);
      playTone(420, .14, 'triangle', .06, 160);
      updateHUD();
    }
  }
}

function initThree() {
  tmpV = new THREE.Vector3();
  tmpV2 = new THREE.Vector3();
  tmpV3 = new THREE.Vector3();
  try {
    renderer = new THREE.WebGLRenderer({ canvas: UI.gameCanvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    showLoadError('当前浏览器无法启动 WebGL。请开启硬件加速或换用新版 Chrome / Edge。');
    return false;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1 : 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = !isTouch;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(C.paper);
  scene.fog = new THREE.Fog(C.paper, 26, 52);
  camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xE8F0ED, 0x8D806C, 1.65));
  const sun = new THREE.DirectionalLight(0xFFF4DC, 2.15);
  sun.position.set(-10, 18, -8);
  sun.castShadow = !isTouch;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 50;
  scene.add(sun);
  buildWorld();
  createGun();
  return true;
}

function showLoadError(text) {
  UI.loadError.textContent = text;
  UI.loadError.hidden = false;
  UI.startBtn.disabled = true;
  UI.startBtn.textContent = '暂时无法进入';
}

function disposeDynamic(obj) {
  obj.traverse(n => {
    if (n.userData && n.userData.noDispose) return;   // 墨渍等池化对象跳过销毁
    if (n.geometry) n.geometry.dispose();
    if (n.material) {
      const ms = Array.isArray(n.material) ? n.material : [n.material];
      ms.forEach(m => m.dispose());
    }
  });
}

/* ---------- Blender 模型工厂 ----------
   平面模型：pos=毫米整数顶点（非索引三角形）+ fc=每面 hex 色 → 平直着色
   平滑模型（sm=1）：pos=去重顶点 + col=逐顶点色 + idx=三角形索引
     → 索引共享顶点，computeVertexNormals 天然产生平滑法线；色块边界清晰 */ 
function geoFromModel(m) {
  const geo = new THREE.BufferGeometry();
  if (m.sm) {
    const vertCount = m.pos.length / 3;
    const pos = new Float32Array(m.pos.length);
    for (let i = 0; i < m.pos.length; i++) pos[i] = m.pos[i] / 1000;
    const col = new Float32Array(vertCount * 3);
    for (let i = 0; i < m.col.length; i++) {
      const hex = m.col[i];
      col[i * 3] = parseInt(hex.slice(0, 2), 16) / 255;
      col[i * 3 + 1] = parseInt(hex.slice(2, 4), 16) / 255;
      col[i * 3 + 2] = parseInt(hex.slice(4, 6), 16) / 255;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(m.idx);
    geo.computeVertexNormals();   // 索引共享顶点 → 平滑法线
    return geo;
  }
  const vertCount = m.pos.length / 3;
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < m.pos.length; i++) pos[i] = m.pos[i] / 1000;
  const col = new Float32Array(vertCount * 3);
  for (let f = 0; f < m.fc.length; f++) {
    const hex = m.fc[f];
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    for (let v = 0; v < 3; v++) {
      const i = (f * 3 + v) * 3;
      col[i] = r; col[i + 1] = g; col[i + 2] = b;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();   // 非索引三角形 → 平直着色
  return geo;
}

/** 用预构建几何生成模型 mesh；edgeColor 传色值加描边，传 null 不加 */
function buildModelMesh(key, edgeColor) {
  const spec = MODEL_DATA[key];
  const mesh = new THREE.Mesh(MODEL_GEO[key], spec.sm ? MODEL_MAT_SMOOTH : MODEL_MAT);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (edgeColor !== null) {
    const e = new THREE.LineSegments(MODEL_EDGE_GEO[key], lineMat(edgeColor, .85));
    mesh.add(e);
  }
  return mesh;
}

/** 启动时一次性构建全部模型几何（跨局复用，不销毁） */
function buildModelAssets() {
  // 纸感薄板使用双面渲染：折纸/纸墙从任意方向可见，绕序差异不再影响显示
  MODEL_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true, side: THREE.DoubleSide });
  MODEL_MAT_SMOOTH = MODEL_MAT.clone();
  MODEL_MAT_SMOOTH.flatShading = false;   // 平滑着色（配合导出的平滑法线）
  for (const key in MODEL_DATA) {
    MODEL_GEO[key] = geoFromModel(MODEL_DATA[key]);
    MODEL_EDGE_GEO[key] = new THREE.EdgesGeometry(MODEL_GEO[key], 18);
  }
}

/* ================= 5. 物理 ================= */
/** 单个胶囊（玩家画墙 / 折纸墙）与圆体的推挤 */
function collideCapsule(pos, r, w) {
  const dx = pos.x - w.x, dz = pos.z - w.z;
  const along = dx * w.ux + dz * w.uz;
  const side = dx * w.nx + dz * w.nz;
  const ht = w.halfThickness;
  const ca = Math.max(-w.len / 2, Math.min(w.len / 2, along));
  const cs = Math.max(-ht, Math.min(ht, side));
  const qx = w.x + w.ux * ca + w.nx * cs;
  const qz = w.z + w.uz * ca + w.nz * cs;
  let ox = pos.x - qx, oz = pos.z - qz, d2 = ox * ox + oz * oz;
  if (d2 > 0 && d2 < r * r) {
    const d = Math.sqrt(d2), push = (r - d) / d;
    pos.x += ox * push;
    pos.z += oz * push;
  } else if (Math.abs(along) < w.len / 2 && Math.abs(side) < ht + r) {
    const s = Math.sign(side || 1), push = ht + r - Math.abs(side);
    pos.x += w.nx * s * push;
    pos.z += w.nz * s * push;
  }
}

/** 圆体与静态 AABB、墙体（胶囊）的推挤解算；isPlayer 时平台碰撞豁免（可站立） */
function resolveCircle(pos, r, isPlayer) {
  pos.x = Math.max(-17.35 + r, Math.min(17.35 - r, pos.x));
  pos.z = Math.max(-17.35 + r, Math.min(17.35 - r, pos.z));
  for (const b of staticColliders) {
    if (b.platform && isPlayer) continue;
    const cx = Math.max(b.x - b.hx, Math.min(b.x + b.hx, pos.x));
    const cz = Math.max(b.z - b.hz, Math.min(b.z + b.hz, pos.z));
    let dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 > 0 && d2 < r * r) {
      const d = Math.sqrt(d2), push = (r - d) / d;
      pos.x += dx * push;
      pos.z += dz * push;
    } else if (Math.abs(pos.x - b.x) < b.hx && Math.abs(pos.z - b.z) < b.hz) {
      const px = b.hx - Math.abs(pos.x - b.x), pz = b.hz - Math.abs(pos.z - b.z);
      if (px < pz) pos.x = b.x + Math.sign(pos.x - b.x || 1) * (b.hx + r);
      else pos.z = b.z + Math.sign(pos.z - b.z || 1) * (b.hz + r);
    }
  }
  for (const w of walls) {
    if (w.dead) continue;
    collideCapsule(pos, r, w);
  }
  for (const w of foldWalls) {
    collideCapsule(pos, r, w);
  }
}

function moveCircle(pos, dx, dz, r, isPlayer) {
  pos.x += dx;
  pos.z += dz;
  resolveCircle(pos, r, isPlayer);
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  if (!l2) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/** 玩家墙 / 场景方块是否会挡住 origin → target 的视线 */
function getBlocker(origin, target) {
  const dir = tmpV.copy(target).sub(origin);
  const dist = dir.length();
  if (dist < .001) return null;
  dir.multiplyScalar(1 / dist);
  raycaster.set(origin, dir);
  raycaster.near = .02;
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(solidMeshes, false);
  return hits.length ? hits[0] : null;
}

/** 准星指向的地面落点（画线用） */
function aimGround() {
  const dir = camera.getWorldDirection(tmpV);
  let p;
  if (dir.y < -.06) {
    const t = (.03 - camera.position.y) / dir.y;
    if (t > 0 && t < 13) p = tmpV2.copy(camera.position).addScaledVector(dir, t);
  }
  if (!p) {
    const f = tmpV3.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    p = tmpV2.copy(player.pos).addScaledVector(f, 5.5);
    p.y = .03;
  }
  p.x = Math.max(-16.5, Math.min(16.5, p.x));
  p.z = Math.max(-16.5, Math.min(16.5, p.z));
  return p.clone();
}

/* ================= 6. 玩家 ================= */
function updatePlayer(dt) {
  player.fireCd = Math.max(0, player.fireCd - dt);
  player.eraseCd = Math.max(0, player.eraseCd - dt);
  if (player.reload > 0) {
    player.reload = Math.max(0, player.reload - dt);
    if (player.reload === 0) {
      player.ammo = CONFIG.player.gun.magazine;
      playTone(240, .07, 'triangle', .04, 80);
    }
  }
  if (elapsed - player.lastSkill > CONFIG.ink.regenDelay) {
    player.ink = Math.min(CONFIG.ink.max, player.ink + CONFIG.ink.regenRate * dt);
  }

  let f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + touchMove.y;
  let r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + touchMove.x;
  const il = Math.hypot(f, r);
  if (il > 1) { f /= il; r /= il; }
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  const speed = (keys.ShiftLeft || keys.ShiftRight) ? CONFIG.player.sprintSpeed : CONFIG.player.walkSpeed;
  const blend = 1 - Math.exp(-14 * dt);
  player.velX += (fx * f + rx * r) * speed * blend - player.velX * blend;
  player.velZ += (fz * f + rz * r) * speed * blend - player.velZ * blend;
  // 垂直物理：地面高度随折纸地形变化；步高限制防止从侧面“瞬移”上平台
  const oldFoot = player.pos.y - CONFIG.player.eyeHeight;
  const oldX = player.pos.x, oldZ = player.pos.z;
  moveCircle(player.pos, player.velX * dt, player.velZ * dt, CONFIG.player.radius, true);
  const movedGround = groundHeightAt(player.pos.x, player.pos.z);
  if (movedGround - oldFoot > CONFIG.folds.stepLimit) {
    player.pos.x = oldX;
    player.pos.z = oldZ;
  }

  player.velY -= CONFIG.player.gravity * dt;
  player.pos.y += player.velY * dt;
  const ground = groundHeightAt(player.pos.x, player.pos.z);
  const eye = ground + CONFIG.player.eyeHeight;
  if (player.pos.y <= eye) {
    player.pos.y = eye;
    player.velY = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
  }

  const moving = Math.hypot(player.velX, player.velZ);
  const bob = !reducedMotion && player.grounded ? Math.sin(elapsed * 10) * Math.min(.025, moving * .004) : 0;
  camera.position.set(player.pos.x, player.pos.y + bob, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0);

  recoil = Math.max(0, recoil - dt * 7);
  gun.position.z = -.64 + recoil * .09;
  gun.rotation.x = -.08 + recoil * .09;
  if (player.reload > 0) {
    const p = 1 - player.reload / CONFIG.player.gun.reloadTime;
    gun.rotation.z = Math.sin(p * Math.PI) * .65;
  } else gun.rotation.z = 0;

  if (mouseFire || touchFire) tryFire();
}

function jump() {
  if (mode === 'playing' && player.grounded) {
    player.velY = CONFIG.player.jumpVelocity;
    player.grounded = false;
    playTone(120, .06, 'triangle', .025, 35);
  }
}

function tryFire() {
  if (player.fireCd > 0 || player.reload > 0 || mode !== 'playing') return;
  if (player.ammo <= 0) { startReload(); return; }
  player.ammo--;
  player.fireCd = CONFIG.player.gun.fireInterval;
  recoil = Math.min(1, recoil + .42);
  useProgress = 0;

  const origin = camera.position.clone();
  const dir = camera.getWorldDirection(new THREE.Vector3());
  raycaster.set(origin, dir);
  raycaster.near = .05;
  raycaster.far = CONFIG.player.gun.range;
  const targets = solidMeshes.concat(enemies.filter(e => !e.dead).map(e => e.body));
  if (boss && !boss.dead) targets.push(boss.body);
  const hits = raycaster.intersectObjects(targets, false);
  let end = origin.clone().addScaledVector(dir, CONFIG.player.gun.range);

  if (hits.length) {
    const hit = hits[0];
    end = hit.point;
    const hitNormal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : dir.clone().negate();
    const e = hit.object.userData.enemy;
    if (boss && hit.object === boss.body) {
      damageBoss(CONFIG.player.gun.damage);
      hitTime = .13;
      spawnImpact(hit.point, C.red, 3);
      spawnSplatBurst(hit.point, hitNormal, null);
      updateHUD();
    } else if (e && !e.dead) {
      if (e.armor > 0) {
        // 护甲对子弹抗性极高：每发仅削 3 点
        e.armor = Math.max(0, e.armor - CONFIG.player.gun.armorDamage);
        if (e.armor === 0) stripArmor(e);
      } else {
        e.hp -= CONFIG.player.gun.damage;
      }
      e.flash = .1;
      hitTime = .13;
      spawnImpact(hit.point, e.armor > 0 ? C.red : C.ink, 3);
      if (e.hp <= 0) killEnemy(e);
    } else {
      // 命中墙面：留下彩色墨渍（打在自己画的墙上，拆墙时一并回收）
      spawnImpact(hit.point, C.ink, 2);
      spawnSplatBurst(hit.point, hitNormal, hit.object.userData.wall || null);
    }
  }

  const from = gun.localToWorld(new THREE.Vector3(0, 0, -.58));
  spawnTracer(from, end);
  playTone(105, .055, 'square', .055, 35);
  if (player.ammo === 0) startReload();
  updateHUD();
}

function startReload() {
  if (mode !== 'playing' || player.reload > 0 || player.ammo === CONFIG.player.gun.magazine) return;
  player.reload = CONFIG.player.gun.reloadTime;
  mouseFire = false;
  touchFire = false;
  playTone(150, .08, 'triangle', .04, 60);
  updateHUD();
}

/* ================= 7. 画线掩体 ================= */
function handleDraw() {
  if (mode !== 'playing') return;
  if (!drawStart) {
    if (player.ink < CONFIG.ink.minDrawCost) { toast('至少需要 28 墨量'); return; }
    drawStart = aimGround();
    drawMarker.position.copy(drawStart);
    drawMarker.position.y = .05;
    drawMarker.visible = true;
    UI.drawHint.hidden = false;
    playTone(420, .06, 'triangle', .06, 80);
    return;
  }
  const end = aimGround();
  const len = drawStart.distanceTo(end);
  const cost = CONFIG.ink.drawBase + CONFIG.ink.drawPerMeter * len;
  if (len < CONFIG.ink.drawMinLen || len > CONFIG.ink.drawMaxLen) {
    toast(len < CONFIG.ink.drawMinLen ? '线条太短，至少 2 米' : '线条太长，最多 6 米');
    return;
  }
  if (pointSegmentDistance(player.pos, drawStart, end) < .75) { toast('不能把墙画在自己身上'); return; }
  if (player.ink < cost) { toast('需要 ' + Math.ceil(cost) + ' 墨量'); return; }
  createWall(drawStart, end, len, cost);
  drawStart = null;
  drawPreview.visible = false;
  drawMarker.visible = false;
  UI.drawHint.hidden = true;
}

function cancelDraw() {
  drawStart = null;
  drawPreview.visible = false;
  drawMarker.visible = false;
  UI.drawHint.hidden = true;
}

function updateDrawPreview() {
  if (!drawStart) { drawPreview.visible = false; return; }
  const end = aimGround();
  const dx = end.x - drawStart.x, dz = end.z - drawStart.z;
  const len = Math.hypot(dx, dz);
  if (len < .02) { drawPreview.visible = false; return; }
  drawPreview.visible = true;
  drawPreview.position.set((drawStart.x + end.x) / 2, .825, (drawStart.z + end.z) / 2);
  drawPreview.scale.set(len, 1, 1);
  drawPreview.rotation.y = -Math.atan2(dz, dx);
  const valid = len >= CONFIG.ink.drawMinLen && len <= CONFIG.ink.drawMaxLen
    && player.ink >= CONFIG.ink.drawBase + CONFIG.ink.drawPerMeter * len;
  drawPreview.material.color.set(valid ? C.teal : C.red);
}

function createWall(a, b, len, cost) {
  const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(len, CONFIG.wall.height, CONFIG.wall.thickness),
    mat(C.teal, { transparent: true, opacity: .82 })
  );
  mesh.position.set((a.x + b.x) / 2, CONFIG.wall.height / 2, (a.z + b.z) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const edge = addEdges(mesh, C.teal);
  edge.material.transparent = true;
  scene.add(mesh);
  const wall = {
    mesh, x: mesh.position.x, z: mesh.position.z, len,
    ux: dx, uz: dz, nx: -dz, nz: dx,
    hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, hit: 0, dead: false,
  };
  mesh.userData.wall = wall;
  walls.push(wall);
  solidMeshes.push(mesh);
  player.ink -= cost;
  player.lastSkill = elapsed;
  wallsDrawn++;
  if (walls.length > CONFIG.wall.maxCount) removeWall(walls[0]);
  spawnImpact(mesh.position, C.teal, 8);
  playTone(180, .16, 'sawtooth', .07, 240);
  toast('掩体已实体化');
  updateHUD();
}

function removeWall(w) {
  if (!w || w.dead) return;
  w.dead = true;
  clearSplatsOnWall(w);
  scene.remove(w.mesh);
  const si = solidMeshes.indexOf(w.mesh);
  if (si >= 0) solidMeshes.splice(si, 1);
  const wi = walls.indexOf(w);
  if (wi >= 0) walls.splice(wi, 1);
  disposeDynamic(w.mesh);
}

function damageWall(w, amount) {
  if (!w || w.dead) return;
  w.hp -= amount;
  w.hit = .13;
  if (w.hp <= 0) {
    spawnImpact(w.mesh.position, C.teal, 8);
    removeWall(w);
    playTone(95, .12, 'square', .04, -30);
  }
}

/* ================= 8. 擦除脉冲 ================= */
/** 剥离护甲后的统一视觉：白身 + 青绿描边（可击杀状态） */
function stripArmor(e) {
  e.armor = 0;
  e.shell.visible = false;
  e.body.material.color.set(0xFFFFFF);
  e.edge.material.color.set(C.teal);
}

function erase() {
  if (mode !== 'playing') return;
  if (player.eraseCd > 0) { toast('擦除冷却 ' + player.eraseCd.toFixed(1) + ' 秒'); return; }
  if (player.ink < CONFIG.ink.eraseCost) { toast('擦除需要 35 墨量'); return; }
  player.ink -= CONFIG.ink.eraseCost;
  player.eraseCd = CONFIG.ink.eraseCooldown;
  player.lastSkill = elapsed;
  erases++;
  spawnEraseRing();
  let count = 0;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.group.position.x - player.pos.x, e.group.position.z - player.pos.z);
    if (d <= CONFIG.ink.eraseRadius) {
      if (e.armor > 0) { stripArmor(e); count++; }
      e.stun = CONFIG.ink.eraseStun;
      e.slow = CONFIG.ink.eraseSlow;   // 眩晕结束后仍短暂减速
      e.telegraph = 0;
      e.aimLine.visible = false;
    }
  }
  toast(count ? '擦除了 ' + count + ' 层护甲' : '脉冲已释放');
  playTone(260, .24, 'sine', .09, 520);
  updateHUD();
}

function spawnEraseRing() {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(.88, 1, 64),
    new THREE.MeshBasicMaterial({ color: C.teal, transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(player.pos.x, .06, player.pos.z);
  scene.add(mesh);
  effects.push({ mesh, type: 'ring', life: .45, max: .45 });
}

/* ================= 9. 敌人（涂改灵 crane / 橡皮擦虫 eraser / 纸飞机 plane） ================= */
function createEnemy(type, x, z, opts = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  let body, edge = null, shell = null;

  if (type === 'eraser') {
    // 橡皮擦虫：Blender 模型，无护甲，啃墙近战
    body = buildModelMesh('eraser', C.red);
    group.add(body);
  } else if (type === 'plane') {
    // 纸飞机：Blender 模型（原点=体中心），飞行单位
    body = buildModelMesh('plane', C.red);
    group.add(body);
  } else {
    // 涂改灵：折纸形体（原版几何）
    type = 'crane';
    const verts = new Float32Array([
      0, 1.4, 0, 0, .12, 0, -.56, .72, 0,
      .56, .72, 0, 0, .74, .45, 0, .74, -.36,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex([0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 4, 2, 1, 3, 4, 1, 5, 3, 1, 2, 5]);
    geo.computeVertexNormals();
    body = new THREE.Mesh(geo, mat(C.paper, { flatShading: true }));
    body.castShadow = true;
    group.add(body);
    edge = addEdges(body, C.red);
    // 修正液护甲壳
    shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.18, 1.48, .92)),
      lineMat(C.red, .9)
    );
    shell.position.y = .75;
    group.add(shell);
    // 眼部线条
    const eyeGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-.2, 1, .43), new THREE.Vector3(-.05, .91, .47),
      new THREE.Vector3(.05, .91, .47), new THREE.Vector3(.2, 1, .43),
    ]);
    group.add(new THREE.LineSegments(eyeGeo, lineMat(C.red)));
  }

  // 接地阴影
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(.58, 20),
    new THREE.MeshBasicMaterial({ color: C.ink, transparent: true, opacity: .13, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = .018;
  group.add(shadow);
  scene.add(group);
  // 蓄力瞄准线（涂改灵射击 / 纸飞机俯冲预警）
  const aimLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    lineMat(C.red, .6)
  );
  aimLine.material.transparent = true;
  aimLine.visible = false;
  scene.add(aimLine);

  const spec = type === 'eraser' ? CONFIG.enemy.eraser : type === 'plane' ? CONFIG.enemy.plane : null;
  const e = {
    type, group, body, edge, shell, aimLine,
    hp: spec ? spec.hp : CONFIG.enemy.hp,
    armor: type === 'crane' ? CONFIG.enemy.armor : 0,
    attackCd: .7 + Math.random(),
    telegraph: 0, stun: 0, slow: 0, flash: 0,
    strafe: Math.random() < .5 ? -1 : 1,
    stuckTimer: 0,
    losTimer: Math.random() * CONFIG.enemy.losInterval,  // 错峰视线检测
    blocked: null,
    spawnT: opts.spawnAnim ? 0 : 1,                      // 增援落地动画
    // 纸飞机状态机
    state: type === 'plane' ? 'circle' : '',
    diveDirX: 0, diveDirZ: 0, diveT: 0,
    circleCd: 1 + Math.random(),
    phase: Math.random() * Math.PI * 2,
    dead: false,
  };
  body.userData.enemy = e;
  enemies.push(e);
  if (type !== 'plane') resolveCircle(group.position, spec ? spec.radius : CONFIG.enemy.radius);
  if (e.spawnT < 1) group.scale.setScalar(.05);
  return e;
}

/** 增援：按波次表生成，优先选离玩家最远的生成点 + 落地动画缓冲；Boss 阶段停止增援 */
function spawnReinforcements(anchor) {
  if (boss) return;
  const table = anchorsDone === 1 ? CONFIG.waves.afterA1 : CONFIG.waves.afterA2;
  const spots = [[3, 2], [-2.5, -3], [3, -2], [-3, 2.5]]
    .map(([ox, oz]) => {
      let x = Math.max(-15, Math.min(15, anchor.x + ox));
      let z = Math.max(-15, Math.min(15, anchor.z + oz));
      const dx = x - player.pos.x, dz = z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 3.5) {
        // 离玩家太近：沿“玩家 → 生成点”方向推远到 5 米
        const k = 5 / Math.max(.001, d);
        x = Math.max(-15, Math.min(15, player.pos.x + dx * k));
        z = Math.max(-15, Math.min(15, player.pos.z + dz * k));
      }
      return { x, z, d: Math.hypot(x - player.pos.x, z - player.pos.z) };
    })
    .sort((a, b) => b.d - a.d);
  for (let i = 0; i < table.length; i++) {
    if (enemies.filter(e => !e.dead).length >= CONFIG.enemy.maxCount) break;
    const s = spots[i % spots.length];
    const e = createEnemy(table[i], s.x, s.z, { spawnAnim: true });
    e.attackCd = 1.5;
  }
}

/* ================= 9.5 终局 Boss：涂改大王 ================= */
function spawnBoss() {
  const group = new THREE.Group();
  group.position.set(0, 0, 5.5);
  const body = buildModelMesh('boss', null);   // 奶龙为平滑圆身，不加线框描边
  group.add(body);
  scene.add(group);
  const aimLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    lineMat(C.red, .7)
  );
  aimLine.material.transparent = true;
  aimLine.visible = false;
  scene.add(aimLine);
  boss = {
    group, body, edge: body.children[0] || null, aimLine,
    hp: CONFIG.boss.hp, maxHp: CONFIG.boss.hp,
    attackCd: 2.5, nextAttack: 0, state: 'idle', telegraph: 0,
    dirX: 0, dirZ: 0, chargeT: 0, hitDone: false, flash: 0, dead: false,
  };
  UI.bossBar.hidden = false;
  updateHUD();
}

function removeBoss() {
  if (!boss) return;
  scene.remove(boss.group);
  scene.remove(boss.aimLine);
  disposeDynamic(boss.group);
  disposeDynamic(boss.aimLine);
  boss = null;
  UI.bossBar.hidden = true;
}

function killBoss() {
  if (!boss) return;
  const p = boss.group.position.clone();
  p.y = 1.2;
  spawnImpact(p, C.red, 14);
  removeBoss();
  exitUnlocked = true;
  updateExitVisual();
  toast('涂改大王被修订归档——裁切线开启！');
  playTone(330, .4, 'triangle', .08, 260);
  updateHUD();
}

function damageBoss(n) {
  if (!boss || boss.dead) return;
  // 涂改护盾：常态减伤 65%，狂暴阶段解除（狂暴即输出窗口，同时它也更快更凶）
  const dealt = boss.raged ? n : Math.ceil(n * .35);
  boss.hp = Math.max(0, boss.hp - dealt);
  boss.flash = .1;
  if (boss.hp <= 0) killBoss();
}

function updateBoss(dt) {
  if (!boss || boss.dead) return;
  boss.flash = Math.max(0, boss.flash - dt);
  if (boss.edge) boss.edge.material.color.set(boss.flash > 0 ? 0xFFFFFF : C.red);

  const pos = boss.group.position;
  const dx = player.pos.x - pos.x, dz = player.pos.z - pos.z;
  const dist = Math.max(.001, Math.hypot(dx, dz));
  boss.group.rotation.y = Math.atan2(dx, dz);   // 面部始终朝向玩家（换装后奶龙有脸）

  // 狂暴阶段：血量低于阈值时攻速/移速/弹幕全面强化
  const rage = boss.hp <= boss.maxHp * CONFIG.boss.rage.at;
  if (rage && !boss.raged) {
    boss.raged = true;
    toast('涂改大王进入狂暴状态！');
    playTone(120, .4, 'sawtooth', .08, 80);
  }
  const moveSpeed = boss.raged ? CONFIG.boss.rage.speed : CONFIG.boss.speed;
  const interval = boss.raged ? CONFIG.boss.rage.attackInterval : CONFIG.boss.attackInterval;
  const fanCount = CONFIG.boss.fanCount + (boss.raged ? CONFIG.boss.rage.fanBonus : 0);
  const fanSpeed = boss.raged ? CONFIG.boss.rage.fanSpeed : CONFIG.boss.fanSpeed;

  // 蓄力体感：轻微膨胀脉动
  boss.body.scale.setScalar(boss.state !== 'idle' ? 1 + Math.sin(elapsed * 18) * .02 : 1);

  if (boss.state === 'idle') {
    boss.aimLine.visible = false;
    if (dist > 3.5) {
      const step = moveSpeed * dt;
      moveCircle(pos, dx / dist * step, dz / dist * step, CONFIG.boss.radius);
    }
    boss.attackCd -= dt;
    if (boss.attackCd <= 0) {
      boss.state = ['fan', 'summon', 'charge'][boss.nextAttack % 3];
      boss.nextAttack++;
      boss.telegraph = 0;
      if (boss.state === 'fan') playTone(140, .3, 'sawtooth', .06, 60);
      else if (boss.state === 'summon') playTone(110, .35, 'triangle', .06, 40);
    }
    return;
  }

  boss.telegraph += dt;
  if (boss.state === 'fan') {
    if (boss.telegraph >= CONFIG.boss.fanTelegraph) {
      // 扇形墨弹幕：以玩家方向为中心展开，横向走位可躲
      const base = Math.atan2(dx, dz);
      for (let i = 0; i < fanCount; i++) {
        const ang = base + (i - (fanCount - 1) / 2) * CONFIG.boss.fanSpread;
        fireProjectile(
          { x: pos.x, y: 1.4, z: pos.z },
          { x: pos.x + Math.sin(ang) * 10, y: 1.4, z: pos.z + Math.cos(ang) * 10 },
          fanSpeed,
          CONFIG.boss.fanDamage
        );
      }
      boss.state = 'idle';
      boss.attackCd = interval;
    }
  } else if (boss.state === 'summon') {
    if (boss.telegraph >= CONFIG.boss.summonTelegraph) {
      for (let i = 0; i < CONFIG.boss.summonCount; i++) {
        if (enemies.filter(e => !e.dead).length >= CONFIG.enemy.maxCount) break;
        const ang = Math.random() * Math.PI * 2;
        const e = createEnemy('crane',
          Math.max(-15, Math.min(15, pos.x + Math.sin(ang) * 3)),
          Math.max(-15, Math.min(15, pos.z + Math.cos(ang) * 3)),
          { spawnAnim: true });
        e.attackCd = 1.5;
      }
      toast('涂改大王召唤了增援！');
      boss.state = 'idle';
      boss.attackCd = interval;
    }
  } else if (boss.state === 'charge') {
    // 冲撞预警线
    const a = boss.aimLine.geometry.attributes.position;
    a.setXYZ(0, pos.x, 1.5, pos.z);
    a.setXYZ(1, player.pos.x, player.pos.y, player.pos.z);
    a.needsUpdate = true;
    boss.aimLine.visible = true;
    if (boss.telegraph >= CONFIG.boss.chargeTelegraph) {
      boss.state = 'charging';
      boss.dirX = dx / dist;
      boss.dirZ = dz / dist;
      boss.chargeT = 0;
      boss.hitDone = false;
      playTone(90, .25, 'sawtooth', .07, 60);
    }
  } else if (boss.state === 'charging') {
    boss.aimLine.visible = false;
    boss.chargeT += dt;
    const step = CONFIG.boss.chargeSpeed * dt;
    pos.x += boss.dirX * step;
    pos.z += boss.dirZ * step;
    resolveCircle(pos, CONFIG.boss.radius);
    // 撞上玩家画墙：撞碎并结束冲撞
    for (const w of walls) {
      if (w.dead) continue;
      if (Math.hypot(w.x - pos.x, w.z - pos.z) < 1.4) {
        damageWall(w, CONFIG.boss.chargeWallDamage);
        boss.hitDone = true;
        boss.chargeT = CONFIG.boss.chargeTime;
        break;
      }
    }
    // 冲撞命中玩家（按移动后的实际距离判定）
    const pdx = player.pos.x - pos.x, pdz = player.pos.z - pos.z;
    if (!boss.hitDone && pdx * pdx + pdz * pdz < 1.25 * 1.25) {
      damagePlayer(CONFIG.boss.chargeDamage);
      boss.hitDone = true;
      boss.chargeT = CONFIG.boss.chargeTime;
    }
    if (boss.chargeT >= CONFIG.boss.chargeTime) {
      boss.state = 'idle';
      boss.attackCd = interval;
    }
  }
}

function killEnemy(e) {
  if (e.dead) return;
  const p = e.group.position.clone();
  p.y = .75;
  removeEnemy(e);
  kills++;
  spawnImpact(p, C.red, 9);
  playTone(210, .11, 'triangle', .06, -100);
}

function removeEnemy(e) {
  scene.remove(e.group);
  scene.remove(e.aimLine);
  disposeDynamic(e.group);
  disposeDynamic(e.aimLine);
  e.dead = true;
}

function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    e.flash = Math.max(0, e.flash - dt);
    // 颜色反馈：涂改灵用身体色（受击红 / 无甲白 / 纸色），模型敌人用描边闪白
    if (e.type === 'crane') {
      if (e.flash > 0) e.body.material.color.set(C.red);
      else if (e.armor <= 0) e.body.material.color.set(0xFFFFFF);
      else e.body.material.color.set(C.paper);
    } else if (e.edge) {
      e.edge.material.color.set(e.flash > 0 ? 0xFFFFFF : C.red);
    }

    // 增援落地动画
    if (e.spawnT < 1) {
      e.spawnT = Math.min(1, e.spawnT + dt / CONFIG.enemy.spawnAnimTime);
      e.group.scale.setScalar(.05 + .95 * e.spawnT);
    }

    e.slow = Math.max(0, e.slow - dt);
    e.attackCd -= dt;
    if (graceTime > 0) e.attackCd = Math.max(e.attackCd, .5);

    if (e.stun > 0) {
      e.stun -= dt;
      e.telegraph = 0;
      e.aimLine.visible = false;
      continue;
    }

    if (e.type === 'plane') { updatePlane(e, dt); continue; }
    if (e.type === 'eraser') { updateEraser(e, dt); continue; }

    // ---- 涂改灵 ----
    const pos = e.group.position;
    const dx = player.pos.x - pos.x, dz = player.pos.z - pos.z;
    const dist = Math.max(.001, Math.hypot(dx, dz));
    e.group.rotation.y = Math.atan2(dx, dz);

    // 视线检测按固定间隔错峰执行，结果缓存到 e.blocked
    const origin = tmpV2.set(pos.x, .86, pos.z);
    const target = tmpV3.set(player.pos.x, Math.min(player.pos.y, 1.8), player.pos.z);
    e.losTimer -= dt;
    if (e.losTimer <= 0) {
      e.losTimer = CONFIG.enemy.losInterval;
      e.blocked = getBlocker(origin, target);
    }

    const canAct = e.spawnT >= 1;
    const blocker = e.blocked;
    let mx = 0, mz = 0, attackPlayer = false, attackWall = null;
    if (blocker && blocker.object.userData.wall && !blocker.object.userData.wall.dead) {
      // 视线被玩家掩体挡住：靠近后攻击掩体，避免卡死
      const w = blocker.object.userData.wall;
      const bd = Math.hypot(blocker.point.x - pos.x, blocker.point.z - pos.z);
      if (bd > 1.05) {
        mx = (blocker.point.x - pos.x) / bd;
        mz = (blocker.point.z - pos.z) / bd;
      } else attackWall = w;
    } else if (blocker) {
      // 被固定场景障碍挡住：沿切向绕行
      const side = e.strafe;
      mx = -dz / dist * side + dx / dist * (dist > 8 ? .55 : .1);
      mz = dx / dist * side + dz / dist * (dist > 8 ? .55 : .1);
    } else if (dist < CONFIG.enemy.attackRange && canAct) {
      // 视线通畅：进入攻击状态
      attackPlayer = true;
      if (dist < 4) { mx = -dx / dist; mz = -dz / dist; }
      else { mx = -dz / dist * e.strafe * .48; mz = dx / dist * e.strafe * .48; }
    } else {
      mx = dx / dist;
      mz = dz / dist;
    }

    if (attackPlayer || attackWall) {
      if (e.attackCd <= 0) {
        e.telegraph += dt;
        const tx = attackPlayer ? player.pos.x : attackWall.x;
        const tz = attackPlayer ? player.pos.z : attackWall.z;
        const ty = attackPlayer ? Math.min(player.pos.y, 1.65) : .85;
        const a = e.aimLine.geometry.attributes.position;
        a.setXYZ(0, pos.x, .88, pos.z);
        a.setXYZ(1, tx, ty, tz);
        a.needsUpdate = true;
        e.aimLine.material.opacity = .25 + .7 * Math.min(1, e.telegraph / CONFIG.enemy.telegraph);
        e.aimLine.visible = true;
        if (e.telegraph >= CONFIG.enemy.telegraph) {
          if (attackPlayer) {
            // 发射瞬间实时复检视线；能否命中交给可躲避的墨弹
            const check = getBlocker(origin, target);
            if (!check && dist < CONFIG.enemy.attackRange + .4) {
              fireProjectile(
                { x: pos.x, y: .88, z: pos.z },
                { x: player.pos.x, y: player.pos.y, z: player.pos.z },
                CONFIG.enemy.projectileSpeed,
                CONFIG.enemy.damage
              );
            }
          } else {
            damageWall(attackWall, CONFIG.enemy.wallDamage);
          }
          e.telegraph = 0;
          e.attackCd = CONFIG.enemy.attackCooldown;
          e.aimLine.visible = false;
        }
      } else {
        e.telegraph = 0;
        e.aimLine.visible = false;
      }
    } else {
      e.telegraph = 0;
      e.aimLine.visible = false;
    }

    // 移动（蓄力与减速时变慢）+ 卡住检测（超时翻转绕行方向）
    const ml = Math.hypot(mx, mz);
    if (ml > .01) {
      const mul = (e.telegraph > 0 ? .32 : 1) * (e.slow > 0 ? CONFIG.enemy.slowFactor : 1);
      const step = CONFIG.enemy.speed * mul * dt;
      const bx = pos.x, bz = pos.z;
      moveCircle(pos, mx / ml * step, mz / ml * step, CONFIG.enemy.radius);
      const moved = Math.hypot(pos.x - bx, pos.z - bz);
      if (moved < step * .3) e.stuckTimer += dt;
      else e.stuckTimer = Math.max(0, e.stuckTimer - dt * 2);
      if (e.stuckTimer > CONFIG.enemy.stuckFlipTime) {
        e.strafe *= -1;
        e.stuckTimer = 0;
      }
    }
  }

  // 敌人之间简单分离，避免重叠（飞行单位不参与）
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a.dead || a.type === 'plane') continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j];
      if (b.dead || b.type === 'plane') continue;
      const dx = b.group.position.x - a.group.position.x;
      const dz = b.group.position.z - a.group.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0 && d < .72) {
        const p = (.72 - d) / d * .25;
        a.group.position.x -= dx * p;
        a.group.position.z -= dz * p;
        b.group.position.x += dx * p;
        b.group.position.z += dz * p;
      }
    }
  }
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (enemies[i].dead) enemies.splice(i, 1);
  }
}

/** 橡皮擦虫：优先啃玩家的墙，无墙时贴身啃玩家 */
function updateEraser(e, dt) {
  const spec = CONFIG.enemy.eraser;
  const pos = e.group.position;
  const mul = e.slow > 0 ? CONFIG.enemy.slowFactor : 1;
  let wallTarget = null, wd = Infinity;
  for (const w of walls) {
    if (w.dead) continue;
    const d = Math.hypot(w.x - pos.x, w.z - pos.z);
    if (d < wd) { wd = d; wallTarget = w; }
  }
  let mx = 0, mz = 0;
  if (wallTarget && wd < spec.seekRange) {
    e.group.rotation.y = Math.atan2(wallTarget.x - pos.x, wallTarget.z - pos.z);
    if (wd > 1.15) {
      mx = (wallTarget.x - pos.x) / wd;
      mz = (wallTarget.z - pos.z) / wd;
    } else if (e.attackCd <= 0) {
      damageWall(wallTarget, spec.wallBite);
      e.attackCd = spec.biteCooldown;
      spawnImpact(wallTarget.mesh.position, C.paper, 5);
      playTone(90, .1, 'square', .05, -20);
    }
  } else {
    const dx = player.pos.x - pos.x, dz = player.pos.z - pos.z;
    const d = Math.max(.001, Math.hypot(dx, dz));
    e.group.rotation.y = Math.atan2(dx, dz);
    if (d > .95) {
      mx = dx / d;
      mz = dz / d;
    } else if (e.attackCd <= 0) {
      damagePlayer(spec.biteDamage);
      e.attackCd = spec.biteCooldown;
      spawnImpact(player.pos, C.paper, 5);
      playTone(70, .1, 'square', .05, -10);
    }
  }
  const ml = Math.hypot(mx, mz);
  if (ml > .01) {
    const step = spec.speed * mul * dt;
    moveCircle(pos, mx / ml * step, mz / ml * step, spec.radius);
  }
}

/** 纸飞机：高空环绕，蓄力后俯冲（无视墙体） */
function updatePlane(e, dt) {
  const spec = CONFIG.enemy.plane;
  const pos = e.group.position;
  const hoverY = spec.height;
  const dx = player.pos.x - pos.x, dz = player.pos.z - pos.z;
  const dist = Math.max(.001, Math.hypot(dx, dz));
  const mul = e.slow > 0 ? CONFIG.enemy.slowFactor : 1;

  if (e.state === 'circle') {
    pos.y = hoverY + Math.sin(elapsed * 3 + e.phase) * .25;
    const tx = -dz / dist * e.strafe + dx / dist * (dist > spec.circleDist ? .6 : -.4);
    const tz = dx / dist * e.strafe + dz / dist * (dist > spec.circleDist ? .6 : -.4);
    pos.x = Math.max(-16, Math.min(16, pos.x + tx * spec.speed * mul * dt));
    pos.z = Math.max(-16, Math.min(16, pos.z + tz * spec.speed * mul * dt));
    e.group.rotation.y = Math.atan2(dx, dz);
    e.telegraph = 0;
    e.aimLine.visible = false;
    e.circleCd -= dt;
    if (e.circleCd <= 0 && dist < 12) {
      e.state = 'aim';
      e.telegraph = 0;
    }
  } else if (e.state === 'aim') {
    pos.y = hoverY + Math.sin(elapsed * 3 + e.phase) * .15;
    e.group.rotation.y = Math.atan2(dx, dz);
    e.telegraph += dt;
    const a = e.aimLine.geometry.attributes.position;
    a.setXYZ(0, pos.x, pos.y, pos.z);
    a.setXYZ(1, player.pos.x, player.pos.y, player.pos.z);
    a.needsUpdate = true;
    e.aimLine.material.opacity = .25 + .7 * Math.min(1, e.telegraph / spec.aimTime);
    e.aimLine.visible = true;
    if (e.telegraph >= spec.aimTime) {
      e.state = 'dive';
      e.diveT = 0;
      e.diveDirX = dx / dist;
      e.diveDirZ = dz / dist;
      e.diveY = player.pos.y - .4;   // 俯冲目标：玩家躯干高度（机体中心）
      playTone(300, .12, 'sawtooth', .05, 120);
    }
  } else if (e.state === 'dive') {
    e.aimLine.visible = false;
    e.diveT += dt;
    pos.x += e.diveDirX * spec.diveSpeed * dt;
    pos.z += e.diveDirZ * spec.diveSpeed * dt;
    pos.y += Math.max(-spec.diveSpeed * dt * .8, Math.min(spec.diveSpeed * dt * .8, e.diveY - pos.y));
    const pd = Math.hypot(player.pos.x - pos.x, player.pos.z - pos.z);
    const band = Math.abs(pos.y - (player.pos.y - .35)) < .8;
    if (pd < .6 && band) {
      damagePlayer(spec.diveDamage);
      spawnImpact(pos, C.red, 6);
      e.state = 'climb';
      e.diveT = 0;
    } else if (e.diveT >= spec.diveTime) {
      e.state = 'climb';
      e.diveT = 0;
    }
  } else { // climb：回升到环绕高度
    e.aimLine.visible = false;
    e.diveT += dt;
    pos.y = Math.min(hoverY, pos.y + 3.5 * dt);
    if (e.diveT >= .6) {
      e.state = 'circle';
      e.circleCd = spec.circleCd;
    }
  }
}

/* ================= 10. 敌方投射物（可躲避墨弹） ================= */
function fireProjectile(from, to, speed, damage) {
  if (projectiles.length >= 24) return;
  const dir = tmpV2.set(to.x - from.x, to.y - from.y, to.z - from.z);
  const dist = dir.length();
  if (dist < .4) return;
  dir.multiplyScalar(1 / dist);
  let mesh = projectilePool.pop();
  if (!mesh) mesh = new THREE.Mesh(PROJECTILE_GEO, PROJECTILE_MAT);
  mesh.visible = true;
  if (!mesh.parent) scene.add(mesh);
  mesh.position.set(from.x, from.y, from.z);
  projectiles.push({ mesh, vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed, life: 1.8, damage });
  playTone(170, .07, 'sawtooth', .04, -40);
}

/** 点是否落在墙体胶囊范围内（含弹道半径） */
function capsulePoint2D(px, pz, w) {
  const dx = px - w.x, dz = pz - w.z;
  const along = dx * w.ux + dz * w.uz;
  const side = dx * w.nx + dz * w.nz;
  return Math.abs(along) <= w.len / 2 && Math.abs(side) <= w.halfThickness + CONFIG.enemy.projectileRadius;
}

function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life -= dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    const px = p.mesh.position.x, py = p.mesh.position.y, pz = p.mesh.position.z;
    let hit = false;
    // 玩家画的掩体：命中造成墙体伤害并消散，留下红色墨渍
    if (py < CONFIG.wall.height) {
      for (const w of walls) {
        if (w.dead) continue;
        if (capsulePoint2D(px, pz, w)) {
          damageWall(w, CONFIG.enemy.wallDamage);
          spawnImpact(p.mesh.position, C.teal, 5);
          const vlen = Math.hypot(p.vx, p.vy, p.vz) || 1;
          spawnSplatBurst(p.mesh.position, tmpV.set(-p.vx / vlen, -p.vy / vlen, -p.vz / vlen), w, C.red);
          hit = true;
          break;
        }
      }
    }
    // 折纸纸墙：纯阻挡（永久设施，不扣耐久），同样留红渍
    if (!hit && py < CONFIG.folds.wallHeight) {
      for (const w of foldWalls) {
        if (capsulePoint2D(px, pz, w)) {
          spawnImpact(p.mesh.position, C.teal, 4);
          const vlen = Math.hypot(p.vx, p.vy, p.vz) || 1;
          spawnSplatBurst(p.mesh.position, tmpV.set(-p.vx / vlen, -p.vy / vlen, -p.vz / vlen), null, C.red);
          hit = true;
          break;
        }
      }
    }
    // 固定场景障碍（比弹道高的才挡得住）
    if (!hit) {
      for (const b of staticColliders) {
        if (py < b.h && Math.abs(px - b.x) < b.hx && Math.abs(pz - b.z) < b.hz) {
          spawnImpact(p.mesh.position, C.ink, 4);
          hit = true;
          break;
        }
      }
    }
    // 玩家躯干判定带
    if (!hit) {
      const dx = px - player.pos.x, dz = pz - player.pos.z;
      if (Math.abs(py - (player.pos.y - .35)) < .55 && dx * dx + dz * dz < .45 * .45) {
        damagePlayer(p.damage);
        spawnImpact(p.mesh.position, C.red, 6);
        hit = true;
      }
    }
    // 出界或超时
    if (!hit && (p.life <= 0 || py < .02 || py > 6 || Math.abs(px) > 17.4 || Math.abs(pz) > 17.4)) hit = true;
    if (hit) {
      p.mesh.visible = false;
      projectilePool.push(p.mesh);
      projectiles.splice(i, 1);
    }
  }
}

/* ================= 11. 特效（对象池） ================= */
/** 命中粒子：共享几何 + 池化网格，不再每次新建几何体 */
function spawnImpact(point, color, count = 4) {
  for (let i = 0; i < count; i++) {
    let mesh = particlePool.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(PARTICLE_GEO, new THREE.MeshBasicMaterial({ transparent: true }));
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    mesh.visible = true;
    mesh.material.color.set(color);
    mesh.position.copy(point);
    mesh.position.x += (Math.random() - .5) * .25;
    mesh.position.y += (Math.random() - .5) * .25;
    mesh.position.z += (Math.random() - .5) * .25;
    mesh.rotation.set(0, 0, 0);
    effects.push({
      type: 'particle', mesh,
      life: .38 + Math.random() * .2, max: .58,
      vel: new THREE.Vector3((Math.random() - .5) * 2, 1 + Math.random() * 2, (Math.random() - .5) * 2),
      spin: (Math.random() - .5) * 9,
    });
  }
}

/** 射击曳光线：池化复用，只更新顶点位置 */
function spawnTracer(from, to) {
  let ref = tracerPool.pop();
  if (!ref) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = lineMat(C.teal, .85);
    material.transparent = true;
    const line = new THREE.Line(geo, material);
    line.frustumCulled = false;
    scene.add(line);
    ref = { line };
  }
  const a = ref.line.geometry.attributes.position;
  a.setXYZ(0, from.x, from.y, from.z);
  a.setXYZ(1, to.x, to.y, to.z);
  a.needsUpdate = true;
  ref.line.visible = true;
  effects.push({ type: 'tracer', ref, life: .07, max: .07 });
}

function releaseEffect(f) {
  if (f.type === 'tracer') {
    f.ref.line.visible = false;
    tracerPool.push(f.ref);
  } else if (f.type === 'particle') {
    f.mesh.visible = false;
    particlePool.push(f.mesh);
  } else {
    scene.remove(f.mesh);
    disposeDynamic(f.mesh);
  }
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const f = effects[i];
    f.life -= dt;
    if (f.type === 'tracer') {
      f.ref.line.material.opacity = Math.max(0, f.life / f.max) * .85;
    } else if (f.type === 'particle') {
      f.vel.y -= 8 * dt;
      f.mesh.position.addScaledVector(f.vel, dt);
      f.mesh.rotation.x += f.spin * dt;
      f.mesh.rotation.z += f.spin * .7 * dt;
      f.mesh.material.opacity = Math.max(0, f.life / f.max);
    } else if (f.type === 'ring') {
      const p = 1 - f.life / f.max;
      f.mesh.scale.setScalar(1 + p * 5.7);
      f.mesh.material.opacity = Math.max(0, 1 - p);
    }
    if (f.life <= 0) {
      releaseEffect(f);
      effects.splice(i, 1);
    }
  }
}

/* ---------- 墙面墨渍：子弹命中留下彩色墨点（池化 + 定时淡出） ---------- */
const SPLAT_Z = new THREE.Vector3(0, 0, 1);

function spawnInkSplat(point, normal, colorHex, wallRef = null) {
  if (!SPLAT_GEO) return null;
  // 上限管理：超出则立即回收最旧的一枚
  if (activeSplats.length >= CONFIG.visual.splat.max) {
    releaseSplat(activeSplats.shift());
  }
  const mesh = splatPool.pop() || (() => {
    const m = new THREE.Mesh(SPLAT_GEO, new THREE.MeshBasicMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    m.userData.noDispose = true;
    m.renderOrder = 4;   // 半透明画墙属于透明队列，墨渍需后画避免被冲淡
    return m;
  })();
  const mat = mesh.material;
  // palette 以无 # 的 hex 存储时 Color.set 会静默失败，这里统一补 #
  mat.color.set(colorHex[0] === '#' ? colorHex : '#' + colorHex);
  mat.opacity = .88;
  mesh.position.set(
    point.x + normal.x * .015,
    point.y + normal.y * .015,
    point.z + normal.z * .015
  );
  mesh.quaternion.setFromUnitVectors(SPLAT_Z, normal);
  mesh.rotateZ(Math.random() * Math.PI * 2);
  const s = .16 + Math.random() * .22;
  mesh.scale.set(s * (.7 + Math.random() * .8), s * (.7 + Math.random() * .8), 1);
  if (!mesh.parent) scene.add(mesh);
  const rec = { mesh, life: CONFIG.visual.splat.life, wallRef };
  mesh.userData.splatRec = rec;
  activeSplats.push(rec);
  return rec;
}

/** 一组墨渍：主渍 + 40% 概率的小溅点 */
function spawnSplatBurst(point, normal, wallRef, colorHex) {
  const palette = CONFIG.visual.splat.palette;
  const c = colorHex || palette[(Math.random() * palette.length) | 0];
  spawnInkSplat(point, normal, c, wallRef);
  if (Math.random() < .4) {
    spawnInkSplat(
      {
        x: point.x + (Math.random() - .5) * .3,
        y: point.y + (Math.random() - .5) * .3,
        z: point.z + (Math.random() - .5) * .3,
      },
      normal, c, wallRef
    );
  }
}

function releaseSplat(rec) {
  if (rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
  rec.mesh.visible = false;
  splatPool.push(rec.mesh);
}

function updateSplats(dt) {
  const fade = CONFIG.visual.splat.fadeTime;
  for (let i = activeSplats.length - 1; i >= 0; i--) {
    const rec = activeSplats[i];
    rec.life -= dt;
    rec.mesh.material.opacity = Math.min(.88, Math.max(0, rec.life / fade) * .88);
    if (rec.life <= 0) {
      releaseSplat(rec);
      activeSplats.splice(i, 1);
    }
  }
}

/** 墙被拆除时，一并回收附着其上的墨渍 */
function clearSplatsOnWall(w) {
  for (let i = activeSplats.length - 1; i >= 0; i--) {
    if (activeSplats[i].wallRef === w) {
      releaseSplat(activeSplats[i]);
      activeSplats.splice(i, 1);
    }
  }
}

/* ================= 12. 导航辅助 ================= */
function makeNavArrow(label, color) {
  const el = document.createElement('div');
  el.className = 'nav-arrow';
  el.style.setProperty('--nav-color', color);
  el.innerHTML = '<i></i><b></b><span></span>';
  el.querySelector('b').textContent = label;
  UI.navLayer.appendChild(el);
  return { el, tip: el.querySelector('i'), dist: el.querySelector('span'), lastDist: -1, visible: false };
}

function buildNavUI() {
  navArrows = anchors.map(a => makeNavArrow(a.label, '#F2C14E'));
  navExitArrow = makeNavArrow('出口', '#007F7B');
}

function hideNavArrow(arrow) {
  if (arrow.visible) {
    arrow.el.classList.remove('show');
    arrow.visible = false;
  }
}

/** 每帧把未完成目标投影到屏幕；不可见时在屏幕边缘显示方向箭头 */
function updateNav() {
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const w = innerWidth, h = innerHeight;
  const place = (arrow, x, z) => {
    tmpV.set(x, 1.6, z);
    tmpV2.copy(tmpV).applyMatrix4(camera.matrixWorldInverse);
    const behind = tmpV2.z > 0;
    tmpV.project(camera);
    let nx = tmpV.x, ny = tmpV.y;
    if (behind) { nx = -nx; ny = -ny; }
    const off = behind || Math.abs(nx) > .96 || Math.abs(ny) > .96;
    if (!off) { hideNavArrow(arrow); return; }
    // 归一化到屏幕边缘内侧 88% 位置
    const m = Math.max(Math.abs(nx), Math.abs(ny), .0001);
    nx = nx / m * .88;
    ny = ny / m * .88;
    const sx = (nx * .5 + .5) * w;
    const sy = (.5 - ny * .5) * h;
    const ang = Math.atan2(nx, ny);      // 相对“向上”的顺时针角度
    const dist = Math.round(Math.hypot(player.pos.x - x, player.pos.z - z));
    if (!arrow.visible) {
      arrow.el.classList.add('show');
      arrow.visible = true;
    }
    arrow.el.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-50%)`;
    arrow.tip.style.transform = `rotate(${ang.toFixed(3)}rad)`;
    if (dist !== arrow.lastDist) {
      arrow.dist.textContent = dist + 'm';
      arrow.lastDist = dist;
    }
  };
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (a.active || Math.hypot(player.pos.x - a.x, player.pos.z - a.z) < 3) {
      hideNavArrow(navArrows[i]);
      continue;
    }
    place(navArrows[i], a.x, a.z);
  }
  if (exitUnlocked && Math.hypot(player.pos.x - exitGroup.position.x, player.pos.z - exitGroup.position.z) >= 3) {
    place(navExitArrow, exitGroup.position.x, exitGroup.position.z);
  } else {
    hideNavArrow(navExitArrow);
  }
}

/** 未锚定锚点的黄色光柱脉动 */
function updateBeacons(dt) {
  for (const a of anchors) {
    if (a.active) continue;
    a.beacon.material.opacity = .22 + .12 * Math.sin(elapsed * 2.6);
    a.beacon.rotation.y += dt * 1.2;
  }
}

/* ================= 13. HUD（脏检查） ================= */
const hudCache = { hp: -1, ink: -1, ammo: '', weapon: '', timer: '', danger: null, objective: '', cross: null, damage: -1, toast: null, boss: -1 };

function resetHudCache() {
  hudCache.hp = -1;
  hudCache.ink = -1;
  hudCache.ammo = '';
  hudCache.weapon = '';
  hudCache.timer = '';
  hudCache.danger = null;
  hudCache.objective = '';
  hudCache.cross = null;
  hudCache.damage = -1;
  hudCache.toast = null;
  hudCache.boss = -1;
}

function updateHUD() {
  if (!player) return;
  const hp = Math.ceil(player.hp);
  if (hp !== hudCache.hp) {
    hudCache.hp = hp;
    UI.hpText.textContent = hp;
    UI.hpFill.style.width = hp + '%';
  }
  const ink = Math.floor(player.ink);
  if (ink !== hudCache.ink) {
    hudCache.ink = ink;
    UI.inkText.textContent = ink;
    UI.inkFill.style.width = ink + '%';
  }
  const ammo = player.ammo + ' / ∞';
  if (ammo !== hudCache.ammo) {
    hudCache.ammo = ammo;
    UI.ammoText.textContent = ammo;
  }
  const weapon = player.reload > 0
    ? '换弹中 ' + player.reload.toFixed(1) + 's'
    : '线规笔 · 连发墨点 · E ' + (player.eraseCd > 0 ? player.eraseCd.toFixed(1) + 's' : '就绪');
  if (weapon !== hudCache.weapon) {
    hudCache.weapon = weapon;
    UI.weaponState.textContent = weapon;
  }
  const timer = formatTime(timeLeft);
  if (timer !== hudCache.timer) {
    hudCache.timer = timer;
    UI.timer.textContent = timer;
  }
  const danger = timeLeft <= 30;
  if (danger !== hudCache.danger) {
    hudCache.danger = danger;
    UI.timer.classList.toggle('danger', danger);
  }
  const objective = boss ? 'boss' : exitUnlocked ? 'exit' : 'a' + anchorsDone;
  if (objective !== hudCache.objective) {
    hudCache.objective = objective;
    UI.objective.innerHTML = boss
      ? '击败涂改大王<small>击败后裁切线开启</small>'
      : exitUnlocked
        ? '裁切线已开启<small>前往南侧出口，按住 F 撤离</small>'
        : '装订锚点 ' + anchorsDone + ' / 3<small>启动全部锚点后撤离</small>';
  }
  if (boss) {
    const pct = Math.round(boss.hp / boss.maxHp * 100);
    if (pct !== hudCache.boss) {
      hudCache.boss = pct;
      UI.bossFill.style.width = pct + '%';
    }
  }
  const cross = hitTime > 0;
  if (cross !== hudCache.cross) {
    hudCache.cross = cross;
    UI.crosshair.classList.toggle('hit', cross);
  }
  const dmg = Math.round(Math.min(.72, damageTime * 1.7) * 100);
  if (dmg !== hudCache.damage) {
    hudCache.damage = dmg;
    UI.damage.style.opacity = dmg / 100;
  }
  const toastShown = toastTime > 0;
  if (toastShown !== hudCache.toast) {
    hudCache.toast = toastShown;
    UI.toast.classList.toggle('show', toastShown);
  }
}

function toast(text) {
  UI.toast.textContent = text;
  UI.toast.classList.add('show');
  hudCache.toast = true;
  toastTime = 2.1;
}

function formatTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ================= 14. 流程 ================= */
function resetGame() {
  clearDynamic();
  timeLeft = CONFIG.round.timeLimit;
  elapsed = 0;
  kills = 0;
  wallsDrawn = 0;
  erases = 0;
  anchorsDone = 0;
  exitUnlocked = false;
  graceTime = CONFIG.round.graceTime;
  drawStart = null;
  useProgress = 0;
  useTarget = null;
  toastTime = 0;
  hitTime = 0;
  damageTime = 0;
  recoil = 0;
  mouseFire = false;
  touchFire = false;
  touchUse = false;
  Object.keys(keys).forEach(k => delete keys[k]);
  touchMove.x = touchMove.y = 0;
  player = {
    pos: new THREE.Vector3(0, CONFIG.player.eyeHeight, -13),
    velX: 0, velZ: 0, velY: 0,
    yaw: Math.PI, pitch: 0,
    hp: CONFIG.player.maxHp,
    ink: CONFIG.ink.max,
    ammo: CONFIG.player.gun.magazine,
    reload: 0, fireCd: 0, eraseCd: 0, lastSkill: -10, grounded: true,
  };
  anchors.forEach(a => {
    a.active = false;
    a.ringMat.color.set(C.yellow);
    a.group.scale.setScalar(1);
    a.beacon.visible = true;
  });
  updateExitVisual();
  drawPreview.visible = false;
  drawMarker.visible = false;
  camera.position.copy(player.pos);
  camera.rotation.set(0, player.yaw, 0);
  gun.position.set(.38, -.31, -.64);
  gun.rotation.set(-.08, -.08, 0);
  CONFIG.waves.initial.forEach((type, i) => {
    const p = CONFIG.waves.spots[i % CONFIG.waves.spots.length];
    createEnemy(type, p[0], p[1]);
  });
  // 折纸地形复位（默认坡道）+ 拾取物复位
  foldWalls = [];
  for (const f of folds) {
    f.state = 'ramp';
    f.animT = 1;
    f.fromAngle = CONFIG.folds.rampAngle;
    f.pivot.rotation.x = CONFIG.folds.rampAngle;
    f.wall = null;
    const mi = solidMeshes.indexOf(f.mesh);
    if (mi >= 0) solidMeshes.splice(mi, 1);
  }
  for (const p of pickups) {
    p.taken = false;
    p.mesh.visible = true;
    p.mesh.position.y = .32;
  }
  resetHudCache();
  updateHUD();
  // 清空全部墙面墨渍
  while (activeSplats.length) releaseSplat(activeSplats.pop());
}

function clearDynamic() {
  removeBoss();
  enemies.forEach(e => {
    scene.remove(e.group);
    scene.remove(e.aimLine);
    disposeDynamic(e.group);
    disposeDynamic(e.aimLine);
    e.dead = true;
  });
  enemies = [];
  walls.forEach(w => {
    scene.remove(w.mesh);
    disposeDynamic(w.mesh);
    w.dead = true;
  });
  walls = [];
  effects.forEach(f => releaseEffect(f));
  effects = [];
  projectiles.forEach(p => {
    p.mesh.visible = false;
    projectilePool.push(p.mesh);
  });
  projectiles = [];
  solidMeshes = staticMeshes.slice();
}

function updateExitVisual() {
  exitPlane.material.color.set(exitUnlocked ? C.teal : C.red);
  exitPlane.material.opacity = exitUnlocked ? .72 : .4;
  if (exitGroup.userData.sign) {
    exitGroup.remove(exitGroup.userData.sign);
    disposeDynamic(exitGroup.userData.sign);
  }
  const sign = createTextPlane(exitUnlocked ? '撤离点\nOPEN' : '裁切线\nLOCKED', 3.4, 1.3, exitUnlocked ? '#007F7B' : '#E34B3F');
  sign.position.set(0, 1.55, 0);
  exitGroup.add(sign);
  exitGroup.userData.sign = sign;
}

function startGame() {
  resetGame();
  mode = 'playing';
  UI.menu.hidden = true;
  UI.pauseOverlay.hidden = true;
  UI.endOverlay.hidden = true;
  UI.settingsOverlay.hidden = true;
  document.body.classList.add('playing');
  initAudio();
  clockLast = performance.now();
  toast('启动三处锚点，然后撤离');
  requestLock();
}

function pauseGame(manual = true) {
  if (mode !== 'playing') return;
  if (!manual && noAutoPause) return;   // 调试模式：忽略失焦/切后台触发的自动暂停
  mode = 'paused';
  mouseFire = false;
  touchFire = false;
  touchUse = false;
  Object.keys(keys).forEach(k => delete keys[k]);
  cancelDraw();
  document.body.classList.remove('playing');
  UI.pauseOverlay.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function resumeGame() {
  if (mode !== 'paused') return;
  mode = 'playing';
  UI.pauseOverlay.hidden = true;
  document.body.classList.add('playing');
  clockLast = performance.now();
  requestLock();
}

function endGame(won, reason) {
  if (mode !== 'playing') return;
  mode = won ? 'won' : 'lost';
  mouseFire = false;
  touchFire = false;
  touchUse = false;
  document.body.classList.remove('playing');
  cancelDraw();
  if (document.pointerLockElement) document.exitPointerLock();
  UI.endTitle.textContent = won ? '纸页已锚定' : '修订失败';
  UI.endReason.textContent = reason;
  UI.statTime.textContent = formatTime(elapsed);
  UI.statKills.textContent = kills;
  UI.statWalls.textContent = wallsDrawn;
  UI.statErases.textContent = erases;
  if (won) {
    const isNew = updateBestRecord(elapsed);
    UI.bestLine.hidden = false;
    UI.bestLine.classList.toggle('new-record', isNew);
    UI.bestLine.textContent = isNew
      ? '新纪录！最快撤离 ' + formatTime(elapsed)
      : '最快撤离纪录 ' + formatTime(loadBestRecord().time);
  } else {
    const best = loadBestRecord();
    UI.bestLine.hidden = !best;
    UI.bestLine.classList.remove('new-record');
    if (best) UI.bestLine.textContent = '最快撤离纪录 ' + formatTime(best.time);
  }
  UI.endOverlay.hidden = false;
  if (won) playTone(330, .35, 'triangle', .08, 330);
  else playTone(120, .35, 'sawtooth', .06, -60);
}

function activateAnchor(a) {
  if (a.active) return;
  a.active = true;
  a.ringMat.color.set(C.teal);
  a.group.scale.setScalar(1.12);
  a.beacon.visible = false;
  anchorsDone++;
  useProgress = 0;
  useTarget = null;
  spawnReinforcements(a);
  playTone(300, .22, 'triangle', .08, 260);
  if (anchorsDone === 3) {
    spawnBoss();
    toast('三处锚点完成——涂改大王现身！');
  } else {
    toast(a.label + ' 已锚定，增援出现');
  }
}

function updateInteraction(dt) {
  let target = null, type = '';
  for (const a of anchors) {
    if (!a.active && Math.hypot(player.pos.x - a.x, player.pos.z - a.z) < CONFIG.anchor.radius) {
      target = a;
      type = 'anchor';
      break;
    }
  }
  if (!target && exitUnlocked && Math.hypot(player.pos.x - exitGroup.position.x, player.pos.z - exitGroup.position.z) < CONFIG.anchor.exitRadius) {
    target = exitGroup;
    type = 'exit';
  }
  if (!target) {
    useProgress = 0;
    useTarget = null;
    UI.prompt.hidden = true;
    return;
  }
  const required = type === 'exit' ? CONFIG.anchor.exitHoldTime : CONFIG.anchor.holdTime;
  UI.prompt.hidden = false;
  UI.useTrack.hidden = false;
  UI.promptText.textContent = type === 'exit' ? '按住 F 完成撤离' : '按住 F 启动 ' + target.label;
  const using = (keys.KeyF || touchUse) && !mouseFire && !touchFire;
  if (using) {
    if (useTarget !== target) {
      useTarget = target;
      useProgress = 0;
    }
    useProgress += dt;
    if (useProgress >= required) {
      useProgress = 0;
      if (type === 'exit') {
        endGame(true, '三处锚点已恢复，你从裁切线安全撤离。');
        return;
      }
      activateAnchor(target);
    }
  } else {
    useProgress = 0;
    useTarget = target;
  }
  UI.useFill.style.width = Math.min(100, useProgress / required * 100) + '%';
}

function damagePlayer(amount) {
  if (mode !== 'playing' || godMode) return;
  player.hp = Math.min(CONFIG.player.maxHp, Math.max(0, player.hp - amount));
  damageTime = .42;
  // 调试观测：调试模式下记录每次受击（正常模式无此数组，零开销）
  if (window.__inklineHitLog) window.__inklineHitLog.push({ t: +elapsed.toFixed(2), hp: +player.hp.toFixed(1), dmg: amount });
  playTone(70, .15, 'sawtooth', .065, -20);
  if (player.hp <= 0) endGame(false, '生命值耗尽，纸页被涂改灵覆盖。');
}

/* ================= 15. 音频 ================= */
function initAudio() {
  if (reducedMotion) return;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = soundOn ? settings.volume : 0;
    masterGain.connect(audioCtx.destination);
  }
  if (soundOn && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function toggleSound() {
  if (reducedMotion) return;
  initAudio();
  soundOn = !soundOn;
  try { localStorage.setItem('inkline-sound', soundOn ? 'on' : 'off'); } catch { /* 忽略 */ }
  if (masterGain) {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(soundOn ? settings.volume : 0, audioCtx.currentTime + .05);
  }
  if (soundOn && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  updateSoundButton();
  if (soundOn) playTone(330, .08, 'triangle', .06, 80);
}

function playTone(freq, duration, type = 'sine', volume = .06, slide = 0) {
  if (!soundOn || !audioCtx || !masterGain || reducedMotion) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(30, freq), t);
  o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + duration);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(volume, t + .005);
  g.gain.exponentialRampToValueAtTime(.0001, t + duration);
  o.connect(g);
  g.connect(masterGain);
  o.start(t);
  o.stop(t + duration + .02);
}

function updateSoundButton() {
  UI.soundBtn.textContent = soundOn ? '声音 开' : '声音 关';
  UI.soundBtn.setAttribute('aria-checked', String(soundOn));
  if (reducedMotion) {
    UI.soundBtn.disabled = true;
    UI.soundBtn.title = '系统减少动态效果已开启，声音保持关闭';
  }
}

/* ================= 16. 输入 ================= */
function enableFallback() {
  if (isTouch) return;
  fallbackAim = true;
  UI.pauseOverlay.hidden = true;
  if (mode === 'paused') {
    mode = 'playing';
    clockLast = performance.now();
  }
  document.body.classList.add('playing');
  toast('兼容模式：移动鼠标瞄准，左键射击');
}

function requestLock() {
  if (isTouch || fallbackAim || mode !== 'playing') return;
  const c = UI.gameCanvas;
  if (document.pointerLockElement === c) return;
  if (!c.requestPointerLock) { enableFallback(); return; }
  try {
    const p = c.requestPointerLock();
    if (p && p.catch) p.catch(() => { if (mode === 'playing') enableFallback(); });
    setTimeout(() => {
      if (mode === 'playing' && !fallbackAim && document.pointerLockElement !== c) enableFallback();
    }, 450);
  } catch { enableFallback(); }
}

function bindHold(el, on, off) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    on();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    el.addEventListener(ev, e => { e.preventDefault(); off(); });
  }
}

function bindTouch() {
  UI.drawHint.textContent = isTouch ? '再次点击“画线”确定终点' : 'Q 确定终点 · 右键取消';
  const pad = UI.movePad, thumb = UI.moveThumb;
  let moveId = null;
  const move = e => {
    const r = pad.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy), max = 42;
    const k = len > max ? max / len : 1;
    const x = dx * k, y = dy * k;
    thumb.style.transform = `translate(${x}px,${y}px)`;
    touchMove.x = x / max;
    touchMove.y = -y / max;
  };
  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    moveId = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    move(e);
  });
  pad.addEventListener('pointermove', e => { if (e.pointerId === moveId) move(e); });
  const end = e => {
    if (e.pointerId !== moveId) return;
    moveId = null;
    touchMove.x = touchMove.y = 0;
    thumb.style.transform = 'translate(0,0)';
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, end);

  const look = UI.lookPad;
  let lookId = null, lx = 0, ly = 0;
  look.addEventListener('pointerdown', e => {
    e.preventDefault();
    lookId = e.pointerId;
    lx = e.clientX;
    ly = e.clientY;
    look.setPointerCapture(e.pointerId);
  });
  look.addEventListener('pointermove', e => {
    if (e.pointerId !== lookId || mode !== 'playing') return;
    player.yaw -= (e.clientX - lx) * .006 * settings.touchSens;
    player.pitch = Math.max(-1.42, Math.min(1.42, player.pitch - (e.clientY - ly) * .006 * settings.touchSens));
    lx = e.clientX;
    ly = e.clientY;
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    look.addEventListener(ev, e => { if (e.pointerId === lookId) lookId = null; });
  }

  bindHold(UI.touchFire, () => touchFire = true, () => touchFire = false);
  bindHold(UI.touchUse, () => touchUse = true, () => touchUse = false);
  UI.touchWall.addEventListener('click', handleDraw);
  UI.touchErase.addEventListener('click', erase);
  UI.touchFold.addEventListener('click', toggleNearestFold);
  UI.touchReload.addEventListener('click', startReload);
  UI.touchJump.addEventListener('click', jump);
  UI.touchPause.addEventListener('click', pauseGame);
}

function bindInputs() {
  UI.startBtn.addEventListener('click', startGame);
  UI.restartBtn.addEventListener('click', startGame);
  UI.pauseRestartBtn.addEventListener('click', startGame);
  UI.resumeBtn.addEventListener('click', resumeGame);
  UI.soundBtn.addEventListener('click', toggleSound);
  UI.settingsBtn.addEventListener('click', () => openSettings('menu'));
  UI.pauseSettingsBtn.addEventListener('click', () => openSettings('pause'));
  UI.settingsBackBtn.addEventListener('click', closeSettings);
  UI.howBtn.addEventListener('click', () => {
    const open = UI.howPanel.hidden;
    UI.howPanel.hidden = !open;
    UI.howBtn.setAttribute('aria-expanded', String(open));
    UI.howBtn.textContent = open ? '收起说明' : '操作说明';
  });

  const canvas = UI.gameCanvas;
  canvas.addEventListener('click', () => { if (mode === 'playing') requestLock(); });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousedown', e => {
    if (mode !== 'playing' || isTouch) return;
    if (fallbackAim) {
      if (e.button === 0) mouseFire = true;
      if (e.button === 2) cancelDraw();
      return;
    }
    if (document.pointerLockElement !== canvas) { requestLock(); return; }
    if (e.button === 0) mouseFire = true;
    if (e.button === 2) cancelDraw();
  });
  document.addEventListener('mouseup', e => { if (e.button === 0) mouseFire = false; });
  document.addEventListener('mousemove', e => {
    if (mode !== 'playing' || (!fallbackAim && document.pointerLockElement !== UI.gameCanvas)) return;
    player.yaw -= e.movementX * .0022 * settings.sens;
    player.pitch = Math.max(-1.42, Math.min(1.42, player.pitch - e.movementY * .0022 * settings.sens));
  });
  document.addEventListener('pointerlockchange', () => {
    if (!isTouch && !fallbackAim && mode === 'playing' && document.pointerLockElement !== UI.gameCanvas) pauseGame();
  });
  document.addEventListener('keydown', e => {
    if (mode !== 'playing') return;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'KeyR'].includes(e.code)) e.preventDefault();
    keys[e.code] = true;
    if (e.repeat) return;
    if (e.code === 'Space') jump();
    else if (e.code === 'KeyQ') handleDraw();
    else if (e.code === 'KeyC') toggleNearestFold();
    else if (e.code === 'KeyE') erase();
    else if (e.code === 'KeyR') startReload();
    else if (e.code === 'Escape') pauseGame();
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });
  window.addEventListener('blur', () => { if (mode === 'playing') pauseGame(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'playing') pauseGame(false); });
  window.addEventListener('resize', () => {
    if (!renderer) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1 : 1.5));
    renderer.setSize(innerWidth, innerHeight);
  });
  bindTouch();
}

/* ---------- 设置面板 ---------- */
let settingsFrom = 'menu';

function syncSettingsUI() {
  UI.sensSlider.value = Math.round(settings.sens * 100);
  UI.touchSensSlider.value = Math.round(settings.touchSens * 100);
  UI.volSlider.value = Math.round(settings.volume * 100);
  UI.fovSlider.value = settings.fov;
  UI.sensVal.textContent = settings.sens.toFixed(2) + '×';
  UI.touchSensVal.textContent = settings.touchSens.toFixed(2) + '×';
  UI.volVal.textContent = Math.round(settings.volume * 100) + '%';
  UI.fovVal.textContent = settings.fov;
  UI.touchSensRow.hidden = !isTouch;
}

function bindSettingsUI() {
  const bind = (slider, output, apply, fmt) => {
    UI[slider].addEventListener('input', () => {
      apply(+UI[slider].value);
      UI[output].textContent = fmt();
      saveSettings();
      applySettings();
    });
  };
  bind('sensSlider', 'sensVal', v => { settings.sens = v / 100; }, () => settings.sens.toFixed(2) + '×');
  bind('touchSensSlider', 'touchSensVal', v => { settings.touchSens = v / 100; }, () => settings.touchSens.toFixed(2) + '×');
  bind('volSlider', 'volVal', v => { settings.volume = v / 100; }, () => Math.round(settings.volume * 100) + '%');
  bind('fovSlider', 'fovVal', v => { settings.fov = v; }, () => settings.fov);
  syncSettingsUI();
}

function openSettings(from) {
  settingsFrom = from;
  if (from === 'menu') UI.menu.hidden = true;
  else UI.pauseOverlay.hidden = true;
  syncSettingsUI();
  UI.settingsOverlay.hidden = false;
}

function closeSettings() {
  UI.settingsOverlay.hidden = true;
  if (settingsFrom === 'menu') UI.menu.hidden = false;
  else UI.pauseOverlay.hidden = false;
}

/* ================= 17. 主循环与启动 ================= */
function update(dt) {
  elapsed += dt;
  timeLeft -= dt;
  graceTime = Math.max(0, graceTime - dt);
  if (timeLeft <= 0) {
    timeLeft = 0;
    endGame(false, '倒计时结束，工作页未能完成锚定。');
    return;
  }
  updatePlayer(dt);
  updateProjectiles(dt);
  updateWalls(dt);
  updateFolds(dt);
  updateDrawPreview();
  updateEnemies(dt);
  updateBoss(dt);
  if (mode !== 'playing') return;
  updateEffects(dt);
  updateSplats(dt);
  updateInteraction(dt);
  if (mode !== 'playing') return;
  updatePickups(dt);
  updateBeacons(dt);
  updateNav();
  toastTime = Math.max(0, toastTime - dt);
  hitTime = Math.max(0, hitTime - dt);
  damageTime = Math.max(0, damageTime - dt);
  updateHUD();
}

function updateWalls(dt) {
  for (let i = walls.length - 1; i >= 0; i--) {
    const w = walls[i];
    w.life -= dt;
    w.hit = Math.max(0, w.hit - dt);
    const opacity = w.life < 3 ? Math.max(0, w.life / 3) * .82 : .82;
    w.mesh.material.opacity = opacity;
    w.mesh.material.color.set(w.hit > 0 ? C.red : C.teal);
    if (w.mesh.children[0]) w.mesh.children[0].material.opacity = opacity;
    if (w.life <= 0) removeWall(w);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.04, Math.max(0, (now - clockLast) / 1000));
  clockLast = now;
  if (document.hidden) return;
  if (mode === 'playing') update(dt);
  if (renderer && scene && camera) renderer.render(scene, camera);
}

/** ?debug=1 时暴露确定性调试钩子，用于自动化回归（正式游玩无感） */
function enableDebugHooks() {
  window.__INKLINE_DEBUG__ = {
    state() {
      return {
        mode,
        timeLeft: +timeLeft.toFixed(2),
        elapsed: +elapsed.toFixed(2),
        hp: player ? player.hp : null,
        ink: player ? player.ink : null,
        ammo: player ? player.ammo : null,
        reload: player ? player.reload : null,
        anchorsDone, exitUnlocked, kills, wallsDrawn, erases,
        enemies: enemies.filter(e => !e.dead).map(e => ({
          type: e.type,
          x: +e.group.position.x.toFixed(2), z: +e.group.position.z.toFixed(2),
          hp: e.hp, armor: e.armor, stun: +e.stun.toFixed(2),
        })),
        walls: walls.map(w => ({
          x: +w.x.toFixed(2), z: +w.z.toFixed(2), len: +w.len.toFixed(2),
          hp: w.hp, life: +w.life.toFixed(2),
        })),
        anchors: anchors.map(a => ({ label: a.label, active: a.active })),
        folds: folds.map(f => ({ id: f.id, state: f.state, anim: +f.animT.toFixed(2) })),
        pickups: pickups.map(p => ({ type: p.type, taken: p.taken })),
        boss: boss ? { hp: boss.hp, state: boss.state, x: +boss.group.position.x.toFixed(2), z: +boss.group.position.z.toFixed(2) } : null,
        playerY: player ? +player.pos.y.toFixed(2) : null,
        ground: player ? +groundHeightAt(player.pos.x, player.pos.z).toFixed(2) : null,
        splats: activeSplats.length,
        splatDetails: activeSplats.slice(0, 6).map(r => ({
          x: +r.mesh.position.x.toFixed(2),
          y: +r.mesh.position.y.toFixed(2),
          z: +r.mesh.position.z.toFixed(2),
          color: '#' + r.mesh.material.color.getHexString(),
          opacity: +r.mesh.material.opacity.toFixed(2),
          visible: r.mesh.visible,
          inScene: !!r.mesh.parent,
        })),
      };
    },
    start: () => startGame(),
    pause: () => pauseGame(),
    resume: () => resumeGame(),
    teleport(x, z) { if (player) player.pos.set(x, CONFIG.player.eyeHeight, z); },
    setYaw(a) { if (player) { player.yaw = a; player.pitch = 0; } },
    setPitch(a) { if (player) player.pitch = a; },
    drawWall(ax, az, bx, bz) {
      if (mode !== 'playing') return false;
      const a = new THREE.Vector3(ax, 0, az);
      const b = new THREE.Vector3(bx, 0, bz);
      const len = a.distanceTo(b);
      if (len < CONFIG.ink.drawMinLen || len > CONFIG.ink.drawMaxLen) return false;
      createWall(a, b, len, CONFIG.ink.drawBase + CONFIG.ink.drawPerMeter * len);
      return true;
    },
    erase: () => erase(),
    fire: () => tryFire(),
    reload: () => startReload(),
    activateAnchor(i) { const a = anchors[i]; if (a) activateAnchor(a); },
    giveInk(n = 100) { if (player) player.ink = Math.min(CONFIG.ink.max, player.ink + n); },
    hurt(n = 8) { damagePlayer(n); },
    setTime(s) { timeLeft = s; },
    /** 确定性步进：手动驱动 update()（宿主窗口失焦导致 rAF 节流时，自动化测试仍可推进逻辑） */
    step(n = 1, dt = 1 / 60, render = true) {
      for (let i = 0; i < n; i++) {
        if (mode === 'playing') update(dt);
      }
      if (render && renderer && scene && camera) renderer.render(scene, camera);
      return { mode, timeLeft: +timeLeft.toFixed(2), elapsed: +elapsed.toFixed(2) };
    },
    end: won => endGame(won, won ? '调试：直接胜利' : '调试：直接失败'),
    spawnEnemy(type = 'crane', x = 0, z = 5) {
      if (mode !== 'playing') return null;
      const e = createEnemy(type, x, z, { spawnAnim: true });
      e.attackCd = 1.5;
      return e.type;
    },
    toggleFold(i = 0) { const f = folds[i]; if (f) toggleFold(f); return folds[i] ? folds[i].state : null; },
    spawnBoss() { if (mode === 'playing' && !boss) spawnBoss(); return !!boss; },
    hurtBoss(n = 24) { damageBoss(n); return boss ? boss.hp : 0; },
    god(v) { godMode = v === undefined ? !godMode : !!v; return godMode; },
    noPause(v) { noAutoPause = !!v; return noAutoPause; },
    rayInfo() {
      if (!player) return null;
      raycaster.set(tmpV2.set(player.pos.x, player.pos.y, player.pos.z), tmpV.set(0, 0, 1));
      raycaster.near = .05;
      raycaster.far = 48;
      const hits = raycaster.intersectObjects(solidMeshes, false);
      return {
        solidCount: solidMeshes.length,
        wallInSolid: solidMeshes.some(m => m.userData.wall),
        hitCount: hits.length,
        first: hits[0] ? {
          d: +hits[0].distance.toFixed(2),
          z: +hits[0].point.z.toFixed(2),
          isWall: !!hits[0].object.userData.wall,
        } : null,
      };
    },
  };
  window.__inklineHitLog = [];
  console.info('[INKLINE] 调试模式已启用（?debug=1）');
}

function boot() {
  if (!window.THREE) {
    showLoadError('3D 引擎未能载入。请使用新版 Chrome / Edge 打开本页面，并确认文件完整。');
    return;
  }
  if (!MODEL_DATA) {
    showLoadError('模型数据缺失，文件可能不完整。请重新获取游戏文件。');
    return;
  }
  buildModelAssets();
  tmpV = new THREE.Vector3();
  tmpV2 = new THREE.Vector3();
  tmpV3 = new THREE.Vector3();
  PROJECTILE_GEO = new THREE.SphereGeometry(CONFIG.enemy.projectileRadius, 8, 6);
  PROJECTILE_MAT = new THREE.MeshBasicMaterial({ color: C.red });
  PARTICLE_GEO = new THREE.BoxGeometry(.045, .045, .012);
  SPLAT_GEO = new THREE.CircleGeometry(1, 10);
  if (!initThree()) return;
  buildNavUI();
  resetGame();
  bindInputs();
  bindSettingsUI();
  updateSoundButton();
  if (new URLSearchParams(location.search).get('debug') === '1') enableDebugHooks();
  window.__buildTag = '0.3.3';
  requestAnimationFrame(frame);
}

try {
  boot();
} catch (err) {
  // 启动失败时给出可见反馈，而不是静默黑屏
  const msg = String((err && err.message) || err);
  (window.__inklineErrors = window.__inklineErrors || []).push('boot: ' + String((err && err.stack) || err));
  showLoadError('启动失败：' + msg);
  console.error('[INKLINE] 启动失败', err);
}
})();
