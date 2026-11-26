// OVERHAUL-2 验收：离线 dist/inkline.html 真实 WebGL 四格截图 + 平滑/双手/三阶段读数。
// 用法：node tests/overhaul2-browser.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = pathToFileURL(path.join(root, 'dist', 'inkline.html')).href + '?seed=11';
const port = Number(process.env.CDP_PORT || 9357);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-overhaul2-'));
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { started: new Date().toISOString(), checks: {}, externalRequests: [], consoleErrors: [] };
let ws;
try {
  let endpoint;
  for (let n = 0; n < 100; n++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch (_) {}
    if (endpoint) break;
    await delay(100);
  }
  if (!endpoint) throw new Error('Chrome 未就绪');
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(), events = [];
  let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
    else if (message.method) events.push(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 60000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const run = body => evaluate(`(() => {const d=window.__CLIENT_DEBUG__,K=d.kernel,C=K.CONFIG;let m=d.match,p=m.players[0];${body}})()`);
  const wait = async expression => {
    for (let n = 0; n < 120; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('等待超时: ' + expression);
  };
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;

  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.requestAnimationFrame = fn => { window.__testFrame = fn; return 0; };
  ` });
  await S('Page.navigate', { url: file });
  await wait('!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5');
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glbLoaded === true');
  await run("d.pause(true);document.getElementById('lock-hint').style.display='none';d.pump(0.05);");
  evidence.checks.boot = await run("return {seed:d.state().seed, phase:m.phase, players:m.players.length};");

  const pump = n => run(`for(let i=0;i<${n};i++)d.pump(0.05);`);
  const pictures = [];

  // 1) MARK-02 + 奶龙捧腹大笑：双层扩散音浪环 + 肚皮弱点环
  await run(`
    d.restart();
    m = d.match; p = m.players[0];
    d.spawnBoss();
    d.teleport(0, 10.4);
    d.aimAt(0, 1.35, 5.5);
    d.weapon(1);
    p.ammo = 6; p.fireCd = 0;
    document.getElementById('lock-hint').style.display='none';
    d.pump(0.05);
  `);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await run("document.getElementById('lock-hint').style.display='none';d.pump(0.05);");
  await pump(70);
  await run(`
    document.getElementById('lock-hint').style.display='none';
    const b = m.boss;
    b.laughExposeT = 2.2;
    d.renderer.triggerBossLaugh();
    m.hazards.push({ id: m.nextId++, kind: 'wave', x: b.x, z: b.z, r: 4.6, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] });
    m.hazards.push({ id: m.nextId++, kind: 'wave', x: b.x, z: b.z, r: 8.2, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] });
    d.pump(0.05);
  `);
  await pump(10);
  evidence.checks.scene1 = await run(`
    const dbg=d.renderer.bossDebug(), od=d.renderer.overhaulDebug();
    return { weapon: od.weapons[1].name, hands: od.weapons[1].hands, laugh: dbg.cur, belly: dbg.belly,
      waves: od.hazards.filter(h=>h.kind==='hazard-w').length, hpText: (document.querySelector('#boss-hp-num')||{}).textContent,
      label: (document.querySelector('#boss-label')||{}).textContent };
  `);
  pictures.push(await capture());

  // 2) INK-01 + 天降墨雨红圈与下坠巨型墨球
  await run(`
    d.restart();
    m = d.match; p = m.players[0];
    d.spawnBoss();
    d.teleport(0, 10.6);
    d.aimAt(1.2, 1.3, 5.6);
    d.weapon(0);
    p.ammo = 12; p.fireCd = 0;
    d.pump(0.05);
  `);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await run("document.getElementById('lock-hint').style.display='none';d.pump(0.05);");
  await pump(70);
  await run(`
    document.getElementById('lock-hint').style.display='none';
    const b = m.boss; b.hp = b.maxHp; b.phase = 1;
    const spots = [[2.4, 6.4, 0.18], [-2.1, 7.1, 0.55], [0.7, 4.6, 0.72], [3.5, 9.1, 0.42], [-3.3, 9.8, 0.6], [1.8, 11.2, 0.5]];
    for (const [x, z, t] of spots) m.hazards.push({ id: m.nextId++, kind: 'mortar', x, z, r: 2.2, fuse: 1.15, t, damage: 16 });
    d.pump(0.05);
  `);
  await pump(6);
  evidence.checks.scene2 = await run(`
    const od=d.renderer.overhaulDebug();
    return { weapon: od.weapons[0].name, mortars: od.hazards.filter(h=>h.kind==='hazard-m').length,
      balls: od.hazards.filter(h=>h.kind==='hazard-m').map(h=>h.parts[2]).filter(b=>b.visible).length };
  `);
  pictures.push(await capture());

  // 3) LINE-03 + 连环冲锋灼痕 + G 速墙撞晕（金星 + 破盾徽标）
  await run(`
    d.restart();
    m = d.match; p = m.players[0];
    d.spawnBoss();
    d.teleport(0, 10.2);
    d.aimAt(0, 1.5, 5.3);
    d.weapon(2);
    p.ammo = 5; p.fireCd = 0; p.ink = 100;
    d.pump(0.05);
  `);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await run("document.getElementById('lock-hint').style.display='none';d.quickWall();d.pump(0.05);");
  await pump(70);
  await run(`
    document.getElementById('lock-hint').style.display='none';
    const b = m.boss; b.x = 0; b.z = 5.1; b.stunT = 2.2; b.state = 'idle';
    for (const [x, z] of [[0.9, 8.2], [-0.8, 7.5], [1.6, 6.7], [-1.4, 6.1]]) m.hazards.push({ id: m.nextId++, kind: 'puddle', x, z, r: 1.45, t: 3.6, tick: 0.25 });
    d.pump(0.05);
  `);
  await pump(8);
  evidence.checks.scene3 = await run(`
    const dbg=d.renderer.bossDebug(), od=d.renderer.overhaulDebug();
    return { weapon: od.weapons[2].name, dizzy: dbg.dizzy, stun: d.state().boss && d.state().boss.t,
      chip: (document.querySelector('#boss-state-chip')||{}).textContent,
      puddles: od.hazards.filter(h=>h.kind==='hazard-p').length,
      status: (document.querySelector('#boss-state-chip')||{}).style.display };
  `);
  pictures.push(await capture());

  // 4) Phase 3 暗绯天空 + 三段刻度血条 + 双层高速弹幕 + 暴击飘字
  await run(`
    d.restart();
    m = d.match; p = m.players[0];
    d.spawnBoss();
    d.teleport(0, 10.8);
    d.aimAt(0, 1.5, 5.5);
    d.weapon(0);
    p.ammo = 15; p.fireCd = 0;
    d.pump(0.05);
  `);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await run(`
    document.getElementById('lock-hint').style.display='none';
    const b = m.boss;
    b.phase = 3; b.raged = true; b.hp = Math.round(b.maxHp * 0.27); b.laughExposeT = 0;
    d.pump(0.05);
  `);
  await pump(120);
  await run(`
    const b = m.boss;
    d.hud.showPhaseBanner(3, C.boss.phaseTitles[2]);
    for (let i = 0; i < 7; i++) m.projectiles.push({ id: m.nextId++, x: -2.7 + i * 0.9, y: 1.32, z: 7.6, vx: 0, vy: 0, vz: 13 });
    for (let i = 0; i < 8; i++) m.projectiles.push({ id: m.nextId++, x: -3.2 + i * 0.91, y: 1.15, z: 8.5, vx: 0, vy: 0, vz: 14.5 });
    d.hud.spawnDmgNumber({ x: 0.3, y: 2.0, z: 5.7 }, '暴击 -38!', 'crit');
    d.pump(0.05);
  `);
  await pump(4);
  evidence.checks.scene4 = await run(`
    const od=d.renderer.overhaulDebug();
    return { projectiles: od.projectiles.length, sky: d.renderer.scene.background.getHexString(),
      label: (document.querySelector('#boss-label')||{}).textContent,
      hpText: (document.querySelector('#boss-hp-num')||{}).textContent,
      banner: (document.querySelector('#boss-phase-banner')||{}).textContent,
      floats: [...document.querySelectorAll('.dmg-float')].map(e=>e.textContent).filter(Boolean) };
  `);
  pictures.push(await capture());

  // 平滑读数：onLook getter / alpha 支撑 / sway 低通
  evidence.checks.smooth = await run(`
    const out = { pitch: d.input.pitch, alpha: typeof d.runtime.alpha === 'function',
      onLookWired: typeof d.input.pitch === 'number' };
    d.restart(); m = d.match; p = m.players[0]; d.pump(0.05);
    m.players[0].velX = C.player.walkSpeed;
    for (let i = 0; i < 80; i++) d.pump(1 / 60);
    out.swayWalk = d.renderer.overhaulDebug().sway;
    m.players[0].velX = 0;
    for (let i = 0; i < 160; i++) d.pump(1 / 60);
    out.swayIdle = d.renderer.overhaulDebug().sway;
    out.shake = d.renderer.overhaulDebug().shake;
    return out;
  `);
  evidence.checks.hands = await run(`
    const od = d.renderer.overhaulDebug();
    const cap = d.renderer.scene.getObjectByName('reservoir-cap');
    return { partCounts: od.weapons.map(w=>w.partCount),
      modes: od.weapons.map(w=>({ right: w.hands.right.mode, left: w.hands.left.mode })),
      cap: cap ? { metal: cap.material.metalness, top: cap.geometry.parameters.radiusTop, bottom: cap.geometry.parameters.radiusBottom } : null,
      ring: !!d.renderer.scene.getObjectByName('reservoir-cap-ring'),
      rig: d.renderer.modelDebug().gun };
  `);
  evidence.checks.boss = await run(`
    d.restart(); m = d.match; p = m.players[0]; d.spawnBoss();
    const b = m.boss;
    return { hp: b.hp, max: b.maxHp, phase: b.phase, scales: [1,2,3,4].map(n => C.scaling[n].bossHp) };
  `);
  evidence.checks.god = await run(`
    d.restart(); m = d.match; p = m.players[0];
    document.getElementById('lock-hint').style.display='none';
    const before = p.hp;
    const toggled = d.god(true);
    m.hazards.push({ id: m.nextId++, kind: 'wave', x: p.pos.x, z: p.pos.z, r: 0.2, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] });
    d.step(1); d.pump(0.05);
    const afterWave = p.hp, vel = { x: p.velX, z: p.velZ };
    const chip = getComputedStyle(document.getElementById('god-chip')).display;
    const wasOn = p.god;
    d.god(false);
    return { toggled, wasOn, before, afterWave, vel, chip, offNow: p.god };
  `);

  // 2×2 拼合 2560×1440
  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');const images=${JSON.stringify(pictures)};for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,i%2*1280,Math.floor(i/2)*720,1280,720);}return c.toDataURL('image/png').split(',')[1];})()`);
  fs.mkdirSync(path.join(root, 'N5-Open/renders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'N5-Open/renders/OVERHAUL-2-verify.png'), Buffer.from(sheet, 'base64'));
  for (let i = 0; i < pictures.length; i++) {
    fs.writeFileSync(path.join(root, `N5-Open/renders/OVERHAUL-2-scene-${i + 1}.png`), Buffer.from(pictures[i], 'base64'));
  }

  const external = events.filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request.url).filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  const errors = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  evidence.externalRequests = external;
  evidence.consoleErrors = errors.map(e => e.method + ':' + JSON.stringify(e.params).slice(0, 300));
  evidence.finished = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'N5-Open/reports/OVERHAUL-2-browser.json'), JSON.stringify(evidence, null, 2));

  const c = evidence.checks;
  const ok = c.scene1 && c.scene1.waves === 2 && c.scene1.belly === true &&
    c.scene2 && c.scene2.mortars === 6 && c.scene2.balls >= 1 &&
    c.scene3 && c.scene3.dizzy === true && c.scene3.puddles === 4 &&
    c.scene4 && c.scene4.projectiles === 15 && c.scene4.sky === 'd8c4c4' &&
    c.smooth && c.smooth.swayWalk > 0.9 && c.smooth.swayIdle < 1e-3 &&
    c.hands && c.hands.ring === true && c.boss && c.boss.hp === 1100 &&
    c.god && c.god.toggled.god === true && c.god.wasOn === true && c.god.before === c.god.afterWave &&
    c.god.vel.x === 0 && c.god.vel.z === 0 && c.god.chip === 'block' && c.god.offNow === false &&
    external.length === 0 && errors.length === 0;
  console.log(JSON.stringify(evidence.checks, null, 1));
  console.log('external:', external.length, 'errors:', errors.length);
  console.log(ok ? 'PASS: OVERHAUL-2 浏览器验收' : 'FAIL: 检查未全部通过');
  process.exitCode = ok ? 0 : 1;
} finally {
  try { await send('Browser.close'); } catch (_) {}
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await delay(400);
  fs.rmSync(profile, { recursive: true, force: true });
}
