import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 9349, names = ['INK-01', 'MARK-02', 'LINE-03'], tags = ['INK', 'MARK', 'LINE'];
const evidence = { started: new Date().toISOString(), checks: {}, runtimeErrors: [], consoleErrors: [], externalRequests: [], networkFailures: [], warnings: [], captures: [] };
evidence.visualReview = 'Manual review required: automated checks do not establish absence of hand/weapon intersections.';
const events = [], pending = new Map(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, profile, ws, send, phase = 'startup', spawnError;
const collect = () => {
  evidence.runtimeErrors = events.filter(e => e.method === 'Runtime.exceptionThrown');
  evidence.consoleErrors = events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' || e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
  evidence.warnings = events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'warning' || e.method === 'Log.entryAdded' && e.params.entry.level === 'warning');
  evidence.externalRequests = events.filter(e => ['Network.requestWillBeSent', 'Network.webSocketCreated'].includes(e.method)).map(e => ({ phase: e.phase, url: e.params.request?.url || e.params.url })).filter(e => /^(https?|wss?):/.test(e.url) && !(e.phase === 'preview' && new URL(e.url).origin === 'http://127.0.0.1:8128'));
  evidence.networkFailures = events.filter(e => e.method === 'Network.loadingFailed' || e.method === 'Network.responseReceived' && e.params.response.status >= 400);
};
try {
  const occupied = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  assert.equal(occupied, false, 'CDP 9349 must be free; never attach to another Chrome');
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-hands-'));
  chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--window-size=1280,720', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', error => { spawnError = error; });
  let endpoint;
  for (let n = 0; n < 80; n++) {
    if (spawnError) throw spawnError;
    try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json()).webSocketDebuggerUrl; } catch {}
    if (endpoint) break;
    assert.equal(chrome.exitCode, null, 'Chrome exited before CDP became ready'); await delay(100);
  }
  assert.ok(endpoint, 'Chrome ready'); ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
    else if (message.method) events.push({ ...message, phase });
  };
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 45000);
    pending.set(key, { resolve, reject, timer }); ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (method, params = {}) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const run = body => evaluate(`(() => {const d=window.__CLIENT_DEBUG__,C=d.kernel.CONFIG;const m=d.match,p=m.players[0];${body}})()`);
  const wait = async expression => {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('Not ready: ' + expression);
  };
  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `window.requestAnimationFrame=fn=>{window.__handsRAF=fn;return 0;};window.cancelAnimationFrame=()=>{};` });
  const installProbe = () => evaluate(`window.__handsProbe=(weapon,dt=0)=>{
    const d=window.__CLIENT_DEBUG__,s=d.renderer.scene,c=d.renderer.camera,passes=[],before=s.onBeforeRender;
    s.onBeforeRender=function(...args){passes.push(args[2].layers.mask);return before?.apply(this,args);};
    try{d.pump(dt);}finally{s.onBeforeRender=before;}
    s.updateMatrixWorld(true);const rig=s.getObjectByName('weapon-rig'),all=d.renderer.overhaulDebug().weapons;
    const visible=o=>{for(;o;o=o.parent)if(!o.visible)return false;return true;};
    const views=all.map(v=>{
      const g=s.getObjectByName(v.name),h=g?.getObjectByName('tactical-hands');if(!g||!h)throw Error('Missing hands: '+v.name);
      const local=o=>g.worldToLocal(o.getWorldPosition(c.position.clone())).toArray();
      const members=[];h.traverse(o=>members.push({name:o.name,type:o.type,layer:o.layers.mask,visible:o.visible,mesh:!!o.isMesh,materials:o.material?[].concat(o.material).map(m=>m.type):[]}));
      const find=name=>{const o=h.getObjectByName(name);if(!o)throw Error('Missing '+v.name+'/'+name);return o;};
      const right=find('right-hand'),left=find('left-hand');
      const arms=['right','left'].map(side=>{
        const o=find(side+'-forearm'),geo=o.geometry,wrist=find(side+'-hand');let compatible=false,ndc=null;
        if(geo?.type==='CylinderGeometry'&&Math.abs(geo.parameters.height-1)<1e-6&&o.scale.y>0){
          geo.computeBoundingBox();const b=geo.boundingBox,tip=o.localToWorld(c.position.clone().set(0,.5,0)),end=o.localToWorld(c.position.clone().set(0,-.5,0)),w=wrist.getWorldPosition(c.position.clone());
          compatible=Math.abs(b.min.y+.5)<1e-6&&Math.abs(b.max.y-.5)<1e-6&&tip.distanceTo(w)<end.distanceTo(w);
          if(compatible)ndc=end.project(c).toArray();
        }
        return {name:o.name,mesh:!!o.isMesh,visible:o.visible,compatible,ndc};
      });
      const part=name=>{const o=g.getObjectByName(name);return o?local(o):null;};
      return {...v,parent:g.parent?.name,handsParent:h.parent?.name,handsType:h.type,members,arms,right:local(right),left:local(left),
        groups:[right.type,left.type],shown:[visible(right),visible(left)],pumpPosition:part('independent-pump'),boltHandle:part('bolt-handle')};
    });
    return {weapon,active:d.renderer.modelDebug().weapon,models:d.renderer.modelDebug().loaded,passes,rigVisible:rig.visible,views,view:views[weapon],enemies:d.match.enemies.length,guide:d.settings().showGuide};
  }`);
  const probe = (weapon, dt = 0) => evaluate(`window.__handsProbe(${weapon},${dt})`);
  const prepare = async weapon => {
    await run(`d.restart();d.pause(true);d.setSettings({...d.settings(),showGuide:false});d.match.enemies.length=0;d.teleport(0,-15);d.aimAt(0,.95,-11);d.weapon(${weapon});`);
    return probe(weapon, 3);
  };
  const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
  const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const validate = (frame, modes = {}) => {
    assert.equal(frame.models.length, 5); assert.equal(frame.active, frame.weapon); assert.equal(frame.enemies, 0); assert.equal(frame.guide, false);
    assert.deepEqual(frame.views.map(v => v.name), names); assert.deepEqual(frame.passes, [1, 2]); assert.equal(frame.rigVisible, true);
    for (const [i, v] of frame.views.entries()) {
      assert.equal(v.parent, 'weapon-rig'); assert.equal(v.handsParent, names[i]); assert.equal(v.handsType, 'Group'); assert.deepEqual(v.groups, ['Group', 'Group']);
      assert.equal(v.partCount, [22, 23, 24][i]); assert.ok(v.parts.every(p => !v.members.some(m => m.name && m.name === p.name)), 'hands excluded from gunViews.parts');
      for (const m of v.members) { assert.equal(m.layer, 2, m.name); if (m.mesh) { assert.ok(m.materials.length); assert.ok(m.materials.every(t => ['MeshStandardMaterial', 'MeshPhysicalMaterial'].includes(t)), m.name); } }
      assert.ok(v.arms.every(a => a.mesh && a.visible));
    }
    const v = frame.view; assert.deepEqual(v.shown, [true, true]);
    for (const a of v.arms) if (a.compatible) { assert.ok(a.ndc.every(Number.isFinite)); assert.ok(a.ndc[1] < -1 && a.ndc[2] > -1 && a.ndc[2] < 1, a.name + ' distal end below viewport'); }
    v.handsDebugChecked = ['right', 'left'].every(side => typeof v.hands?.[side]?.mode === 'string' && ['position', 'contact', 'target'].every(k => Array.isArray(v.hands[side][k]) && v.hands[side][k].length === 3));
    if (v.handsDebugChecked) for (const side of ['right', 'left']) {
      const hand = v.hands[side]; assert.ok([hand.position,hand.contact,hand.target].flat().every(Number.isFinite));
      assert.ok((modes[side] || (side === 'right' ? ['grip'] : frame.weapon === 1 ? ['support', 'pump'] : ['support'])).includes(hand.mode));
      near(distance(hand.position, v[side]), 0); near(distance(hand.contact, hand.target), 0);
    }
    return frame;
  };
  const boot = async url => {
    await S('Page.navigate', { url }); await wait('!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5'); await installProbe();
    const xy = await evaluate(`(()=>{const r=document.querySelector('#enter-btn').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    await wait('__CLIENT_DEBUG__.input.locked');
  };
  phase = 'preview'; evidence.previewUrl = 'http://127.0.0.1:8128/dev/client.html'; await boot(evidence.previewUrl);
  evidence.checks.preview = []; for (let i = 0; i < 3; i++) evidence.checks.preview.push(validate(await prepare(i)));
  collect(); for (const key of ['runtimeErrors', 'consoleErrors', 'externalRequests', 'networkFailures']) assert.deepEqual(evidence[key], [], key);
  phase = 'offline'; await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  evidence.offline = true; evidence.fileUrl = pathToFileURL(path.join(root, 'dist/inkline.html')).href; await boot(evidence.fileUrl);
  const pictures = [], capture = async (index, filename, label) => {
    await evaluate(`(()=>{let e=document.getElementById('hands-frame-label');if(!e){e=document.createElement('div');e.id='hands-frame-label';e.style.cssText='position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;padding:5px 10px;border:1px solid #20242a;background:#f3f1e7ed;color:#20242a;font:600 16px/1.3 monospace';document.body.append(e);}e.textContent=${JSON.stringify(label)};})()`);
    const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); pictures[index] = data;
    const file = path.join(root, 'N5-Open/renders', filename); fs.writeFileSync(file, Buffer.from(data, 'base64')); evidence.captures.push({ file, label, width: 1280, height: 720 });
  };
  const idle = evidence.checks.idle = [];
  for (let i = 0; i < 3; i++) {
    idle.push(validate(await prepare(i))); await capture(i, `HANDS-${tags[i]}-idle.png`, `${names[i]} | IDLE`);
  }
  evidence.checks.sniperCapacity = await run('p.ammo=4;d.pump(0);return {capacity:C.player.weapons[2].magazine,ammo:p.ammo,fill:d.renderer.overhaulDebug().weapons[2].fill};');
  assert.equal(evidence.checks.sniperCapacity.capacity, 5); near(evidence.checks.sniperCapacity.fill, 4 / 5);
  const trigger = async i => {
    const ok = await run(i === 0 ? 'p.ammo=C.player.weapons[0].magazine-1;const result=d.reload();p.reload=C.player.weapons[0].reloadTime*.76;return result.ok;' : 'p.fireCd=0;return d.shoot().ok;');
    assert.equal(ok, true, i === 0 ? 'actual d.reload' : 'actual d.shoot'); return probe(i, [0, .21, .43][i]);
  };
  evidence.checks.actions = []; evidence.checks.restart = [];
  for (let i = 0; i < 3; i++) {
    await prepare(i); const frame = await trigger(i), v = frame.view, home = idle[i].view;
    await capture(i + 3, `HANDS-${tags[i]}-${['reload', 'pump', 'bolt'][i]}.png`, `${names[i]} | ${['RELOAD PULL r=0.24', 'PUMP shotAge=0.21', 'RIGHT-HAND BOLT shotAge=0.43'][i]}`);
    evidence.checks.actions.push(frame); validate(frame, i === 2 ? { right: ['bolt'] } : { left: [i === 0 ? 'magazine' : 'pump'] });
    if (i === 0) { near(v.reload, .24); assert.ok(v.left[1] < home.left[1] - .03, 'rifle left hand lowers'); }
    if (i === 1) { near(v.shotAge, .21); assert.ok(v.pump > .99); assert.ok(distance(v.left, home.left) > .05); near(v.left[2] - home.left[2], v.pumpPosition[2] - home.pumpPosition[2], .015); }
    if (i === 2) { near(v.shotAge, .43); assert.ok(v.bolt > .99); assert.ok(distance(v.right, home.right) > .03); assert.ok(distance(v.right, v.boltHandle) < distance(home.right, v.boltHandle), 'right hand approaches bolt handle'); }
    if (i === 0) await run('p.reload=0;');
    const returned = validate(await probe(i, .8)); for (const side of ['right', 'left']) near(distance(returned.view[side], home[side]), 0, .001);
    frame.returned = returned.view; await trigger(i); await run('d.restart();d.pause(true);d.match.enemies.length=0;d.teleport(0,-15);d.aimAt(0,.95,-11);');
    const reset = await probe(0); validate(reset);
    for (let j = 0; j < 3; j++) for (const side of ['right', 'left']) near(distance(reset.views[j][side], idle[j].view[side]), 0, .001);
    await run(`d.weapon(${i});`); const restored = validate(await probe(i, .5)); evidence.checks.restart.push({ reset, restored });
  }
  const mouse = type => S('Input.dispatchMouseEvent', { type, button: 'right', clickCount: 1, x: 640, y: 360 });
  await mouse('mousePressed'); evidence.checks.ads = await probe(2, .5);
  assert.equal(await run('return d.input.ads;'), true); assert.equal(evidence.checks.ads.rigVisible, false); assert.deepEqual(evidence.checks.ads.passes, [1]);
  for (const v of evidence.checks.ads.views) assert.deepEqual(v.shown, [false, false]);
  await mouse('mouseReleased'); evidence.checks.adsReleased = validate(await probe(2, .5));
  await mouse('mousePressed'); await probe(2, .5); await run('d.restart();d.pause(true);d.match.enemies.length=0;d.teleport(0,-15);d.aimAt(0,.95,-11);');
  evidence.checks.adsRestart = validate(await probe(0, .5)); await mouse('mouseReleased');
  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=3840;c.height=1440;const x=c.getContext('2d'),images=${JSON.stringify(pictures)};for(let i=0;i<6;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();if(image.width!==1280||image.height!==720)throw Error('Capture dimensions');x.drawImage(image,i%3*1280,Math.floor(i/3)*720);}return c.toDataURL('image/png').split(',')[1];})()`);
  evidence.sheet = path.join(root, 'N5-Open/renders/HANDS-verify.png'); fs.writeFileSync(evidence.sheet, Buffer.from(sheet, 'base64'));
  evidence.forearmProjection = 'Asserted only for unit-height local-Y cylinders whose +Y end faces the wrist; other geometry is deferred to main unit tests.';
  collect(); for (const key of ['runtimeErrors', 'consoleErrors', 'externalRequests', 'networkFailures']) assert.deepEqual(evidence[key], [], key);
  evidence.passed = true; console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.passed = false; evidence.failure = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  collect();
  try { fs.writeFileSync(path.join(root, 'N5-Open/reports/HANDS-browser.json'), JSON.stringify(evidence, null, 2)); }
  finally {
    if (send && ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
    ws?.close(); for (const item of pending.values()) clearTimeout(item.timer);
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exited; }
    if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
