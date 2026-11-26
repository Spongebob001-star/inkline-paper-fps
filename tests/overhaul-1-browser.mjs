import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CDP_PORT || 9347);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-overhaul1-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { started: new Date().toISOString(), checks: {}, externalRequests: [], consoleErrors: [] };
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
  const errors = () => events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
    (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)));
  const wait = async expression => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('Not ready: ' + expression + '\n' + JSON.stringify(errors()));
  };
  const run = body => evaluate(`(() => {const d=window.__CLIENT_DEBUG__,K=d.kernel,C=K.CONFIG;let m=d.match,p=m.players[0];${body}})()`);
  const key = async (code, value, vk) => {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', code, key: value, windowsVirtualKeyCode: vk });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', code, key: value, windowsVirtualKeyCode: vk });
  };
  const click = async selector => {
    const xy = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...xy });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...xy });
  };
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;
  const booted = '!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5 && __CLIENT_DEBUG__.renderer.bossDebug().glbLoaded';
  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.requestAnimationFrame = fn => { window.__testFrame = fn; return 0; };
    window.__audioContexts = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); this.testGains=[]; window.__audioContexts.push(this); }
      createGain() { const node=super.createGain(); this.testGains.push(node); return node; }
    };
  ` });
  await S('Page.navigate', { url: 'http://127.0.0.1:8127/dev/client.html?seed=11' });
  await wait(booted);
  evidence.checks.devPreview = await run('d.pause(true);d.pump(.05);return {title:document.title,models:d.renderer.modelDebug().loaded};');
  assert.ok(errors().every(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'warning' && e.params.args[0]?.value.startsWith('Scripts "build/three.js"')));
  events.length = 0;
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  evidence.offlineEmulation = true;
  evidence.fileUrl = pathToFileURL(path.join(root, 'dist/inkline.html')).href + '?seed=11';
  await S('Page.navigate', { url: evidence.fileUrl }); await wait(booted);
  evidence.checks.initialAudio = await run('return d.audio.debug();');
  assert.equal(evidence.checks.initialAudio.muted, false);
  assert.equal(evidence.checks.initialAudio.state, 'locked');
  await click('#enter-btn'); await wait('__CLIENT_DEBUG__.input.locked && __CLIENT_DEBUG__.audio.debug().state==="running"');
  evidence.checks.firstGesture = await run('const before=d.audio.debug().starts;d.shoot();d.pump(.01);return {before,after:d.audio.debug().starts,audio:d.audio.debug(),locked:d.input.locked};');
  assert.equal(evidence.checks.firstGesture.after, evidence.checks.firstGesture.before + 1);
  assert.equal(evidence.checks.firstGesture.audio.masterPeak, .62);
  assert.equal(evidence.checks.firstGesture.audio.maxVoices, 14);
  await run('d.audio.stop();');
  await wait('__CLIENT_DEBUG__.audio.debug().active===0');
  evidence.checks.measuredShots = [];
  for (const weapon of [0, 1, 2]) {
    const measured = await evaluate(`(async()=>{
      const d=window.__CLIENT_DEBUG__;const ctx=window.__audioContexts.find(c=>c.testGains.some(g=>Math.abs(g.gain.value-.62)<1e-6));
      const bus=ctx.testGains.find(g=>Math.abs(g.gain.value-.62)<1e-6),analyser=ctx.createAnalyser();analyser.fftSize=2048;bus.connect(analyser);
      const data=new Float32Array(analyser.fftSize);let peak=0,sum=0,count=0;d.audio.shot(${weapon});
      await new Promise(resolve=>{const start=performance.now();const timer=setInterval(()=>{analyser.getFloatTimeDomainData(data);for(const v of data){peak=Math.max(peak,Math.abs(v));sum+=v*v;count++;}if(performance.now()-start>700){clearInterval(timer);resolve();}},8);});
      bus.disconnect(analyser);analyser.disconnect();return {weapon:${weapon},peak,rms:Math.sqrt(sum/count),frames:count,audio:d.audio.debug()};
    })()`);
    assert.ok(measured.peak > .025 && measured.peak <= 1, 'audible, finite, bounded output');
    evidence.checks.measuredShots.push(measured);
  }
  await key('KeyM', 'm', 77); assert.equal(await run('return d.audio.isMuted();'), true);
  await key('KeyM', 'm', 77); assert.equal(await run('return d.audio.isMuted();'), false);

  const prepare = async weapon => run(`d.restart();d.pause(true);d.setSettings({...d.settings(),showGuide:false});m=d.match;p=m.players[0];m.enemies.length=0;d.teleport(0,-15);d.aimAt(0,.95,-11);d.weapon(${weapon});d.pump(3);return d.renderer.modelDebug();`);
  const pictures = [];
  evidence.checks.weapons = [];
  for (const weapon of [0, 1, 2]) {
    await prepare(weapon);
    if (weapon === 2) {
      await run("for(let i=0;i<3;i++){const e=K.createEnemy(m,'crane',0,-11);e.armor=0;e.hp=1;d.pump(.5);p.fireCd=0;p.ammo=9;d.shoot();d.pump(.01);m.enemies=m.enemies.filter(e=>!e.dead);}");
    }
    await run(`const e=K.createEnemy(m,'crane',0,-11);e.armor=${weapon === 0 ? 'C.enemy.armor' : '0'};e.hp=${weapon === 0 ? 'C.enemy.hp' : '1'};d.pump(.4);p.fireCd=0;p.ammo=C.player.weapons[${weapon}].magazine;`);
    const shot = await run('const origin=d.renderer.overhaulDebug().weapons[p.weapon].muzzle;const result=d.shoot();d.pump([.045,.075,.20][p.weapon]);return {ok:result.ok,origin,ammo:p.ammo,model:d.renderer.modelDebug(),detail:d.renderer.overhaulDebug(),feedback:d.hud.feedbackDebug(),stamp:document.querySelector("#kill-stamp-label").textContent};');
    assert.equal(shot.ok, true);
    assert.equal(shot.model.weapon, weapon);
    assert.equal(shot.model.tracers, weapon === 1 ? 5 : 1);
    if (weapon === 2) assert.match(shot.stamp, /墨影无双/);
    const detail = shot.detail, view = detail.weapons[weapon];
    assert.ok(view.partCount >= 15 && view.partCount <= 25);
    assert.equal(view.muzzleLayers, 3);
    assert.equal(detail.pool.capacity, 180);
    for (const beam of detail.beams) {
      assert.equal(beam.geometry, 'CylinderGeometry');
      assert.equal(beam.radius, [.016, .024, .028][weapon]);
      assert.equal(beam.life, [.09, .11, .24][weapon]);
      assert.deepEqual(beam.origin, shot.origin);
      assert.equal(beam.halo, weapon === 2);
    }
    assert.ok(detail.pool.active >= (weapon === 0 ? 10 : 20));
    evidence.checks.weapons.push(shot);
    pictures.push(await capture());
  }
  await prepare(0);
  await run("const a=K.createEnemy(m,'crane',1.3,-11.7),b=K.createEnemy(m,'eraser',-.15,-12),c=K.createEnemy(m,'plane',-1.4,-11.4);a.telegraph=.3;b.telegraph=.35;c.y=1.7;c.state='aim';c.telegraph=.4;d.aimAt(0,.95,-11.7);m.projectiles.push({id:m.nextId++,x:.65,y:1.35,z:-12.2},{id:m.nextId++,x:-.85,y:1.1,z:-12.0});d.pump(.5);m.projectiles[0].z-=.12;m.projectiles[1].z-=.1;d.pump(.04);");
  evidence.checks.enemies = await run('return {state:d.state(),models:d.renderer.modelDebug(),detail:d.renderer.overhaulDebug()};');
  const creatures = evidence.checks.enemies.detail.enemies;
  assert.equal(creatures.find(e => e.type === 'crane').shieldLights, 4);
  assert.equal(creatures.find(e => e.type === 'eraser').legs.length, 6);
  assert.equal(creatures.find(e => e.type === 'plane').target.laser, true);
  assert.equal(evidence.checks.enemies.detail.projectiles.length, 2);
  pictures.push(await capture());
  await run('d.renderer.onEvent({type:"hit",data:{id:m.enemies[0].id,point:{x:1.3,y:1,z:-11.7},crit:true,critKind:"head"}});d.pump(0);');
  evidence.checks.hitFeedback = await run('return d.renderer.overhaulDebug();');
  assert.equal(evidence.checks.hitFeedback.enemies[0].hitKick, 1);
  assert.equal(evidence.checks.hitFeedback.enemies[0].body.rotation[0], -.22);
  assert.deepEqual(evidence.checks.hitFeedback.enemies[0].body.scale, [1.12, .88, 1.12]);
  await run('for(let i=0;i<40;i++)d.renderer.onEvent({type:"impact",data:{point:{x:0,y:1,z:-6},kind:"static"}});d.pump(.01);');
  evidence.checks.particleStress = await run('return d.renderer.overhaulDebug();');
  assert.equal(evidence.checks.particleStress.pool.active, 180);
  await run('d.pump(3);d.restart();d.pump(0);');
  evidence.checks.reset = await run('return {models:d.renderer.modelDebug(),feedback:d.hud.feedbackDebug()};');
  assert.equal(evidence.checks.reset.models.tracers, 0);
  assert.equal(evidence.checks.reset.feedback.combo, 0);
  evidence.checks.rifleDynamics = await run('p.ammo=3;d.pump(0);const low=d.renderer.overhaulDebug().weapons[0];d.reload();p.reload=C.player.weapons[0].reloadTime*.5;d.pump(0);return {low,reload:d.renderer.overhaulDebug().weapons[0]};');
  assert.equal(evidence.checks.rifleDynamics.low.fill, 3 / 18);
  assert.equal(evidence.checks.rifleDynamics.reload.parts.find(p => p.name === 'slanted-magazine').visible, false);
  await prepare(1);
  evidence.checks.pumpDynamics = await run('p.fireCd=0;d.shoot();d.pump(.14);const start=d.renderer.overhaulDebug().weapons[1].pump;d.pump(.07);const back=d.renderer.overhaulDebug().weapons[1].pump;d.pump(.19);return {start,back,home:d.renderer.overhaulDebug().weapons[1].pump};');
  assert.equal(evidence.checks.pumpDynamics.start, 0);
  assert.ok(evidence.checks.pumpDynamics.back > .99);
  assert.equal(evidence.checks.pumpDynamics.home, 0);
  await prepare(2);
  evidence.checks.sniperDynamics = await run('p.fireCd=0;d.shoot();d.pump(0);const empty=d.renderer.overhaulDebug().weapons[2].rings;d.pump(.31);const lift=d.renderer.overhaulDebug().weapons[2];d.pump(.12);const back=d.renderer.overhaulDebug().weapons[2].bolt;d.pump(.42);return {empty,lift,back,charged:d.renderer.overhaulDebug().weapons[2]};');
  assert.deepEqual(evidence.checks.sniperDynamics.empty, [0, 0, 0, 0]);
  assert.ok(evidence.checks.sniperDynamics.lift.boltLift < -.89);
  assert.ok(evidence.checks.sniperDynamics.back > .99);
  assert.ok(evidence.checks.sniperDynamics.charged.rings.every(v => Math.abs(v - 1.6) < 1e-8));
  await run('d.restart();d.pump(0);');
  await key('KeyO', 'o', 79); await wait('!__CLIENT_DEBUG__.input.locked');
  assert.equal(await run('return d.panels().settingsPaused;'), true);
  await key('KeyO', 'o', 79); await click('#enter-btn'); await wait('__CLIENT_DEBUG__.input.locked');
  await key('Digit3', '3', 51); await run('d.pump(.4);d.setSettings({...d.settings(),fov:82});');
  await S('Input.dispatchMouseEvent', { type:'mousePressed',button:'right',clickCount:1,x:640,y:360 });
  evidence.checks.adsFov=await run('d.pump(.5);return d.renderer.camera.fov;');
  assert.ok(Math.abs(evidence.checks.adsFov-28)<.2);
  await S('Input.dispatchMouseEvent', { type:'mouseReleased',button:'right',clickCount:1,x:640,y:360 });
  evidence.checks.baseFov=await run('d.pump(.5);return d.renderer.camera.fov;');
  assert.ok(Math.abs(evidence.checks.baseFov-82)<.2);
  await S('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
  await wait('__CLIENT_DEBUG__.audio.isMuted()');
  evidence.checks.reducedMotion=await run('d.pump(.1);return {audio:d.audio.debug(),models:d.renderer.modelDebug()};');
  assert.equal(evidence.checks.reducedMotion.models.reducedMotion,true);
  evidence.externalRequests=events.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.params.request.url).filter(url=>/^(https?|wss?):/.test(url));
  evidence.consoleErrors=errors();
  assert.deepEqual(evidence.externalRequests,[]);assert.deepEqual(evidence.consoleErrors,[]);
  const sheet=await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');const images=${JSON.stringify(pictures)};for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,i%2*1280,Math.floor(i/2)*720,1280,720);}return c.toDataURL('image/png').split(',')[1];})()`);
  fs.writeFileSync(path.join(root,'N5-Open/renders/OVERHAUL-1-verify.png'),Buffer.from(sheet,'base64'));
  evidence.passed=true;console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  evidence.passed=false;evidence.failure=error.stack;console.error(error.stack);process.exitCode=1;
} finally {
  fs.writeFileSync(path.join(root,'N5-Open/reports/OVERHAUL-1-browser.json'),JSON.stringify(evidence,null,2));
  if(send&&ws?.readyState===WebSocket.OPEN)await send('Browser.close').catch(()=>{});
  ws?.close();
  if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
