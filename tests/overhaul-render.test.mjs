import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import CONFIG from '../shared/config.mjs';
import * as world from '../shared/world.mjs';
import { perkMods } from '../shared/perks.mjs';

// Real renderer, real Three geometry/transforms, and real legacy JSON; only DOM/GPU are stubbed.
const source = readFileSync(new URL('../client/render.mjs', import.meta.url), 'utf8');
const renderScript = new vm.Script(source.replace(/^import .*;\r?\n/gm, '').replace('export function createRenderer', 'function createRenderer'));
const threeScript = new vm.Script(readFileSync(new URL('../src/three/three.min.js', import.meta.url), 'utf8'));
const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const equalArray = (a, b) => { assert.equal(a.length, b.length); a.forEach((n, i) => close(n, b[i])); };
async function harness({ reduced = false, models = true } = {}) {
  const media = { matches: reduced }, texts = [], requests = [];
  const ctx = vm.createContext({ CONFIG, ...world, perkMods, console: { ...console, warn() {} },
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, clearRect() {}, fillText(t) { texts.push(t); }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, strokeRect() {}, setLineDash() {}, closePath() {} }) }) },
    performance: { now: () => 10000 }, setTimeout, clearTimeout,
    location: { search: '' }, localStorage: { getItem: () => null },
    matchMedia: () => media, addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 720,
    fetch(path) {
      requests.push(path);
      const name = path.match(/\/(er|pl|bo|ta|fold)\.json$/)?.[1];
      return Promise.resolve({ ok: models && !!name, json: () => Promise.resolve(JSON.parse(readFileSync(new URL(`../src/models/${name}.json`, import.meta.url), 'utf8'))) });
    },
  });
  ctx.window = ctx; threeScript.runInContext(ctx);
  const T = ctx.THREE;
  let renders = 0, gpuDisposed = 0, depthClears = 0;
  const passes = [];
  T.WebGLRenderer = class { shadowMap = {}; setPixelRatio() {} setSize() {} clearDepth() { depthClears++; }
    render(scene, camera) { renders++; passes.push({ layer: camera.layers.mask, background: !!scene.background, clear: this.autoClear }); }
    dispose() { gpuDisposed++; } };
  ctx.GLTFLoader = class {};
  renderScript.runInContext(ctx);
  const r = ctx.createRenderer({ clientWidth: 1280, clientHeight: 720 });
  await new Promise(resolve => setImmediate(resolve));
  const me = { id: 0, st: 0, x: 1, y: 1.7, z: -10, yaw: 0, pitch: 0, wp: 0, rl: 0, ammo: 18, pk: [] };
  const snap = { players: [me], enemies: [], projectiles: [], folds: [], pickups: [], walls: [], anchors: [], phase: 'anchors', boss: null };
  r.update(snap, 0);
  const update = dt => r.update(snap, dt);
  const event = (type, data = {}) => r.onEvent({ type, data });
  const shot = (wp = me.wp, count = wp === 1 ? 5 : 1) => event('shot', { weapon: wp, ends: Array.from({ length: count }, (_, i) => ({ x: i * 0.2, y: 1.6, z: -18 })) });
  const enemies = () => {
    snap.enemies = ['crane', 'eraser', 'plane'].map((type, id) => ({ id: id + 10, type, x: id * 3 - 3, y: type === 'plane' ? 2 : 0, z: -6,
      hp: type === 'crane' ? CONFIG.enemy.hp : CONFIG.enemy[type].hp, armor: type === 'crane' ? CONFIG.enemy.armor : 0,
      telegraph: 0, stun: 0, state: 'idle' })); update(0.5);
  };
  return { r, T, me, snap, media, texts, requests, update, event, shot, enemies, passes,
    debug: () => r.overhaulDebug(), get renders() { return renders; }, get gpuDisposed() { return gpuDisposed; }, get depthClears() { return depthClears; } };
}

test('overhaul: three substantial named PBR assemblies, varied geometry, decals, brushed metal and isolated key/rim', async () => {
  const h = await harness(), d = h.debug();
  assert.equal(d.weapons.length, 3);
  assert.deepEqual([...d.weapons].map(w => w.partCount), [22, 23, 24]);
  assert.deepEqual(h.passes, [{ layer: 1, background: true, clear: true }, { layer: 2, background: false, clear: false }]);
  assert.equal(h.depthClears, 1); assert.equal(h.r.camera.layers.mask, 3);
  for (const w of d.weapons) {
    assert.ok(w.partCount >= 15 && w.partCount <= 25, `${w.name}: ${w.partCount} parts`);
    assert.equal(new Set(w.parts.map(p => p.name)).size, w.partCount);
    assert.ok(new Set(w.parts.map(p => p.geometry)).size >= 6, w.name);
    assert.ok(w.parts.every(p => p.geometry !== 'BoxGeometry'));
    assert.ok(w.parts.every(p => ['MeshStandardMaterial', 'MeshPhysicalMaterial'].includes(p.material)));
    assert.ok(w.parts.some(p => p.material === 'MeshPhysicalMaterial'));
    assert.ok(w.parts.every(p => p.layer === 2));
    assert.equal(w.muzzleLayers, 3);
  }
  for (const text of ['INK-01', 'MARK-02 // SCATTER', '0.05mm // LINE-03']) assert.ok(h.texts.includes(text));
  assert.equal(d.lights.length, 2); assert.ok(d.lights.every(l => l.layer === 2 && l.intensity > 1));
  assert.notEqual(d.lights[0].color, d.lights[1].color);
  const silver = h.r.scene.getObjectByName('barrel-silver').material;
  assert.ok(silver.metalness >= 0.8 && silver.roughnessMap?.isCanvasTexture);
  assert.equal(h.r.scene.getObjectByName('ported-muzzle').geometry.index.count, 240, 'middle sleeve segments contain real open ports');
});

