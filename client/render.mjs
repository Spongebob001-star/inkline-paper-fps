// 只消费快照与事件，不持有玩法状态。
import CONFIG from '../shared/config.mjs';
import { COVERS, BOUNDS, ANCHORS, FOLDS, EXIT, pickupList, foldWallBox } from '../shared/world.mjs';
import { GLTFLoader } from './gltf-loader.mjs';
import { perkMods } from '../shared/perks.mjs';

const C = CONFIG.colors;
const col = h => new window.THREE.Color('#' + h);

export function createRenderer(canvas) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  let disposed = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = col('DDE9EE');
  scene.fog = new THREE.Fog(col('DDE9EE'), 36, 72);
  const skyTint = new THREE.Color();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let baseFov = CONFIG.player.fov.default;
  const camera = new THREE.PerspectiveCamera(baseFov, 1, CONFIG.camera.near, CONFIG.camera.far);
  camera.rotation.order = 'YXZ';
  function setBaseFov(v) {
    if (Number.isFinite(v)) baseFov = Math.max(60, Math.min(95, v));
    return baseFov;
  }

  scene.add(new THREE.HemisphereLight(0xf4faff, 0xe8e2d0, 0.9));
  const sun = new THREE.DirectionalLight(0xfff3d8, 1.05);
  sun.position.set(-12, 24, -8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 70 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => !!motionQuery?.matches;
  function outline(mesh, hex = C.ink, opacity = 1, threshold = 28) {
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold),
      new THREE.LineBasicMaterial({ color: col(hex), transparent: true, opacity }));
    mesh.add(edge);
    return edge;
  }
  function disposeTree(root) {
    const geos = new Set(), mats = new Set();
    root.traverse(o => { if (o.geometry) geos.add(o.geometry); if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m => mats.add(m)); else mats.add(o.material); } });
    for (const g of geos) g.dispose(); for (const m of mats) m.dispose();
  }

  const lam = (h, extra = {}) => new THREE.MeshLambertMaterial({ color: col(h), ...extra });
  const box = (w, h, d, h2, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lam(h2));
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    outline(m);
    scene.add(m);
    return m;
  };

  const paperCanvas = document.createElement('canvas');
  paperCanvas.width = paperCanvas.height = 512;
  const paper = paperCanvas.getContext('2d');
  paper.fillStyle = '#F4F0E4';
  paper.fillRect(0, 0, 512, 512);
  paper.fillStyle = 'rgba(100,89,66,.045)';
  for (let i = 0; i < 7000; i++) paper.fillRect(Math.random() * 512, Math.random() * 512, 0.5 + Math.random(), 1 + Math.random() * 3);
  for (let i = 0; i <= 512; i += 32) {
    paper.fillStyle = i % 128 === 0 ? 'rgba(100,141,156,.25)' : 'rgba(100,141,156,.13)';
    const width = i % 128 === 0 ? 1.6 : 0.7;
    paper.fillRect(i, 0, width, 512);
    paper.fillRect(0, i, 512, width);
  }
  const paperMap = new THREE.CanvasTexture(paperCanvas);
  paperMap.wrapS = paperMap.wrapT = THREE.RepeatWrapping;
  paperMap.repeat.set(9, 9);
  paperMap.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), lam('FFFFFF', { map: paperMap }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  function graffiti(x, z, title, subtitle, angle) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(39,84,88,.48)'; ctx.textAlign = 'center';
    ctx.font = 'bold 38px "Microsoft YaHei", sans-serif'; ctx.fillText(title, 256, 108);
    ctx.font = '26px "Microsoft YaHei", sans-serif'; ctx.fillText(subtitle, 256, 158);
    ctx.fillRect(96, 183, 320, 2);
    const tex = new THREE.CanvasTexture(cv);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    mesh.rotation.set(-Math.PI / 2, 0, angle); mesh.position.set(x, 0.015, z);
    mesh.renderOrder = 1; scene.add(mesh);
  }
  graffiti(0, -10.5, 'KEEP MOVING ↗', 'Q 画墙挡弹', Math.PI + 0.08);
  graffiti(10, -7, 'C 翻折登高', 'TAKE THE HIGH GROUND', -0.1);
  graffiti(-2, 3.2, '小心涂改大王!', 'DO NOT FEED THE INK', 0.12);

  // —— 书桌纸艺奇境：Canvas 文具皮肤（严格贴合原碰撞尺寸，仅视觉） ——
  function texCanvas(w, h, draw) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const noteTex = texCanvas(256, 256, (x) => {
    x.fillStyle = '#F6DE6E'; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = 'rgba(122,101,32,.35)'; x.lineWidth = 2;
    for (let i = 24; i < 256; i += 28) { x.beginPath(); x.moveTo(0, i); x.lineTo(256, i); x.stroke(); }
    x.fillStyle = 'rgba(32,36,42,.72)'; x.font = 'bold 30px monospace'; x.fillText('NOTE-01', 28, 58);
    x.font = '20px monospace'; x.fillText('DRAFT / 墨线', 28, 94);
    x.fillStyle = '#E34B3F'; x.fillRect(190, 14, 12, 46);
  });
  const pagesTex = texCanvas(256, 128, (x) => {
    x.fillStyle = '#F7F2E1'; x.fillRect(0, 0, 256, 128);
    x.strokeStyle = 'rgba(92,110,120,.35)'; x.lineWidth = 2;
    for (let i = 10; i < 128; i += 10) { x.beginPath(); x.moveTo(4, i); x.lineTo(252, i); x.stroke(); }
    x.fillStyle = '#C94F45'; x.fillRect(150, 0, 14, 128);
    x.fillStyle = '#007F7B'; x.fillRect(172, 0, 8, 128);
  });
  const caseTex = texCanvas(256, 128, (x) => {
    x.fillStyle = '#5D8FA6'; x.fillRect(0, 0, 256, 64);
    x.fillStyle = '#E7E1D2'; x.fillRect(0, 64, 256, 64);
    x.fillStyle = '#20242A'; x.textAlign = 'center';
    x.font = 'bold 44px monospace'; x.fillText('2B', 128, 92);
    x.strokeStyle = 'rgba(32,36,42,.5)'; x.lineWidth = 3; x.strokeRect(8, 8, 240, 112);
    x.fillStyle = '#F2C14E'; x.fillRect(16, 16, 36, 18);
  });
  const coverTextures = [pagesTex, noteTex, caseTex];
  const stationery = ['D9AE6C', '6D8EA6', '6BA397', 'CBC3B2', 'D98C82'];
  const coverMatCache = [];
  function coverMaterials(type, hex) {
    if (!coverMatCache[type]) {
      const paper = new THREE.MeshLambertMaterial({ map: coverTextures[type] });
      const solid = lam(hex);
      coverMatCache[type] = type === 0
        ? [paper, paper, solid, solid, paper, paper]
        : type === 1 ? [paper, paper, paper, paper, paper, paper]
          : [solid, solid, solid, solid, paper, paper];
    }
    return coverMatCache[type];
  }
  COVERS.forEach((c, i) => {
    const type = i % 3;
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.w, c.h, c.d), coverMaterials(type, stationery[i % stationery.length]));
    m.name = 'cover-' + i + '-skin';
    m.position.set(c.x, c.h / 2, c.z);
    m.castShadow = m.receiveShadow = true;
    m.userData.skin = ['notebook', 'sticky', 'case'][type];
    outline(m);
    scene.add(m);
    if (type === 0) {
      const ribbon = box(0.12, c.h * 0.92, 0.02, 'C94F45', c.x + c.w * 0.3, c.h / 2, c.z + c.d / 2 + 0.012);
      ribbon.name = 'cover-' + i + '-ribbon';
    }
    if (type === 1) {
      const print = box(c.w * 0.42, 0.02, c.d * 0.2, 'F2C14E', c.x - c.w * 0.2, c.h + 0.012, c.z - c.d * 0.2);
      print.name = 'cover-' + i + '-label';
    }
  });
  for (const b of BOUNDS) box(b.w, b.h, b.d, 'DDD7C8', b.x, b.h / 2, b.z);
  const wallDecorTex = texCanvas(1024, 256, (x) => {
    x.clearRect(0, 0, 1024, 256);
    x.fillStyle = 'rgba(243,241,231,.55)'; x.fillRect(0, 40, 1024, 190);
    x.strokeStyle = 'rgba(32,36,42,.42)'; x.lineWidth = 3;
    for (let i = 40; i < 1024; i += 56) {
      x.beginPath(); x.arc(i, 64, 9, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.arc(i, 64, 4, 0, Math.PI * 2); x.stroke();
    }
    x.lineWidth = 2;
    for (let i = 0; i < 1024; i += 14) {
      const major = i % 70 === 0;
      x.beginPath(); x.moveTo(i, 226); x.lineTo(i, major ? 194 : 210); x.stroke();
    }
    x.fillStyle = 'rgba(32,36,42,.45)'; x.font = 'bold 18px monospace';
    for (let i = 0; i < 1024; i += 140) x.fillText(String(i / 70 | 0), i + 3, 190);
  });
  wallDecorTex.wrapS = THREE.RepeatWrapping;
  const wallDecorMat = new THREE.MeshLambertMaterial({ map: wallDecorTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  BOUNDS.forEach((b, i) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(b.w, b.d) - 0.2, b.h - 0.4), wallDecorMat);
    if (b.z < 0) { mesh.position.set(b.x, b.h / 2, b.z + b.d / 2 + 0.012); }
    else if (b.z > 0) { mesh.position.set(b.x, b.h / 2, b.z - b.d / 2 - 0.012); mesh.rotation.y = Math.PI; }
    else if (b.x < 0) { mesh.position.set(b.x + b.w / 2 + 0.012, b.h / 2, b.z); mesh.rotation.y = Math.PI / 2; }
    else { mesh.position.set(b.x - b.w / 2 - 0.012, b.h / 2, b.z); mesh.rotation.y = -Math.PI / 2; }
    mesh.name = 'wall-decor-' + i;
    scene.add(mesh);
  });

  // —— 场外巨型文具天际线（全部位于 |x|>20 / |z|>20，不影响碰撞与射线） ——
  const inkEdge = (mesh, opacity = 0.9) => mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: col(C.ink), transparent: true, opacity })));
  const pencilTower = new THREE.Group(); pencilTower.name = 'desk-pencil-tower';
  const eraser = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 1.2, 6), lam('E58F9A'));
  eraser.position.y = 0.6; inkEdge(eraser);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(1.66, 1.66, 0.5, 6), lam('C8D0D4'));
  ferrule.position.y = 1.45; inkEdge(ferrule);
  const pencilBody = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 13.4, 6), lam('F2C14E'));
  pencilBody.position.y = 8.4; inkEdge(pencilBody);
  const wood = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 0.4, 2.3, 12), lam('E8C6A8'));
  wood.position.y = 16.25; inkEdge(wood);
  const graphite = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.5, 8), lam('20242A'));
  graphite.position.y = 18.15; inkEdge(graphite);
  pencilTower.add(eraser, ferrule, pencilBody, wood, graphite);
  pencilTower.position.set(13, 0, -24); pencilTower.rotation.y = 0.5;
  scene.add(pencilTower);

  const rulerShape = new THREE.Shape();
  rulerShape.moveTo(0, 0); rulerShape.lineTo(20, 0); rulerShape.lineTo(0, 13); rulerShape.closePath();
  const rulerGeo = new THREE.ExtrudeGeometry(rulerShape, { depth: 0.35, bevelEnabled: false });
  const ruler = new THREE.Mesh(rulerGeo, new THREE.MeshLambertMaterial({ color: 0x9fdfe0, transparent: true, opacity: 0.44 }));
  ruler.name = 'desk-ruler-arch';
  ruler.position.set(-10, 0, -23.5); ruler.rotation.y = -0.12;
  inkEdge(ruler, 0.65);
  const tickPts = [];
  for (let i = 1; i < 40; i++) {
    const px = i * 0.5, hgt = i % 5 === 0 ? 1.1 : 0.6;
    tickPts.push(px, 0.02, 0.37, px, hgt, 0.37);
  }
  const ticks = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tickPts, 3)),
    new THREE.LineBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0.55 }));
  ruler.add(ticks);
  scene.add(ruler);

  const clipCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(2.4, 0.6, 0.2), new THREE.Vector3(2.1, 4.2, 0),
    new THREE.Vector3(0.2, 8.2, -0.2), new THREE.Vector3(-1.9, 11.2, 0), new THREE.Vector3(-3.4, 9.6, 0.1),
    new THREE.Vector3(-3.1, 7.0, 0), new THREE.Vector3(-1.0, 4.6, 0), new THREE.Vector3(-0.2, 7.8, 0),
    new THREE.Vector3(0, 10.4, 0), new THREE.Vector3(1.4, 12.8, 0),
  ]);
  const clip = new THREE.Mesh(new THREE.TubeGeometry(clipCurve, 72, 0.34, 8, false),
    new THREE.MeshStandardMaterial({ color: 0xe2eaee, metalness: 0.25, roughness: 0.38 }));
  clip.name = 'desk-paperclip';
  clip.position.set(22.5, 0, -6); clip.rotation.set(0.1, -0.7, 0.16);
  clip.castShadow = true;
  scene.add(clip);

  const noteTower = new THREE.Group(); noteTower.name = 'desk-note-tower';
  [['F2C14E', 0.9], ['E58F9A', 2.2], ['6BA397', 3.5], ['3E6FB0', 4.7]].forEach(([hex, y], i) => {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(9 - i * 1.5, 1.1, 9 - i * 1.5), lam(hex));
    pad.position.y = y; pad.rotation.y = i * 0.14; inkEdge(pad);
    noteTower.add(pad);
  });
  noteTower.position.set(-22.5, 0, -15);
  scene.add(noteTower);

  const cloudViews = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group(); g.name = 'paper-cloud-' + i;
    const big = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 0), lam('FBF8EE', { emissive: 0x2a2820 }));
    const small = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 0), lam('F2ECDC', { emissive: 0x24221b }));
    small.position.set(1.7, -0.35, 0.4);
    inkEdge(big, 0.4); inkEdge(small, 0.35);
    g.add(big, small);
    const baseX = -26 + i * 13, baseZ = -22 + (i % 2) * -8;
    g.position.set(baseX, 10.5 + (i % 3) * 1.8, baseZ);
    scene.add(g);
    cloudViews.push({ g, baseX, baseZ, speed: 0.05 + i * 0.012, phase: i * 1.7 });
  }

  // 折页：固定平台 + 铰链翻折板（ramp 坡角 ⟷ wall 竖直，0.4s smoothstep）+ 地面交互环
  const foldViews = FOLDS.map(f => {
    const px = f.x + Math.sin(f.rotY) * CONFIG.folds.platformSize;
    const pz = f.z + Math.cos(f.rotY) * CONFIG.folds.platformSize;
    const plat = new THREE.Mesh(new THREE.BoxGeometry(CONFIG.folds.platformSize, CONFIG.folds.platformHeight, CONFIG.folds.platformSize), lam(C.teal));
    plat.position.set(px, CONFIG.folds.platformHeight / 2, pz);
    plat.castShadow = plat.receiveShadow = true;
    outline(plat);
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
    return { pivot, board, ring, model: false, state: 'ramp', fromAngle: CONFIG.folds.rampAngle, angle: CONFIG.folds.rampAngle, flash: 0 };
  });

  // 锚点信标 + 共持圈；出口圈。T7.3：当前导航目标追加穿透遮挡的光柱（depthTest=false）。
  const anchorViews = ANCHORS.map(a => {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, CONFIG.anchor.pillarHeight, 8), lam(C.yellow));
    pillar.name = 'anchor-pillar-' + a.i;
    pillar.position.set(a.x, CONFIG.anchor.pillarHeight / 2, a.z);
    scene.add(pillar);
    const ring = new THREE.Mesh(new THREE.RingGeometry(CONFIG.anchor.radius - 0.08, CONFIG.anchor.radius, 32), lam(C.yellow, { transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.name = 'anchor-ring-' + a.i;
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(a.x, 0.02, a.z);
    scene.add(ring);
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.62, CONFIG.anchor.pillarHeight, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: col(C.yellow), transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
    );
    glow.name = 'anchor-glow-' + a.i;
    glow.position.set(a.x, CONFIG.anchor.pillarHeight / 2, a.z);
    glow.renderOrder = 6;
    glow.visible = false;
    scene.add(glow);
    return { pillar, ring, glow };
  });
  const exitRing = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.7, 32), lam(C.red, { transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
  exitRing.rotation.x = -Math.PI / 2;
  exitRing.position.set(EXIT.x, 0.02, EXIT.z);
  scene.add(exitRing);
  const exitBeam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.8, CONFIG.anchor.pillarHeight, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: col(C.teal), transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
  );
  exitBeam.position.set(EXIT.x, CONFIG.anchor.pillarHeight / 2, EXIT.z);
  exitBeam.renderOrder = 6;
  exitBeam.visible = false;
  scene.add(exitBeam);

  // T7.4：队友占位化身（胶囊 + 地面标记 + 头顶状态牌）；美术资产在 D8 替换。
  const teammateViews = new Map();
  function makeTeammateView(p) {
    const markHex = C.playerMarks[(p.id - 1 + C.playerMarks.length) % C.playerMarks.length];
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: col(markHex), transparent: true });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(CONFIG.player.radius, 1.1, 4, 10), mat);
    body.position.y = 0.89;
    g.add(body);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 28),
      new THREE.MeshBasicMaterial({ color: col(C.yellow), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);
    const cv = document.createElement('canvas');
    cv.width = 176; cv.height = 56;
    const tex = new THREE.CanvasTexture(cv);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    tag.scale.set(1.76, 0.56, 1);
    tag.position.y = 2.25;
    tag.renderOrder = 11;
    g.add(tag);
    scene.add(g);
    return { id: p.id, g, body, mat, ring, tag, cv, ctx: cv.getContext('2d'), tex, markHex, text: '', tone: '' };
  }
  function drawTeammateTag(v, text, tone) {
    if (v.text === text && v.tone === tone) return;
    v.text = text; v.tone = tone;
    const x = v.ctx;
    x.clearRect(0, 0, 176, 56);
    x.fillStyle = 'rgba(32,36,42,0.78)';
    x.fillRect(0, 8, 176, 40);
    x.fillStyle = '#' + tone;
    x.font = 'bold 22px "Microsoft YaHei", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, 88, 28);
    v.tex.needsUpdate = true;
  }
  function disposeTeammateView(v) {
    scene.remove(v.g);
    v.body.geometry.dispose();
    v.mat.dispose();
    v.ring.geometry.dispose();
    v.ring.material.dispose();
    v.tag.material.dispose();
    v.tex.dispose();
  }

  // 拾取物占位：悬浮旋转（规格 §3.10）
  const pickupViews = new Map();
  for (const p of pickupList()) {
    const m = p.ty === 'ink'
      ? new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 10), lam(C.teal))
      : new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.55), lam(C.yellow));
    const baseY = 0.08;
    m.position.set(p.x, baseY, p.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.43, 24),
      new THREE.MeshBasicMaterial({ color: col(p.ty === 'ink' ? C.teal : C.yellow), transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.025, p.z);
    scene.add(m, ring);
    pickupViews.set(p.id, { m, ring, ty: p.ty, model: false, baseY, phase: p.id * 1.7 });
  }

  // Presentation-only machining: beveled sections, open frames and curved plumbing.
  const pbr = (color, metalness = 0.1, roughness = 0.58, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
  function bevel(w, h, d, b = 0.009) {
    const s = new THREE.Shape();
    s.moveTo(-w / 2 + b, -h / 2); s.lineTo(w / 2 - b, -h / 2);
    s.lineTo(w / 2, -h / 2 + b); s.lineTo(w / 2, h / 2 - b);
    s.lineTo(w / 2 - b, h / 2); s.lineTo(-w / 2 + b, h / 2);
    s.lineTo(-w / 2, h / 2 - b); s.lineTo(-w / 2, -h / 2 + b); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: d - b * 2, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: b / 2, bevelThickness: b });
    g.translate(0, 0, -d / 2 + b); return g;
  }
  const cylinder = (r, len, n = 16, r2 = r) => new THREE.CylinderGeometry(r, r2, len, n).rotateX(Math.PI / 2);
  function portedSleeve() {
    const g = new THREE.CylinderGeometry(0.036, 0.036, 0.09, 16, 3, true), idx = [];
    const src = g.index.array;
    for (let segment = 0; segment < 16; segment++) for (let row = 0; row < 3; row++) {
      if (row === 1 && segment % 4 < 2) continue;
      const start = (segment * 3 + row) * 6;
      for (let j = 0; j < 6; j++) idx.push(src[start + j]);
    }
    g.setIndex(idx); return g.rotateX(Math.PI / 2);
  }
  const brushCanvas = document.createElement('canvas'); brushCanvas.width = 128; brushCanvas.height = 32;
  const brush = brushCanvas.getContext('2d'); brush.fillStyle = '#aaaaaa'; brush.fillRect(0, 0, 128, 32);
  for (let i = 0; i < 32; i++) { brush.fillStyle = i % 3 ? '#b8b8b8' : '#909090'; brush.fillRect(0, i, 128, 0.4); }
  const brushedMap = new THREE.CanvasTexture(brushCanvas); brushedMap.wrapS = brushedMap.wrapT = THREE.RepeatWrapping;
  brushedMap.repeat.set(2, 4);
  function starGeometry(radius = 1, inner = 0.22, points = 6) {
    const s = new THREE.Shape();
    for (let i = 0; i <= points * 2; i++) {
      const a = i * Math.PI / points, r = i % 2 ? inner * radius : radius;
      if (!i) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    return new THREE.ShapeGeometry(s);
  }
  function decal(text, color, bg, width, height) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
    const x = cv.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, 512, 128);
    x.fillStyle = color; x.font = 'bold 38px monospace'; x.textAlign = 'center'; x.fillText(text, 256, 74);
    for (let i = 0; i < 24; i++) x.fillRect(12 + i * 21, 101, 2, i % 4 ? 8 : 17);
    const map = new THREE.CanvasTexture(cv); map.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(width, height), pbr(0xffffff, 0.15, 0.65, { map }));
  }
  const handMaterials = {
    sleeve: pbr(0xefece2, 0, 0.93), band: pbr(0x007f7b, 0.05, 0.7),
    glove: pbr(0x262d35, 0, 0.86), skin: pbr(0xe8c6a8, 0, 0.82),
  };
  const fingerGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
  const handAxis = new THREE.Vector3(0, 1, 0), handDirection = new THREE.Vector3();
  function handSegment(parent, name, from, to, radius, material) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const m = new THREE.Mesh(fingerGeometry, material); m.name = name;
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.set(radius, a.distanceTo(b), radius);
    m.quaternion.setFromUnitVectors(handAxis, b.sub(a).normalize()); parent.add(m); return m;
  }
  function makeHands(g, parts, idx) {
    const root = new THREE.Group(); root.name = 'tactical-hands'; g.add(root);
    function mesh(parent, name, geo, mat, x = 0, y = 0, z = 0) {
      const m = new THREE.Mesh(geo, mat); m.name = name; m.position.set(x, y, z); parent.add(m); return m;
    }
    function fingers(parent, prefix, points, radius = 0.009) {
      for (let j = 1; j < points.length; j++) handSegment(parent, prefix + '-' + j, points[j - 1], points[j], radius, j === 1 ? handMaterials.glove : handMaterials.skin);
    }
    function arm(side, wrist) {
      const hand = new THREE.Group(); hand.name = side + '-hand'; root.add(hand);
      const forearm = mesh(root, side + '-forearm', new THREE.CylinderGeometry(0.049, 0.085, 1, 7), handMaterials.sleeve);
      const cuff = mesh(root, side + '-cuff', new THREE.CylinderGeometry(0.051, 0.059, 0.065, 7), handMaterials.sleeve);
      const band = mesh(root, side + '-wristband', new THREE.CylinderGeometry(0.048, 0.052, 0.028, 7), handMaterials.band);
      return { g: hand, forearm, cuff, band, wrist: new THREE.Vector3(...wrist), start: new THREE.Vector3(), end: new THREE.Vector3(),
        rest: new THREE.Vector3(), restQ: new THREE.Quaternion(), target: new THREE.Vector3(), targetQ: new THREE.Quaternion(), mode: side === 'right' ? 'grip' : 'support' };
    }
    const grip = parts[['angled-grip', 'pistol-grip', 'grip'][idx]], radius = [0.041, 0.047, 0.035][idx];
    const right = arm('right', [radius + 0.018, -0.060, 0.025]);
    right.rest.copy(grip.position); right.rest.y += 0.021; right.restQ.copy(grip.quaternion);
    const palm = mesh(right.g, 'right-palm', bevel(0.035, 0.092, 0.078, 0.008), handMaterials.glove, radius + 0.023, -0.016, 0.007);
    mesh(right.g, 'right-back-pad', bevel(0.007, 0.058, 0.050, 0.003), handMaterials.band, radius + 0.038, -0.008, 0.009);
    const gripFingers = new THREE.Group(), boltFingers = new THREE.Group(); right.g.add(gripFingers, boltFingers); boltFingers.visible = false;
    for (let k = 0; k < 3; k++) {
      const y = 0.004 - k * 0.025, r = radius + 0.016;
      fingers(gripFingers, 'right-wrap-' + k, [[r, y, -0.018], [r * 0.72, y, -r * 0.78], [-r * 0.22, y, -r], [-r * 0.85, y, -r * 0.45]]);
      fingers(boltFingers, 'right-bolt-wrap-' + k, [[0.052, -0.028 - k * 0.024, 0], [0.036, -0.035 - k * 0.024, -0.023], [0.005, -0.035 - k * 0.024, -0.023]]);
    }
    fingers(gripFingers, 'right-thumb', [[radius + 0.022, 0.037, 0.023], [0.022, 0.040, radius + 0.009], [-0.025, 0.031, radius + 0.003]]);
    const trigger = parts[idx === 1 ? 'trigger-guard' : 'trigger-loop'];
    const t = trigger.position.clone().sub(right.rest).applyQuaternion(right.restQ.clone().invert());
    fingers(gripFingers, 'right-index', [[radius + 0.022, 0.030, -0.025], [0.042, t.y + 0.014, t.z + 0.012], [0.016, t.y, t.z], [0.014, t.y - 0.012, t.z - 0.005]], 0.008);
    fingers(boltFingers, 'right-bolt-index', [[0.046, 0.012, 0], [0.022, 0.020, -0.017], [-0.006, 0.020, -0.023]], 0.009);
    fingers(boltFingers, 'right-bolt-thumb', [[0.043, 0.028, 0.025], [0.008, 0.028, 0.015], [-0.014, 0.013, 0.012]], 0.01);
    right.gripFingers = gripFingers; right.boltFingers = boltFingers; right.palm = palm;
    const rx = [0.034, 0.116, 0.059][idx], ry = [0.030, 0.086, 0.028][idx];
    const left = arm('left', [-0.065, -ry - 0.033, 0.025]);
    left.rest.set(0, [0.012, -0.035, -0.037][idx], [-0.285, -0.265, -0.29][idx]);
    const support = new THREE.Group(); left.g.add(support); left.support = support;
    mesh(support, 'left-palm', bevel(idx === 1 ? 0.17 : 0.10, 0.035, 0.10, 0.007), handMaterials.glove, -0.012, -ry - 0.02);
    mesh(support, 'left-back-pad', bevel(0.060, 0.007, 0.055, 0.003), handMaterials.band, -0.018, -ry - 0.040);
    for (let k = 0; k < 4; k++) {
      const z = -0.037 + k * 0.024;
      fingers(support, 'left-wrap-' + k, [[-rx - 0.008, -ry - 0.016, z], [-rx - 0.020, -ry * 0.22, z], [-rx - 0.010, ry * 0.65, z], [-rx * 0.62, ry + 0.012, z]], 0.009);
    }
    fingers(support, 'left-thumb', [[0.024, -ry - 0.023, 0.040], [rx + 0.014, -ry * 0.48, 0.045], [rx + 0.012, ry * 0.30, 0.018]], 0.011);
    if (idx === 0) {
      left.magGrip = new THREE.Group(); left.g.add(left.magGrip); left.magGrip.visible = false;
      mesh(left.magGrip, 'left-magazine-palm', bevel(0.11, 0.035, 0.085, 0.007), handMaterials.glove, 0, -0.055);
      mesh(left.magGrip, 'left-magazine-pad', bevel(0.06, 0.007, 0.055, 0.003), handMaterials.band, 0, -0.075);
      for (let k = 0; k < 4; k++) { const z = -0.033 + k * 0.022;
        fingers(left.magGrip, 'left-magazine-finger-' + k, [[-0.051, -0.050, z], [-0.061, -0.014, z], [-0.054, 0.021, z], [-0.053, 0.038, z]], 0.008);
      }
      fingers(left.magGrip, 'left-magazine-thumb', [[0.037, -0.056, 0.025], [0.057, -0.012, 0.027], [0.053, 0.019, 0.012]], 0.009);
    }
    right.g.position.copy(right.rest); right.g.quaternion.copy(right.restQ); left.g.position.copy(left.rest);
    return { g: root, right, left };
  }
  const handInverse = new THREE.Matrix4(), handOffset = new THREE.Vector3();
  function updateHands(v, idx) {
    const { right, left } = v.hands, a = v.shotAge, r = Math.max(0, Math.min(1, v.reload));
    right.target.copy(right.rest); right.targetQ.copy(right.restQ); right.mode = 'grip';
    let reach = 0;
    if (idx === 2 && a > 0.20 && a < 0.65) {
      reach = a < 0.25 ? (a - 0.20) / 0.05 : a <= 0.58 ? 1 : (0.65 - a) / 0.07;
      reach = reach * reach * (3 - 2 * reach);
      right.target.copy(v.parts['bolt-handle'].position).applyQuaternion(v.bolt.quaternion).add(v.bolt.position);
      right.targetQ.set(0, 0, Math.sin(v.bolt.rotation.z / 2), Math.cos(v.bolt.rotation.z / 2)).multiply(right.restQ); right.mode = 'bolt';
    }
    if (reach < 1e-8) { reach = 0; right.target.copy(right.rest); right.targetQ.copy(right.restQ); right.mode = 'grip'; }
    right.g.position.copy(right.rest).lerp(right.target, reach);
    right.g.position.x += Math.sin(reach * Math.PI) * 0.055;
    right.g.quaternion.copy(right.restQ).slerp(right.targetQ, reach);
    right.gripFingers.visible = reach < 0.5; right.boltFingers.visible = reach >= 0.5;
    right.palm.position.y = -0.016 - 0.019 * reach;
    left.target.copy(left.rest); left.targetQ.identity(); left.mode = idx === 1 ? 'pump' : 'support';
    let transfer = 0;
    if (idx === 1) left.target.z = v.pump.position.z;
    if (idx === 0 && r > 0) {
      transfer = Math.min(1, r / 0.12, (1 - r) / 0.12); transfer = transfer * transfer * (3 - 2 * transfer);
      left.targetQ.copy(v.magazine.quaternion);
      handOffset.set(-0.002, -0.065, 0).applyQuaternion(left.targetQ);
      left.target.copy(v.magazine.position).add(handOffset);
      if (r > 0.35 && r < 0.65) left.target.y -= 0.45 * Math.sin((r - 0.35) / 0.30 * Math.PI);
      left.mode = 'magazine';
    }
    left.g.position.copy(left.rest).lerp(left.target, idx === 0 ? transfer : 1);
    left.g.quaternion.identity().slerp(left.targetQ, transfer);
    if (left.magGrip) { left.magGrip.visible = transfer >= 0.5; left.support.visible = transfer < 0.5; }
    for (const [side, hand] of [['right', right], ['left', left]]) {
      hand.start.copy(hand.wrist).applyQuaternion(hand.g.quaternion).add(hand.g.position);
      hand.end.set(side === 'right' ? 0.82 : -0.82, -1.35, -0.22).applyMatrix4(handInverse);
      handDirection.copy(hand.start).sub(hand.end); const length = handDirection.length(); handDirection.divideScalar(length);
      hand.forearm.position.copy(hand.start).add(hand.end).multiplyScalar(0.5);
      hand.forearm.quaternion.setFromUnitVectors(handAxis, handDirection); hand.forearm.scale.y = length;
      hand.cuff.quaternion.copy(hand.forearm.quaternion); hand.band.quaternion.copy(hand.forearm.quaternion);
      hand.cuff.position.copy(hand.start).addScaledVector(handDirection, -0.035);
      hand.band.position.copy(hand.start).addScaledVector(handDirection, 0.007);
    }
  }
  const gun = new THREE.Group(); gun.name = 'weapon-rig';
  const flashGeo = starGeometry(0.11);
  const gunViews = [0, 1, 2].map(idx => {
    const g = new THREE.Group(); g.name = ['INK-01', 'MARK-02', 'LINE-03'][idx];
    const parts = {}, metal = pbr(0xc1ced4, 0.82, 0.43, { roughnessMap: brushedMap }), black = pbr(0x172129, 0.25, 0.72);
    const body = pbr([0x173856, 0xdfab26, 0x9daeb9][idx], idx === 2 ? 0.7 : 0.25, 0.48);
    const glow = pbr(idx === 1 ? 0xffce39 : 0x43e5df, 0.15, 0.26, { emissive: idx === 1 ? 0xffaa16 : 0x19c8cf, emissiveIntensity: 1.25 });
    const glass = new THREE.MeshPhysicalMaterial({ color: idx === 1 ? 0xffe589 : 0x76eecb, metalness: 0, roughness: 0.13,
      transmission: 0, transparent: true, opacity: 0.24, depthWrite: false, clearcoat: 1, side: THREE.DoubleSide });
    function part(name, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
      const m = new THREE.Mesh(geo, mat); m.name = name; m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      parts[name] = m; g.add(m); return m;
    }
    function label(text, color, bg, w, h, x, y, z, ry = 0) {
      const m = decal(text, color, bg, w, h); m.name = 'serial-decal'; m.position.set(x, y, z); m.rotation.y = ry;
      parts[m.name] = m; g.add(m);
    }
    let ink = null, magazine = null, bolt = null, pump = null;
    const chargeRings = [];
    if (idx === 0) {
      part('deep-blue-receiver', bevel(0.145, 0.13, 0.36), body);
      part('barrel-silver', cylinder(0.024, 0.39), metal, 0, 0.012, -0.355);
      part('ported-muzzle', portedSleeve(), black, 0, 0.012, -0.58);
      part('muzzle-crown', new THREE.TorusGeometry(0.027, 0.008, 6, 16), metal, 0, 0.012, -0.629);
      for (const s of [-1, 1]) {
        part('open-rail-' + s, bevel(0.015, 0.025, 0.29, 0.003), metal, s * 0.06, 0.058, -0.20);
        part('muzzle-port-' + s, bevel(0.005, 0.016, 0.055, 0.002), metal, s * 0.034, 0.012, -0.58);
      }
      part('angled-grip', new THREE.CapsuleGeometry(0.041, 0.115, 3, 8), black, 0, -0.14, 0.095, -0.32);
      const trigger = part('trigger-loop', new THREE.TorusGeometry(0.055, 0.009, 6, 12), metal, 0, -0.10, 0.005, 0, Math.PI / 2);
      trigger.scale.y = 0.78;
      part('trigger', new THREE.CapsuleGeometry(0.006, 0.035, 2, 6), black, 0, -0.09, -0.007, -0.25);
      magazine = part('slanted-magazine', bevel(0.078, 0.17, 0.085), body, 0, -0.15, -0.10, 0.24);
      part('magazine-shoe', bevel(0.095, 0.026, 0.10, 0.004), black, 0, -0.086, 0).removeFromParent();
      magazine.add(parts['magazine-shoe']);
      const sight = part('holo-frame', new THREE.TorusGeometry(0.051, 0.010, 4, 4), black, 0, 0.133, -0.10, 0, 0, Math.PI / 4);
      sight.scale.set(0.9, 0.92, 1);
      part('holo-green-glass', new THREE.CircleGeometry(0.044, 4), glass, 0, 0.133, -0.10, 0, 0, Math.PI / 4);
      part('holo-cyan-dot', new THREE.SphereGeometry(0.0045, 8, 6), glow, 0, 0.133, -0.09);
      part('ink-tube-glass', cylinder(0.021, 0.23), glass, -0.082, 0.009, -0.015);
      ink = part('ink-level', cylinder(0.014, 0.21), glow, -0.082, 0.009, -0.015);
      part('tube-endcap', cylinder(0.024, 0.026), metal, -0.082, 0.009, 0.108);
      bolt = part('reciprocating-bolt', bevel(0.024, 0.033, 0.09, 0.004), metal, 0.079, 0.019, 0.04);
      part('penclip-rail', new THREE.TorusGeometry(0.057, 0.007, 4, 12, Math.PI), metal, -0.07, 0.032, 0.08, Math.PI / 2, 0, Math.PI / 2).scale.y = 2;
      label('INK-01', '#c6efed', '#173856', 0.20, 0.035, -0.075, -0.036, 0.005, -Math.PI / 2);
    } else if (idx === 1) {
      part('heavy-yellow-receiver', bevel(0.235, 0.175, 0.34, 0.018), body);
      for (const s of [-1, 1]) {
        part('twin-barrel-' + s, cylinder(0.039, 0.48), metal, s * 0.063, -0.015, -0.395);
        part('barrel-crown-' + s, new THREE.TorusGeometry(0.029, 0.012, 6, 16), black, s * 0.063, -0.015, -0.637);
        const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 0.09, 0.15, 0.06), new THREE.Vector3(s * 0.17, 0.07, 0.13),
          new THREE.Vector3(s * 0.17, -0.075, -0.10), new THREE.Vector3(s * 0.094, -0.025, -0.22)]);
        part('curved-pressure-hose-' + s, new THREE.TubeGeometry(curve, 16, 0.015, 6, false), black);
        part('hose-coupling-' + s, cylinder(0.023, 0.025), metal, s * 0.094, -0.025, -0.22);
      }
      const guard = part('splash-guard', new THREE.TorusGeometry(0.088, 0.017, 5, 12, Math.PI), body, 0, 0.012, -0.46);
      guard.scale.x = 1.5;
      part('reservoir-glass', new THREE.CapsuleGeometry(0.085, 0.14, 4, 16), glass, 0, 0.155, -0.018, Math.PI / 2);
      ink = part('reservoir-ink-level', new THREE.CapsuleGeometry(0.069, 0.13, 4, 12), glow, 0, 0.155, -0.018, Math.PI / 2);
      // 后盖收窄为倒角银灰端盖 + 小型黄色压力发光环（环为子件，不新增命名部件）
      const resCap = part('reservoir-cap', new THREE.CylinderGeometry(0.05, 0.064, 0.03, 12).rotateX(Math.PI / 2), metal, 0, 0.155, 0.158);
      const resCapRing = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.0055, 4, 18), glow);
      resCapRing.name = 'reservoir-cap-ring';
      resCapRing.position.z = 0.017;
      resCap.add(resCapRing);
      part('reservoir-cradle', bevel(0.155, 0.035, 0.21, 0.008), metal, 0, 0.083, -0.018);
      pump = part('independent-pump', cylinder(0.086, 0.125, 10), black, 0, -0.035, -0.265); pump.scale.x = 1.35;
      part('pump-grip-ring', new THREE.TorusGeometry(0.087, 0.008, 4, 12), body, 0, 0, -0.038).removeFromParent(); pump.add(parts['pump-grip-ring']);
      part('stock-neck', cylinder(0.045, 0.10, 8), metal, 0, -0.025, 0.20);
      part('stock-pad', bevel(0.13, 0.17, 0.065), black, 0, -0.028, 0.26);
      part('pistol-grip', new THREE.CapsuleGeometry(0.047, 0.10, 3, 8), black, 0, -0.15, 0.08, -0.26);
      part('trigger-guard', new THREE.TorusGeometry(0.06, 0.011, 6, 12), metal, 0, -0.113, -0.03, 0, Math.PI / 2);
      part('pressure-gauge', cylinder(0.037, 0.018, 16), metal, -0.126, 0.045, 0.065, 0, Math.PI / 2);
      part('pressure-needle', new THREE.ConeGeometry(0.006, 0.045, 3), glow, -0.14, 0.045, 0.065, 0.7);
      label('MARK-02 // SCATTER', '#172129', '#e5b63c', 0.27, 0.045, -0.12, 0.047, 0.015, -Math.PI / 2);
    } else {
      part('silver-receiver', bevel(0.125, 0.12, 0.40), body);
      part('long-needle', cylinder(0.015, 0.57, 16, 0.026), metal, 0, 0.006, -0.47);
      part('needle-tip', new THREE.ConeGeometry(0.015, 0.09, 12).rotateX(-Math.PI / 2), metal, 0, 0.006, -0.79);
      for (const s of [-1, 1]) part('black-spine-rail-' + s, bevel(0.018, 0.022, 0.47, 0.003), black, s * 0.052, 0.057, -0.12);
      part('scope-tube', cylinder(0.044, 0.28), black, 0, 0.145, -0.012);
      const lens = glass.clone(); lens.color.setHex(0x91dfff); lens.emissive.setHex(0x75cfff); lens.emissiveIntensity = 0.25;
      part('scope-front-lens', new THREE.CircleGeometry(0.036, 20), lens, 0, 0.145, -0.154);
      part('scope-back-lens', new THREE.CircleGeometry(0.039, 20), lens, 0, 0.145, 0.131);
      part('scope-eyecup', new THREE.TorusGeometry(0.043, 0.013, 6, 20), black, 0, 0.145, 0.138);
      part('scope-elevation-knob', cylinder(0.023, 0.034, 10), metal, 0, 0.198, -0.015, Math.PI / 2);
      part('scope-windage-knob', cylinder(0.022, 0.03, 10), metal, 0.052, 0.145, -0.015, 0, Math.PI / 2);
      part('scope-saddle', bevel(0.055, 0.075, 0.065, 0.004), metal, 0, 0.075, 0.01);
      for (const s of [-1, 1]) part('folded-bipod-' + s, new THREE.CapsuleGeometry(0.011, 0.25, 3, 8), black, s * 0.044, -0.045, -0.31, Math.PI / 2, s * 0.13);
      for (let i = 0; i < 4; i++) chargeRings.push(part('charge-ring-' + i, new THREE.TorusGeometry(0.029 - i * 0.002, 0.007, 6, 16), glow.clone(), 0, 0.006, -0.29 - i * 0.096));
      bolt = part('bolt-lever', cylinder(0.009, 0.075, 8), metal, 0.087, 0.012, 0.105, 0, Math.PI / 2);
      part('bolt-handle', new THREE.SphereGeometry(0.019, 10, 8), black, 0, 0, 0.042).removeFromParent(); bolt.add(parts['bolt-handle']);
      part('rear-stock', bevel(0.095, 0.10, 0.105), black, 0, -0.018, 0.245);
      part('grip', new THREE.CapsuleGeometry(0.035, 0.12, 3, 8), black, 0, -0.13, 0.14, -0.25);
      part('trigger-loop', new THREE.TorusGeometry(0.049, 0.008, 5, 12), metal, 0, -0.096, 0.042, 0, Math.PI / 2);
      label('0.05mm // LINE-03', '#d0dde0', '#172129', 0.31, 0.035, -0.064, 0.005, 0.015, -Math.PI / 2);
    }
    const muzzle = new THREE.Group(); muzzle.name = 'actual-muzzle'; muzzle.position.set(0, idx === 1 ? -0.015 : 0.01, [-0.636, -0.652, -0.838][idx]);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(i === 2 ? new THREE.ConeGeometry(0.029, 0.18, 6).rotateX(-Math.PI / 2) : flashGeo,
        new THREE.MeshBasicMaterial({ color: i === 2 ? 0xffffff : idx === 1 ? 0xffd344 : 0x7ff9ff,
          blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      m.name = 'muzzle-star-' + i; m.rotation.set(0, i === 1 ? Math.PI / 2 : 0, i * 0.6); m.position.z = -0.035;
      m.scale.setScalar(i === 1 ? 0.7 : 1); m.renderOrder = 15; muzzle.add(m);
    }
    g.add(muzzle); muzzle.visible = false; g.visible = idx === 0;
    const hands = makeHands(g, parts, idx);
    g.traverse(o => o.layers.set(1)); gun.add(g);
    return { g, parts, hands, muzzle, ink, magazine, bolt, pump, chargeRings, glow, shotAge: 10, ammo: CONFIG.player.weapons[idx].magazine, fill: 1, reload: 0, pumpPhase: 0, boltPhase: 0 };
  });
  let displayWeapon = 0, targetWeapon = 0, switchT = 0;
  let muzzle = gunViews[0].muzzle;
  gun.position.set(0.27, -0.22, -0.64);
  gun.rotation.set(0.035, 0.14, 0);
  camera.add(gun); camera.layers.enable(1);
  const weaponKey = new THREE.PointLight(0xfff2dc, 2.0, 3, 1.5);
  weaponKey.name = 'weapon-warm-key'; weaponKey.position.set(-0.45, 0.65, 0.1); weaponKey.layers.set(1);
  const weaponRim = new THREE.PointLight(0x85d9e5, 1.05, 2.8, 1.5);
  weaponRim.name = 'weapon-cyan-rim'; weaponRim.position.set(0.65, 0.15, -1.2); weaponRim.layers.set(1);
  camera.add(weaponKey, weaponRim); scene.add(camera);
  const recoilSpec = [
    { pitch: 0.045, roll: 0, setback: 0.055, fov: 0.8, shake: 0.008 },
    { pitch: 0.14, roll: 0.09, setback: 0.14, fov: 2.8, shake: 0.024 },
    { pitch: 0.16, roll: 0, setback: 0.16, fov: 3.2, shake: 0.026 },
  ];
  const spring = { pitch: 0, roll: 0, setback: 0, fov: 0 }, springV = { pitch: 0, roll: 0, setback: 0, fov: 0 };
  function stepSpring(dt) {
    // Semi-implicit fixed-safe substeps, bounded catch-up after a hidden tab.
    for (let left = Math.min(dt, 0.5); left > 1e-8;) {
      const h = Math.min(left, 1 / 120); left -= h;
      for (const k in spring) { springV[k] += (-484 * spring[k] - 36 * springV[k]) * h; spring[k] += springV[k] * h; }
    }
  }
  function updateWeapons(me, dt, motion) {
    gun.updateMatrix(); handInverse.copy(gun.matrix).invert();
    for (let i = 0; i < gunViews.length; i++) {
      const v = gunViews[i]; v.shotAge = Math.min(10, v.shotAge + dt);
      if (i === (me.wp || 0)) { v.ammo = me.ammo ?? v.ammo; v.reload = me.rl > 0 ? 1 - me.rl / (CONFIG.player.weapons[i].reloadTime * perkMods({ perks: me.pk || [] }).reloadMul) : 0; }
      else v.reload = 0;
      v.fill = Math.max(0, Math.min(1, v.ammo / CONFIG.player.weapons[i].magazine));
      const a = v.shotAge, r = Math.max(0, Math.min(1, v.reload));
      if (v.ink) {
        v.ink.visible = v.fill > 0;
        if (i === 0) { v.ink.scale.z = Math.max(0.001, v.fill); v.ink.position.z = 0.09 - 0.105 * v.fill; }
        else { v.ink.scale.set(1, 1, Math.max(0.001, v.fill)); v.ink.position.y = 0.086 + 0.069 * v.fill; }
        v.glow.emissive.setHex(i === 0 && v.ammo <= 4 && (!motion || Math.sin(fxTime * 12) > 0) ? 0xff651b : i === 1 ? 0xffaa16 : 0x19c8cf);
        v.glow.emissiveIntensity = 1.1 + (motion ? Math.max(0, 1 - a / 0.22) * 2 : 0);
      }
      if (v.magazine) {
        const drop = r < 0.35 ? r / 0.35 : r < 0.65 ? 1 : (1 - r) / 0.35;
        v.magazine.position.set(0.025 * drop, -0.15 - 0.24 * drop, -0.10 + 0.10 * drop);
        v.magazine.rotation.x = 0.24 + 0.35 * drop; v.magazine.visible = r < 0.38 || r > 0.61;
      }
      if (i === 0) { v.boltPhase = a < 0.12 ? Math.sin(Math.PI * a / 0.12) : 0; v.bolt.position.z = 0.04 + v.boltPhase * 0.065; }
      if (i === 1) { v.pumpPhase = a < 0.14 || a >= 0.40 ? 0 : a < 0.21 ? (a - 0.14) / 0.07 : 1 - (a - 0.21) / 0.19; v.pump.position.z = -0.265 + 0.11 * v.pumpPhase; }
      if (i === 2) {
        const lift = a < 0.25 || a >= 0.66 ? 0 : a < 0.31 ? (a - 0.25) / 0.06 : a < 0.58 ? 1 : (0.66 - a) / 0.08;
        v.boltPhase = a < 0.31 || a >= 0.58 ? 0 : a < 0.43 ? (a - 0.31) / 0.12 : (0.58 - a) / 0.15;
        v.bolt.rotation.z = -lift * 0.9; v.bolt.position.y = 0.012 + lift * 0.025; v.bolt.position.z = 0.105 + v.boltPhase * 0.095;
        for (let j = 0; j < 4; j++) { const m = v.chargeRings[j].material; m.emissiveIntensity = Math.max(0, Math.min(1, a / 0.85 * 4 - j)) * 1.6; m.color.setHex(m.emissiveIntensity > 0 ? 0x43e5df : 0x293f49); }
      }
      updateHands(v, i);
    }
  }

  // Articulated paper enemies; legacy er/pl cores retain their original scale and colors.
  const enemyViews = new Map();
  const paperModels = new Map();
  function paperMesh(name) {
    const mesh = new THREE.Mesh(paperModels.get(name).clone(),
      new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, transparent: true }));
    mesh.userData.paperModel = name;
    mesh.castShadow = mesh.receiveShadow = true;
    outline(mesh, C.ink, 0.55);
    return mesh;
  }
  function foldedFacet(w, h, ridge) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      0, h / 2, 0, -w / 2, 0, 0, 0, -h / 2, ridge,
      0, h / 2, 0, 0, -h / 2, ridge, w / 2, 0, 0,
    ], 3)); g.computeVertexNormals(); return g;
  }
  function cacheEnemyMaterials(v) {
    v.mats.length = 0;
    v.body.traverse(o => {
      if (o.material?.emissive && !v.mats.some(m => m.mat === o.material)) {
        const mat = o.material;
        if (!mat.userData.intrinsic) mat.userData.intrinsic = { color: mat.emissive.getHex(), intensity: mat.emissiveIntensity };
        v.mats.push({ mat, ...mat.userData.intrinsic });
      }
    });
  }
  function upgradeEnemy(v, type) {
    const name = type === 'eraser' ? 'er' : type === 'plane' ? 'pl' : null;
    if (!name || v.model || !paperModels.has(name)) return;
    v.body.remove(v.base); disposeTree(v.base);
    v.base = paperMesh(name); v.base.name = name + '-legacy-core'; v.model = true;
    // Keep the original vertex colors/scale, add articulation around (not instead of) the legacy asset.
    v.body.userData.paperModel = name; v.body.add(v.base); cacheEnemyMaterials(v);
  }
  function makeEnemyView(e) {
    const g = new THREE.Group(); g.name = e.type + '-' + e.id;
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 26;
    const tex = new THREE.CanvasTexture(cv);
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    bar.scale.set(1.15, 0.31, 1); bar.renderOrder = 10;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 24), lam(C.yellow, { transparent: true, opacity: 0, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
    const body = new THREE.Group(); body.name = 'articulated-body';
    const v = { g, body, base: null, shell: null, bar, cv, ctx: cv.getContext('2d'), tex, ring, edge: null, aimLine: null, shadow: null,
      target: null, flash: 0, hitKick: 0, hitAge: 1, deadT: -1, age: 0, lastHp: -1, lastArmor: -1, mats: [], wings: [], legs: [], jaws: [], shields: [],
      emitT: 0, biteAge: 10, biteX: null, biteZ: null, prevX: e.x, prevZ: e.z, heading: 0, bank: 0, type: e.type };
    const white = pbr(0xeeeade, 0.08, 0.77, { side: THREE.DoubleSide, transparent: true });
    const ink = pbr(0x242d37, 0.5, 0.52, { side: THREE.DoubleSide, transparent: true });
    const steel = pbr(0xabbcc6, 0.8, 0.35, { transparent: true });
    const red = pbr(0xa72b38, 0.4, 0.4, { emissive: 0xe51e35, emissiveIntensity: 0.9, side: THREE.DoubleSide, transparent: true });
    function add(name, geo, mat, x = 0, y = 0, z = 0, parent = body) {
      const m = new THREE.Mesh(geo, mat); m.name = name; m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
    }
    if (e.type === 'eraser') {
      const pink = pbr(0xdba1a6, 0.06, 0.85, { transparent: true });
      v.base = add('er-loading-core', new THREE.CapsuleGeometry(0.27, 0.5, 3, 10), pink, 0, 0.35);
      v.base.rotation.z = Math.PI / 2;
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
        const hip = new THREE.Group(); hip.name = 'leg-hip-' + i; hip.position.set((row - 1) * 0.36, 0.28, side * 0.23); body.add(hip);
        const upper = add('leg-upper-' + i, new THREE.CapsuleGeometry(0.028, 0.16, 2, 6), ink, 0, -0.055, side * 0.10, hip);
        upper.rotation.x = -side * 0.85;
        const knee = new THREE.Group(); knee.name = 'leg-knee-' + i; knee.position.set(0, -0.10, side * 0.20); hip.add(knee);
        const foot = add('leg-lower-' + i, new THREE.ConeGeometry(0.045, 0.23, 5), steel, 0, -0.075, side * 0.04, knee); foot.rotation.x = side * 0.35;
        v.legs.push({ hip, knee });
      }
      for (const side of [-1, 1]) {
        const jaw = new THREE.Group(); jaw.name = 'mandible-' + side; jaw.position.set(side * 0.15, 0.23, 0.27); body.add(jaw); v.jaws.push(jaw);
        const blade = add('mandible-blade-' + side, foldedFacet(0.17, 0.33, 0.07), steel, 0, 0, 0.10, jaw); blade.rotation.x = Math.PI / 2;
        for (let j = 0; j < 3; j++) { const tooth = add('serration-' + side + '-' + j, new THREE.ConeGeometry(0.028, 0.085, 3), steel, -side * 0.046, 0, 0.04 + j * 0.068, jaw); tooth.rotation.z = side * Math.PI / 2; }
        add('red-eye-' + side, new THREE.SphereGeometry(0.034, 8, 6), red, side * 0.135, 0.49, 0.315);
      }
      const teal = pbr(0x397f83, 0.7, 0.33, { transparent: true });
      add('teal-back-spool', cylinder(0.13, 0.35, 12), teal, 0, 0.60, -0.035).rotation.y = Math.PI / 2;
      for (const s of [-1, 1]) add('spool-flange-' + s, new THREE.TorusGeometry(0.132, 0.024, 5, 12), steel, s * 0.19, 0.60, -0.035).rotation.y = Math.PI / 2;
      bar.position.y = 1.15; v.maxHp = CONFIG.enemy.eraser.hp; v.maxArmor = 0;
    } else if (e.type === 'plane') {
      v.base = add('pl-loading-core', foldedFacet(1.37, 1.1, 0.15), white); v.base.rotation.x = Math.PI / 2; outline(v.base);
      for (const side of [-1, 1]) {
        const tail = add('banked-red-tail-' + side, foldedFacet(0.28, 0.48, 0.08), red, side * 0.32, 0.13, -0.35);
        tail.rotation.set(-0.22, 0, side * 0.65); outline(tail);
      }
      v.nozzle = add('belly-ink-nozzle', new THREE.ConeGeometry(0.095, 0.24, 10), red, 0, -0.10, -0.30); v.nozzle.rotation.x = -Math.PI / 2;
      v.nose = add('rotating-nose-aim-cone', new THREE.ConeGeometry(0.075, 0.28, 4), red, 0, 0, 0.55); v.nose.rotation.x = Math.PI / 2;
      bar.position.y = 0.62; v.maxHp = CONFIG.enemy.plane.hp; v.maxArmor = 0;
      v.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: col(C.red), transparent: true, opacity: 0.6 }));
      v.aimLine.visible = false; scene.add(v.aimLine);
      v.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 18), new THREE.MeshBasicMaterial({ color: col(C.ink), transparent: true, opacity: 0.13, depthWrite: false }));
      v.shadow.rotation.x = -Math.PI / 2; scene.add(v.shadow);
      const target = new THREE.Group(); target.name = 'handdrawn-dive-target';
      const points = [];
      for (let i = 0; i < 40; i++) { const a = i * Math.PI / 20, r = 0.63 + Math.sin(i * 17) * 0.026; points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
      const targetMat = new THREE.LineBasicMaterial({ color: 0xef3345, transparent: true, opacity: 0.8, depthWrite: false });
      target.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), targetMat));
      target.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
        -0.88, 0, 0.025, -0.25, 0, -0.012, 0.25, 0, 0.01, 0.86, 0, -0.025,
        0.022, 0, -0.86, -0.01, 0, -0.25, 0.01, 0, 0.25, -0.021, 0, 0.89,
      ], 3)), targetMat));
      target.visible = false; scene.add(target); v.target = target;
    } else {
      v.base = add('folded-chest', new THREE.OctahedronGeometry(1), white, 0, 0.78); v.base.scale.set(0.24, 0.44, 0.25); outline(v.base);
      for (let i = 0; i < 5; i++) {
        const cloak = add('sharp-cloak-fold-' + i, foldedFacet(0.32, 0.87 - i * 0.07, 0.14), i % 2 ? ink : white, (i - 2) * 0.09, 0.60, -0.12 + Math.abs(i - 2) * 0.035);
        cloak.rotation.set(-0.12, (i - 2) * 0.3, (i - 2) * 0.18); outline(cloak);
      }
      for (const side of [-1, 1]) {
        const shoulder = new THREE.Group(); shoulder.name = 'wing-shoulder-' + side; shoulder.position.set(side * 0.16, 0.94, -0.045); body.add(shoulder);
        const inner = add('wing-inner-' + side, foldedFacet(0.40, 0.72, 0.12), white, side * 0.16, 0.06, 0, shoulder); inner.rotation.z = -side * 0.82; outline(inner);
        const elbow = new THREE.Group(); elbow.name = 'wing-elbow-' + side; elbow.position.set(side * 0.34, 0.25, -0.015); shoulder.add(elbow);
        const outer = add('wing-outer-' + side, foldedFacet(0.33, 0.68, 0.10), white, side * 0.13, -0.12, 0, elbow); outer.rotation.z = side * 0.45; outline(outer);
        v.wings.push({ shoulder, elbow, side });
        const mask = add('demonic-mask-' + side, foldedFacet(0.20, 0.35, 0.115), ink, side * 0.072, 1.24, 0.14); mask.rotation.z = -side * 0.22; outline(mask);
        const horn = add('mask-horn-' + side, new THREE.ConeGeometry(0.045, 0.22, 3), white, side * 0.15, 1.42, 0.11); horn.rotation.z = -side * 0.35;
        const eye = add('red-eye-' + side, foldedFacet(0.084, 0.033, 0.014), red, side * 0.073, 1.265, 0.236); eye.rotation.z = side * 0.23;
      }
      v.core = add('telegraph-red-power-core', new THREE.OctahedronGeometry(0.12), red, 0, 0.88, 0.24);
      const collar = add('core-collar', new THREE.TorusGeometry(0.138, 0.021, 4, 8), ink, 0, 0.88, 0.21); collar.rotation.z = Math.PI / 8;
      v.shell = new THREE.Group(); v.shell.name = 'orbiting-armor'; body.add(v.shell);
      for (let i = 0; i < 4; i++) {
        const m = add('folded-teal-shield-' + i, foldedFacet(0.34, 0.48, 0.13),
          pbr(0x358c89, 0.6, 0.3, { emissive: 0x21d9c4, emissiveIntensity: 0.55, transparent: true, opacity: 0.76, side: THREE.DoubleSide }), 0, 0.68, 0, v.shell);
        outline(m, '093e48', 0.9); v.shields.push(m);
      }
      bar.position.y = 1.75; v.maxHp = CONFIG.enemy.hp; v.maxArmor = CONFIG.enemy.armor;
    }
    g.add(body, bar, ring); scene.add(g); cacheEnemyMaterials(v); upgradeEnemy(v, e.type); return v;
  }
  function animateEnemy(v, e, me, dt, motion) {
    const t = fxTime, tel = Math.min(1, (e.telegraph || 0) / (e.type === 'plane' ? CONFIG.enemy.plane.aimTime : CONFIG.enemy.telegraph));
    v.hitAge += dt;
    const h = Math.min(1, v.hitAge / 0.14);
    v.hitKick = h >= 1 ? 0 : (1 - h) * (1 - h) * Math.cos(h * Math.PI * 2);
    v.body.rotation.x = -0.22 * v.hitKick * motion;
    v.body.scale.set(1 + 0.12 * v.hitKick * motion, 1 - 0.12 * v.hitKick * motion, 1 + 0.12 * v.hitKick * motion);
    v.body.position.y = 0; v.body.position.z = 0;
    const dx = e.x - v.prevX, dz = e.z - v.prevZ;
    let heading = me ? Math.atan2(me.x - e.x, me.z - e.z) : v.heading;
    v.biteAge = Math.min(10, v.biteAge + dt);
    if ((e.type === 'plane' || e.type === 'eraser') && Math.hypot(dx, dz) > 0.001 && e.state !== 'aim') heading = Math.atan2(dx, dz);
    if (e.type === 'eraser' && v.biteAge < 0.3 && v.biteX !== null) heading = Math.atan2(v.biteX - e.x, v.biteZ - e.z);
    const turn = Math.atan2(Math.sin(heading - v.heading), Math.cos(heading - v.heading));
    v.bank += (Math.max(-0.55, Math.min(0.55, -turn * 3)) - v.bank) * (1 - Math.exp(-7 * dt));
    v.heading = heading; v.prevX = e.x; v.prevZ = e.z; v.g.rotation.y = heading;
    if (e.type === 'crane' || (!v.legs.length && !v.target)) {
      for (const w of v.wings) { w.shoulder.rotation.z = w.side * (0.13 + Math.sin(t * 5 + e.id) * 0.18 * motion - tel * 0.25); w.elbow.rotation.z = w.side * Math.sin(t * 5 + e.id - 0.8) * 0.25 * motion; }
      v.body.position.y = Math.sin(t * 3 + e.id) * 0.028 * motion;
      v.core.scale.setScalar(1 + tel * (0.55 + Math.sin(t * 16) * 0.12 * motion)); v.core.rotation.y = t * (1 + tel * 5) * motion;
      const count = Math.ceil(Math.max(0, e.armor / v.maxArmor) * 4);
      for (let i = 0; i < 4; i++) { const s = v.shields[i], a = i * Math.PI / 2 + t * 0.65 * motion;
        s.visible = i < count; s.position.set(Math.sin(a) * 0.40, 0.68 + Math.sin(a * 2) * 0.06, Math.cos(a) * 0.40); s.rotation.set(0.12, a, Math.sin(t * 2 + i) * 0.08 * motion); }
      v.shell.visible = e.armor > 0;
    } else if (e.type === 'eraser') {
      for (let i = 0; i < 6; i++) { const phase = t * 13 + Math.floor(i / 2) * 1.1 + (i % 2) * Math.PI;
        v.legs[i].hip.rotation.x = Math.sin(phase) * 0.35 * motion; v.legs[i].hip.rotation.y = Math.cos(phase) * 0.18 * motion;
        v.legs[i].knee.rotation.x = Math.max(0, Math.sin(phase)) * 0.55 * motion; }
      const pulse = Math.max(0, 1 - v.biteAge / 0.3), windup = v.biteAge < 0.08 ? 1 - v.biteAge / 0.08 : 0;
      const bite = e.state === 'bite' || tel > 0 || pulse > 0;
      for (let i = 0; i < 2; i++) v.jaws[i].rotation.y = (i ? 1 : -1) * (0.12 + (bite ? 0.35 + Math.sin(t * 22) * 0.24 * motion : Math.sin(t * 5) * 0.07 * motion));
      v.body.position.y = (Math.sin(t * 13) * 0.018 - (tel + windup) * 0.09) * motion;
      v.body.position.z = (-tel * 0.13 - windup * 0.10 + Math.sin(Math.min(1, v.biteAge / 0.3) * Math.PI) * pulse * 0.25) * motion;
      v.body.scale.y *= 1 - (tel + windup) * 0.14; v.body.scale.z *= 1 + Math.sin(t * 13) * 0.025 * motion;
      v.emitT += dt; if (v.emitT >= 0.18 && motion) { v.emitT = 0; fxPoint.set(e.x, e.y + 0.2, e.z - 0.25); emitDebris(fxPoint, 1, 'D7A0A9', 'crumb'); }
    } else {
      v.g.rotation.x = e.state === 'dive' ? 0.55 : e.state === 'aim' ? 0.16 : 0;
      v.g.rotation.z = (v.bank + Math.sin(t * 3 + e.id) * 0.035) * motion;
      v.nose.rotation.y = t * 4 * motion; v.nozzle.scale.y = 1 + Math.sin(t * 24) * 0.13 * motion;
      v.shadow.position.set(e.x, 0.02, e.z);
      const aiming = !!me && (e.state === 'aim' || e.state === 'dive');
      v.aimLine.visible = v.target.visible = aiming;
      if (aiming) {
        const pa = v.aimLine.geometry.attributes.position; pa.setXYZ(0, e.x, e.y, e.z); pa.setXYZ(1, me.x, 0.045, me.z); pa.needsUpdate = true;
        v.aimLine.geometry.computeBoundingSphere(); v.aimLine.material.opacity = 0.25 + 0.65 * tel;
        v.target.position.set(me.x, 0.045, me.z); v.target.rotation.y = t * 1.7 * motion; v.target.scale.setScalar(e.state === 'dive' ? 0.5 : 1.25 - tel * 0.75);
      }
      v.emitT += dt; if (v.emitT >= 0.065 && motion) { v.emitT = 0; fxPoint.set(e.x, e.y, e.z); emitDebris(fxPoint, 1, 'C53245', 'trail'); }
      v.ring.position.y = 0.02 - e.y;
    }
    // Flash white, then restore the intrinsic red/teal emitters exactly (not black).
    for (const m of v.mats) { m.mat.emissive.setHex(v.flash > 0 ? 0xffffff : m.color); m.mat.emissiveIntensity = v.flash > 0 ? 1.6 : m.intensity; }
    v.ring.material.opacity = e.stun > 0 ? 0.5 : e.type === 'plane' ? 0 : tel > 0 ? 0.35 + 0.5 * tel : 0;
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
    disposeTree(v.g); v.tex.dispose();
    if (v.aimLine) { scene.remove(v.aimLine); v.aimLine.geometry.dispose(); v.aimLine.material.dispose(); }
    if (v.shadow) { scene.remove(v.shadow); v.shadow.geometry.dispose(); v.shadow.material.dispose(); }
    if (v.target) { scene.remove(v.target); disposeTree(v.target); }
  }

  const projViews = new Map();
  const projGeo = new THREE.SphereGeometry(CONFIG.enemy.projectileRadius * 0.70, 10, 8);
  const projHaloGeo = starGeometry(CONFIG.enemy.projectileRadius * 1.8, 0.68, 10);
  const projTailGeo = new THREE.ConeGeometry(CONFIG.enemy.projectileRadius * 0.8, 0.65, 8).rotateX(Math.PI / 2);
  const projMat = new THREE.MeshBasicMaterial({ color: 0xfff4b8 });
  const projHaloMat = new THREE.MeshBasicMaterial({ color: 0xe6293e, transparent: true, opacity: 0.65, depthWrite: false, side: THREE.DoubleSide });
  const projTailMat = new THREE.MeshBasicMaterial({ color: 0xff592f, transparent: true, opacity: 0.48, blending: THREE.AdditiveBlending, depthWrite: false });
  const projPool = Array.from({ length: 96 }, () => {
    const g = new THREE.Group(); g.name = 'ink-projectile';
    const core = new THREE.Mesh(projGeo, projMat), halo = new THREE.Mesh(projHaloGeo, projHaloMat), tail = new THREE.Mesh(projTailGeo, projTailMat);
    core.name = 'hot-white-yellow-core'; halo.name = 'serrated-red-halo'; tail.name = 'stretched-ink-tail'; tail.position.z = -0.32;
    g.add(core, halo, tail); g.visible = false; scene.add(g); return { g, core, halo, tail, active: false, id: null, previous: new THREE.Vector3() };
  });
  const projectileDirection = new THREE.Vector3(), projectileAxis = new THREE.Vector3(0, 0, 1);
  function updateProjectile(v, p, dt, fresh) {
    if (Number.isFinite(p.vx)) projectileDirection.set(p.vx, p.vy || 0, p.vz || 0);
    else projectileDirection.set(p.x, p.y, p.z).sub(v.previous);
    const length = projectileDirection.length();
    if ((!fresh || Number.isFinite(p.vx)) && length > 0.00001) {
      v.g.quaternion.setFromUnitVectors(projectileAxis, projectileDirection.multiplyScalar(1 / length));
      v.tail.scale.z = Math.min(1.8, Math.max(0.7, length / Math.max(dt, 0.001) * 0.08));
    }
    v.previous.set(p.x, p.y, p.z); v.g.position.copy(v.previous);
    v.halo.rotation.z += reducedMotion() ? 0 : dt * 12;
  }

  // 地面警示域：音浪环 / 墨雨红圈+坠球 / 灼烧墨痕。几何共享，材质随域生成/销毁。
  const hazardViews = new Map();
  const hazardGeo = {
    ring: new THREE.RingGeometry(0.88, 1, 56),
    fill: new THREE.CircleGeometry(1, 40),
    ball: new THREE.SphereGeometry(0.42, 10, 8),
  };
  function makeHazardView(h) {
    const g = new THREE.Group(); g.name = 'hazard-' + h.k;
    const flat = (geo, hex, opacity, y) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col(hex), transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.y = y; g.add(m); return m;
    };
    if (h.k === 'w') flat(hazardGeo.ring, 'F2C14E', 0.7, 0.06);
    else if (h.k === 'm') {
      flat(hazardGeo.ring, 'E34B3F', 0.8, 0.055);
      flat(hazardGeo.fill, 'E34B3F', 0.18, 0.05);
      const ball = new THREE.Mesh(hazardGeo.ball, new THREE.MeshBasicMaterial({ color: 0x20242a }));
      ball.name = 'mortar-ink-ball'; ball.visible = false; g.add(ball);
    } else {
      flat(hazardGeo.fill, '8F1F2A', 0.55, 0.035);
      flat(hazardGeo.ring, 'D8452F', 0.5, 0.04);
    }
    scene.add(g);
    return { g };
  }
  function updateHazards(snap) {
    const seen = new Set();
    for (const h of snap.hazards || []) {
      seen.add(h.id);
      let v = hazardViews.get(h.id);
      if (!v) { v = makeHazardView(h); hazardViews.set(h.id, v); }
      v.g.position.set(h.x, 0, h.z);
      const mats = v.g.children;
      if (h.k === 'w') {
        mats[0].scale.setScalar(h.r);
        mats[0].material.opacity = Math.min(0.8, 0.22 + 0.55 * Math.max(0, Math.min(1, (CONFIG.boss.waveMaxRadius - h.r) / 6)));
      } else if (h.k === 'm') {
        const k = Math.max(0, Math.min(1, 1 - h.t / CONFIG.boss.mortarFuse));
        mats[0].scale.setScalar(h.r * (1 + 0.05 * Math.sin(fxTime * 14)));
        mats[0].material.opacity = 0.4 + 0.5 * k;
        mats[1].scale.setScalar(h.r * 0.98);
        mats[1].material.opacity = 0.1 + 0.22 * k;
        const ball = mats[2];
        ball.visible = h.t <= 0.35;
        if (ball.visible) {
          const f = Math.max(0, h.t / 0.35);
          ball.position.y = 0.5 + 6.5 * f;
          ball.scale.setScalar(0.7 + 0.55 * f);
        }
      } else {
        const fade = Math.min(1, h.t / 1.0);
        mats[0].scale.setScalar(h.r * (1 + 0.035 * Math.sin(fxTime * 6 + h.id)));
        mats[0].material.opacity = 0.55 * fade;
        mats[1].scale.setScalar(h.r * 0.95);
        mats[1].material.opacity = 0.45 * fade;
      }
    }
    for (const [id, v] of hazardViews) {
      if (seen.has(id)) continue;
      scene.remove(v.g);
      v.g.traverse(o => { if (o.material) o.material.dispose(); });
      hazardViews.delete(id);
    }
  }

  // 玩家墙视图：青绿半透 .82，末 3 秒淡出（原型 updateWalls 同参数）
  const wallViews = new Map();
  function makeWallView(w) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.len, CONFIG.wall.height, CONFIG.wall.thickness), lam(C.teal, { transparent: true, opacity: 0.82 }));
    m.position.set(w.x, CONFIG.wall.height / 2, w.z);
    m.rotation.y = -Math.atan2(w.uz, w.ux);
    m.castShadow = true;
    const edge = outline(m, '0B4F4C');
    scene.add(m);
    return { m, edge, nx: -w.uz, nz: w.ux, flash: 0 };
  }

  const splats = [];
  const splatGeo = new THREE.CircleGeometry(1, 14);
  const splatConfig = CONFIG.visual.splat;
  const surfaces = [...COVERS, ...BOUNDS, ...FOLDS.map(f => ({
    x: f.x + Math.sin(f.rotY) * CONFIG.folds.platformSize,
    z: f.z + Math.cos(f.rotY) * CONFIG.folds.platformSize,
    w: CONFIG.folds.platformSize, d: CONFIG.folds.platformSize, h: CONFIG.folds.platformHeight,
  }))];
  function removeSplat(i) {
    const s = splats[i]; scene.remove(s.m); s.m.material.dispose(); splats.splice(i, 1);
  }
  function clearWallSplats(id) {
    for (let i = splats.length - 1; i >= 0; i--) if (splats[i].wallId === id) removeSplat(i);
  }
  function addSplat(point, kind, wallId, isEnemy) {
    const pos = new THREE.Vector3(point.x, point.y, point.z);
    const normal = new THREE.Vector3();
    let foldId = null;
    if (kind === 'wall') {
      const v = wallViews.get(wallId);
      if (!v) return;
      normal.set(v.nx, 0, v.nz);
      const side = (camera.position.x - v.m.position.x) * v.nx + (camera.position.z - v.m.position.z) * v.nz >= 0 ? 1 : -1;
      normal.multiplyScalar(side);
      const depth = (pos.x - v.m.position.x) * normal.x + (pos.z - v.m.position.z) * normal.z;
      pos.addScaledVector(normal, CONFIG.wall.halfThickness - depth);
    } else if (kind === 'static') {
      let nearest = Infinity;
      const best = new THREE.Vector3();
      for (const b of surfaces) {
        const cx = Math.max(b.x - b.w / 2, Math.min(b.x + b.w / 2, point.x));
        const cz = Math.max(b.z - b.d / 2, Math.min(b.z + b.d / 2, point.z));
        const cy = Math.max(0, Math.min(b.h, point.y));
        const faces = [
          [b.x - b.w / 2, cy, cz, -1, 0, 0], [b.x + b.w / 2, cy, cz, 1, 0, 0],
          [cx, cy, b.z - b.d / 2, 0, 0, -1], [cx, cy, b.z + b.d / 2, 0, 0, 1],
          [cx, b.h, cz, 0, 1, 0],
        ];
        for (const f of faces) {
          const distance = Math.hypot(f[0] - point.x, f[1] - point.y, f[2] - point.z);
          if (distance < nearest) { nearest = distance; best.set(f[0], f[1], f[2]); normal.set(f[3], f[4], f[5]); }
        }
      }
      pos.copy(best);
    } else if (kind === 'fold') {
      let nearest = Infinity, wall = null;
      for (const f of FOLDS) {
        if (foldViews[f.id].state !== 'wall') continue;
        const b = foldWallBox(f);
        const along = Math.max(-b.len / 2, Math.min(b.len / 2, (point.x - b.x) * b.ux + (point.z - b.z) * b.uz));
        const distance = Math.hypot(point.x - b.x - along * b.ux, point.z - b.z - along * b.uz);
        if (distance < nearest) { nearest = distance; wall = b; foldId = f.id; }
      }
      if (!wall) return;
      normal.set(wall.nx, 0, wall.nz);
      if ((camera.position.x - wall.x) * normal.x + (camera.position.z - wall.z) * normal.z < 0) normal.negate();
      const depth = (pos.x - wall.x) * normal.x + (pos.z - wall.z) * normal.z;
      pos.addScaledVector(normal, wall.halfThickness - depth);
    } else return;
    pos.addScaledVector(normal, 0.015);
    const hex = isEnemy ? C.red : splatConfig.palette[Math.floor(Math.random() * splatConfig.palette.length)];
    const put = (center, radius) => {
      const m = new THREE.Mesh(splatGeo, new THREE.MeshBasicMaterial({ color: col(hex), transparent: true,
        opacity: 0.84, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.position.copy(center); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      m.rotateZ(Math.random() * Math.PI); m.scale.set(radius, radius * (0.6 + Math.random() * 0.35), 1);
      m.renderOrder = 4; m.userData.splat = { kind, wallId, enemy: !!isEnemy };
      scene.add(m); splats.push({ m, wallId: kind === 'wall' ? wallId : null, foldId, life: splatConfig.life });
      if (splats.length > splatConfig.max) removeSplat(0);
    };
    put(pos, 0.18 + Math.random() * 0.2);
    if (Math.random() < splatConfig.splashChance) {
      const tangent = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal));
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent);
      const angle = Math.random() * Math.PI * 2, distance = 0.12 + Math.random() * 0.16;
      const satellite = pos.clone().addScaledVector(tangent, Math.cos(angle) * distance).addScaledVector(bitangent, Math.sin(angle) * distance);
      put(satellite, 0.06 + Math.random() * 0.08);
    }
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

  // Boss：M5 奶龙动画模型（src/models/nailong_boss.glb，LOD2）+ AnimationMixer 六状态机。
  // 仅渲染层：战斗数值/AI/碰撞半径全部由 shared 内核决定，这里只消费快照与事件。
  // 加载顺序：GLB（优先）→ 黄色胶囊回退（bs.json 低模已淘汰，不再内联）。
  function geoFromModel(m) {
    const g = new THREE.BufferGeometry();
    const vertCount = m.pos.length / 3;
    const pos = new Float32Array(m.pos.length);
    for (let i = 0; i < m.pos.length; i++) pos[i] = m.pos[i] / 1000;
    const colArr = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      const hex = m.fc ? m.fc[Math.floor(i / 3)] : m.col[i];
      colArr[i * 3] = parseInt(hex.slice(0, 2), 16) / 255;
      colArr[i * 3 + 1] = parseInt(hex.slice(2, 4), 16) / 255;
      colArr[i * 3 + 2] = parseInt(hex.slice(4, 6), 16) / 255;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    if (m.idx) g.setIndex(m.idx);
    g.computeVertexNormals();
    return g;
  }
  function loadPaper(name, request) {
    request.then(r => r.ok ? r.json() : null).then(data => {
      if (!data || disposed) return;
      paperModels.set(name, geoFromModel(data));
      if (name === 'fold') for (const v of foldViews) {
        v.pivot.remove(v.board); disposeTree(v.board);
        v.board = paperMesh(name); v.model = true; v.pivot.add(v.board);
      }
      if (name === 'bo' || name === 'ta') for (const v of pickupViews.values()) {
        if ((v.ty === 'ink' ? 'bo' : 'ta') !== name) continue;
        const mesh = paperMesh(name); mesh.position.copy(v.m.position);
        mesh.visible = v.m.visible; scene.remove(v.m); disposeTree(v.m);
        v.m = mesh; v.model = true; scene.add(mesh);
      }
    }).catch(() => {});
  }
  loadPaper('er', fetch('/src/models/er.json'));
  loadPaper('pl', fetch('/src/models/pl.json'));
  loadPaper('fold', fetch('/src/models/fold.json'));
  loadPaper('bo', fetch('/src/models/bo.json'));
  loadPaper('ta', fetch('/src/models/ta.json'));

  // GLB ArrayBuffer 只下载/解压一次并缓存；每次 makeBossView 用 loader.parse() 实例化
  // 干净的 SkinnedMesh+Skeleton+AnimationMixer，杜绝 restart 骨骼失效与内存泄漏。
  let bossGLBBuf = null;
  let bossGLBFailed = false;
  let bossGLBPromise = null;
  function loadBossGLB() {
    if (bossGLBPromise) return bossGLBPromise;
    const wantLod0 = /[?&]lod=0\b/.test(window.location.search);
    const primary = wantLod0
      ? fetch('/src/models/nailong_boss_lod0.glb')
      : fetch('/src/models/nailong_boss.glb');
    bossGLBPromise = primary
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(buf => {
        if (buf) return buf;
        return fetch('/src/models/nailong_boss.glb').then(r => (r.ok ? r.arrayBuffer() : null));
      })
      .then(buf => { bossGLBBuf = buf; if (!buf) bossGLBFailed = true; return buf; })
      .catch(() => { bossGLBFailed = true; return null; });
    return bossGLBPromise;
  }
  loadBossGLB();

  let bossView = null;
  let anchorsSuppressed = false;
  // Loading/unlocking warms caches only; it never replays a skipped event.
  const laughCooldown = 3.5, soundPeak = 0.35;
  const soundNow = () => performance.now() / 1000;
  let soundMuted = false, soundVolume = soundPeak, soundDistance = 1;
  try { soundMuted = window.localStorage.getItem('inkline-sound') === 'off'; } catch (_) {}
  let soundCtx = null, soundBytes = null, soundBuffer = null, soundDecode = null;
  let soundVoice = null, soundPending = null, soundLast = -Infinity, soundStarts = 0, soundError = false;
  let soundStartTimes = [];
  function decodeBossSound() {
    if (!soundCtx || !soundBytes || soundDecode) return;
    try {
      soundDecode = soundCtx.decodeAudioData(soundBytes.slice(0));
      soundDecode.then(buf => { soundBuffer = buf; }, () => { soundError = true; });
    } catch (_) { soundError = true; }
  }
  fetch('/src/audio/boss_laugh.mp3')
    .then(r => r.ok ? r.arrayBuffer() : null)
    .then(buf => { soundBytes = buf; if (!buf) soundError = true; decodeBossSound(); })
    .catch(() => { soundError = true; });
  function unlockBossSound(ev) {
    if (!ev.isTrusted || soundMuted) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      if (!soundCtx) {
        soundCtx = new Audio();
        soundCtx.onstatechange = () => { if (soundCtx.state !== 'running') stopBossSound(); };
      }
      // resume MUST run in the trusted handler, not in a fetch/decode continuation.
      if (soundCtx.state !== 'running') soundCtx.resume().catch(() => {});
      decodeBossSound();
    } catch (_) {}
  }
  for (const name of ['pointerdown', 'click', 'keydown']) window.addEventListener(name, unlockBossSound, true);
  function stopBossSound() {
    if (soundPending !== null) clearTimeout(soundPending);
    soundPending = null;
    const voice = soundVoice;
    if (!voice) return;
    if (soundCtx.state !== 'running') {
      voice.source.stop();
      voice.source.onended();
      return;
    }
    if (voice.stopping) return;
    voice.stopping = true;
    const now = soundCtx.currentTime;
    voice.envelope.gain.cancelAndHoldAtTime(now);
    voice.envelope.gain.linearRampToValueAtTime(0.001, now + 0.05);
    voice.source.stop(now + 0.05);
  }
  function setBossSoundMuted(muted) {
    soundMuted = !!muted;
    if (soundMuted) stopBossSound();
    try { window.localStorage.setItem('inkline-sound', soundMuted ? 'off' : 'on'); } catch (_) {}
  }
  function updateBossSoundGain() {
    if (soundVoice && !soundVoice.stopping) {
      soundVoice.gain.gain.setTargetAtTime(soundVolume / soundPeak * soundDistance, soundCtx.currentTime, 0.05);
    }
  }
  function setBossLaughVolume(v) {
    if (Number.isFinite(v)) {
      soundVolume = Math.max(0, Math.min(1, v));
      updateBossSoundGain();
    }
    return soundVolume;
  }
  function playBossSound() {
    const now = soundNow(), view = bossView;
    if (soundMuted || !soundBuffer || !soundCtx || soundCtx.state !== 'running'
      || soundVoice || soundPending !== null || now - soundLast < laughCooldown) return;
    soundLast = now;
    soundPending = setTimeout(() => {
      soundPending = null;
      if (soundMuted || soundCtx.state !== 'running' || bossView !== view || view.dying) return;
      try {
        const source = soundCtx.createBufferSource();
        const envelope = soundCtx.createGain(), gain = soundCtx.createGain();
        const voice = soundVoice = { source, envelope, gain, stopping: false };
        const at = soundCtx.currentTime, end = at + soundBuffer.duration;
        source.buffer = soundBuffer;
        // Independent gain stages keep per-frame distance updates out of the envelope.
        source.connect(envelope);
        envelope.connect(gain);
        gain.connect(soundCtx.destination);
        envelope.gain.setValueAtTime(0.001, at);
        envelope.gain.linearRampToValueAtTime(soundPeak, at + 0.20);
        envelope.gain.setValueAtTime(soundPeak, end - 0.25);
        envelope.gain.linearRampToValueAtTime(0.001, end);
        gain.gain.setValueAtTime(soundVolume / soundPeak * soundDistance, at);
        source.onended = () => {
          source.disconnect();
          envelope.disconnect();
          gain.disconnect();
          source.onended = null;
          if (soundVoice === voice) soundVoice = null;
        };
        source.start(at);
        soundStarts++;
        soundStartTimes.push(soundNow());
        if (soundStartTimes.length > 16) soundStartTimes.shift();
      } catch (_) { soundError = true; stopBossSound(); }
    }, 220);
  }
  function bossAudioDebug() {
    return {
      muted: soundMuted, state: soundCtx ? soundCtx.state : (window.AudioContext || window.webkitAudioContext ? 'locked' : 'unsupported'),
      loaded: !!soundBuffer, bytes: soundBytes ? soundBytes.byteLength : 0, error: soundError,
      active: soundVoice ? 1 : 0, pending: soundPending !== null, stopping: !!soundVoice?.stopping,
      starts: soundStarts, startTimes: soundStartTimes.slice(),
      volume: soundVolume, distanceFactor: soundDistance, targetGain: soundVolume * soundDistance,
      gain: soundVoice ? soundVoice.envelope.gain.value * soundVoice.gain.gain.value : 0,
      duration: soundBuffer ? soundBuffer.duration : 0,
      cooldown: Math.max(0, laughCooldown - (soundNow() - soundLast)),
    };
  }
  function triggerBossLaugh() {
    const v = bossView;
    if (!v || v.dying) return false;
    // Summon/rage/debug always animate, even on cooldown; audio never overrides it.
    v.laughAt = soundNow();
    v.laughT = v.laughDur;
    v.atkT = v.hitT = 0;
    setBossAnim(v, 'LaughAttack', 0.15, true);
    playBossSound();
    return true;
  }
  function makeBossView() {
    stopBossSound();
    soundLast = -Infinity;
    soundStarts = 0;
    soundStartTimes = [];
    const g = new THREE.Group();
    const mat = lam(C.yellow);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(CONFIG.boss.radius, 2.2 - CONFIG.boss.radius * 2, 4, 12), mat);
    body.position.y = 1.1;
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 26;
    const tex = new THREE.CanvasTexture(cv);
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    bar.scale.set(1.6, 0.43, 1);
    bar.position.y = 2.9;
    bar.renderOrder = 10;
    const aura = new THREE.Mesh(
      new THREE.RingGeometry(1.15, 1.42, 36),
      lam(C.red, { transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.03;
    const aim = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: col(C.red), transparent: true, opacity: 0.8 })
    );
    aim.visible = false;
    aim.frustumCulled = false;
    const dizzyGroup = new THREE.Group();
    dizzyGroup.name = 'dizzyGroup';
    dizzyGroup.position.y = 2.55;
    for (let i = 0; i < 3; i++) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), lam(C.yellow));
      const angle = i * Math.PI * 2 / 3;
      star.position.set(Math.cos(angle) * 0.62, 0, Math.sin(angle) * 0.62);
      star.scale.set(0.8, 1.25, 0.45);
      outline(star);
      dizzyGroup.add(star);
    }
    const bellyTarget = new THREE.Group();
    bellyTarget.name = 'bellyTarget';
    bellyTarget.position.set(0, 1.15, 0.72);
    const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.3, 36),
      new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    targetRing.renderOrder = 12;
    bellyTarget.add(targetRing);
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.028, 0.1), targetRing.material.clone());
      const angle = i * Math.PI / 2;
      tick.position.set(Math.sin(angle) * 0.34, Math.cos(angle) * 0.34, 0.01);
      tick.rotation.z = -angle;
      tick.renderOrder = 12;
      bellyTarget.add(tick);
    }
    dizzyGroup.visible = bellyTarget.visible = false;
    const slamRing = new THREE.Mesh(new THREE.RingGeometry(3.86, 4.3, 48),
      new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    slamRing.name = 'slam-warning';
    slamRing.rotation.x = -Math.PI / 2;
    slamRing.position.y = 0.045;
    slamRing.visible = false;
    g.add(body, bar, aura, dizzyGroup, bellyTarget, slamRing);
    scene.add(g);
    scene.add(aim);
    const v = {
      g, body, bar, aura, aim, mat, cv, ctx: cv.getContext('2d'), tex, dizzyGroup, bellyTarget, slamRing, stunned: false,
      model: false, lastHp: -1, lastRaged: null, flash: 0, auraT: 0,
      glbRoot: null, mixer: null, actions: null, clips: null, mats: [], cur: null,
      glbPending: false, glbDone: false, dying: false, deathT: 0, deathDur: 0,
      atkT: 0, atkDur: 1.5, hitT: 0, hitDur: 0.8333, hitCd: 0,
      laughT: 0, laughDur: 2, laughAt: -Infinity,
      speed: 0, px: null, pz: null,
    };
    bossView = v;
    attachBossGLB(v);
    return v;
  }

  function disposeGLTF(gltf) {
    if (!gltf || !gltf.scene) return;
    gltf.scene.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.skeleton && o.skeleton.dispose) o.skeleton.dispose();
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of ms) m.dispose();
      }
    });
  }

  function attachBossGLB(v) {
    if (bossGLBFailed) return;
    v.glbPending = true;
    const apply = buf => {
      if (!buf || bossView !== v || v.dying) { v.glbPending = false; return; }
      let loader;
      try { loader = new GLTFLoader(); } catch (e) { v.glbPending = false; return; }
      loader.parse(buf, '', gltf => {
        if (bossView !== v || v.dying) { disposeGLTF(gltf); return; }
        setupBossGLB(v, gltf);
      }, () => { v.glbPending = false; });
    };
    if (bossGLBBuf) apply(bossGLBBuf);
    else loadBossGLB().then(apply);
  }

  function setupBossGLB(v, gltf) {
    const root = gltf.scene;
    root.scale.setScalar(1.0);
    const mats = [];
    root.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false;
        const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of ms) if (!mats.includes(m)) mats.push(m);
      }
    });
    // 移除占位本体，挂上动画模型
    v.g.remove(v.body);
    if (!v.model) v.body.geometry.dispose();
    if (v.mat) v.mat.dispose();
    v.body = root;
    v.g.add(root);
    v.glbRoot = root;
    v.mats = mats;
    v.mat = null;
    v.model = true;
    const mixer = new THREE.AnimationMixer(root);
    const clips = {};
    for (const c of gltf.animations) clips[c.name] = c;
    const mk = (name, repeat, clamp) => {
      const clip = clips[name];
      if (!clip) return null;
      const a = mixer.clipAction(clip);
      a.setLoop(repeat ? THREE.LoopRepeat : THREE.LoopOnce, repeat ? Infinity : 1);
      a.clampWhenFinished = !!clamp;
      return a;
    };
    const actions = {
      Idle: mk('Idle', true, false),
      Move: mk('Move', true, false),
      Attack: mk('Attack', false, true),
      LaughAttack: mk('LaughAttack', false, true),
      Hit: mk('Hit', false, true),
      Death: mk('Death', false, true),
    };
    v.mixer = mixer;
    v.actions = actions;
    v.clips = clips;
    if (clips.Attack) v.atkDur = clips.Attack.duration;
    if (clips.LaughAttack) v.laughDur = clips.LaughAttack.duration;
    if (clips.Hit) v.hitDur = clips.Hit.duration;
    if (clips.Death) v.deathDur = clips.Death.duration;
    setBossAnim(v, v.laughT > 0 ? 'LaughAttack' : 'Idle', 0);
    v.glbPending = false;
    v.glbDone = true;
  }

  function setBossAnim(v, name, fade, restart = false) {
    if (!v.actions || !v.actions[name] || (v.cur === name && !restart)) return;
    const next = v.actions[name];
    const prev = v.cur ? v.actions[v.cur] : null;
    next.enabled = true;
    next.reset();
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    v.cur = name;
  }

  function setBossEmissive(v, hex) {
    if (v.glbRoot) { for (const m of v.mats) if (m.emissive) m.emissive.setHex(hex); }
    else if (v.mat && v.mat.emissive) v.mat.emissive.setHex(hex);
  }

  function setBossOpacity(v, k) {
    if (v.glbRoot) { for (const m of v.mats) m.opacity = k; }
    else if (v.mat) v.mat.opacity = k;
  }

  function startBossDeath(v) {
    stopBossSound();
    v.laughT = v.atkT = v.hitT = 0;
    v.dying = true;
    v.deathT = 0;
    v.bar.visible = false;
    v.aim.visible = false;
    v.aura.visible = false;
    v.dizzyGroup.visible = v.bellyTarget.visible = false;
    v.slamRing.visible = false;
    if (v.glbRoot) { for (const m of v.mats) { m.transparent = true; m.needsUpdate = true; } }
    else if (v.mat) { v.mat.transparent = true; v.mat.needsUpdate = true; }
    setBossAnim(v, 'Death', 0.15);
  }

  function drawBossBar(v, hp, maxHp, phase) {
    const x = v.ctx;
    x.clearRect(0, 0, 96, 26);
    x.fillStyle = 'rgba(32,36,42,0.55)';
    x.fillRect(0, 0, 96, 26);
    x.fillStyle = '#' + (phase >= 3 ? 'B3273C' : C.red);
    x.fillRect(3, 8, 90 * Math.max(0, hp / maxHp), 12);
    if (phase >= 2) { x.fillStyle = '#' + C.yellow; x.fillRect(3, 3, 90, 3); }
    v.tex.needsUpdate = true;
  }

  function removeBossView() {
    stopBossSound();
    if (!bossView) return;
    const v = bossView;
    scene.remove(v.g);
    scene.remove(v.aim);
    v.aim.geometry.dispose();
    v.aim.material.dispose();
    if (v.mixer) { v.mixer.stopAllAction(); v.mixer.uncacheRoot(v.glbRoot); }
    if (v.glbRoot) {
      v.glbRoot.traverse(o => {
        if (o.isMesh || o.isSkinnedMesh) {
          if (o.geometry) o.geometry.dispose();
          if (o.skeleton && o.skeleton.dispose) o.skeleton.dispose();
        }
      });
      for (const m of v.mats) m.dispose();
    } else {
      if (!v.model) v.body.geometry.dispose();
      if (v.mat) v.mat.dispose();
    }
    disposeTree(v.dizzyGroup);
    disposeTree(v.bellyTarget);
    v.slamRing.geometry.dispose();
    v.slamRing.material.dispose();
    v.aura.geometry.dispose();
    v.aura.material.dispose();
    v.bar.material.dispose();
    v.tex.dispose();
    bossView = null;
  }

  // Fixed-capacity GPU pools. No geometry, material, vector or particle allocation on shot/update.
  const tracers = [], rings = [];
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const beamSpec = [{ radius: 0.016, life: 0.09, color: 0xc5ffff }, { radius: 0.024, life: 0.11, color: 0xffd66e }, { radius: 0.028, life: 0.24, color: 0x79d9ff }];
  const beamPool = Array.from({ length: 48 }, () => {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const core = new THREE.Mesh(beamGeo, mat), halo = new THREE.Mesh(beamGeo, mat.clone());
    core.name = 'pooled-tracer-core'; halo.name = 'pooled-tracer-halo'; core.visible = halo.visible = false; scene.add(core, halo);
    return { core, halo, start: new THREE.Vector3(), end: new THREE.Vector3(), t: 0, life: 0, radius: 0, weapon: 0, active: false };
  });
  const debrisGeo = new THREE.TetrahedronGeometry(1), paperDebrisGeo = foldedFacet(1.7, 1.2, 0.2), starDebrisGeo = starGeometry(1, 0.2, 4);
  const debris = Array.from({ length: 180 }, () => {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(debrisGeo, mat); m.visible = false; m.name = 'pooled-ink-debris'; scene.add(m);
    return { m, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, t: 0, life: 0, size: 0, kind: '' };
  });
  let debrisCursor = 0;
  const fxPoint = new THREE.Vector3(), fxDirection = new THREE.Vector3(), beamAxis = new THREE.Vector3(0, 1, 0);
  const eraseRingGeo = new THREE.RingGeometry(0.88, 1, 64);
  let fxTime = 0;
  let muzzleT = 0, shake = 0, stride = 0, smoothSway = 0;
  function bossShake(amount) {
    if (bossView) shake = Math.max(shake, amount * Math.max(0, 1 - camera.position.distanceTo(bossView.g.position) / 24));
  }
  function addTracer(end, weapon = displayWeapon) {
    if (!end) return;
    let b; for (const slot of beamPool) if (!slot.active) { b = slot; break; } if (!b) return;
    const spec = beamSpec[weapon] || beamSpec[0];
    camera.updateMatrixWorld(true); gunViews[weapon].muzzle.getWorldPosition(b.start); b.end.set(end.x, end.y, end.z);
    fxDirection.subVectors(b.end, b.start); const length = fxDirection.length(); if (length < 0.001) return;
    fxDirection.multiplyScalar(1 / length);
    b.core.position.copy(b.start).addScaledVector(fxDirection, length / 2); b.core.quaternion.setFromUnitVectors(beamAxis, fxDirection);
    b.core.scale.set(weapon === 2 ? 0.012 : spec.radius, length, weapon === 2 ? 0.012 : spec.radius);
    b.core.material.color.setHex(spec.color); b.core.material.opacity = 0.95; b.core.visible = true;
    b.halo.position.copy(b.core.position); b.halo.quaternion.copy(b.core.quaternion); b.halo.scale.set(spec.radius, length, spec.radius);
    b.halo.material.color.setHex(0xeaffff); b.halo.material.opacity = 0.32; b.halo.visible = weapon === 2;
    b.active = true; b.weapon = weapon; b.t = b.life = spec.life; b.radius = spec.radius; tracers.push(b);
  }
  function emitDebris(point, count, hex, kind = 'hit', size = 1) {
    if (!point) return;
    if (reducedMotion()) count = kind === 'shot' || kind === 'trail' || kind === 'crumb' ? 0 : Math.min(2, count);
    const color = typeof hex === 'number' ? hex : parseInt(hex, 16);
    for (let i = 0; i < count; i++) {
      const p = debris[debrisCursor]; debrisCursor = (debrisCursor + 1) % debris.length;
      const flat = kind === 'armor' || kind === 'kill' && i % 3 === 0;
      p.kind = kind; p.m.geometry = kind === 'shot' ? starDebrisGeo : flat ? paperDebrisGeo : debrisGeo;
      p.m.material.blending = kind === 'shot' ? THREE.AdditiveBlending : THREE.NormalBlending;
      p.m.material.color.setHex(kind === 'armor' || kind === 'crumb' ? color : kind === 'dash' ? (i % 3 === 0 ? 0xdff7f2 : color) : kind === 'trail' ? (debrisCursor % 2 ? color : 0x20242a) : i % 3 === 0 ? 0xfffae8 : color); p.m.material.opacity = 1;
      p.m.position.copy(point); p.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      p.size = (kind === 'shot' ? 0.025 : kind === 'crumb' || kind === 'trail' ? 0.024 : kind === 'dash' ? 0.14 + Math.random() * 0.07 : 0.035 + Math.random() * 0.028) * size;
      p.life = p.t = kind === 'shot' ? 0.14 : kind === 'trail' ? 0.26 : kind === 'dash' ? 0.6 : 0.32 + Math.random() * 0.26;
      const speed = kind === 'crumb' || kind === 'trail' ? 0.35 : kind === 'dash' ? 1.5 + Math.random() * 1.2 : 4.5 + Math.random() * 3;
      p.vx = (Math.random() - 0.5) * speed * 2; p.vy = 0.8 + Math.random() * speed; p.vz = (Math.random() - 0.5) * speed * 2;
      if (kind === 'dash') {
        const a = i / count * Math.PI * 2;
        p.m.position.x += Math.cos(a) * 0.32; p.m.position.z += Math.sin(a) * 0.32;
        p.vx = Math.cos(a) * (1.5 + Math.random()); p.vz = Math.sin(a) * (1.5 + Math.random());
        p.vy = 1.5 + Math.random() * 1.2;
      }
      if (kind === 'shot') { fxDirection.set(-0.8 - Math.random(), 0.8 + Math.random(), 0.1).applyQuaternion(camera.quaternion); p.vx = fxDirection.x; p.vy = fxDirection.y; p.vz = fxDirection.z; }
      p.sx = (Math.random() - 0.5) * 16; p.sy = (Math.random() - 0.5) * 16; p.sz = (Math.random() - 0.5) * 16;
      p.m.scale.setScalar(p.size); p.m.visible = true;
    }
  }
  function addPuff(point, hex, size = 1) { emitDebris(point, 8, hex, 'hit', size * 0.65); }
  function updateVisualPools(dt) {
    for (let i = tracers.length - 1; i >= 0; i--) {
      const b = tracers[i]; b.t -= dt;
      const k = Math.sqrt(Math.max(0, b.t / b.life)); b.core.material.opacity = k * 0.95; b.halo.material.opacity = k * 0.32;
      if (b.t <= 0) { b.core.visible = b.halo.visible = b.active = false; tracers[i] = tracers[tracers.length - 1]; tracers.pop(); }
    }
    const motion = reducedMotion() ? 0 : 1;
    for (const p of debris) {
      if (p.t <= 0) continue;
      const h = Math.min(dt, p.t) * motion; p.t -= dt;
      p.m.position.x += p.vx * h; p.m.position.y += p.vy * h - 7 * h * h; p.m.position.z += p.vz * h; p.vy -= 14 * h;
      p.m.rotation.x += p.sx * h; p.m.rotation.y += p.sy * h; p.m.rotation.z += p.sz * h;
      const k = Math.max(0, p.t / p.life); p.m.material.opacity = k; p.m.scale.setScalar(p.size * (0.45 + k * 0.55));
      if (p.t <= 0) { p.t = 0; p.m.visible = false; }
    }
  }
  function addBurstRing(x, z, hex, maxR, life = 0.5, peak = 0.85) {
    const m = new THREE.Mesh(eraseRingGeo, lam(hex, { transparent: true, opacity: peak, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.06, z);
    scene.add(m);
    rings.push({ m, t: life, life, max: maxR, peak });
  }
  function addEraseRing(x, z) {
    addBurstRing(x, z, C.teal, CONFIG.ink.eraseRadius, 0.45, 0.85);
  }

  function onEvent(ev) {
    if (disposed) return;
    if (ev.type === 'shot') {
      const wp = ev.data.weapon ?? displayWeapon, v = gunViews[wp], spec = recoilSpec[wp];
      if (ev.data.ends) { for (const end of ev.data.ends) addTracer(end, wp); } else addTracer(ev.data.end, wp);
      v.shotAge = 0; for (const ring of v.chargeRings) { ring.material.emissiveIntensity = 0; ring.material.color.setHex(0x293f49); }
      for (const k in spring) { spring[k] = Math.min(spring[k] + spec[k], spec[k] * 1.7); springV[k] = 0; }
      muzzleT = 0.055; shake = Math.max(shake, spec.shake);
      camera.updateMatrixWorld(true); v.muzzle.getWorldPosition(fxPoint); emitDebris(fxPoint, wp === 1 ? 3 : 2, wp === 1 ? 0xffd963 : 0xd4ffff, 'shot');
    }
    else if (ev.type === 'playerHit') { if (ev.data.id === 0) shake = Math.max(shake, 0.012); }
    else if (ev.type === 'dash') {
      if (!reducedMotion()) {
        spring.fov = Math.min(12, spring.fov + 6); springV.fov = 0;
        fxPoint.set(ev.data.x, 0.08, ev.data.z);
        emitDebris(fxPoint, 6, C.teal, 'dash', 1);
      }
    }
    else if (ev.type === 'hit') {
      const crit = ev.data.crit || ev.data.critKind;
      emitDebris(ev.data.point, crit ? 14 : 8, crit ? 0xffd15a : ev.data.armored ? C.teal : C.ink, 'hit');
      const hitView = !ev.data.boss && enemyViews.get(ev.data.id);
      if (hitView) { hitView.flash = 0.10; hitView.hitAge = 0; hitView.hitKick = 1; }
      if (ev.data.boss && bossView) {
        bossView.flash = 0.12;
        const v = bossView;
        if (v.glbDone && !v.dying && v.laughT <= 0 && v.atkT <= 0 && v.hitCd <= 0) {
          v.hitT = v.hitDur;
          v.hitCd = 0.45;
        }
      }
    }
    else if (ev.type === 'impact') {
      emitDebris(ev.data.point, 5, ev.data.enemy ? C.red : C.ink, 'impact');
      addSplat(ev.data.point, ev.data.kind, ev.data.wallId, ev.data.enemy);
      if (ev.data.wallId !== null && ev.data.wallId !== undefined) {
        const v = wallViews.get(ev.data.wallId);
        if (v) v.flash = 0.12;
      }
    } else if (ev.type === 'armorStrip') {
      const v = enemyViews.get(ev.data.id);
      if (v) { fxPoint.copy(v.g.position); fxPoint.y += 0.8; emitDebris(fxPoint, 8, C.teal, 'armor', 1.8); }
    } else if (ev.type === 'erase') {
      addEraseRing(ev.data.x, ev.data.z);
    } else if (ev.type === 'fold') {
      addPuff({ x: ev.data.x, y: 1.1, z: ev.data.z }, C.teal, 2.0);
    } else if (ev.type === 'bite') {
      const v = enemyViews.get(ev.data.id);
      if (v?.type === 'eraser') { v.biteAge = 0; v.biteX = v.biteZ = null; }
    } else if (ev.type === 'wallBite') {
      let biter = null, nearest = 1.5;
      for (const v of enemyViews.values()) if (v.type === 'eraser' && v.deadT < 0) {
        const d = Math.hypot(v.g.position.x - ev.data.x, v.g.position.z - ev.data.z);
        if (d < nearest) { nearest = d; biter = v; }
      }
      if (biter) { biter.biteAge = 0; biter.biteX = ev.data.x; biter.biteZ = ev.data.z; }
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
      if (v) { v.deadT = 0; fxPoint.copy(v.g.position); fxPoint.y += 0.5; emitDebris(fxPoint, 18, C.ink, 'kill', 1.6); }
    } else if (ev.type === 'wallBreak' || ev.type === 'wallRemove' || ev.type === 'wallExpire') {
      clearWallSplats(ev.data.id);
      const v = wallViews.get(ev.data.id);
      if (v) {
        addPuff({ x: v.m.position.x, y: 0.8, z: v.m.position.z }, ev.type === 'wallBreak' ? C.red : C.teal, 2.2);
        scene.remove(v.m); disposeTree(v.m);
        wallViews.delete(ev.data.id);
      }
    } else if (ev.type === 'rage') {
      bossShake(0.014);
      if (bossView) addPuff({ x: bossView.g.position.x, y: 1.3, z: bossView.g.position.z }, C.red, 3.2);
      triggerBossLaugh();
    } else if (ev.type === 'bossPhase') {
      bossShake(0.02);
      if (bossView) {
        bossView.flash = 0.22;
        addPuff({ x: bossView.g.position.x, y: 1.6, z: bossView.g.position.z }, C.red, 3.6);
      }
    } else if (ev.type === 'waveBurst') {
      bossShake(0.012);
      addBurstRing(ev.data.x, ev.data.z, C.yellow, 5.5, 0.4, 0.6);
    } else if (ev.type === 'mortarBoom') {
      bossShake(0.03);
      emitDebris({ x: ev.data.x, y: 0.4, z: ev.data.z }, 16, '8F1F2A', 'kill', 1.8);
      addBurstRing(ev.data.x, ev.data.z, C.red, ev.data.r + 1.6, 0.5, 0.8);
    } else if (ev.type === 'bossSlam') {
      bossShake(0.026);
      emitDebris({ x: ev.data.x, y: 0.7, z: ev.data.z }, 12, C.yellow, 'impact', 1.6);
      addBurstRing(ev.data.x, ev.data.z, C.yellow, ev.data.radius, 0.55, 0.85);
    } else if (ev.type === 'bossAttack') {
      bossShake(ev.data.attack === 'charge' ? 0.018 : 0.01);
      if (bossView && ev.data.attack === 'fan') addPuff({ x: bossView.g.position.x, y: 1.4, z: bossView.g.position.z }, C.ink, 2.0);
      if (bossView && ev.data.attack === 'summon') addPuff({ x: bossView.g.position.x, y: 0.6, z: bossView.g.position.z }, C.yellow, 2.6);
      const v = bossView;
      if (v && !v.dying) {
        const attack = ev.data.attack;
        if (attack === 'summon' || (attack === 'fan' && soundNow() - soundLast >= laughCooldown)) triggerBossLaugh();
        else if (attack === 'fan' || attack === 'charge') {
          // A real attack event may replace a laugh; ordinary snapshots/hits may not.
          stopBossSound();
          v.laughT = v.hitT = 0;
          v.atkT = v.atkDur;
          setBossAnim(v, 'Attack', 0.15, true);
        }
      }
    } else if (ev.type === 'bossStun' || ev.type === 'bossInterrupt') {
      stopBossSound();
      bossShake(0.022);
      const v = bossView;
      if (v && !v.dying) {
        v.laughT = v.atkT = 0;
        v.hitT = ev.data.duration;
        v.stunned = true;
        setBossAnim(v, 'Hit', 0.08, true);
      }
    } else if (ev.type === 'bossDown') {
      stopBossSound();
      if (bossView) {
        addPuff({ x: bossView.g.position.x, y: 1.2, z: bossView.g.position.z }, C.red, 3.4);
        startBossDeath(bossView);
      }
    }
  }

  // 隐藏浏览器面板可能报 0×0；用固定回退尺寸避免除零/NaN 投影
  function viewSize() {
    return {
      w: canvas.clientWidth || window.innerWidth || 1280,
      h: canvas.clientHeight || window.innerHeight || 720,
    };
  }
  function resize() {
    const { w, h } = viewSize();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function update(snap, dt) {
    if (disposed) return;
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    fxTime += dt;
    const me = snap.players[0];
    stepSpring(dt);
    if (me) {
      // 倒地/阵亡视角贴地；倒地时收起枪
      const eyeY = me.st === 0 ? me.y : me.y - 1.05;
      camera.position.set(me.x, eyeY, me.z);
      shake *= Math.exp(-11 * dt);
      if (shake < 0.0004) shake = 0;
      const motion = reducedMotion() ? 0 : 1;
      // 权威水平速度驱动 sway：无 tick 帧不再闪回中心，站立时 0 抖动。
      const spd = Math.hypot(me.vx || 0, me.vz || 0);
      stride += spd * dt * 2.2;
      const targetSway = Math.min(1, spd / CONFIG.player.walkSpeed) * motion;
      smoothSway += (targetSway - smoothSway) * (1 - Math.exp(-10 * dt));
      const sway = smoothSway;
      const wp = me.wp || 0, w = CONFIG.player.weapons[wp];
      if (wp !== targetWeapon) { targetWeapon = wp; switchT = 0.18; }
      switchT = Math.max(0, switchT - dt);
      if (switchT <= 0.09 && displayWeapon !== targetWeapon) {
        gunViews[displayWeapon].g.visible = false;
        muzzle.visible = false;
        displayWeapon = targetWeapon;
        gunViews[displayWeapon].g.visible = true;
        muzzle = gunViews[displayWeapon].muzzle;
        muzzleT = 0;
      }
      const switchDip = Math.sin(Math.PI * switchT / 0.18) * motion;
      const reloadDip = me.rl > 0 ? Math.sin(Math.PI * (1 - me.rl / (w.reloadTime * perkMods({ perks: me.pk || [] }).reloadMul))) : 0;
      const scoped = !!me.ads && wp === 2 && me.st === 0 && me.rl <= 0;
      const fov = (scoped ? w.scopeFov : baseFov) + spring.fov * motion;
      camera.fov += (fov - camera.fov) * (reducedMotion() ? 1 : 1 - Math.exp(-18 * dt));
      camera.updateProjectionMatrix();
      camera.rotation.y = me.yaw + Math.sin(fxTime * 38) * shake * motion;
      camera.rotation.x = me.pitch + (spring.pitch * 0.28 + Math.sin(fxTime * 31) * shake) * motion;
      camera.rotation.z = (spring.roll * 0.16 + Math.sin(fxTime * 27) * shake * 0.35) * motion;
      gun.position.set(0.27 + Math.sin(stride) * 0.0085 * sway, -0.22 + Math.sin(stride * 2) * 0.0045 * sway - reloadDip * 0.13 * motion - switchDip * 0.28,
        -0.64 + spring.setback * motion);
      gun.rotation.z = -reloadDip * 0.65 * motion - switchDip * 0.25 + spring.roll * motion;
      gun.rotation.x = 0.035 + reloadDip * 0.24 * motion + switchDip * 0.35 + spring.pitch * motion;
      gun.rotation.y = 0.14;
      updateWeapons(me, dt, motion);
      muzzleT = Math.max(0, muzzleT - dt);
      muzzle.visible = muzzleT > 0 && !!motion && !scoped;
      for (const m of muzzle.children) m.material.opacity = Math.min(1, muzzleT / 0.055);
      muzzle.rotation.z = fxTime * 17;
      gun.visible = me.st === 0 && !scoped;
    }

    const seen = new Set();
    for (const e of snap.enemies) {
      seen.add(e.id);
      let v = enemyViews.get(e.id);
      if (!v) { v = makeEnemyView(e); enemyViews.set(e.id, v); }
      if (v.deadT >= 0) continue;
      upgradeEnemy(v, e.type);
      v.age += dt;
      v.g.position.set(e.x, e.y, e.z);
      v.g.scale.setScalar(Math.min(1, 0.2 + 0.8 * v.age / CONFIG.enemy.spawnAnimTime));
      if (e.hp !== v.lastHp || e.armor !== v.lastArmor) {
        if ((v.lastHp >= 0 && e.hp < v.lastHp) || (v.lastArmor >= 0 && e.armor < v.lastArmor)) { v.flash = 0.1; v.hitAge = 0; v.hitKick = 1; }
        drawBar(v, e.hp, v.maxHp, e.armor, v.maxArmor);
        v.lastHp = e.hp; v.lastArmor = e.armor;
      }
      v.flash = Math.max(0, v.flash - dt);
      animateEnemy(v, e, me, dt, reducedMotion() ? 0 : 1);
    }
    for (const [id, v] of enemyViews) {
      if (v.deadT >= 0) {
        v.deadT += dt;
        const k = Math.max(0, 1 - v.deadT / 0.4);
        v.g.scale.set(k, k * k, k);
        v.body.traverse(o => { if (o.material) o.material.opacity = k; });
        v.bar.material.opacity = k;
        if (v.aimLine) v.aimLine.visible = false;
        if (v.shadow) v.shadow.visible = false;
        if (v.target) v.target.visible = false;
        if (v.deadT > 0.4) { disposeEnemyView(v); enemyViews.delete(id); }
      } else if (!seen.has(id)) { disposeEnemyView(v); enemyViews.delete(id); }
    }

    const pseen = new Set();
    for (const p of snap.projectiles) {
      pseen.add(p.id);
      let v = projViews.get(p.id), fresh = false;
      if (!v) {
        for (const slot of projPool) if (!slot.active) { v = slot; break; }
        if (!v) continue;
        v.active = v.g.visible = true; v.id = p.id; v.g.quaternion.identity(); v.tail.scale.z = 1; v.halo.rotation.z = 0;
        v.previous.set(p.x, p.y, p.z); projViews.set(p.id, v); fresh = true;
      }
      updateProjectile(v, p, dt, fresh);
    }
    for (const [id, v] of projViews) if (!pseen.has(id)) { v.active = v.g.visible = false; v.id = null; projViews.delete(id); }
    updateHazards(snap);

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
      v.ring.visible = !p.taken;
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
      v.edge.material.opacity = v.m.material.opacity / 0.82;
      v.m.material.color.set('#' + (v.flash > 0 ? C.red : C.teal));
    }
    for (const [id, v] of wallViews) if (!wseen.has(id)) { clearWallSplats(id); scene.remove(v.m); disposeTree(v.m); wallViews.delete(id); }
    for (let i = splats.length - 1; i >= 0; i--) {
      const s = splats[i]; s.life -= dt;
      if (s.life <= 0 || (s.foldId !== null && foldViews[s.foldId].state !== 'wall')) { removeSplat(i); continue; }
      s.m.material.opacity = 0.84 * Math.min(1, s.life / splatConfig.fadeTime);
    }

    // T7.3：当前导航锚点 = 最近的未激活锚点（与 HUD 箭头同一目标）
    let navAnchor = -1;
    if (me && me.st === 0 && snap.phase === 'anchors') {
      let best = Infinity;
      for (const a of snap.anchors) {
        if (a.active) continue;
        const d = Math.hypot(me.x - ANCHORS[a.i].x, me.z - ANCHORS[a.i].z);
        if (d < best) { best = d; navAnchor = a.i; }
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(fxTime * 3);
    for (const a of snap.anchors) {
      const v = anchorViews[a.i];
      if (!v) continue;
      v.pillar.visible = !anchorsSuppressed && !a.active;
      v.ring.visible = !anchorsSuppressed;
      v.ring.material.color.set('#' + (a.active ? C.teal : C.yellow));
      v.ring.material.opacity = a.active ? 0.8 : 0.35 + 0.45 * a.progress;
      v.glow.visible = !anchorsSuppressed && a.i === navAnchor && !a.active;
      if (v.glow.visible) v.glow.material.opacity = 0.09 + 0.11 * pulse;
    }
    const exitUnlocked = snap.phase !== 'anchors' && !snap.boss;
    exitRing.material.color.set('#' + (exitUnlocked ? C.teal : C.red));
    exitRing.material.opacity = exitUnlocked ? 0.72 : 0.4;
    exitBeam.visible = exitUnlocked;
    if (exitUnlocked) exitBeam.material.opacity = 0.07 + 0.07 * pulse;

    // T7.4：队友化身 / 倒地倒计时牌 / 救援进度环
    const tseen = new Set();
    for (const p of snap.players) {
      if (p.id === 0) continue;
      tseen.add(p.id);
      let v = teammateViews.get(p.id);
      if (!v) { v = makeTeammateView(p); teammateViews.set(p.id, v); }
      const downed = p.st === 1, dead = p.st === 2;
      v.g.position.set(p.x, p.y - CONFIG.player.eyeHeight, p.z);
      v.body.visible = !dead;
      v.body.rotation.x = downed ? Math.PI / 2 - 0.25 : 0;
      v.body.position.y = downed ? 0.36 : 0.89;
      v.mat.opacity = dead ? 0 : downed ? 0.55 : 1;
      v.mat.color.set('#' + (p.iv > 0 ? C.teal : v.markHex));
      if (downed) {
        v.ring.visible = true;
        v.ring.material.opacity = 0.22 + 0.5 * p.rv;
        v.ring.scale.setScalar(1 + 0.06 * pulse);
      } else v.ring.visible = false;
      const base = 'P' + (p.id + 1);
      const text = dead ? base + ' 阵亡'
        : downed ? (p.rv > 0 ? base + ' 救援 ' + Math.round(p.rv * 100) + '%' : base + ' 倒地 ' + p.dt.toFixed(1) + 's')
          : p.iv > 0 ? base + ' 无敌' : base;
      const tone = dead ? C.red : downed ? C.yellow : p.iv > 0 ? C.teal : v.markHex;
      drawTeammateTag(v, text, tone);
    }
    for (const [id, v] of teammateViews) {
      if (!tseen.has(id)) { disposeTeammateView(v); teammateViews.delete(id); }
    }

    if (bossView && bossView.dying) {
      // 死亡：播完 Death（clampWhenFinished 定格）→ 停留约 1.2s → 淡出移除
      const v = bossView;
      v.deathT += dt;
      if (v.mixer) v.mixer.update(dt);
      const fadeStart = v.deathDur + 1.2;
      if (v.deathT > fadeStart) {
        const k = Math.max(0, 1 - (v.deathT - fadeStart) / 0.4);
        setBossOpacity(v, k);
        if (k <= 0) removeBossView();
      }
    } else if (snap.boss) {
      if (!bossView) bossView = makeBossView();
      const v = bossView;
      const b = snap.boss;
      if (b.st > 0 && !v.stunned) {
        stopBossSound();
        v.laughT = v.atkT = 0;
        v.hitT = b.st;
        setBossAnim(v, 'Hit', 0.08, true);
      }
      v.stunned = b.st > 0;
      v.dizzyGroup.visible = v.stunned;
      v.dizzyGroup.rotation.y += reducedMotion() ? 0 : dt * 2.7;
      v.bellyTarget.visible = b.ex > 0 && !v.stunned;
      v.bellyTarget.scale.setScalar(reducedMotion() ? 1 : 1 + Math.sin(fxTime * 7) * 0.10);
      if (me) {
        const dist = Math.hypot(me.x - b.x, me.z - b.z);
        soundDistance = 1 - Math.max(0, Math.min(1, (dist - 6) / 16)) * 0.72;
      }
      updateBossSoundGain();
      v.g.position.set(b.x, 0, b.z);
      v.g.rotation.y = b.fy !== undefined ? b.fy : (me ? Math.atan2(me.x - b.x, me.z - b.z) : 0);
      v.flash = Math.max(0, v.flash - dt);
      const tel = b.state !== 'idle' && !v.stunned;
      if (tel) {
        v.body.scale.set(1.02, 1 - 0.03 * Math.abs(Math.sin(fxTime * 18)), 1.02);
      } else v.body.scale.set(1, 1, 1);
      if (!v.glbRoot && !v.model) v.body.material.color.set('#' + (b.raged ? C.red : C.yellow));
      setBossEmissive(v, v.flash > 0 ? 0xffffff : (b.raged ? 0x330000 : 0x000000));
      v.auraT += dt;
      v.aura.material.opacity = b.raged ? 0.3 + 0.16 * Math.sin(v.auraT * 5) : 0;
      v.aura.scale.setScalar(b.raged ? 1 + 0.05 * Math.sin(v.auraT * 5) : 1);
      v.aim.visible = b.state === 'charge' && !v.stunned;
      if (v.aim.visible) {
        const pa = v.aim.geometry.attributes.position;
        pa.setXYZ(0, b.x, 1.5, b.z);
        pa.setXYZ(1, b.ax, 1.25, b.az);
        pa.needsUpdate = true;
        v.aim.material.opacity = 0.35 + 0.55 * Math.min(1, b.t / CONFIG.boss.chargeTelegraph);
      }
      if (b.hp !== v.lastHp || b.ph !== v.lastRaged) {
        drawBossBar(v, b.hp, b.max || CONFIG.scaling[snap.players.length].bossHp, b.ph || 1);
        v.lastHp = b.hp; v.lastRaged = b.ph;
      }
      // Death > LaughAttack > Attack > Hit > Move > Idle. Only events start attacks;
      // snapshot states are telegraphs, not a second laugh/attack trigger.
      const dx = b.x - (v.px === null ? b.x : v.px);
      const dz = b.z - (v.pz === null ? b.z : v.pz);
      v.speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
      v.px = b.x; v.pz = b.z;
      const st = b.state;
      v.slamRing.visible = st === 'slam' && !v.stunned;
      if (v.slamRing.visible) {
        v.slamRing.material.opacity = 0.3 + 0.45 * Math.min(1, (b.t || 0) / CONFIG.boss.slamTelegraph);
        v.slamRing.scale.setScalar(reducedMotion() ? 1 : 1 + 0.04 * Math.sin(fxTime * 16));
      }
      v.laughT = Math.max(0, v.laughT - dt);
      v.atkT = Math.max(0, v.atkT - dt);
      v.hitT = Math.max(0, v.hitT - dt);
      v.hitCd = Math.max(0, v.hitCd - dt);
      if (v.actions && v.actions.Move) v.actions.Move.timeScale = (b.raged || st === 'charging') ? 1.35 : 1.0;
      const want = v.stunned ? 'Hit' : v.laughT > 0 ? 'LaughAttack' : v.atkT > 0 ? 'Attack' : v.hitT > 0 ? 'Hit' : v.speed > 0.15 ? 'Move' : 'Idle';
      setBossAnim(v, want, 0.15);
      if (v.mixer) v.mixer.update(dt);
    } else if (bossView) {
      removeBossView();
    }

    updateVisualPools(dt);
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.t -= dt;
      const k = Math.max(0, r.t / r.life);
      r.m.scale.setScalar(1 + (1 - k) * (r.max - 1));
      r.m.material.opacity = r.peak * k;
      if (r.t <= 0) { scene.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); }
    }

    for (const c of cloudViews) {
      c.g.position.x = c.baseX + Math.sin(fxTime * c.speed + c.phase) * 3.2;
      c.g.position.z = c.baseZ + Math.cos(fxTime * c.speed * 0.8 + c.phase) * 1.6;
      c.g.rotation.y = Math.sin(fxTime * 0.05 + c.phase) * 0.25;
    }

    // 阶段 3：天空/雾气平滑切为压迫感暗绯纸雾；Boss 死亡或重开恢复
    skyTint.setHex(snap.boss && snap.boss.ph >= 3 ? 0xD8C4C4 : 0xDDE9EE);
    scene.background.lerp(skyTint, reducedMotion() ? 1 : 1 - Math.exp(-2.2 * dt));
    scene.fog.color.copy(scene.background);

    // Three light layers are camera-filtered, not mesh-filtered. Two passes truly isolate
    // the warm/cyan studio rig and keep close viewmodels from clipping into world walls.
    camera.layers.set(0); renderer.autoClear = true; renderer.render(scene, camera);
    if (gun.visible) {
      const background = scene.background;
      scene.background = null; camera.layers.set(1); renderer.autoClear = false;
      renderer.clearDepth?.(); renderer.render(scene, camera);
      scene.background = background; renderer.autoClear = true;
    }
    camera.layers.enable(0); camera.layers.enable(1);
  }

  // 再来一局：清空全部动态视图，静态场景保留（下一帧快照重建锚点/出口状态）
  function reset() {
    for (const [, v] of enemyViews) disposeEnemyView(v);
    enemyViews.clear();
    for (const v of projPool) { v.active = v.g.visible = false; v.id = null; v.previous.set(0, 0, 0); }
    projViews.clear();
    for (const [, v] of wallViews) { scene.remove(v.m); disposeTree(v.m); }
    wallViews.clear();
    for (const [, v] of hazardViews) { scene.remove(v.g); v.g.traverse(o => { if (o.material) o.material.dispose(); }); }
    hazardViews.clear();
    scene.background.setHex(0xDDE9EE);
    scene.fog.color.setHex(0xDDE9EE);
    for (const b of beamPool) { b.active = b.core.visible = b.halo.visible = false; b.t = 0; }
    tracers.length = 0;
    for (const p of debris) { p.t = 0; p.m.visible = false; p.vx = p.vy = p.vz = p.sx = p.sy = p.sz = 0; }
    debrisCursor = 0;
    for (const r of rings) { scene.remove(r.m); r.m.material.dispose(); }
    rings.length = 0;
    for (const v of foldViews) { v.state = 'ramp'; v.fromAngle = CONFIG.folds.rampAngle; v.angle = CONFIG.folds.rampAngle; v.flash = 0; v.pivot.rotation.x = CONFIG.folds.rampAngle; }
    for (const [id, v] of teammateViews) { disposeTeammateView(v); teammateViews.delete(id); }
    for (const v of anchorViews) v.glow.visible = false;
    exitBeam.visible = false;
    removeBossView();
    setDrawStart(null);
    muzzleT = shake = stride = smoothSway = fxTime = 0;
    for (const k in spring) spring[k] = springV[k] = 0;
    displayWeapon = targetWeapon = 0; switchT = 0;
    for (let i = 0; i < gunViews.length; i++) { const v = gunViews[i]; v.g.visible = i === 0; v.muzzle.visible = false; v.shotAge = 10; v.ammo = CONFIG.player.weapons[i].magazine; v.reload = 0; }
    gun.position.set(0.27, -0.22, -0.64); gun.rotation.set(0.035, 0.14, 0); gun.visible = true;
    updateWeapons({ wp: 0, rl: 0, ammo: CONFIG.player.weapons[0].magazine }, 0, 0);
    muzzle = gunViews[0].muzzle;
    camera.fov = baseFov; camera.updateProjectionMatrix();
    for (let i = splats.length - 1; i >= 0; i--) removeSplat(i);
  }

  // 世界坐标 → 屏幕像素（HUD 边缘箭头用）；behind 时镜像到正确方向
  const projectedPoint = new THREE.Vector3();
  function project(x, y, z, out = {}) {
    const v = projectedPoint.set(x, y, z).project(camera);
    const w = canvas.clientWidth || window.innerWidth || 1280;
    const h = canvas.clientHeight || window.innerHeight || 720;
    const behind = v.z > 1;
    let sx = (v.x * 0.5 + 0.5) * w;
    let sy = (-v.y * 0.5 + 0.5) * h;
    if (behind) { sx = w - sx; sy = h - sy; }
    const onScreen = !behind && sx > 40 && sx < w - 40 && sy > 40 && sy < h - 40;
    out.x = sx; out.y = sy; out.onScreen = onScreen; out.behind = behind; out.w = w; out.h = h;
    return out;
  }

  // 验收读数：世界内队友化身状态（T7.4）
  function teammates() {
    return [...teammateViews.values()].map(v => ({
      id: v.id, text: v.text, tone: v.tone,
      x: +v.g.position.x.toFixed(2), z: +v.g.position.z.toFixed(2),
      bodyVisible: v.body.visible, ringVisible: v.ring.visible,
      ringOpacity: +v.ring.material.opacity.toFixed(2),
    }));
  }

  // M5 验收读数：Boss 模型/动画状态机实时状态（window.__CLIENT_DEBUG__.renderer.bossDebug()）
  function bossDebug() {
    const v = bossView;
    if (!v) return { present: false, glbLoaded: !!bossGLBBuf, glbFailed: bossGLBFailed, audio: bossAudioDebug() };
    const acts = {};
    if (v.actions) {
      for (const k of Object.keys(v.actions)) {
        const a = v.actions[k];
        acts[k] = a ? {
          running: a.isRunning(), time: +a.time.toFixed(3), loop: a.loop, clamp: a.clampWhenFinished,
          weight: +a.getEffectiveWeight().toFixed(2), timeScale: +a.timeScale.toFixed(2),
        } : null;
      }
    }
    let minY = null;
    if (v.glbRoot) {
      const box = new THREE.Box3().setFromObject(v.glbRoot);
      minY = +box.min.y.toFixed(3);
    }
    return {
      present: true, glb: !!v.glbRoot, glbPending: v.glbPending, glbFailed: bossGLBFailed,
      model: v.model, dying: v.dying, cur: v.cur, audio: bossAudioDebug(),
      laughT: +v.laughT.toFixed(3), laughDur: v.laughDur,
      laughCooldown: Math.max(0, laughCooldown - (soundNow() - v.laughAt)),
      speed: +v.speed.toFixed(3), atkT: +v.atkT.toFixed(2), hitT: +v.hitT.toFixed(2), hitCd: +v.hitCd.toFixed(2),
      deathT: +v.deathT.toFixed(2), deathDur: +v.deathDur.toFixed(3), flash: +v.flash.toFixed(2),
      mats: v.mats.length, barY: v.bar.position.y, barVisible: v.bar.visible,
      auraOpacity: +v.aura.material.opacity.toFixed(2),
      dizzy: v.dizzyGroup.visible, dizzyAngle: v.dizzyGroup.rotation.y, belly: v.bellyTarget.visible,
      pos: { x: +v.g.position.x.toFixed(2), z: +v.g.position.z.toFixed(2) },
      rotY: +v.g.rotation.y.toFixed(3), modelMinY: minY,
      clips: v.clips ? Object.keys(v.clips) : [], actions: acts,
    };
  }

  function modelDebug() {
    return { loaded: [...paperModels.keys()],
      enemies: [...enemyViews.entries()].map(([id, v]) => ({ id, model: v.body.userData.paperModel || 'crane', white: v.base.material.color.getHexString() })),
      folds: foldViews.map(v => v.model), pickups: [...pickupViews.values()].map(v => v.model),
      muzzle: muzzle.visible, gun: { x: gun.position.x, y: gun.position.y, tilt: gun.rotation.z, visible: gun.visible },
      weapon: displayWeapon, switching: switchT, fov: camera.fov, baseFov, tracers: tracers.length, reducedMotion: reducedMotion() };
  }
  // Snapshot diagnostics only: allocations here never occur in the frame/shot paths.
  function overhaulDebug() {
    camera.updateMatrixWorld(true);
    const pose = m => ({ name: m.name, geometry: m.geometry?.type, material: m.material?.type, layer: m.layers.mask,
      position: m.position.toArray(), rotation: [m.rotation.x, m.rotation.y, m.rotation.z], scale: m.scale.toArray(), visible: m.visible });
    return {
      weapons: gunViews.map((v, i) => ({ name: v.g.name, partCount: Object.keys(v.parts).length, parts: Object.values(v.parts).map(pose),
        hands: Object.fromEntries(['right', 'left'].map(side => { const h = v.hands[side]; return [side, { mode: h.mode,
          position: h.g.position.toArray(), contact: h.g.position.toArray(), target: h.target.toArray(), wrist: h.start.toArray(), end: h.end.toArray() }]; })),
        ammo: v.ammo, fill: v.fill, inkScale: v.ink?.scale.toArray(), inkEmissive: v.glow.emissive.getHexString(), reload: v.reload, shotAge: v.shotAge,
        pump: v.pumpPhase, bolt: v.boltPhase, boltLift: v.bolt?.rotation.z || 0, rings: v.chargeRings.map(m => m.material.emissiveIntensity),
        muzzle: v.muzzle.getWorldPosition(new THREE.Vector3()).toArray(), muzzleLayers: v.muzzle.children.length, spec: { ...recoilSpec[i] } })),
      lights: [weaponKey, weaponRim].map(m => ({ name: m.name, color: m.color.getHexString(), layer: m.layers.mask, intensity: m.intensity })),
      spring: { ...spring }, springVelocity: { ...springV }, shake, sway: smoothSway, stride,
      hazards: [...hazardViews.entries()].map(([id, v]) => ({ id, kind: v.g.name, x: v.g.position.x, z: v.g.position.z,
        parts: v.g.children.map(c => ({ name: c.name, visible: c.visible, opacity: +c.material.opacity.toFixed(3), scale: +c.scale.x.toFixed(3) })) })),
      beams: tracers.map(b => ({ weapon: b.weapon, radius: b.radius, life: b.life, remaining: b.t, origin: b.start.toArray(), end: b.end.toArray(),
        coreRadius: b.core.scale.x, halo: b.halo.visible, geometry: b.core.geometry.type })),
      pool: { capacity: debris.length, active: debris.filter(p => p.t > 0).length, beamCapacity: beamPool.length, projectileCapacity: projPool.length, gravity: -14,
        particles: debris.filter(p => p.t > 0).map(p => ({ kind: p.kind, position: p.m.position.toArray(), velocity: [p.vx, p.vy, p.vz], spin: [p.sx, p.sy, p.sz],
          rotation: [p.m.rotation.x, p.m.rotation.y, p.m.rotation.z], remaining: p.t, life: p.life, geometry: p.m.geometry.type, color: p.m.material.color.getHexString() })) },
      enemies: [...enemyViews.entries()].map(([id, v]) => { const parts = []; v.body.traverse(m => { if (m.isMesh) parts.push(pose(m)); });
        return { id, type: v.type, parts, model: !!v.model, hitKick: v.hitKick, flash: v.flash, biteAge: v.biteAge, body: pose(v.body), bank: v.bank,
          wings: v.wings.map(w => ({ shoulder: w.shoulder.rotation.z, elbow: w.elbow.rotation.z })),
          legs: v.legs.map(l => ({ hip: l.hip.rotation.x, knee: l.knee.rotation.x })), jaws: v.jaws.map(j => j.rotation.y),
          shieldLights: v.shields.filter(s => s.visible).length, emissives: v.mats.map(m => m.mat.emissive.getHexString()),
          target: v.target ? { ...pose(v.target), laser: v.aimLine.visible } : null }; }),
      projectiles: [...projViews.values()].map(v => ({ id: v.id, layers: v.g.children.map(pose), quaternion: v.g.quaternion.toArray() })),
    };
  }
  function dispose() {
    if (disposed) return;
    reset(); disposed = true;
    const geos = new Set([debrisGeo, paperDebrisGeo, starDebrisGeo, beamGeo, flashGeo, eraseRingGeo, splatGeo, ...paperModels.values()]);
    const mats = new Set(gunViews.map(v => v.glow)), textures = new Set([brushedMap]);
    scene.traverse(o => { if (o.geometry) geos.add(o.geometry); if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m => mats.add(m)); else mats.add(o.material); } });
    for (const g of geos) g.dispose();
    for (const m of mats) { for (const value of Object.values(m)) if (value?.isTexture) textures.add(value); m.dispose(); }
    for (const t of textures) t.dispose();
    window.removeEventListener?.('resize', resize);
    for (const name of ['pointerdown', 'click', 'keydown']) window.removeEventListener?.(name, unlockBossSound, true);
    scene.clear(); renderer.dispose?.();
  }
  function setAnchorsHidden(on) {
    anchorsSuppressed = !!on;
    for (const v of anchorViews) {
      v.pillar.visible = !anchorsSuppressed;
      v.ring.visible = !anchorsSuppressed;
      v.glow.visible = false;
    }
  }
  return { update, onEvent, resize, reset, dispose, setBaseFov, setDrawStart, setDrawPreview, project, teammates, bossDebug, triggerBossLaugh, setBossSoundMuted, setBossLaughVolume, bossAudioDebug, setAnchorsHidden,
    splatCount: () => splats.length, splatsOnWall: id => splats.filter(s => s.wallId === id).length, modelDebug, overhaulDebug, scene, camera };
}