// 内核客户端渲染层（D3 首个垂直切片）：占位场景 + 胶囊敌人 + 血条/护甲条 + 射击表现。
// 只消费快照与事件，不持有玩法状态；美术为占位 Token 色，D8/D9 替换为纸艺资产。
import CONFIG from '../shared/config.mjs';
import { COVERS, BOUNDS, ANCHORS, FOLDS, EXIT, pickupList } from '../shared/world.mjs';

const C = CONFIG.colors;
const col = h => new window.THREE.Color('#' + h);

export function createRenderer(canvas) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = col(C.paper);
  scene.fog = new THREE.Fog(col(C.paper), 34, CONFIG.camera.far);
  const camera = new THREE.PerspectiveCamera(CONFIG.player.fov.default, 1, CONFIG.camera.near, CONFIG.camera.far);
  camera.rotation.order = 'YXZ';

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d4c8, 1.05));
  const sun = new THREE.DirectionalLight(0xfff6e0, 0.85);
  sun.position.set(8, 14, 6);
  scene.add(sun);

  const lam = (h, extra = {}) => new THREE.MeshLambertMaterial({ color: col(h), ...extra });
  const box = (w, h, d, h2, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lam(h2));
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };

  // 地面 + 淡网格（移动参照）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), lam(C.paper));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE.GridHelper(36, 18, col(C.ink), col(C.ink));
  grid.material.transparent = true;
  grid.material.opacity = 0.1;
  grid.position.y = 0.01;
  scene.add(grid);

  for (const b of BOUNDS) box(b.w, b.h, b.d, C.ink, b.x, b.h / 2, b.z);
  for (const c of COVERS) box(c.w, c.h, c.d, C.ink, c.x, c.h / 2, c.z);

  // 折页：固定平台 + 铰链翻折板（ramp 坡角 ⟷ wall 竖直，0.4s smoothstep）+ 地面交互环
  const foldViews = FOLDS.map(f => {
    const px = f.x + Math.sin(f.rotY) * CONFIG.folds.platformSize;
    const pz = f.z + Math.cos(f.rotY) * CONFIG.folds.platformSize;
    const plat = new THREE.Mesh(new THREE.BoxGeometry(CONFIG.folds.platformSize, CONFIG.folds.platformHeight, CONFIG.folds.platformSize), lam(C.teal));
    plat.position.set(px, CONFIG.folds.platformHeight / 2, pz);
    scene.add(plat);
    const pivot = new THREE.Group();
    pivot.position.set(f.x, 0, f.z);
    pivot.rotation.order = 'YXZ';
    pivot.rotation.y = f.rotY;
    pivot.rotation.x = CONFIG.folds.rampAngle;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(CONFIG.folds.wallLen, CONFIG.folds.wallHeight, CONFIG.folds.halfThickness * 2),
      lam(C.teal)
    );
    board.position.y = CONFIG.folds.wallHeight / 2;
    board.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(board.geometry),
      new THREE.LineBasicMaterial({ color: col(C.ink) })
    ));
    pivot.add(board);
    scene.add(pivot);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 28), lam(C.teal, { transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(f.x, 0.03, f.z);
    scene.add(ring);
    return { pivot, ring, state: 'ramp', fromAngle: CONFIG.folds.rampAngle, angle: CONFIG.folds.rampAngle, flash: 0 };
  });

  // 锚点信标 + 共持圈；出口圈
  const anchorViews = ANCHORS.map(a => {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, CONFIG.anchor.pillarHeight, 8), lam(C.yellow));
    pillar.position.set(a.x, CONFIG.anchor.pillarHeight / 2, a.z);
    scene.add(pillar);
    const ring = new THREE.Mesh(new THREE.RingGeometry(CONFIG.anchor.radius - 0.08, CONFIG.anchor.radius, 32), lam(C.yellow, { transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(a.x, 0.02, a.z);
    scene.add(ring);
    return { pillar, ring };
  });
  const exitRing = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.7, 32), lam(C.red, { transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
  exitRing.rotation.x = -Math.PI / 2;
  exitRing.position.set(EXIT.x, 0.02, EXIT.z);
  scene.add(exitRing);

  // 拾取物占位：悬浮旋转（规格 §3.10）
  const pickupViews = new Map();
  for (const p of pickupList()) {
    const m = p.ty === 'ink'
      ? new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 10), lam(C.teal))
      : new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.55), lam(C.yellow));
    const baseY = p.ty === 'ink' ? 0.28 : 0.11;
    m.position.set(p.x, baseY, p.z);
    scene.add(m);
    pickupViews.set(p.id, { m, baseY, phase: p.id * 1.7 });
  }

  // 第一人称枪占位 + 后坐
  const gun = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.36), lam(C.ink));
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), lam(C.ink));
  grip.position.set(0, -0.11, 0.12);
  const nib = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.06), lam(C.teal));
  nib.position.set(0, 0.01, -0.2);
  gun.add(barrel, grip, nib);
  gun.position.set(0.22, -0.2, -0.5);
  camera.add(gun);
  scene.add(camera);

  // 敌人视图：按型区分占位（涂改灵胶囊 / 橡皮擦虫低伏红虫 / 纸飞机纸板）+ 血条/护甲条 + 蓄力圈
  const enemyViews = new Map();
  function makeEnemyView(e) {
    const g = new THREE.Group();
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 26;
    const tex = new THREE.CanvasTexture(cv);
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    bar.scale.set(1.15, 0.31, 1);
    bar.renderOrder = 10;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 24), lam(C.yellow, { transparent: true, opacity: 0, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    const view = { g, body: null, shell: null, bar, cv, ctx: cv.getContext('2d'), tex, ring, edge: null, aimLine: null, shadow: null, flash: 0, deadT: -1, age: 0, lastHp: -1, lastArmor: -1 };
    if (e.type === 'eraser') {
      view.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.62, 4, 10), lam(C.red, { transparent: true }));
      view.body.rotation.z = Math.PI / 2;
      view.body.position.y = 0.3;
      bar.position.y = 1.15;
      view.maxHp = CONFIG.enemy.eraser.hp;
      view.maxArmor = 0;
    } else if (e.type === 'plane') {
      view.body = new THREE.Mesh(new THREE.BoxGeometry(1.37, 0.1, 1.1), lam(C.paper, { transparent: true }));
      view.body.add(new THREE.LineSegments(new THREE.EdgesGeometry(view.body.geometry), new THREE.LineBasicMaterial({ color: col(C.ink) })));
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.5), lam(C.red));
      fin.position.set(0, 0.14, 0.12);
      view.body.add(fin);
      bar.position.y = 0.62;
      view.maxHp = CONFIG.enemy.plane.hp;
      view.maxArmor = 0;
      // 俯冲瞄准线（红，aim 态渐亮）与地面投影
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      view.aimLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: col(C.red), transparent: true, opacity: 0.6 }));
      view.aimLine.visible = false;
      scene.add(view.aimLine);
      view.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 18), new THREE.MeshBasicMaterial({ color: col(C.ink), transparent: true, opacity: 0.13, depthWrite: false }));
      view.shadow.rotation.x = -Math.PI / 2;
      scene.add(view.shadow);
    } else {
      view.body = new THREE.Mesh(new THREE.CapsuleGeometry(CONFIG.enemy.radius, 1.49 - CONFIG.enemy.radius * 2, 4, 10), lam(C.paper, { transparent: true }));
      view.body.position.y = 1.49 / 2;
      view.shell = new THREE.Mesh(new THREE.CylinderGeometry(CONFIG.enemy.radius + 0.07, CONFIG.enemy.radius + 0.07, 1.0, 10), lam(C.teal, { transparent: true, opacity: 0.4 }));
      view.shell.position.y = 0.62;
      bar.position.y = 1.95;
      view.edge = new THREE.Mesh(
        new THREE.CapsuleGeometry(CONFIG.enemy.radius + 0.02, 1.49 - CONFIG.enemy.radius * 2, 4, 10),
        new THREE.MeshBasicMaterial({ color: col(C.teal), wireframe: true, transparent: true, opacity: 0.9 })
      );
      view.edge.position.y = 1.49 / 2;
      view.edge.visible = false;
      view.maxHp = CONFIG.enemy.hp;
      view.maxArmor = CONFIG.enemy.armor;
    }
    g.add(view.body, bar, ring);
    if (view.shell) g.add(view.shell);
    if (view.edge) g.add(view.edge);
    scene.add(g);
    return view;
  }
  function drawBar(v, hp, maxHp, armor, maxArmor) {
    const x = v.ctx;
    x.clearRect(0, 0, 96, 26);
    x.fillStyle = 'rgba(32,36,42,0.55)';
    x.fillRect(0, 0, 96, 26);
    if (maxArmor > 0) {
      x.fillStyle = '#' + C.teal;
      x.fillRect(3, 3, 90 * Math.max(0, armor / maxArmor), 8);
    }
    x.fillStyle = '#' + C.red;
    x.fillRect(3, 15, 90 * Math.max(0, hp / maxHp), 8);
    v.tex.needsUpdate = true;
  }
  function disposeEnemyView(v) {
    scene.remove(v.g);
    if (v.aimLine) { scene.remove(v.aimLine); v.aimLine.geometry.dispose(); v.aimLine.material.dispose(); }
    if (v.shadow) { scene.remove(v.shadow); v.shadow.geometry.dispose(); v.shadow.material.dispose(); }
  }

  const projViews = new Map();
  const projGeo = new THREE.SphereGeometry(CONFIG.enemy.projectileRadius, 8, 6);
  const projMat = lam(C.red);

  // 玩家墙视图：青绿半透 .82，末 3 秒淡出（原型 updateWalls 同参数）
  const wallViews = new Map();
  function makeWallView(w) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.len, CONFIG.wall.height, CONFIG.wall.thickness), lam(C.teal, { transparent: true, opacity: 0.82 }));
    m.position.set(w.x, CONFIG.wall.height / 2, w.z);
    m.rotation.y = -Math.atan2(w.uz, w.ux);
    scene.add(m);
    return { m, flash: 0 };
  }

  // 画线起点标记 + 两级预览（预览即所得：与内核 validateDraw 同判定）
  const drawMarker = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 24), lam(C.yellow, { transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  drawMarker.rotation.x = -Math.PI / 2;
  drawMarker.visible = false;
  scene.add(drawMarker);
  const drawPreview = new THREE.Mesh(new THREE.BoxGeometry(1, CONFIG.wall.height, CONFIG.wall.thickness), lam(C.teal, { transparent: true, opacity: 0.5 }));
  drawPreview.visible = false;
  scene.add(drawPreview);
  function setDrawStart(pt) {
    drawMarker.visible = !!pt;
    if (pt) drawMarker.position.set(pt.x, 0.05, pt.z);
    if (!pt) drawPreview.visible = false;
  }
  function setDrawPreview(a, b, valid) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.02) { drawPreview.visible = false; return; }
    drawPreview.visible = true;
    drawPreview.position.set((a.x + b.x) / 2, CONFIG.wall.height / 2, (a.z + b.z) / 2);
    drawPreview.scale.set(len, 1, 1);
    drawPreview.rotation.y = -Math.atan2(dz, dx);
    drawPreview.material.color.set('#' + (valid ? C.teal : C.red));
  }

  // Boss 占位（奶龙本体 D8 热替换）：黄色胶囊 + 红色背鳍 + 血条
  let bossView = null;
  function makeBossView() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(CONFIG.boss.radius, 2.2 - CONFIG.boss.radius * 2, 4, 12), lam(C.yellow));
    body.position.y = 1.1;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.7, 1.2), lam(C.red));
    fin.position.set(0, 1.9, 0.5);
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 26;
    const tex = new THREE.CanvasTexture(cv);
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    bar.scale.set(1.6, 0.43, 1);
    bar.position.y = 2.7;
    bar.renderOrder = 10;
    g.add(body, fin, bar);
    scene.add(g);
    return { g, body, bar, cv, ctx: cv.getContext('2d'), tex, lastHp: -1, lastRaged: null };
  }
  function drawBossBar(v, hp, maxHp, raged) {
    const x = v.ctx;
    x.clearRect(0, 0, 96, 26);
    x.fillStyle = 'rgba(32,36,42,0.55)';
    x.fillRect(0, 0, 96, 26);
    x.fillStyle = '#' + C.red;
    x.fillRect(3, 8, 90 * Math.max(0, hp / maxHp), 12);
    if (raged) { x.fillStyle = '#' + C.yellow; x.fillRect(3, 3, 90, 3); }
    v.tex.needsUpdate = true;
  }
  function removeBossView() {
    if (!bossView) return;
    scene.remove(bossView.g);
    bossView = null;
  }

  // 特效池：曳光 / 命中 puff / 擦除扩散光环
  const tracers = [];
  const puffs = [];
  const rings = [];
  const puffGeo = new THREE.SphereGeometry(0.09, 6, 5);
  const eraseRingGeo = new THREE.RingGeometry(0.88, 1, 64);
  let recoil = 0;
  let fxTime = 0;

  function addTracer(end) {
    camera.updateMatrixWorld();
    const start = new THREE.Vector3(0.22, -0.16, -0.55).applyMatrix4(camera.matrixWorld);
    const geo = new THREE.BufferGeometry().setFromPoints([start, new THREE.Vector3(end.x, end.y, end.z)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col(C.ink), transparent: true, opacity: 0.85 }));
    scene.add(line);
    tracers.push({ line, t: 0.09 });
    recoil = 1;
  }
  function addPuff(point, hex, size = 1) {
    const m = new THREE.Mesh(puffGeo, lam(hex, { transparent: true, opacity: 0.85 }));
    m.position.set(point.x, point.y, point.z);
    m.scale.setScalar(size);
    scene.add(m);
    puffs.push({ m, t: 0.25, size });
  }
  function addEraseRing(x, z) {
    const m = new THREE.Mesh(eraseRingGeo, lam(C.teal, { transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.06, z);
    scene.add(m);
    rings.push({ m, t: 0.45 });
  }

  function onEvent(ev) {
    if (ev.type === 'shot') addTracer(ev.data.end);
    else if (ev.type === 'hit') addPuff(ev.data.point, ev.data.armored ? C.teal : C.red, ev.data.armored ? 0.8 : 1.2);
    else if (ev.type === 'impact') {
      addPuff(ev.data.point, C.ink, 0.9);
      if (ev.data.wallId !== null && ev.data.wallId !== undefined) {
        const v = wallViews.get(ev.data.wallId);
        if (v) v.flash = 0.12;
      }
    } else if (ev.type === 'armorStrip') {
      const v = enemyViews.get(ev.data.id);
      if (v) addPuff({ x: v.g.position.x, y: 1.0, z: v.g.position.z }, C.teal, 2.2);
    } else if (ev.type === 'erase') {
      addEraseRing(ev.data.x, ev.data.z);
    } else if (ev.type === 'fold') {
      addPuff({ x: ev.data.x, y: 1.1, z: ev.data.z }, C.teal, 2.0);
    } else if (ev.type === 'wallBite') {
      addPuff({ x: ev.data.x, y: 0.6, z: ev.data.z }, C.paper, 1.6);
      const v = wallViews.get(ev.data.wallId);
      if (v) v.flash = 0.12;
    } else if (ev.type === 'pickup') {
      addPuff({ x: ev.data.x, y: 0.5, z: ev.data.z }, ev.data.ty === 'ink' ? C.teal : C.yellow, 1.8);
    } else if (ev.type === 'dive') {
      const v = enemyViews.get(ev.data.id);
      if (v) addPuff({ x: v.g.position.x, y: v.g.position.y, z: v.g.position.z }, C.red, 1.4);
    } else if (ev.type === 'kill') {
      const v = enemyViews.get(ev.data.id);
      if (v) { v.deadT = 0; addPuff({ x: v.g.position.x, y: 0.8, z: v.g.position.z }, C.ink, 2.6); }
    } else if (ev.type === 'wallBreak' || ev.type === 'wallRemove' || ev.type === 'wallExpire') {
      const v = wallViews.get(ev.data.id);
      if (v) {
        addPuff({ x: v.m.position.x, y: 0.8, z: v.m.position.z }, ev.type === 'wallBreak' ? C.red : C.teal, 2.2);
        scene.remove(v.m); v.m.geometry.dispose(); v.m.material.dispose();
        wallViews.delete(ev.data.id);
      }
    } else if (ev.type === 'bossDown') {
      if (bossView) addPuff({ x: bossView.g.position.x, y: 1.2, z: bossView.g.position.z }, C.red, 3.4);
      removeBossView();
    }
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function update(snap, dt) {
    fxTime += dt;
    const me = snap.players[0];
    if (me) {
      camera.position.set(me.x, me.y, me.z);
      recoil = Math.max(0, recoil - dt * 9);
      camera.rotation.y = me.yaw;
      camera.rotation.x = me.pitch + recoil * 0.014;
      gun.position.z = -0.5 + recoil * 0.07;
    }

    const seen = new Set();
    for (const e of snap.enemies) {
      seen.add(e.id);
      let v = enemyViews.get(e.id);
      if (!v) { v = makeEnemyView(e); enemyViews.set(e.id, v); }
      if (v.deadT >= 0) continue;
      v.age += dt;
      v.g.position.set(e.x, e.y, e.z);
      v.g.scale.setScalar(Math.min(1, 0.2 + 0.8 * v.age / CONFIG.enemy.spawnAnimTime));
      if (e.hp !== v.lastHp || e.armor !== v.lastArmor) {
        if (v.lastHp >= 0 && e.hp < v.lastHp) v.flash = 0.1;
        if (v.lastArmor >= 0 && e.armor < v.lastArmor) v.flash = 0.1;
        drawBar(v, e.hp, v.maxHp, e.armor, v.maxArmor);
        v.lastHp = e.hp; v.lastArmor = e.armor;
      }
      v.flash = Math.max(0, v.flash - dt);
      const base = e.type === 'eraser' ? C.red : e.type === 'plane' ? C.paper : e.armor > 0 ? C.paper : 'FFFFFF';
      v.body.material.color.set(v.flash > 0 ? '#' + C.red : '#' + base);
      if (v.shell) v.shell.visible = e.armor > 0;
      // 涂改灵护甲只可能被剥离归零：armor 0 即剥甲态（白身 + 青绿描边）
      if (v.edge) v.edge.visible = e.type === 'crane' && e.armor === 0;
      if (e.type === 'plane') {
        v.g.rotation.y = me ? Math.atan2(me.x - e.x, me.z - e.z) : 0;
        v.g.rotation.x = e.state === 'dive' ? -0.9 : e.state === 'aim' ? -0.25 : 0;
        if (v.shadow) v.shadow.position.set(e.x, 0.02, e.z);
        const aiming = e.state === 'aim';
        v.aimLine.visible = aiming;
        if (aiming && me) {
          const pa = v.aimLine.geometry.attributes.position;
          pa.setXYZ(0, e.x, e.y, e.z);
          pa.setXYZ(1, me.x, me.y, me.z);
          pa.needsUpdate = true;
          v.aimLine.material.opacity = 0.25 + 0.7 * Math.min(1, e.telegraph / CONFIG.enemy.plane.aimTime);
        }
        v.ring.position.y = 0.02 - e.y;
        v.ring.material.opacity = e.stun > 0 ? 0.5 : 0;
      } else {
        v.ring.material.opacity = e.stun > 0 ? 0.5 : e.telegraph > 0 ? 0.35 + 0.5 * (e.telegraph / CONFIG.enemy.telegraph) : 0;
      }
    }
    for (const [id, v] of enemyViews) {
      if (v.deadT >= 0) {
        v.deadT += dt;
        const k = Math.max(0, 1 - v.deadT / 0.4);
        v.g.scale.set(k, k * k, k);
        v.body.material.opacity = k;
        v.bar.material.opacity = k;
        if (v.shell) v.shell.material.opacity = 0.4 * k;
        if (v.edge) v.edge.material.opacity = 0.9 * k;
        if (v.aimLine) v.aimLine.visible = false;
        if (v.shadow) v.shadow.visible = false;
        if (v.deadT > 0.4) { disposeEnemyView(v); enemyViews.delete(id); }
      } else if (!seen.has(id)) { disposeEnemyView(v); enemyViews.delete(id); }
    }

    const pseen = new Set();
    for (const p of snap.projectiles) {
      pseen.add(p.id);
      let m = projViews.get(p.id);
      if (!m) { m = new THREE.Mesh(projGeo, projMat); scene.add(m); projViews.set(p.id, m); }
      m.position.set(p.x, p.y, p.z);
    }
    for (const [id, m] of projViews) if (!pseen.has(id)) { scene.remove(m); projViews.delete(id); }

    for (const f of snap.folds) {
      const v = foldViews[f.id];
      if (!v) continue;
      if (v.state !== f.state) { v.fromAngle = v.angle; v.state = f.state; v.flash = 0.4; }
      const target = f.state === 'ramp' ? CONFIG.folds.rampAngle : 0;
      const t = f.anim >= 1 ? 1 : f.anim * f.anim * (3 - 2 * f.anim);
      v.angle = v.fromAngle + (target - v.fromAngle) * t;
      v.pivot.rotation.x = v.angle;
      v.flash = Math.max(0, v.flash - dt);
      const near = me && Math.hypot(me.x - FOLDS[f.id].x, me.z - FOLDS[f.id].z) <= CONFIG.folds.interactRadius;
      v.ring.material.color.set('#' + (near || v.flash > 0 ? C.yellow : C.teal));
      v.ring.material.opacity = near ? 0.75 : 0.45;
    }
    for (const p of snap.pickups) {
      const v = pickupViews.get(p.id);
      if (!v) continue;
      v.m.visible = !p.taken;
      v.m.rotation.y += dt * 1.6;
      v.m.position.y = v.baseY + Math.sin(fxTime * 2.4 + v.phase) * 0.07;
    }

    const wseen = new Set();
    for (const w of snap.walls) {
      wseen.add(w.id);
      let v = wallViews.get(w.id);
      if (!v) { v = makeWallView(w); wallViews.set(w.id, v); }
      v.flash = Math.max(0, v.flash - dt);
      v.m.material.opacity = w.life < CONFIG.wall.fadeLast ? Math.max(0, w.life / CONFIG.wall.fadeLast) * 0.82 : 0.82;
      v.m.material.color.set('#' + (v.flash > 0 ? C.red : C.teal));
    }
    for (const [id, v] of wallViews) if (!wseen.has(id)) { scene.remove(v.m); v.m.geometry.dispose(); v.m.material.dispose(); wallViews.delete(id); }

    for (const a of snap.anchors) {
      const v = anchorViews[a.i];
      if (!v) continue;
      v.pillar.visible = !a.active;
      v.ring.material.color.set('#' + (a.active ? C.teal : C.yellow));
      v.ring.material.opacity = a.active ? 0.8 : 0.35 + 0.45 * a.progress;
    }
    const exitUnlocked = snap.phase !== 'anchors' && !snap.boss;
    exitRing.material.color.set('#' + (exitUnlocked ? C.teal : C.red));
    exitRing.material.opacity = exitUnlocked ? 0.72 : 0.4;

    if (snap.boss) {
      if (!bossView) bossView = makeBossView();
      bossView.g.position.set(snap.boss.x, 0, snap.boss.z);
      bossView.body.material.color.set('#' + (snap.boss.raged ? C.red : C.yellow));
      if (snap.boss.hp !== bossView.lastHp || snap.boss.raged !== bossView.lastRaged) {
        drawBossBar(bossView, snap.boss.hp, CONFIG.scaling[snap.players.length].bossHp, snap.boss.raged);
        bossView.lastHp = snap.boss.hp; bossView.lastRaged = snap.boss.raged;
      }
    } else removeBossView();

    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i];
      t.t -= dt;
      t.line.material.opacity = Math.max(0, t.t / 0.09) * 0.85;
      if (t.t <= 0) { scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); tracers.splice(i, 1); }
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.t -= dt;
      const k = Math.max(0, p.t / 0.25);
      p.m.scale.setScalar(p.size * (1 + (1 - k) * 1.6));
      p.m.material.opacity = 0.85 * k;
      if (p.t <= 0) { scene.remove(p.m); p.m.material.dispose(); puffs.splice(i, 1); }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.t -= dt;
      const k = Math.max(0, r.t / 0.45);
      r.m.scale.setScalar(1 + (1 - k) * (CONFIG.ink.eraseRadius - 1));
      r.m.material.opacity = 0.85 * k;
      if (r.t <= 0) { scene.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); }
    }

    renderer.render(scene, camera);
  }

  // 再来一局：清空全部动态视图，静态场景保留（下一帧快照重建锚点/出口状态）
  function reset() {
    for (const [, v] of enemyViews) disposeEnemyView(v);
    enemyViews.clear();
    for (const [, m] of projViews) scene.remove(m);
    projViews.clear();
    for (const [, v] of wallViews) { scene.remove(v.m); v.m.geometry.dispose(); v.m.material.dispose(); }
    wallViews.clear();
    for (const t of tracers) { scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); }
    tracers.length = 0;
    for (const p of puffs) { scene.remove(p.m); p.m.material.dispose(); }
    puffs.length = 0;
    for (const r of rings) { scene.remove(r.m); r.m.material.dispose(); }
    rings.length = 0;
    for (const v of foldViews) { v.state = 'ramp'; v.fromAngle = CONFIG.folds.rampAngle; v.angle = CONFIG.folds.rampAngle; v.flash = 0; v.pivot.rotation.x = CONFIG.folds.rampAngle; }
    removeBossView();
    setDrawStart(null);
    recoil = 0;
  }

  return { update, onEvent, resize, reset, setDrawStart, setDrawPreview, scene, camera };
}