test('overhaul: close FP receiver, magazine and optics stay framed at 1280x720; world pass alone renders ADS', async () => {
  const h = await harness();
  for (const name of ['deep-blue-receiver', 'slanted-magazine', 'holo-frame', 'heavy-yellow-receiver', 'reservoir-glass', 'silver-receiver', 'scope-tube']) {
    const m = h.r.scene.getObjectByName(name), p = m.getWorldPosition(new h.T.Vector3()).project(h.r.camera);
    assert.ok(p.x > 0 && p.x < 0.92 && p.y > -0.95 && p.y < 0.4, `${name} projects to ${p.x}, ${p.y}`);
  }
  Object.assign(h.me, { wp: 2, ads: true }); const count = h.passes.length; h.update(0.2);
  assert.equal(h.passes.length, count + 1); assert.equal(h.passes.at(-1).layer, 1);
});

test('overhaul: missing model fetches retain articulated enemy fallbacks and do not block presentation', async () => {
  const h = await harness({ models: false }); h.enemies();
  assert.equal(h.debug().enemies.length, 3); assert.ok(h.debug().enemies.every(e => !e.model));
  assert.ok(h.r.scene.getObjectByName('er-loading-core')); assert.ok(h.r.scene.getObjectByName('pl-loading-core'));
  h.update(0.1); assert.ok(h.debug().enemies[1].legs.length === 6);
});

test('overhaul: rifle ink reflects ammo/18, flashes orange below five and reciprocates bolt', async () => {
  const h = await harness(); h.me.ammo = 9; h.update(0);
  close(h.debug().weapons[0].fill, 0.5); close(h.debug().weapons[0].inkScale[2], 0.5);
  h.me.ammo = 4; h.update(0.05); assert.equal(h.debug().weapons[0].inkEmissive, 'ff651b');
  h.update(0.3); assert.equal(h.debug().weapons[0].inkEmissive, '19c8cf');
  h.shot(); h.update(0.03); assert.ok(h.debug().weapons[0].bolt > 0.7);
  h.update(0.15); close(h.debug().weapons[0].bolt, 0);
  h.me.ammo = 0; h.update(0); assert.equal(h.r.scene.getObjectByName('ink-level').visible, false);
});

test('overhaul: rifle reload drops/hides/inserts the slanted magazine and honors perk-scaled durations', async () => {
  const h = await harness(); h.me.pk = ['light_feet'];
  const duration = CONFIG.player.weapons[0].reloadTime * perkMods({ perks: h.me.pk }).reloadMul;
  const mag = h.r.scene.getObjectByName('slanted-magazine');
  h.me.rl = duration * 0.8; h.update(0); assert.ok(mag.position.y < -0.25); assert.ok(mag.visible);
  h.me.rl = duration * 0.5; h.update(0); assert.equal(mag.visible, false); close(h.r.modelDebug().gun.tilt, -0.65);
  h.me.rl = duration * 0.15; h.update(0); assert.equal(mag.visible, true); assert.ok(mag.position.y < -0.15);
  h.me.rl = 0; h.update(0); close(mag.position.y, -0.15); close(mag.rotation.x, 0.24);
});

test('overhaul: marker reservoir tracks ammo/6, pulses and pump moves independently through .14/.21/.40', async () => {
  const h = await harness(); Object.assign(h.me, { wp: 1, ammo: 3 }); h.update(0.2);
  close(h.debug().weapons[1].fill, 0.5); close(h.debug().weapons[1].inkScale[2], 0.5);
  h.shot(); h.update(0.02);
  assert.ok(h.r.scene.getObjectByName('reservoir-ink-level').material.emissiveIntensity > 2);
  h.update(0.11); close(h.debug().weapons[1].pump, 0);
  h.update(0.045); close(h.debug().weapons[1].pump, 0.5);
  h.update(0.035); close(h.debug().weapons[1].pump, 1);
  h.update(0.095); close(h.debug().weapons[1].pump, 0.5);
  h.update(0.095); close(h.debug().weapons[1].pump, 0);
});

test('overhaul: liner rings extinguish immediately then charge rear-to-front over .85 seconds', async () => {
  const h = await harness(); Object.assign(h.me, { wp: 2, ammo: 4 }); h.update(0.2);
  h.shot(); equalArray(h.debug().weapons[2].rings, [0, 0, 0, 0]);
  for (let n = 1; n <= 4; n++) {
    h.update(0.2125);
    equalArray(h.debug().weapons[2].rings, Array.from({ length: 4 }, (_, i) => i < n ? 1.6 : 0));
  }
  const rings = h.debug().weapons[2].parts.filter(p => p.name.startsWith('charge-ring'));
  for (let i = 1; i < 4; i++) assert.ok(rings[i].position[2] < rings[i - 1].position[2]);
});

test('overhaul: liner bolt lifts at .25, reaches lift at .31, pulls/pushes then locks', async () => {
  const h = await harness(); h.shot(2); h.update(0.25); close(h.debug().weapons[2].boltLift, 0);
  h.update(0.06); close(h.debug().weapons[2].boltLift, -0.9); close(h.debug().weapons[2].bolt, 0);
  h.update(0.12); close(h.debug().weapons[2].bolt, 1);
  h.update(0.15); close(h.debug().weapons[2].bolt, 0);
  h.update(0.08); close(h.debug().weapons[2].boltLift, 0);
});

