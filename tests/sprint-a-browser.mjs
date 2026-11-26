import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CDP_PORT || 9341);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-sprint-a-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { started: new Date().toISOString(), checks: {}, screenshots: 'controlled real WebGL scenes; no mocked renderer', errors: [] };
let ws, send;
try {
  let endpoint;
  for (let n = 0; n < 80; n++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch (_) {}
    if (endpoint) break;
    await sleep(100);
  }
  assert.ok(endpoint, 'Chrome ready');
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map(), events = [];
  let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
    else if (message.method) events.push(message);
  };
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 45000);
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
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error('Not ready: ' + expression);
  };
  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = () => 0;' });
  await S('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/inkline.html')).href + '?seed=11' });
  await wait('!!window.__CLIENT_DEBUG__');
  await wait('__CLIENT_DEBUG__.renderer.modelDebug().loaded.length === 5 && __CLIENT_DEBUG__.renderer.bossDebug().glbLoaded');
  const run = body => evaluate(`(() => { const d=window.__CLIENT_DEBUG__, K=d.kernel, C=K.CONFIG; let m=d.match, p=m.players[0]; ${body} })()`);
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;
  const pictures = [];
  evidence.checks.boot = await run(`d.pause(true); d.restart();m=d.match;p=m.players[0]; d.aimAt(0,0.8,0); d.pump(.4); return {models:d.renderer.modelDebug(),audio:d.audio.debug(),bossAudio:d.renderer.bossAudioDebug()};`);
  assert.equal(evidence.checks.boot.audio.state, 'locked');
  assert.equal(evidence.checks.boot.audio.muted, false);
  assert.ok(evidence.checks.boot.models.folds.every(Boolean));
  assert.ok(evidence.checks.boot.models.pickups.every(Boolean));
  pictures.push(await capture());

  evidence.checks.lowModels = await run(`
    m.enemies.length=0; K.createEnemy(m,'eraser',2,-6); K.createEnemy(m,'plane',-2,-6); K.createEnemy(m,'crane',0,-5);
    d.pump(.4); return d.renderer.modelDebug();`);
  assert.ok(evidence.checks.lowModels.enemies.some(e => e.model === 'er' && e.white === 'ffffff'));
  assert.ok(evidence.checks.lowModels.enemies.some(e => e.model === 'pl' && e.white === 'ffffff'));

  evidence.checks.wall = await run(`
    m.enemies.length=0; d.teleport(0,-13); d.aimAt(0,1,-9);
    const drawn=d.drawWall(-2,-9,2,-9); d.pump(0);
    const id=m.walls[0].id; d.aimAt(0,1,-9); const shot=d.shoot(); d.pump(0);
    const before=d.renderer.splatsOnWall(id);
    const meshes=d.renderer.scene.children.filter(o=>o.userData.splat?.wallId===id);
    const finite=meshes.every(o=>Number.isFinite(o.position.x)&&Number.isFinite(o.quaternion.w));
    const normal=meshes[0] ? new THREE.Vector3(0,0,1).applyQuaternion(meshes[0].quaternion).toArray() : [];
    m.walls[0].hp=1;
    m.projectiles.push({id:m.nextId++,x:0,y:1,z:-9,vx:0,vy:0,vz:0,damage:8,life:1});
    d.step(); d.pump(0);
    return {drawn,shot,before,after:d.renderer.splatsOnWall(id),finite,normal};`);
  assert.equal(evidence.checks.wall.shot.kind, 'wall');
  assert.ok(evidence.checks.wall.before > 0);
  assert.equal(evidence.checks.wall.after, 0);
  assert.equal(evidence.checks.wall.finite, true);
  assert.ok(evidence.checks.wall.normal[2] < -.99);

  evidence.checks.wallLifetimes = await run(`
    const result={};
    for(const mode of ['wallRemove','wallExpire','snapshot']) {
      m.walls.length=0; p.ink=100; d.pump(0); d.drawWall(-2,-9,2,-9); d.pump(0);
      const w=m.walls[0]; p.fireCd=0; p.ammo=18; d.shoot(); d.pump(0);
      const before=d.renderer.splatsOnWall(w.id);
      if(mode==='snapshot') {m.walls.length=0;d.pump(0);}
      else if(mode==='wallExpire') {w.life=.01;d.step();d.pump(0);}
      else d.renderer.onEvent({type:mode,data:{id:w.id}});
      result[mode]={before,after:d.renderer.splatsOnWall(w.id)};
    }
    return result;`);
  for (const item of Object.values(evidence.checks.wallLifetimes)) { assert.ok(item.before > 0); assert.equal(item.after, 0); }

  evidence.checks.splats = await run(`
    m.walls.length=0; d.pump(0);
    for(let i=0;i<150;i++) m.events.push({type:'impact',data:{point:{x:0,y:1,z:-17.75},kind:'static'}});
    d.pump(0); const cap=d.renderer.splatCount();
    const enemyRed=d.renderer.scene.children.filter(o=>o.userData.splat).every(o=>o.material.color.getHexString()==='e34b3f');
    d.pump(18); const faded=d.renderer.scene.children.filter(o=>o.userData.splat).every(o=>o.material.opacity>0&&o.material.opacity<.84);
    d.pump(2.1); const expired=d.renderer.splatCount();
    d.renderer.onEvent({type:'impact',data:{point:{x:0,y:1,z:-17.75},kind:'static'}});
    d.restart();m=d.match;p=m.players[0]; return {cap,enemyRed,faded,expired,reset:d.renderer.splatCount()};`);
  assert.equal(evidence.checks.splats.cap, 90);
  assert.ok(evidence.checks.splats.enemyRed && evidence.checks.splats.faded);
  assert.equal(evidence.checks.splats.expired, 0); assert.equal(evidence.checks.splats.reset, 0);

  evidence.checks.surfaceNormals = await run(`
    d.teleport(0,-13);m.folds[1].state='wall';m.folds[1].animT=1;d.pump(0);
    d.renderer.onEvent({type:'impact',data:{kind:'fold',point:{x:-8.94,y:1,z:4}}});
    const fold=d.renderer.scene.children.find(o=>o.userData.splat?.kind==='fold');
    const foldNormal=fold ? new THREE.Vector3(0,0,1).applyQuaternion(fold.quaternion).toArray() : [];
    d.renderer.onEvent({type:'impact',data:{kind:'static',point:{x:0,y:1.3,z:0}}});
    const top=d.renderer.scene.children.filter(o=>o.userData.splat?.kind==='static').at(-1);
    const topNormal=new THREE.Vector3(0,0,1).applyQuaternion(top.quaternion).toArray();
    m.folds[1].state='ramp';d.pump(0);
    const cleared=!d.renderer.scene.children.some(o=>o.userData.splat?.kind==='fold');
    d.restart();m=d.match;p=m.players[0];return {foldNormal,topNormal,cleared};`);
  assert.ok(evidence.checks.surfaceNormals.foldNormal[0] > .99);
  assert.ok(evidence.checks.surfaceNormals.topNormal[1] > .99);
  assert.ok(evidence.checks.surfaceNormals.cleared);

  evidence.checks.damage = await run(`
    m.enemies.length=0; const e=K.createEnemy(m,'crane',0,-16);
    d.teleport(0,-13); d.aimAt(0,.75,-16); d.pump(.4);
    e.armor=3;p.fireCd=0;p.ammo=18;d.shoot();d.pump(0);
    const armor=[...document.querySelectorAll('.dmg-float')].map(el=>el.textContent);
    p.fireCd=0;d.shoot();d.pump(0);
    const regular=[...document.querySelectorAll('.dmg-float')].map(el=>el.textContent);
    p.fireCd=0;d.shoot();d.pump(0);
    const kill=document.querySelector('#hitmark').classList.contains('kill');
    d.aimAt(0,1,0);d.pump(0);
    const behind=[...document.querySelectorAll('.dmg-float')].every(el=>getComputedStyle(el).display==='none');
    return {armor,regular,kill,behind,pool:document.querySelectorAll('.dmg-float').length};`);
  assert.ok(evidence.checks.damage.armor.includes('-3') && evidence.checks.damage.armor.includes('破甲!'));
  assert.ok(evidence.checks.damage.regular.includes('-24'));
  assert.ok(evidence.checks.damage.kill && evidence.checks.damage.behind);
  assert.equal(evidence.checks.damage.pool, 16);

  await run('d.audio.setMuted(true);'); // Set up the explicit unmute check; fresh sound now defaults on.
  await S('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await wait('__CLIENT_DEBUG__.audio.debug().state === "running"');
  evidence.checks.unmuted = await run(`return {audio:d.audio.isMuted(),boss:d.renderer.bossAudioDebug().muted,stored:localStorage.getItem('inkline-sound'),button:document.querySelector('#mute-btn').getAttribute('aria-pressed')};`);
  assert.deepEqual(evidence.checks.unmuted, { audio: false, boss: false, stored: 'on', button: 'false' });
  evidence.checks.sounds = await run(`return (async()=>{
    const start=d.audio.debug().starts;
    for(const name of ['shot','reload','hit','armorStrip','kill','wallDraw','erase','fold','pickup','playerHit']) {d.audio[name]();d.audio.stop();await new Promise(r=>setTimeout(r,50));}
    return {start,debug:d.audio.debug()};})();`);
  assert.equal(evidence.checks.sounds.debug.starts - evidence.checks.sounds.start, 10);
  assert.ok(evidence.checks.sounds.debug.active <= 14);
  await sleep(80);
  assert.equal(await run('return d.audio.debug().active;'), 0);
  const muteBox = await evaluate(`(() => {const r=document.querySelector('#mute-btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...muteBox });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...muteBox });
  evidence.checks.muted = await run(`return {audio:d.audio.isMuted(),boss:d.renderer.bossAudioDebug().muted,stored:localStorage.getItem('inkline-sound'),button:document.querySelector('#mute-btn').getAttribute('aria-pressed')};`);
  assert.deepEqual(evidence.checks.muted, { audio: true, boss: true, stored: 'off', button: 'true' });
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await wait('__CLIENT_DEBUG__.audio.debug().reducedMotion');
  evidence.checks.reduced = await run(`d.audio.setMuted(false);d.renderer.onEvent({type:'playerHit',data:{id:0}});d.pump(0);return {audio:d.audio.debug(),boss:d.renderer.bossAudioDebug().muted,visual:d.renderer.modelDebug().reducedMotion};`);
  assert.ok(evidence.checks.reduced.audio.muted && evidence.checks.reduced.boss && evidence.checks.reduced.visual);
  await S('Emulation.setEmulatedMedia', { features: [] });

  await run(`d.restart();m=d.match;p=m.players[0]; d.pause(true); m.enemies.length=0; d.teleport(15,-6);d.aimAt(8,.8,-10);document.querySelector('#lock-hint').style.display='none';
    K.createEnemy(m,'eraser',11,-8);K.createEnemy(m,'plane',10,-11);K.createEnemy(m,'crane',12,-10);d.pump(.4);`);
  pictures.push(await capture());

  evidence.checks.palette = await run(`
    d.restart();m=d.match;p=m.players[0];m.enemies.length=0;d.teleport(0,-12);d.aimAt(0,1,-18);d.pump(.4);
    for(let i=0;i<96;i++){p.ammo=18;p.fireCd=0;d.aimAt(-2.6+(i%12)*.47,.35+Math.floor(i/12)*.23,-18);d.shoot();d.pump(0);}
    const colors=[...new Set(d.renderer.scene.children.filter(o=>o.userData.splat&&!o.userData.splat.enemy).map(o=>o.material.color.getHexString()))];
    const e=K.createEnemy(m,'crane',1.8,-16);e.armor=0;d.pump(.4);p.ammo=18;p.fireCd=0;d.aimAt(e.x,.75,e.z);d.shoot();d.aimAt(0,1,-18);d.pump(0);
    return {colors,muzzle:d.renderer.modelDebug().muzzle,damage:[...document.querySelectorAll('.dmg-float')].some(el=>el.textContent==='-24'&&el.style.display==='block')};`);
  assert.equal(evidence.checks.palette.colors.length, 6);
  assert.ok(evidence.checks.palette.muzzle && evidence.checks.palette.damage);
  pictures.push(await capture());

  await run(`d.restart();m=d.match;p=m.players[0];m.enemies.length=0;d.teleport(4,-9);m.phase='boss';m.anchors.forEach(a=>a.active=true);m.anchorsDone=3;
    const b=d.spawnBoss();b.x=4;b.z=-4;b.faceYaw=Math.PI;b.hp=245;b.raged=false;d.aimAt(4,1.2,-4);d.pump(.4);`);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb');
  evidence.checks.boss = await run(`
    d.pump(.1);const before=m.boss.hp;p.fireCd=0;p.ammo=18;d.shoot();d.pump(0);
    const shieldLoss=before-m.boss.hp;
    const shieldFloat=[...document.querySelectorAll('.dmg-float')].some(el=>el.textContent==='-9');
    p.fireCd=0;const rageBefore=m.boss.hp;d.shoot();d.pump(0);
    return {shieldLoss,shieldFloat,rageLoss:rageBefore-m.boss.hp,debug:d.renderer.bossDebug(),bar:getComputedStyle(document.querySelector('#boss-bar')).display};`);
  assert.equal(evidence.checks.boss.shieldLoss, 9); assert.ok(evidence.checks.boss.shieldFloat);
  assert.equal(evidence.checks.boss.rageLoss, 24); assert.equal(evidence.checks.boss.debug.clips.length, 6);
  assert.equal(evidence.checks.boss.bar, 'flex');
  await run('d.pump(.14);');
  pictures.push(await capture());

  evidence.checks.reload = await run(`p.reload=C.player.gun.reloadTime/2;d.pump(0);return d.renderer.modelDebug().gun;`);
  assert.ok(evidence.checks.reload.y < -.3 && evidence.checks.reload.tilt < -.5);
  await run('p.reload=0;d.pump(0);');
  const button = await evaluate(`(() => {document.querySelector('#lock-hint').style.display='flex';const r=document.querySelector('#enter-btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...button });
  await sleep(150);
  evidence.checks.enter = await run(`return {locked:d.input.locked,fullscreen:!!document.fullscreenElement,status:document.querySelector('#lock-status').textContent,ammo:p.ammo};`);
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 640, y: 570 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 640, y: 570 });
  await sleep(150);
  evidence.checks.lockRetry = await run(`return {locked:d.input.locked,hint:getComputedStyle(document.querySelector('#lock-hint')).display,toast:document.querySelector('#hud-toast').textContent};`);
  assert.equal(evidence.checks.enter.fullscreen, true);
  assert.equal(evidence.checks.lockRetry.locked, true);
  assert.equal(evidence.checks.lockRetry.hint, 'none');
  await evaluate('document.exitPointerLock?.();document.fullscreenElement&&document.exitFullscreen();');
  evidence.externalRequests = events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request.url).filter(url => /^(https?|wss?):/.test(url));
  evidence.errors = events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) || (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))).map(e => ({ method: e.method, params: e.params }));
  assert.deepEqual(evidence.externalRequests, []); assert.deepEqual(evidence.errors, []);
  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');const images=${JSON.stringify(pictures)};for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,(i%2)*1280,Math.floor(i/2)*720,1280,720);}return c.toDataURL('image/png').split(',')[1];})()`);
  fs.writeFileSync(path.join(root, 'N5-Open/renders/SPRINT-A-verify.png'), Buffer.from(sheet, 'base64'));
  evidence.passed = true;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.passed = false; evidence.failure = error.stack;
  console.error(error.stack); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'N5-Open/reports/SPRINT-A-browser.json'), JSON.stringify(evidence, null, 2));
  if (send && ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
  ws?.close();
  if (chrome.exitCode === null) {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
