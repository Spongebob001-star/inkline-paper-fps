// OVERHAUL-4 验收：书桌奇境全景、Dash 实战、受击红弧、S 级印章四格截图与读数。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = pathToFileURL(path.join(root, 'dist', 'inkline.html')).href + '?seed=11';
const port = Number(process.env.CDP_PORT || 9387);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-overhaul4-'));
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
    for (let n = 0; n < 160; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('等待超时: ' + expression);
  };
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;

  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `window.requestAnimationFrame = fn => { window.__testFrame = fn; return 0; };` });
  await S('Page.navigate', { url: file });
  await wait('!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5');
  await run("d.pause(true);document.getElementById('lock-hint').style.display='none';d.pump(0.05);");
  const pump = n => run(`for(let i=0;i<${n};i++)d.pump(0.05);`);
  const pictures = [];

  // 1) 书桌纸艺奇境全景：NE 视线覆盖铅笔塔/三角尺/回形针/便利贴 + 云端 + 文具掩体
  await run(`
    d.restart(); m = d.match; p = m.players[0];
    document.getElementById('lock-hint').style.display='none';
    d.renderer.setBaseFov(95);
    d.teleport(15, 10);
    d.aimAt(2, 8.2, -24);
    d.weapon(0);
    d.pump(0.05);
  `);
  await pump(60);
  await run(`
    d.renderer.setAnchorsHidden(true); d.pump(0.02);
    d.hud.toast('');
    const t = document.getElementById('hud-toast'); t.textContent = ''; t.style.opacity = 0;
  `);
  evidence.checks.diorama = await run(`
    const names = ['desk-pencil-tower','desk-ruler-arch','desk-paperclip','desk-note-tower','paper-cloud-0','paper-cloud-4','wall-decor-0','cover-0-skin','cover-7-skin'];
    return { present: names.map(n=>!!d.renderer.scene.getObjectByName(n)), fov: d.renderer.camera.fov,
      anchorsHidden: (()=>{let ok=true; d.renderer.scene.traverse(o=>{if(o.name&&o.name.indexOf('anchor-')===0&&o.visible&&o.geometry&&o.geometry.type!=='PlaneGeometry')ok=false;}); return [ok,ok,ok];})(),
      covers: [0,7].map(i=>{const m=d.renderer.scene.getObjectByName('cover-'+i+'-skin');return m?m.userData.skin:null;}) };
  `);
  pictures.push(await capture());

  // 2) 墨迹闪避：Shift 卡片冷却 + 青色速度线 + 青墨拖尾
  await run(`
    d.restart(); m = d.match; p = m.players[0];
    d.renderer.setBaseFov(68);
    d.teleport(5, 13); d.aimAt(5, 1.3, 4.5); d.weapon(0);
    d.spawnCrane(8, 9);
    document.getElementById('lock-hint').style.display='none';
    d.pump(0.05);
  `);
  await pump(70);
  await run("d.runtime.setInput(0,{f:1,dash:true,seq:1}); d.runtime.tickOnce(); d.pump(0.05);");
  for (let i = 0; i < 3; i++) await run(`d.runtime.setInput(0,{f:1,seq:${i + 2}}); d.runtime.tickOnce(); d.pump(0.05);`);
  await run("d.aimAt(2.9, 0.5, 6.6); d.hud.dashFlash(); " +
    "d.renderer.onEvent({type:'dash',data:{id:0,x:2.9,z:6.6,dx:0.8,dz:-0.6}}); d.pump(0.12); " +
    "d.renderer.setAnchorsHidden(true); d.pump(0.01);");
  evidence.checks.dash = await run(`
    const od=d.renderer.overhaulDebug();
    return { dashCd: d.match.players[0].dashCd, dashT: d.match.players[0].dashT,
      card: (document.querySelector('#dash-state')||{}).textContent,
      lines: Number(getComputedStyle(document.getElementById('dash-lines')).opacity),
      particles: od.pool.particles.filter(p=>p.kind==='dash').length,
      cards: document.querySelectorAll('#hud-abilities .ab').length };
  `);
  pictures.push(await capture());

  // 3) 受击方向红弧：右侧音浪来源
  await run(`
    d.aimAt(5, 1.2, 3.0);
    const wave = { id: m.nextId++, kind: 'wave', x: p.pos.x + 6.2, z: p.pos.z, r: 6.2, speed: 11.5, maxR: 16, damage: 12, push: 5.5, hit: [] };
    m.hazards.push(wave);
    d.runtime.tickOnce(); d.pump(0.05);
  `);
  await delay(180);
  await run("d.pump(0.001); d.renderer.setAnchorsHidden(true); d.pump(0.02);");
  evidence.checks.hurt = await run(`
    const el = document.querySelectorAll('#dmg-dir-layer .dmg-dir');
    return { count: el.length, opacities: [...el].map(e=>Number(getComputedStyle(e).opacity)),
      transforms: [...el].map(e=>e.style.transform), hp: d.match.players[0].hp };
  `);
  pictures.push(await capture());

  // 4) 胜利结算 S 级红印章（真实 finish 路径）
  await run(`
    d.restart(); m = d.match; p = m.players[0];
    document.getElementById('lock-hint').style.display='none';
    d.renderer.setBaseFov(68);
    p.perks.push('quick_ink', 'heavy_nib', 'light_feet');
    m.exitUnlocked = true; m.boss = null; m.phase = 'boss';
    d.teleport(0, -15.0);
    d.aimAt(0, 1.5, -15.6);
    d.pump(0.05);
  `);
  for (let i = 0; i < 50; i++) {
    await run(`d.runtime.setInput(0,{hold:true,seq:${i + 1}}); d.runtime.tickOnce();`);
    const phase = await run('return m.phase;');
    if (phase === 'won') break;
  }
  await run("d.pump(0.05);");
  await delay(450);
  evidence.checks.settlement = await evaluate(`(() => {
    const stamp = document.getElementById('end-rank-stamp');
    return { phase: __CLIENT_DEBUG__.match.phase,
      overlay: getComputedStyle(document.getElementById('end-overlay')).display,
      stampHidden: stamp.hidden, letter: (document.querySelector('#rank-letter')||{}).textContent,
      title: (document.querySelector('#rank-title')||{}).textContent,
      mode: !(document.querySelector('#rank-mode')||{}).hidden,
      legacyIds: ['end-overlay','end-title','end-reason','end-stats','end-team','end-best','end-perks','restart-btn','new-seed-btn'].every(id=>!!document.getElementById(id)),
      voiceComms: !!document.getElementById('voice-comms') };
  })()`);
  pictures.push(await capture());

  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');const images=${JSON.stringify(pictures)};for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,i%2*1280,Math.floor(i/2)*720,1280,720);}return c.toDataURL('image/png').split(',')[1];})()`);
  fs.mkdirSync(path.join(root, 'N5-Open/renders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'N5-Open/renders/OVERHAUL-4-verify.png'), Buffer.from(sheet, 'base64'));
  for (let i = 0; i < pictures.length; i++) fs.writeFileSync(path.join(root, `N5-Open/renders/OVERHAUL-4-scene-${i + 1}.png`), Buffer.from(pictures[i], 'base64'));

  const external = events.filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request.url).filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  const errors = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  evidence.externalRequests = external;
  evidence.consoleErrors = errors.map(e => e.method + ':' + JSON.stringify(e.params).slice(0, 300));
  evidence.finished = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'N5-Open/reports/OVERHAUL-4-browser.json'), JSON.stringify(evidence, null, 2));

  const c = evidence.checks, d = c.dash, hu = c.hurt, s = c.settlement;
  const ok = c.diorama.present.every(Boolean) && c.diorama.anchorsHidden.every(Boolean) && c.diorama.fov >= 90 && c.diorama.covers[0] === 'notebook' && c.diorama.covers[1] === 'sticky' &&
    d.dashCd > 1.5 && d.card && d.card !== '就绪' && d.lines > 0.2 && d.particles >= 4 && d.cards === 4 &&
    hu.count === 3 && Math.max(...hu.opacities) > 0.2 && hu.transforms.some(t => { const m = /rotate\(([-\d.]+)deg\)/.exec(t); return m && Math.abs(Math.abs(Number(m[1])) - 90) < 20; }) &&
    s.phase === 'won' && s.overlay === 'flex' && s.stampHidden === false && s.letter === 'S' && s.title.includes('神笔惊墨') &&
    s.mode === false && s.legacyIds === true && s.voiceComms === false &&
    external.length === 0 && errors.length === 0;
  console.log(JSON.stringify(evidence, null, 1));
  console.log(ok ? 'PASS: OVERHAUL-4 浏览器验收' : 'FAIL: 检查未全部通过');
  process.exitCode = ok ? 0 : 1;
} finally {
  try { await send('Browser.close'); } catch (_) {}
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await delay(400);
  fs.rmSync(profile, { recursive: true, force: true });
}