for (const [wp, count, radius, life] of [[0, 1, 0.016, 0.09], [1, 5, 0.024, 0.11], [2, 1, 0.028, 0.24]]) {
  test(`overhaul: weapon ${wp} pooled cylinder beams originate at actual transformed muzzle, with exact radii/lifetime`, async () => {
    const h = await harness(); Object.assign(h.me, { wp, yaw: 0.71, pitch: -0.2 }); h.update(0.2);
    const start = h.debug().weapons[wp].muzzle; h.shot(wp);
    const beams = h.debug().beams;
    assert.equal(beams.length, count); assert.equal(h.r.modelDebug().tracers, count);
    for (const beam of beams) {
      equalArray(beam.origin, start); close(beam.radius, radius); close(beam.life, life);
      assert.equal(beam.geometry, 'CylinderGeometry'); assert.equal(beam.halo, wp === 2);
    }
    const core = h.r.scene.children.find(m => m.name === 'pooled-tracer-core' && m.visible);
    assert.equal(core.geometry.parameters.radialSegments, 6); assert.equal(core.geometry.parameters.openEnded, true);
    assert.equal(core.material.blending, h.T.AdditiveBlending); assert.equal(core.material.depthWrite, false);
    const endA = new h.T.Vector3(0, -0.5, 0), endB = new h.T.Vector3(0, 0.5, 0);
    core.updateMatrixWorld(true); endA.applyMatrix4(core.matrixWorld); endB.applyMatrix4(core.matrixWorld);
    equalArray(endA.toArray(), start); equalArray(endB.toArray(), beams[0].end);
    h.update(life - 0.001); assert.equal(h.r.modelDebug().tracers, count);
    h.update(0.002); assert.equal(h.r.modelDebug().tracers, 0);
  });
}

test('overhaul: 180 preallocated particles, exact burst counts, gravity -14, spin and decay; no hot-path Mesh/material/geometry creation', async () => {
  const h = await harness(), point = { x: 0, y: 2, z: -4 };
  assert.equal(h.r.scene.children.filter(m => m.name === 'pooled-ink-debris').length, 180);
  let allocations = 0;
  for (const name of ['Mesh', 'MeshBasicMaterial', 'BufferGeometry', 'CylinderGeometry', 'SphereGeometry', 'Vector3']) {
    const Original = h.T[name]; h.T[name] = class extends Original { constructor(...args) { super(...args); allocations++; } };
  }
  h.event('hit', { point }); h.update(0.01);
  assert.equal(allocations, 0);
  let d = h.debug(); assert.equal(d.pool.active, 8); assert.equal(d.pool.gravity, -14);
  const p = d.pool.particles[0]; h.update(0.02); const q = h.debug().pool.particles[0];
  close(q.velocity[1], p.velocity[1] - 0.28);
  close(q.position[1], p.position[1] + p.velocity[1] * 0.02 - 7 * 0.02 ** 2);
  close(q.rotation[0], p.rotation[0] + p.spin[0] * 0.02);
  assert.ok(q.remaining < p.remaining); assert.ok(p.spin.some(x => x !== 0));
  h.r.reset(); h.event('hit', { point, crit: true }); assert.equal(h.debug().pool.active, 14);
  assert.ok(h.debug().pool.particles.every(p => ['ffd15a', 'fffae8'].includes(p.color)));
  h.r.reset(); h.event('impact', { point, kind: 'none' }); assert.equal(h.debug().pool.active, 5);
  h.r.reset(); h.shot(0); assert.equal(h.debug().pool.active, 2);
  assert.ok(h.debug().pool.particles.every(p => p.kind === 'shot' && p.velocity[0] < 0 && p.velocity[1] > 0));
  h.r.reset(); h.shot(1); assert.equal(h.debug().pool.active, 3);
  h.r.reset(); allocations = 0;
  for (let i = 0; i < 80; i++) { h.event('hit', { point }); h.shot(0); }
  assert.equal(allocations, 0); assert.equal(h.debug().pool.active, 180); assert.equal(h.debug().beams.length, 48);
  h.update(1); assert.equal(h.debug().pool.active, 0); assert.equal(h.debug().beams.length, 0);
});

