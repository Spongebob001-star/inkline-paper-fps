import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CDP_PORT || 9342);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-sprint-b-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { started: new Date().toISOString(), checks: {}, screenshots: 'offline file:// actual WebGL; controlled authority states, real keyboard/mouse input', externalRequests: [], consoleErrors: [] };
let ws, send;
try {
  let endpoint;
  for (let n = 0; n < 80; n++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch (_) {}
    if (endpoint) break;
    await delay(100);
  }
  assert.ok(endpoint, 'Chrome ready');
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(), events = [];
  let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
    else if (message.method) events.push(message);
  };
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 45000);
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
  const wait = async expression => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await delay(100); }
    const diagnostic = await evaluate(`({url:location.href,body:document.body.innerText.slice(0,250),debug:typeof window.__CLIENT_DEBUG__,models:window.__CLIENT_DEBUG__?.renderer.modelDebug(),boss:window.__CLIENT_DEBUG__?.renderer.bossDebug()})`);
    evidence.consoleErrors = errors();
    throw new Error('Not ready: ' + expression + '\n' + JSON.stringify(diagnostic) + '\n' + JSON.stringify(evidence.consoleErrors));
  };
  const run = body => evaluate(`(() => {const d=window.__CLIENT_DEBUG__,K=d.kernel,C=K.CONFIG;let m=d.match,p=m.players[0];${body}})()`);
  const key = async (code, value, vk) => {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: value, windowsVirtualKeyCode: vk });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: value, windowsVirtualKeyCode: vk });
  };
  const mouse = (type, button = 'right', xy = { x: 640, y: 360 }) => S('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...xy });
  const click = async selector => {
    const xy = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await mouse('mousePressed', 'left', xy); await mouse('mouseReleased', 'left', xy);
  };
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;
  const errors = () => events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
    (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))).map(e => ({ method: e.method, params: e.params }));
  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = () => 0;' });
  await S('Page.navigate', { url: 'http://127.0.0.1:8125/dev/client.html?seed=11' });
  await wait('!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5 && __CLIENT_DEBUG__.renderer.bossDebug().glbLoaded');
  evidence.checks.devPreview = await run('d.pause();d.pump(.05);return {models:d.renderer.modelDebug(),weapon:p.weapon,quickWall:typeof d.quickWall};');
  assert.equal(evidence.checks.devPreview.quickWall, 'function');
  evidence.checks.devPreview.messages = errors();
  assert.ok(evidence.checks.devPreview.messages.every(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'warning' &&
    e.params.args[0]?.value.startsWith('Scripts "build/three.js" and "build/three.min.js" are deprecated')));
  events.length = 0;
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  evidence.offlineEmulation = true;
  evidence.fileUrl = pathToFileURL(path.join(root, 'dist/inkline.html')).href + '?seed=11';
  await S('Page.navigate', { url: evidence.fileUrl });
  await wait('!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5 && __CLIENT_DEBUG__.renderer.bossDebug().glbLoaded');
  await run('d.pause();d.restart();m=d.match;p=m.players[0];m.enemies.length=0;d.pump(.05);');
  await click('#enter-btn');
  await wait('__CLIENT_DEBUG__.input.locked');
  evidence.checks.entry = await run("return {locked:d.input.locked,fullscreen:!!document.fullscreenElement,hint:getComputedStyle(document.querySelector('#lock-hint')).display,ammo:p.ammo};");
  assert.deepEqual(evidence.checks.entry, { locked: true, fullscreen: false, hint: 'none', ammo: 18 });
  await run('d.audio.setMuted(true);'); // Set up the explicit unmute check; fresh sound now defaults on.
  await key('KeyM', 'm', 77);
  await wait('__CLIENT_DEBUG__.audio.debug().state === "running"');
  const pictures = [];

  await key('Digit2', '2', 50);
  evidence.checks.marker = await run(`
    d.step(4);d.teleport(0,-13);d.aimAt(0,.95,-18);d.pump(.2);
    const ammo=p.ammo,start=m.events.length;const shot=d.shoot();
    const impacts=m.events.slice(start).filter(e=>e.type==='impact');d.pump(0);
    const splats=d.renderer.scene.children.filter(o=>o.userData.splat);
    return {weapon:p.weapon,ammoSpent:ammo-p.ammo,shot,impacts:impacts.length,playerSplats:splats.every(o=>!o.userData.splat.enemy),
      splats:splats.length,colors:[...new Set(splats.map(o=>o.material.color.getHexString()))],visual:d.renderer.modelDebug(),
      tab:document.querySelector('.weapon-tag.selected').textContent,cap:document.querySelector('#ammo-cap').textContent};`);
  assert.equal(evidence.checks.marker.weapon, 1);
  assert.equal(evidence.checks.marker.ammoSpent, 1);
  assert.equal(evidence.checks.marker.impacts, 5);
  assert.equal(evidence.checks.marker.shot.ends.length, 5);
  assert.equal(evidence.checks.marker.visual.tracers, 5);
  assert.ok(evidence.checks.marker.playerSplats && evidence.checks.marker.splats >= 5);
  assert.match(evidence.checks.marker.tab, /2荧光笔/);
  assert.equal(evidence.checks.marker.cap, '/6');
  pictures.push(await capture());

  await run('d.restart();m=d.match;p=m.players[0];m.enemies.length=0;d.teleport(4,-12);const b=d.spawnBoss();b.x=4;b.z=-4;b.faceYaw=Math.PI;d.aimAt(4,1.2,-4);d.pump(.1);');
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb');
  await key('Digit3', '3', 51);
  await run('d.pump(.2);');
  await mouse('mousePressed');
  evidence.checks.scope = await run(`d.pump(.4);return {ads:d.input.ads,visual:d.renderer.modelDebug(),scope:getComputedStyle(document.querySelector('#scope-overlay')).display,crosshair:getComputedStyle(document.querySelector('#crosshair')).display,cap:document.querySelector('#ammo-cap').textContent};`);
  assert.equal(evidence.checks.scope.ads, true);
  assert.ok(Math.abs(evidence.checks.scope.visual.fov - 28) < .1);
  assert.equal(evidence.checks.scope.visual.gun.visible, false);
  assert.equal(evidence.checks.scope.scope, 'block');
  assert.equal(evidence.checks.scope.crosshair, 'none');
  assert.equal(evidence.checks.scope.cap, '/5');
  pictures.push(await capture());
  await mouse('mouseReleased');
  assert.equal(await run('return d.input.ads;'), false);
  await mouse('mousePressed');
  await run('p.ammo=4;');
  await key('KeyR', 'r', 82);
  evidence.checks.reloadADS = await run('d.pump(.4);return {ads:d.input.ads,reload:p.reload,fov:d.renderer.camera.fov};');
  assert.equal(evidence.checks.reloadADS.ads, false);
  assert.equal(evidence.checks.reloadADS.reload, 1.55);
  assert.ok(Math.abs(evidence.checks.reloadADS.fov - 68) < .1);
  await mouse('mouseReleased');
  await run('p.reload=0;'); await mouse('mousePressed'); await key('Digit1', '1', 49);
  assert.equal(await run('return d.input.ads;'), false);
  await mouse('mouseReleased'); await key('Digit3', '3', 51); await mouse('mousePressed');
  evidence.checks.downADS = await run('d.downPlayer(0);d.pump(.05);return {ads:d.input.ads,gun:d.renderer.modelDebug().gun.visible};');
  assert.deepEqual(evidence.checks.downADS, { ads: false, gun: false });
  await mouse('mouseReleased');

  await run(`d.restart();m=d.match;p=m.players[0];m.enemies.length=0;m.phase='boss';m.anchorsDone=3;m.anchors.forEach(a=>a.active=true);
    d.teleport(4,-10);const b=d.spawnBoss();b.x=4;b.z=-4.8;b.faceYaw=Math.PI;d.aimAt(4,1.85,-4.8);d.pump(.2);`);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb');
  await key('KeyQ', 'q', 81);
  await key('KeyG', 'g', 71);
  evidence.checks.quickWall = await run(`d.pump(0);return {walls:m.walls.length,wall:m.walls[0],ink:p.ink,toast:document.querySelector('#hud-toast').textContent};`);
  assert.equal(evidence.checks.quickWall.walls, 1);
  assert.ok(Math.abs(evidence.checks.quickWall.wall.len - 3.2) < 1e-9);
  assert.ok(Math.abs(evidence.checks.quickWall.ink - 67.2) < 1e-9);
  assert.equal(evidence.checks.quickWall.toast, '速墙已立起!');
  evidence.checks.wallStun = await run(`
    const b=m.boss;b.state='charge';b.telegraph=C.boss.chargeTelegraph-.01;d.step();d.pump(.01);
    for(let i=0;i<6&&!b.stunT;i++){d.step();d.pump(.01);}
    const first=d.renderer.bossDebug();d.pump(.15);const last=d.renderer.bossDebug();
    return {stun:b.stunT,state:b.state,wallHp:m.walls[0].hp,hp:p.hp,first,last,
      chip:document.querySelector('#boss-state-chip').textContent,grace:getComputedStyle(document.querySelector('#grace-banner')).display};`);
  assert.equal(evidence.checks.wallStun.stun, 2.2);
  assert.equal(evidence.checks.wallStun.state, 'idle');
  assert.equal(evidence.checks.wallStun.wallHp, 75);
  assert.ok(evidence.checks.wallStun.last.dizzy);
  assert.equal(evidence.checks.wallStun.last.cur, 'Hit');
  assert.notEqual(evidence.checks.wallStun.first.dizzyAngle, evidence.checks.wallStun.last.dizzyAngle);
  assert.match(evidence.checks.wallStun.chip, /破盾眩晕 2.2s/);
  assert.equal(evidence.checks.wallStun.grace, 'none');
  pictures.push(await capture());
  evidence.checks.stunCrit = await run(`d.aimAt(m.boss.x,2.05,m.boss.z);p.fireCd=0;const hp=m.boss.hp;d.shoot();d.pump(0);return {dealt:hp-m.boss.hp,text:[...document.querySelectorAll('.dmg-float')].map(e=>e.textContent)};`);
  assert.equal(evidence.checks.stunCrit.dealt, 38);
  assert.ok(evidence.checks.stunCrit.text.includes('暴击 -38!'));

  await run(`d.restart();m=d.match;p=m.players[0];m.enemies.length=0;m.phase='boss';m.anchorsDone=3;m.anchors.forEach(a=>a.active=true);
    d.teleport(4,-10);const b=d.spawnBoss();b.x=4;b.z=-4;b.faceYaw=Math.PI;d.aimAt(4,1.15,-4);d.pump(.1);`);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb');
  evidence.checks.belly = await run(`const b=m.boss;b.state='summon';b.telegraph=C.boss.summonTelegraph-.01;d.step();d.pump(.75);
    const hp=b.hp;p.fireCd=0;d.shoot();d.pump(.14);
    return {dealt:hp-b.hp,expose:b.laughExposeT,debug:d.renderer.bossDebug(),chip:document.querySelector('#boss-state-chip').textContent,
      floats:[...document.querySelectorAll('.dmg-float')].filter(e=>e.style.display==='block').map(e=>({text:e.textContent,color:e.style.color,weight:e.style.fontWeight}))};`);
  assert.equal(evidence.checks.belly.dealt, 38);
  assert.equal(evidence.checks.belly.debug.cur, 'LaughAttack');
  assert.equal(evidence.checks.belly.debug.belly, true);
  assert.equal(evidence.checks.belly.debug.clips.length, 6);
  assert.ok(evidence.checks.belly.floats.some(e => e.text === '暴击 -38!' && e.weight === '900'));
  pictures.push(await capture());
  await key('KeyE', 'e', 69);
  evidence.checks.interrupt = await run(`d.pump(0);return {stun:m.boss.stunT,expose:m.boss.laughExposeT,debug:d.renderer.bossDebug(),toast:document.querySelector('#hud-toast').textContent};`);
  assert.equal(evidence.checks.interrupt.stun, 2);
  assert.equal(evidence.checks.interrupt.expose, 0);
  assert.equal(evidence.checks.interrupt.debug.cur, 'Hit');
  assert.equal(evidence.checks.interrupt.debug.laughT, 0);
  assert.ok(evidence.checks.interrupt.debug.audio.active === 0 || evidence.checks.interrupt.debug.audio.stopping);
  assert.equal(evidence.checks.interrupt.debug.audio.pending, false);
  assert.match(evidence.checks.interrupt.toast, /擦除打断/);
  await wait('__CLIENT_DEBUG__.renderer.bossAudioDebug().active === 0');
  evidence.checks.interrupt.audioStopped = await run('return d.renderer.bossAudioDebug().active === 0 && !d.renderer.bossAudioDebug().pending;');
  assert.equal(evidence.checks.interrupt.audioStopped, true);

  evidence.checks.quickFail = await run(`p.ink=28;const walls=m.walls.length;const result=d.quickWall();return {result,unchanged:walls===m.walls.length,ink:p.ink,toast:document.querySelector('#hud-toast').textContent};`);
  assert.equal(evidence.checks.quickFail.result.reason, 'ink');
  assert.ok(evidence.checks.quickFail.unchanged);
  assert.equal(evidence.checks.quickFail.ink, 28);
  evidence.checks.sounds = await run(`return (async()=>{d.audio.stop();await new Promise(r=>setTimeout(r,80));const start=d.audio.debug().starts;
    for(const name of ['weaponSwitch','crit','bossStun']){d.audio[name]();d.audio.stop();await new Promise(r=>setTimeout(r,80));}
    for(let i=0;i<3;i++){d.audio.shot(i);d.audio.stop();await new Promise(r=>setTimeout(r,80));}
    return {starts:d.audio.debug().starts-start,debug:d.audio.debug()};})();`);
  assert.equal(evidence.checks.sounds.starts, 6);
  assert.equal(evidence.checks.sounds.debug.active, 0);
  await key('KeyM', 'm', 77);
  assert.ok(await run('return d.audio.isMuted()&&d.renderer.bossAudioDebug().muted;'));
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await wait('__CLIENT_DEBUG__.audio.debug().reducedMotion');
  evidence.checks.reducedMotion = await run('d.audio.setMuted(false);d.pump(.05);return {muted:d.audio.isMuted(),visual:d.renderer.modelDebug().reducedMotion};');
  assert.deepEqual(evidence.checks.reducedMotion, { muted: true, visual: true });
  await S('Emulation.setEmulatedMedia', { features: [] });
  await evaluate('document.exitPointerLock();');
  await wait('!__CLIENT_DEBUG__.input.locked');
  await click('#fs-btn');
  await wait('!!document.fullscreenElement');
  assert.equal(await run('return d.input.locked;'), false);
  await click('#fs-btn');
  await wait('!document.fullscreenElement');
  evidence.checks.fullscreen = { independentEnterAndExit: true, pointerLockNotRequested: true };
  evidence.externalRequests = events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request.url).filter(url => /^(https?|wss?):/.test(url));
  evidence.consoleErrors = errors();
  assert.deepEqual(evidence.externalRequests, []);
  assert.deepEqual(evidence.consoleErrors, []);
  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');const images=${JSON.stringify(pictures)};
    for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,i%2*1280,Math.floor(i/2)*720,1280,720);}return c.toDataURL('image/png').split(',')[1];})()`);
  fs.writeFileSync(path.join(root, 'N5-Open/renders/SPRINT-B-verify.png'), Buffer.from(sheet, 'base64'));
  evidence.passed = true;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.passed = false; evidence.failure = error.stack;
  console.error(error.stack); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'N5-Open/reports/SPRINT-B-browser.json'), JSON.stringify(evidence, null, 2));
  if (send && ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
  ws?.close();
  if (chrome.exitCode === null) { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)); }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
