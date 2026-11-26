import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.CDP_PORT || 9343);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-sprint-c-'));
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
  const mouse = (type, button = 'right', xy = { x: 640, y: 360 }) => S('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...xy });
  const click = async selector => {
    const xy = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await mouse('mousePressed', 'left', xy); await mouse('mouseReleased', 'left', xy);
  };
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;
  const booted = '!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5 && __CLIENT_DEBUG__.renderer.bossDebug().glbLoaded';
  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = fn => {window.__testFrame=fn;return 0;};' });
  await S('Page.navigate', { url: 'http://127.0.0.1:8126/dev/client.html?seed=11' });
  await wait(booted);
  evidence.checks.devPreview = await run('d.pause();d.pump(0);return {title:document.title,guide:d.guide.state(),settings:d.settings(),models:d.renderer.modelDebug().loaded};');
  assert.equal(evidence.checks.devPreview.title, '墨线突围 · INKLINE');
  assert.ok(errors().every(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'warning' && e.params.args[0]?.value.startsWith('Scripts "build/three.js"')));
  evidence.checks.devPreview.messages = errors(); events.length = 0;
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  evidence.offlineEmulation = true;
  evidence.fileUrl = pathToFileURL(path.join(root, 'dist/inkline.html')).href + '?seed=11';
  await S('Page.navigate', { url: evidence.fileUrl }); await wait(booted);
  await run('d.restart();d.aimAt(0,1,0);d.pump(.05);');
  await click('#enter-btn'); await wait('__CLIENT_DEBUG__.input.locked');
  await run('d.audio.setMuted(true);'); // Set up the explicit unmute check; fresh sound now defaults on.
  await key('KeyM', 'm', 77);
  evidence.checks.guide = await run("return {guide:d.guide.state(),locked:d.input.locked,ammo:p.ammo,visible:getComputedStyle(document.querySelector('#guide-card')).display};");
  assert.equal(evidence.checks.guide.guide.step, 1);
  assert.equal(evidence.checks.guide.locked, true); assert.equal(evidence.checks.guide.ammo, 18);
  const pictures = [await capture()];
  await key('Digit2', '2', 50); await run('d.pump(.1);');
  assert.equal(await run('return d.guide.state().step;'), 2);
  await key('KeyH', 'h', 72); assert.equal(await run('return d.settings().showGuide;'), false);
  await key('KeyH', 'h', 72); assert.equal(await run('return d.settings().showGuide;'), true);

  await run('m.enemies.length=0;d.teleport(K.ANCHORS[0].x,K.ANCHORS[0].z);d.setHold(true);d.step(45);d.pump(.05);');
  evidence.checks.offer = await run("return {active:m.anchors[0].active,choices:d.perkChoices(),panels:d.panels(),text:document.querySelector('#perk-overlay').innerText,locked:d.input.locked};");
  assert.equal(evidence.checks.offer.active, true);
  assert.equal(evidence.checks.offer.choices.length, 3);
  assert.equal(evidence.checks.offer.panels.perkPaused, true);
  for (const label of ['[Z]', '[X]', '[V]']) assert.ok(evidence.checks.offer.text.includes(label));
  pictures.push(await capture());
  evidence.checks.modalClock = await run('const t=m.tick;window.__testFrame(performance.now()+5000);const frameTick=m.tick;d.runtime.tickOnce();d.pump(0);return {t,frameTick,manualTick:m.tick};');
  assert.equal(evidence.checks.modalClock.t, evidence.checks.modalClock.frameTick);
  assert.equal(evidence.checks.modalClock.manualTick, evidence.checks.modalClock.t + 1);
  await key('Tab', 'Tab', 9); assert.equal(await run('return d.panels().perkPaused;'), false);
  await key('Tab', 'Tab', 9); assert.equal(await run('return d.panels().perkPaused;'), true);
  const picked = evidence.checks.offer.choices[0];
  await key('KeyZ', 'z', 90); await run('d.pump(.1);');
  evidence.checks.pick = await run("return {perks:p.perks,locked:d.input.locked,panels:d.panels(),chips:document.querySelector('#perk-chips').innerText,toast:document.querySelector('#hud-toast').innerText};");
  assert.deepEqual(evidence.checks.pick.perks, [picked]); assert.equal(evidence.checks.pick.locked, true);
  assert.equal(evidence.checks.pick.panels.perkPaused, false);
  assert.match(evidence.checks.pick.toast, /已装订强化/);

  await key('KeyO', 'o', 79); await wait('!__CLIENT_DEBUG__.input.locked');
  evidence.checks.settings = await run("return {panels:d.panels(),ads:d.input.ads,rangeCount:document.querySelectorAll('#settings-overlay input[type=range]').length,text:document.querySelector('#settings-overlay').innerText};");
  assert.equal(evidence.checks.settings.panels.settingsPaused, true);
  assert.equal(evidence.checks.settings.rangeCount, 4); assert.equal(evidence.checks.settings.ads, false);
  await evaluate(`(() => {const inputs=[...document.querySelectorAll('#settings-overlay input[type=range]')];const values=['0.0034','82','0.6','0.22'];inputs.forEach((el,i)=>{el.value=values[i];el.dispatchEvent(new Event('input',{bubbles:true}));});})()`);
  await run('d.pump(.4);');
  evidence.checks.liveSettings = await run('return {settings:d.settings(),fov:d.renderer.camera.fov,audio:d.audio.debug(),boss:d.renderer.bossAudioDebug(),stored:JSON.parse(localStorage.getItem(C.storage.settings))};');
  assert.equal(evidence.checks.liveSettings.settings.fov, 82);
  assert.equal(evidence.checks.liveSettings.settings.sensitivity, .0034);
  assert.equal(evidence.checks.liveSettings.settings.sfxVolume, .6);
  assert.equal(evidence.checks.liveSettings.settings.bossVolume, .22);
  assert.equal(evidence.checks.liveSettings.stored.fov, 82);
  pictures.push(await capture());
  await key('KeyO', 'o', 79); assert.equal(await run('return d.panels().settingsPaused;'), false);
  await click('#enter-btn'); await wait('__CLIENT_DEBUG__.input.locked');
  await key('Digit3', '3', 51); await mouse('mousePressed');
  const adsFov = await run('d.pump(.5);return d.renderer.camera.fov;'); assert.ok(Math.abs(adsFov-28)<.1);
  await mouse('mouseReleased');
  const baseFov = await run('d.pump(.5);return d.renderer.camera.fov;'); assert.ok(Math.abs(baseFov-82)<.1);
  evidence.checks.customADS = { adsFov, baseFov };
  await key('KeyO', 'o', 79); await wait('!__CLIENT_DEBUG__.input.locked');
  await evaluate(`Array.from(document.querySelectorAll('#settings-overlay button')).find(el=>el.textContent.includes('恢复默认')).click()`);
  assert.equal(await run('return d.settings().fov;'), 68);
  assert.equal(await run('return d.settings().sfxVolume;'), .85);
  await key('KeyO', 'o', 79);

  const playthrough = fs.readFileSync(path.join(root, 'tests/offline-playthrough.mjs'), 'utf8');
  const botSetup = playthrough.slice(playthrough.indexOf('const setup = `') + 'const setup = `'.length, playthrough.indexOf('`;\nconsole.log(\'bot:\''))
    .replace('d.pause(true);', 'd.pause(false);');
  assert.ok(botSetup.startsWith('(() => {') && botSetup.endsWith('})()'));
  await evaluate(botSetup);
  const selections = [];
  let final;
  for (let i=0;i<80;i++) {
    const result = await evaluate(`(() => {const d=window.__CLIENT_DEBUG__,picks=[];let state;for(let i=0;i<100;i++){state=window.__bot.run(1);const choices=d.perkChoices();if(choices.length){const id=['heavy_nib','armor_pierce','quick_ink','thick_wall','wide_erase','light_feet'].find(id=>choices.includes(id));const result=d.pickPerk(id);picks.push({id,ok:result.ok,tick:state.tick});d.pump(0);}if(state.phase==='won'||state.phase==='lost')break;}return {state,picks};})()`);
    final=result.state; selections.push(...result.picks);
    if (final.phase==='won'||final.phase==='lost') break;
  }
  assert.equal(final.phase, 'won'); assert.equal(selections.length, 3); assert.ok(selections.every(p=>p.ok));
  await run('d.pump(.05);');
  evidence.checks.perkedPlaythrough = { final, selections, settlement: await run("return {text:document.querySelector('#end-card').innerText,perks:p.perks,panels:d.panels(),newSeed:!!document.querySelector('#new-seed-btn')};") };
  assert.equal(evidence.checks.perkedPlaythrough.settlement.perks.length, 3);
  assert.equal(evidence.checks.perkedPlaythrough.settlement.panels.perkPaused, false);
  evidence.checks.settlementVisible = await evaluate("getComputedStyle(document.querySelector('#lock-hint')).display==='none' && !!document.elementFromPoint(640,360).closest('#end-card')");
  assert.equal(evidence.checks.settlementVisible, true);
  pictures.push(await capture());
  await click('#restart-btn');
  evidence.checks.restart = await run('return {seed:d.state().seed,perks:p.perks,panels:d.panels(),guide:d.guide.state()};');
  assert.equal(evidence.checks.restart.seed, 11); assert.equal(evidence.checks.restart.perks.length, 0);
  assert.equal(evidence.checks.restart.guide.step, 1);
  await run("m.events.push({type:'win',data:{}});d.pump(0);");
  await click('#new-seed-btn');
  evidence.checks.newSeed = await run('return {seed:d.state().seed,perks:p.perks,panels:d.panels()};');
  assert.notEqual(evidence.checks.newSeed.seed, 11); assert.equal(evidence.checks.newSeed.perks.length, 0);

  await run('m.enemies.length=0;d.teleport(K.ANCHORS[0].x,K.ANCHORS[0].z);d.setHold(true);d.step(45);d.pump(0);');
  const mouseChoice = await run('return d.perkChoices()[1];');
  const ammoBeforeClick = await run('return p.ammo;');
  await click('#perk-cards button:nth-child(2)'); await run('d.pump(.1);');
  evidence.checks.mousePick = await run('return {perks:p.perks,ammo:p.ammo,locked:d.input.locked,visible:d.panels().perkVisible};');
  assert.deepEqual(evidence.checks.mousePick.perks, [mouseChoice]);
  assert.equal(evidence.checks.mousePick.ammo, ammoBeforeClick);
  assert.equal(evidence.checks.mousePick.locked, false);
  assert.equal(evidence.checks.mousePick.visible, false);

  await run("d.setSettings({sensitivity:.004,fov:90,sfxVolume:.4,bossVolume:.2,showGuide:false});");
  await S('Page.navigate', { url: evidence.fileUrl }); await wait(booted);
  evidence.checks.persistence = await run('return d.settings();');
  assert.equal(evidence.checks.persistence.fov, 90); assert.equal(evidence.checks.persistence.showGuide, false);
  await run("localStorage.setItem(C.storage.settings,'broken{');");
  await S('Page.navigate', { url: evidence.fileUrl }); await wait(booted);
  evidence.checks.corruptSettings = await run('return d.settings();');
  assert.equal(evidence.checks.corruptSettings.fov, 68);
  assert.equal(evidence.checks.corruptSettings.showGuide, true);
  await click('#start-settings-btn'); assert.equal(await run('return d.panels().settingsPaused;'), true);
  await S('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  evidence.checks.smallSettings = await evaluate(`(() => {const e=document.querySelector('#settings-overlay').firstElementChild,r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
  assert.ok(evidence.checks.smallSettings.left>=0 && evidence.checks.smallSettings.right<=800);
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  evidence.externalRequests = events.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.params.request.url).filter(url=>/^(https?|wss?):/.test(url));
  evidence.consoleErrors = errors();
  assert.deepEqual(evidence.externalRequests, []); assert.deepEqual(evidence.consoleErrors, []);
  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');const images=${JSON.stringify(pictures)};for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,i%2*1280,Math.floor(i/2)*720,1280,720);}return c.toDataURL('image/png').split(',')[1];})()`);
  fs.writeFileSync(path.join(root,'N5-Open/renders/SPRINT-C-verify.png'),Buffer.from(sheet,'base64'));
  evidence.passed=true;
  console.log(JSON.stringify(evidence,null,2));
} catch(error) {
  evidence.passed=false; evidence.failure=error.stack; console.error(error.stack); process.exitCode=1;
} finally {
  fs.writeFileSync(path.join(root,'N5-Open/reports/SPRINT-C-browser.json'),JSON.stringify(evidence,null,2));
  if(send && ws?.readyState===WebSocket.OPEN) await send('Browser.close').catch(()=>{});
  ws?.close();
  if(chrome.exitCode===null){chrome.kill();await new Promise(resolve=>chrome.once('exit',resolve));}
  fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