test('overhaul: all five literal JSON loads remain; er/pl retain real vertex-colored legacy base geometry', async () => {
  const h = await harness(); h.enemies();
  for (const name of ['bo', 'ta', 'fold', 'er', 'pl']) {
    assert.ok(source.includes(`fetch('/src/models/${name}.json')`));
    assert.ok(h.requests.includes(`/src/models/${name}.json`));
  }
  for (const name of ['er', 'pl']) {
    const base = h.r.scene.getObjectByName(name + '-legacy-core');
    assert.ok(base); assert.equal(base.userData.paperModel, name); assert.equal(base.material.vertexColors, true);
    equalArray(base.scale.toArray(), [1, 1, 1]);
    const original = JSON.parse(readFileSync(new URL(`../src/models/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(base.geometry.attributes.position.count, original.pos.length / 3);
    assert.equal(h.r.modelDebug().enemies.find(e => e.model === name).white, 'ffffff');
  }
});

test('overhaul: crane folded cloak, mask/eyes, two-segment articulated wings, core telegraph and four ratio-lit shields', async () => {
  const h = await harness(); h.enemies();
  let crane = h.debug().enemies[0];
  assert.equal(crane.parts.filter(p => p.name.startsWith('sharp-cloak')).length, 5);
  assert.equal(crane.parts.filter(p => p.name.startsWith('demonic-mask')).length, 2);
  assert.equal(crane.parts.filter(p => p.name.startsWith('red-eye')).length, 2);
  assert.equal(crane.wings.length, 2); assert.equal(crane.shieldLights, 4);
  const before = crane.wings[0]; h.update(0.1); crane = h.debug().enemies[0];
  assert.notEqual(crane.wings[0].shoulder, before.shoulder); assert.notEqual(crane.wings[0].elbow, before.elbow);
  h.snap.enemies[0].telegraph = CONFIG.enemy.telegraph; h.snap.enemies[0].armor = CONFIG.enemy.armor / 2; h.update(0.05);
  assert.equal(h.debug().enemies[0].shieldLights, 2);
  assert.ok(h.r.scene.getObjectByName('telegraph-red-power-core').scale.x > 1.4);
  h.event('armorStrip', { id: 10 }); assert.equal(h.debug().pool.particles.filter(p => p.kind === 'armor').length, 8);
  assert.ok(h.debug().pool.particles.filter(p => p.kind === 'armor').every(p => p.geometry === 'BufferGeometry'));
  h.snap.enemies[0].armor = 0; h.update(0); assert.equal(h.debug().enemies[0].shieldLights, 0);
});

test('overhaul: eraser six alternating articulated legs, serrated jaws, red eyes and teal spool animate with bounded crumbs', async () => {
  const h = await harness(); h.enemies(); h.r.reset(); h.enemies();
  const er = h.debug().enemies[1]; assert.equal(er.legs.length, 6); assert.equal(er.jaws.length, 2);
  close(er.legs[0].hip, -er.legs[1].hip);
  assert.equal(er.parts.filter(p => p.name.startsWith('serration')).length, 6);
  assert.ok(er.parts.some(p => p.name === 'teal-back-spool'));
  const before = er.jaws[0]; h.snap.enemies[1].telegraph = CONFIG.enemy.telegraph; h.update(0.04);
  const next = h.debug().enemies[1]; assert.notEqual(next.jaws[0], before); assert.ok(next.body.scale[1] < 1); assert.ok(next.body.position[2] < 0);
  h.update(10);
  assert.ok(h.debug().pool.particles.filter(p => p.kind === 'crumb').length <= 1, 'no catch-up emission storm');
});

test('overhaul: real bite/wallBite events drive eraser compression and lunge without simulation telegraph fields', async () => {
  const h = await harness(); h.enemies();
  for (const [type, data] of [['bite', { id: 11 }], ['wallBite', { x: 0, z: -5, wallId: 99 }]]) {
    h.event(type, data); h.update(0); let er = h.debug().enemies[1];
    close(er.biteAge, 0); assert.ok(er.body.position[2] < 0 && er.body.scale[1] < 1);
    h.update(0.1); er = h.debug().enemies[1]; assert.ok(er.body.position[2] > 0);
    h.update(0.3); close(h.debug().enemies[1].body.position[2], 0);
  }
  assert.ok(h.debug().pool.particles.filter(p => p.kind === 'crumb').every(p => p.color === 'd7a0a9'));
  assert.ok(h.debug().pool.particles.filter(p => p.kind === 'trail').every(p => ['c53245', '20242a'].includes(p.color)));
});

test('overhaul: plane banks with heading, rotating nose, shrinking handdrawn player ground target and laser persist in dive', async () => {
  const h = await harness(); h.enemies();
  const plane = h.snap.enemies[2]; plane.state = 'aim'; plane.telegraph = 0.1; h.update(0.02);
  let d = h.debug().enemies[2]; assert.ok(d.target.visible && d.target.laser);
  equalArray(d.target.position, [h.me.x, 0.045, h.me.z]);
  assert.equal(d.parts.filter(p => p.name.startsWith('banked-red-tail')).length, 2);
  const scale = d.target.scale[0], angle = d.target.rotation[1];
  plane.telegraph = CONFIG.enemy.plane.aimTime * 0.9; h.me.x += 2; h.update(0.1);
  d = h.debug().enemies[2]; assert.ok(d.target.scale[0] < scale); assert.notEqual(d.target.rotation[1], angle);
  equalArray(d.target.position, [h.me.x, 0.045, h.me.z]);
  plane.state = 'dive'; plane.x += 1; h.update(0.05); d = h.debug().enemies[2];
  assert.ok(d.target.visible); assert.notEqual(d.bank, 0);
  assert.ok(d.parts.find(p => p.name === 'rotating-nose-aim-cone').rotation[1] !== 0);
});

test('overhaul: enemy hit is white, applies .22 kick and 1.12/.88 squash, elastically recovers in .14s and restores intrinsic emitters', async () => {
  const h = await harness(); h.enemies();
  const before = [...h.debug().enemies[0].emissives];
  h.event('hit', { id: 10, point: { x: -3, y: 1, z: -6 } }); h.update(0);
  let d = h.debug().enemies[0]; close(d.hitKick, 1); close(d.body.rotation[0], -0.22); equalArray(d.body.scale, [1.12, 0.88, 1.12]);
  assert.ok(d.emissives.every(hex => hex === 'ffffff'));
  h.update(0.14); d = h.debug().enemies[0]; close(d.hitKick, 0); equalArray(d.body.scale, [1, 1, 1]);
  assert.deepEqual([...d.emissives], before); assert.ok(d.emissives.includes('e51e35'));
});

test('overhaul: projectile pool has shared 3-layer resources, velocity/delta orientation, spinning halo and reusable removal', async () => {
  const h = await harness(); h.snap.projectiles = [{ id: 1, x: 0, y: 1, z: -4 }, { id: 2, x: 1, y: 1, z: -4 }]; h.update(0);
  const roots = h.r.scene.children.filter(o => o.name === 'ink-projectile');
  assert.equal(roots.length, 96); assert.equal(h.debug().projectiles.length, 2);
  const live = roots.filter(o => o.visible); assert.equal(live[0].children.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(live[0].children[i].geometry, live[1].children[i].geometry);
  h.snap.projectiles[0].x += 0.5; h.update(0.05);
  const aim = new h.T.Vector3(0, 0, 1).applyQuaternion(live[0].quaternion); equalArray(aim.toArray(), [1, 0, 0]);
  assert.ok(h.debug().projectiles[0].layers[1].rotation[2] > 0);
  h.snap.projectiles = []; h.update(0); assert.ok(roots.every(o => !o.visible));
  h.snap.projectiles = [{ id: 3, x: 0, y: 1, z: 0, vx: 0, vy: 1, vz: 0 }]; h.update(0.05);
  equalArray(new h.T.Vector3(0, 0, 1).applyQuaternion(live[0].quaternion).toArray(), [0, 1, 0]);
});

test('overhaul: weapon recoil specs and fixed-safe springs remain stable and return to custom FOV/ADS', async () => {
  const h = await harness();
  for (const [wp, pitch, setback, fov, shake] of [[0, 0.045, 0.055, 0.8, 0.008], [1, 0.14, 0.14, 2.8, 0.024], [2, 0.16, 0.16, 3.2, 0.026]]) {
    h.r.reset(); h.shot(wp); const d = h.debug(); close(d.spring.pitch, pitch); close(d.spring.setback, setback); close(d.spring.fov, fov); close(d.shake, shake);
    if (wp === 1) close(d.spring.roll, 0.09);
    for (let i = 0; i < 180; i++) h.update(i % 2 ? 1 / 30 : 1 / 120);
    assert.ok(Object.values(h.debug().spring).every(n => Number.isFinite(n) && Math.abs(n) < 1e-8));
  }
  h.r.setBaseFov(87); Object.assign(h.me, { wp: 2, ads: true }); h.update(2); close(h.r.camera.fov, 28);
  h.shot(2); h.update(0.03); assert.ok(h.r.camera.fov > 28);
  h.me.ads = false; for (let i = 0; i < 60; i++) h.update(0.05); close(h.r.camera.fov, 87);
  h.shot(2); h.update(30); assert.ok(Number.isFinite(h.r.camera.fov));
});

test('overhaul: muzzle lifetime is frame-rate independent and never extends across a long frame', async () => {
  const h = await harness();
  h.shot(); h.update(.054); assert.equal(h.r.modelDebug().muzzle, true);
  h.update(.002); assert.equal(h.r.modelDebug().muzzle, false);
  h.shot(); h.update(.2); assert.equal(h.r.modelDebug().muzzle, false);
});

test('overhaul: framing preserves side detail and keeps the receiver ahead of the near plane', async () => {
  const h = await harness(), rig = h.r.scene.getObjectByName('weapon-rig');
  h.update(0); close(rig.rotation.y, .14); close(rig.position.z, -.64); close(rig.position.y, -.22);
  for (const weapon of h.debug().weapons) {
    const receiver = h.r.scene.getObjectByName(weapon.parts.find(p => p.name.includes('receiver')).name);
    receiver.geometry.computeBoundingBox();
    const box = receiver.geometry.boundingBox;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const point = receiver.localToWorld(new h.T.Vector3(x, y, z)); h.r.camera.worldToLocal(point);
      assert.ok(point.z < -.4);
    }
  }
});

test('hands: paper cuffs, teal straps, fingerless gloves and warm knuckles share weapon layer without changing named parts', async () => {
  const h = await harness();
  for (const [i, name] of ['INK-01', 'MARK-02', 'LINE-03'].entries()) {
    const weapon = h.r.scene.getObjectByName(name), hands = weapon.getObjectByName('tactical-hands');
    assert.equal(hands.parent, weapon); assert.equal(h.debug().weapons[i].partCount, [22, 23, 24][i]);
    hands.traverse(o => { assert.equal(o.layers.mask, 2); if (o.isMesh) assert.equal(o.material.type, 'MeshStandardMaterial'); });
    for (const side of ['right', 'left']) {
      assert.equal(hands.getObjectByName(side + '-cuff').material.color.getHex(), 0xefece2);
      assert.equal(hands.getObjectByName(side + '-wristband').material.color.getHex(), 0x007f7b);
      assert.equal(hands.getObjectByName(side + '-palm').material.color.getHex(), 0x262d35);
    }
    assert.equal(hands.getObjectByName('right-wrap-0-2').material.color.getHex(), 0xe8c6a8);
    for (let finger = 0; finger < 3; finger++) for (let joint = 1; joint <= 3; joint++) assert.ok(hands.getObjectByName(`right-wrap-${finger}-${joint}`));
    assert.ok(hands.getObjectByName('right-index-3')); assert.ok(hands.getObjectByName('left-thumb-2'));
  }
});

test('hands: default and reset ammo use CONFIG magazine capacity, including the five-round sniper', async () => {
  const h = await harness();
  equalArray(h.debug().weapons.map(w => w.ammo), CONFIG.player.weapons.map(w => w.magazine));
  Object.assign(h.me, { wp: 2, ammo: 4 }); h.update(.3); close(h.debug().weapons[2].fill, 4 / 5);
  h.r.reset(); equalArray(h.debug().weapons.map(w => w.ammo), CONFIG.player.weapons.map(w => w.magazine));
  assert.ok(h.debug().weapons.every(w => w.fill === 1)); assert.ok(!source.includes('[18, 6, 4]'));
});

test('hands: rifle left hand follows magazine extraction/insertion, leaves the viewport and returns to the rail', async () => {
  const h = await harness(), weapon = h.r.scene.getObjectByName('INK-01');
  const hand = weapon.getObjectByName('left-hand'), mag = weapon.getObjectByName('slanted-magazine'), home = hand.position.clone();
  for (const progress of [.15, .24, .35, .66, .8, .88]) {
    h.me.rl = CONFIG.player.weapons[0].reloadTime * (1 - progress); h.update(0);
    const target = new h.T.Vector3(-.002, -.065, 0).applyQuaternion(mag.quaternion).add(mag.position);
    equalArray(hand.position.toArray(), target.toArray()); close(hand.quaternion.angleTo(mag.quaternion), 0, 1e-7);
    assert.equal(h.debug().weapons[0].hands.left.mode, 'magazine'); assert.equal(weapon.getObjectByName('left-magazine-palm').parent.visible, true);
  }
  h.me.rl = CONFIG.player.weapons[0].reloadTime * .5; h.update(0);
  const offscreen = hand.getWorldPosition(new h.T.Vector3()).project(h.r.camera); assert.ok(offscreen.y < -1);
  h.me.rl = 0; h.update(0); equalArray(hand.position.toArray(), home.toArray());
  assert.equal(h.debug().weapons[0].hands.left.mode, 'support'); assert.equal(weapon.getObjectByName('left-magazine-palm').parent.visible, false);
});

test('hands: shotgun left hand remains locked to the independent pump throughout its complete stroke', async () => {
  const h = await harness(); Object.assign(h.me, { wp: 1, ammo: 6 }); h.update(.4);
  const weapon = h.r.scene.getObjectByName('MARK-02'), hand = weapon.getObjectByName('left-hand'), pump = weapon.getObjectByName('independent-pump');
  const home = hand.position.clone(); h.shot(1);
  for (const dt of [.14, .035, .035, .095, .095, .1]) {
    h.update(dt); equalArray(hand.position.toArray(), pump.position.toArray()); assert.equal(h.debug().weapons[1].hands.left.mode, 'pump');
  }
  equalArray(hand.position.toArray(), home.toArray());
});

test('hands: sniper right hand reaches the exterior bolt, tracks lift/pull/push and regrips by .65 seconds', async () => {
  const h = await harness(); Object.assign(h.me, { wp: 2, ammo: 5 }); h.update(.4);
  const weapon = h.r.scene.getObjectByName('LINE-03'), hand = weapon.getObjectByName('right-hand'), handle = weapon.getObjectByName('bolt-handle');
  const home = hand.position.clone(); assert.ok(handle.position.z > 0); h.shot(2);
  h.update(.2); equalArray(hand.position.toArray(), home.toArray());
  for (const dt of [.05, .06, .12, .07, .08]) {
    h.update(dt); const target = handle.getWorldPosition(new h.T.Vector3()), actual = hand.getWorldPosition(new h.T.Vector3());
    close(actual.distanceTo(target), 0); assert.ok(hand.position.x > .1); assert.equal(h.debug().weapons[2].hands.right.mode, 'bolt');
  }
  h.update(.07); equalArray(hand.position.toArray(), home.toArray()); assert.equal(h.debug().weapons[2].hands.right.mode, 'grip');
  h.shot(2); h.update(2); equalArray(hand.position.toArray(), home.toArray());
});

test('hands: distal sleeve caps remain entirely below the viewport through FOV, aspect, recoil, reload and switch poses', async () => {
  const h = await harness();
  for (const fov of [60, 68, 95]) for (const aspect of [9 / 16, 4 / 3, 16 / 9, 32 / 9]) {
    h.r.setBaseFov(fov); h.r.camera.fov = fov; h.r.camera.aspect = aspect; h.r.camera.updateProjectionMatrix();
    for (const wp of [0, 1, 2]) for (const rl of [0, CONFIG.player.weapons[wp].reloadTime * .5]) {
      Object.assign(h.me, { wp, rl, yaw: .72, pitch: -.4 }); h.me.x += .06; h.me.z += .025; h.shot(wp); h.update(.016);
      for (const weapon of ['INK-01', 'MARK-02', 'LINE-03']) for (const side of ['left', 'right']) {
        const arm = h.r.scene.getObjectByName(weapon).getObjectByName(side + '-forearm'), points = arm.geometry.attributes.position;
        for (let i = 0; i < points.count; i++) if (points.getY(i) < -.499) {
          const p = arm.localToWorld(new h.T.Vector3().fromBufferAttribute(points, i));
          const cameraPoint = h.r.camera.worldToLocal(p.clone()); assert.ok(cameraPoint.z < -h.r.camera.near);
          p.project(h.r.camera); assert.ok(p.y < -1, `${weapon}/${side} FOV${fov} aspect${aspect}: ${p.y}`);
        }
      }
    }
  }
});

test('hands: ADS and downed states hide both hands with the rig; reset clears all hand action poses', async () => {
  const h = await harness(); Object.assign(h.me, { wp: 2, ads: true }); h.update(.3);
  const rig = h.r.scene.getObjectByName('weapon-rig'); assert.equal(rig.visible, false);
  Object.assign(h.me, { ads: false, st: 1 }); h.update(.2); assert.equal(rig.visible, false);
  Object.assign(h.me, { st: 0 }); h.shot(2); h.update(.43); assert.equal(h.debug().weapons[2].hands.right.mode, 'bolt');
  h.r.reset(); assert.equal(rig.visible, true);
  for (const [i, w] of h.debug().weapons.entries()) { assert.equal(w.hands.right.mode, 'grip'); assert.equal(w.hands.left.mode, i === 1 ? 'pump' : 'support'); }
});

test('overhaul: reduced-motion media toggle suppresses muzzle/shake/kick/trails and bounds new debris', async () => {
  const h = await harness({ reduced: true }); h.enemies(); h.shot(1); h.update(0.01);
  assert.equal(h.r.modelDebug().muzzle, false); close(h.r.camera.rotation.x, h.me.pitch); close(h.r.camera.rotation.z, 0);
  assert.equal(h.debug().pool.active, 0);
  h.event('hit', { id: 10, point: { x: 0, y: 1, z: 0 } }); h.update(0);
  assert.equal(h.debug().pool.active, 2); equalArray(h.debug().enemies[0].body.scale, [1, 1, 1]);
  h.media.matches = false; h.r.reset(); h.shot(); h.update(0.001); assert.equal(h.r.modelDebug().muzzle, true);
});

test('overhaul: kill emits 18 ink/paper fragments; removed enemy geometry/textures dispose once; reset reuses pools and teardown disposes them', async () => {
  const h = await harness(); h.enemies();
  const plane = h.r.scene.getObjectByName('plane-12'), geometry = new Set(), material = new Set();
  plane.traverse(o => { if (o.geometry) geometry.add(o.geometry); if (o.material) material.add(o.material); });
  let disposedGeometry = 0, disposedMaterial = 0, disposedTexture = 0;
  for (const g of geometry) g.addEventListener('dispose', () => disposedGeometry++);
  for (const m of material) { m.addEventListener('dispose', () => disposedMaterial++); if (m.map) m.map.addEventListener('dispose', () => disposedTexture++); }
  h.event('kill', { id: 12 }); assert.equal(h.debug().pool.particles.filter(p => p.kind === 'kill').length, 18);
  h.update(0.41); assert.equal(disposedGeometry, geometry.size); assert.equal(disposedMaterial, material.size); assert.equal(disposedTexture, 1);
  h.snap.enemies = []; h.update(0);
  const poolMesh = h.r.scene.children.find(m => m.name === 'pooled-tracer-core'); let poolDisposals = 0;
  poolMesh.geometry.addEventListener('dispose', () => poolDisposals++);
  h.shot(); h.snap.projectiles = [{ id: 8, x: 0, y: 1, z: 0 }]; h.update(0);
  h.r.reset(); const d = h.debug(); assert.equal(d.enemies.length, 0); assert.equal(d.projectiles.length, 0); assert.equal(d.pool.active, 0); assert.equal(d.beams.length, 0);
  assert.equal(poolDisposals, 0); assert.ok(d.weapons.every(w => w.reload === 0 && w.shotAge === 10 && w.fill === 1));
  h.r.dispose(); assert.equal(poolDisposals, 1); assert.equal(h.gpuDisposed, 1); assert.equal(h.r.scene.children.length, 0);
  const count = h.renders; h.r.update(h.snap, 0.1); h.r.dispose(); assert.equal(h.renders, count); assert.equal(h.gpuDisposed, 1);
});

test('overhaul4: desk-diorama landmarks, stationery covers and wall decorations initialize and drift', async () => {
  const h = await harness();
  for (const name of ['desk-pencil-tower', 'desk-ruler-arch', 'desk-paperclip', 'desk-note-tower']) {
    assert.ok(h.r.scene.getObjectByName(name), name);
  }
  for (let i = 0; i < 5; i++) assert.ok(h.r.scene.getObjectByName('paper-cloud-' + i));
  for (let i = 0; i < 4; i++) assert.ok(h.r.scene.getObjectByName('wall-decor-' + i));
  const skins = ['notebook', 'sticky', 'case'];
  for (let i = 0; i < world.COVERS.length; i++) {
    const c = world.COVERS[i], m = h.r.scene.getObjectByName('cover-' + i + '-skin');
    assert.ok(m, 'cover ' + i);
    assert.equal(m.userData.skin, skins[i % 3]);
    assert.equal(m.geometry.parameters.width, c.w);
    assert.equal(m.geometry.parameters.height, c.h);
    assert.equal(m.geometry.parameters.depth, c.d);
  }
  const cloud = h.r.scene.getObjectByName('paper-cloud-0');
  const x0 = cloud.position.x;
  h.update(2);
  assert.notEqual(cloud.position.x, x0, 'paper clouds slowly cruise');
  h.r.dispose();
  assert.equal(h.gpuDisposed, 1);
  assert.equal(h.r.scene.children.length, 0);
});

test('overhaul4: dash event pulses FOV and sprays six teal particles; reduced motion suppresses both', async () => {
  const h = await harness();
  h.event('dash', { id: 0, x: 1, z: -2, dx: 1, dz: 0 });
  h.update(0);
  const d = h.debug();
  assert.ok(d.spring.fov >= 6);
  assert.equal(d.pool.particles.filter(p => p.kind === 'dash').length, 6);
  const reduced = await harness({ reduced: true });
  reduced.event('dash', { id: 0, x: 0, z: 0, dx: 0, dz: -1 });
  reduced.update(0);
  assert.equal(reduced.debug().spring.fov, 0);
  assert.equal(reduced.debug().pool.active, 0);
});

test('overhaul2: sway follows authoritative velocity with exponential smoothing, never snaps to center on tick-less frames', async () => {
  const h = await harness();
  const rig = h.r.scene.getObjectByName('weapon-rig');
  h.me.vx = CONFIG.player.walkSpeed; h.me.vz = 0;
  const xs = [];
  for (let i = 0; i < 90; i++) { h.update(1 / 60); xs.push(rig.position.x); }
  const d = h.debug();
  assert.ok(d.sway > 0.95, 'walk speed reaches full smoothed sway: ' + d.sway);
  assert.ok(xs.every(x => Math.abs(x - 0.27) <= 0.0086), 'walk sway stays within ±8.5mm');
  assert.ok(new Set(xs.map(x => x.toFixed(5))).size > 10, 'rig keeps animating on every frame');
  // 站立：位置坐标变化不再产生 sway（旧实现按相邻渲染帧位移计算会 20Hz 抽搐）
  h.me.vx = h.me.vz = 0; h.me.x += 0.3; h.me.z -= 0.2;
  for (let i = 0; i < 120; i++) h.update(1 / 60);
  assert.ok(h.debug().sway < 1e-3, 'frame-to-frame teleport adds no sway');
  close(h.debug().sway, 0);
  h.update(1 / 60); close(rig.position.x, 0.27, 1e-9);
  assert.ok(source.includes('0.0085') && source.includes('0.0045') && source.includes('Math.exp(-10 * dt)'));
  assert.ok(source.includes('Math.sin(fxTime * 38)') && source.includes('Math.sin(fxTime * 31)') && source.includes('Math.sin(fxTime * 27)'));
});

test('overhaul2: shake below 0.0004 snaps to exact zero', async () => {
  const h = await harness();
  h.event('playerHit', { id: 0 });
  assert.ok(h.debug().shake > 0);
  h.update(0.9);
  assert.equal(h.debug().shake, 0);
});

test('overhaul2: MARK-02 reservoir cap is a narrowed beveled silver plug with a yellow pressure glow ring', async () => {
  const h = await harness();
  const cap = h.r.scene.getObjectByName('reservoir-cap');
  assert.equal(cap.geometry.type, 'CylinderGeometry');
  assert.equal(cap.geometry.parameters.radiusTop, 0.05);
  assert.equal(cap.geometry.parameters.radiusBottom, 0.064);
  assert.equal(cap.geometry.parameters.height, 0.03);
  assert.equal(cap.material.metalness, 0.82);
  const ring = cap.getObjectByName('reservoir-cap-ring');
  assert.equal(ring.geometry.type, 'TorusGeometry');
  assert.ok(ring.material.emissive.getHex() === 0xffaa16 && ring.material.emissiveIntensity > 1);
  assert.equal(h.debug().weapons[1].partCount, 23, 'ring is a child, not a new named part');
});

test('overhaul2: ground hazards render rings, mortar countdown/falling ink ball and fade away on removal', async () => {
  const h = await harness();
  h.snap.hazards = [
    { id: 901, k: 'm', x: 1, z: 2, r: 2.2, t: 1.0 },
    { id: 902, k: 'w', x: 0, z: 0, r: 5, t: 0 },
    { id: 903, k: 'p', x: -3, z: 4, r: 1.45, t: 2.5 },
  ];
  h.update(0.05);
  const mortar = h.r.scene.getObjectByName('hazard-m'), wave = h.r.scene.getObjectByName('hazard-w'), puddle = h.r.scene.getObjectByName('hazard-p');
  assert.ok(mortar && wave && puddle);
  assert.deepEqual([mortar.position.x, mortar.position.z], [1, 2]);
  assert.ok(Math.abs(mortar.children[0].scale.x - 2.2) < 0.13, 'pulsing red circle covers the 2.2m blast radius');
  assert.equal(mortar.children[2].visible, false, 'ink ball waits for the last .35s');
  assert.equal(wave.children[0].scale.x, 5);
  h.snap.hazards[0].t = 0.2; h.update(0.05);
  assert.equal(mortar.children[2].visible, true);
  assert.ok(mortar.children[2].position.y > 2);
  h.snap.hazards = []; h.update(0);
  assert.ok(!h.r.scene.getObjectByName('hazard-m') && !h.r.scene.getObjectByName('hazard-w') && !h.r.scene.getObjectByName('hazard-p'));
});

test('overhaul2: phase 3 sky/fog shift to dark crimson paper and restore on reset; slam warning ring follows state', async () => {
  const h = await harness();
  h.snap.boss = { hp: 300, max: 1100, ph: 3, state: 'idle', raged: true, x: 0, z: 5.5, t: 0, fy: 0, st: 0, ex: 0, sl: 0, ax: 0, az: 0 };
  for (let i = 0; i < 120; i++) h.update(0.05);
  assert.equal(h.r.scene.background.getHexString(), 'd8c4c4');
  assert.equal(h.r.scene.fog.color.getHexString(), 'd8c4c4');
  h.snap.boss.state = 'slam'; h.snap.boss.t = 0.24; h.update(0.05);
  const slam = h.r.scene.getObjectByName('slam-warning');
  assert.equal(slam.visible, true);
  assert.ok(slam.material.opacity > 0.3);
  h.snap.boss.state = 'idle'; h.update(0.05);
  assert.equal(slam.visible, false);
  h.r.reset();
  assert.equal(h.r.scene.background.getHexString(), 'dde9ee');
});

test('overhaul2: mortarBoom and bossSlam events spawn burst debris without pool leaks', async () => {
  const h = await harness();
  h.event('mortarBoom', { x: 2, z: -3, r: 2.2 });
  h.event('bossSlam', { x: -2, z: 1, radius: 4.3 });
  assert.ok(h.debug().pool.particles.filter(p => p.kind === 'kill').length >= 16);
  const active = h.debug().pool.active;
  assert.ok(active >= 28);
  h.update(1);
  assert.equal(h.debug().pool.active, 0);
});
