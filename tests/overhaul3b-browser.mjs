// OVERHAUL-3B 验收：真实 Chrome AudioContext/AnalyserNode 测 BGM 响度、10+ 生态音效、
// Boss 笑声闪避，并截取 2×2 实机图（无 voice-comms，含 800×600 设置面板）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = pathToFileURL(path.join(root, 'dist', 'inkline.html')).href + '?seed=11';
const port = Number(process.env.CDP_PORT || 9377);
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-overhaul3b-'));
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--autoplay-policy=no-user-gesture-required',
  '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { started: new Date().toISOString(), checks: {}, audio: {}, soundscape: {}, externalRequests: [], consoleErrors: [] };
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
    for (let n = 0; n < 180; n++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('等待超时: ' + expression);
  };
  const capture = async () => (await S('Page.captureScreenshot', { format: 'png' })).data;

  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.requestAnimationFrame = fn => { window.__testFrame = fn; return 0; };
    (() => {
      const Native = window.AudioContext || window.webkitAudioContext;
      if (!Native) return;
      const taps = window.__audioTaps = [];
      window.__audioContexts = [];
      class TapContext extends Native {
        constructor(...args) { super(...args); window.__audioContexts.push(this); }
        createGain() {
          const g = super.createGain();
          const orig = g.connect.bind(g);
          g.connect = (dest, ...rest) => {
            const out = orig(dest, ...rest);
            try {
              if (dest === this.destination) {
                const an = super.createAnalyser();
                an.fftSize = 2048;
                const buf = new Float32Array(an.fftSize);
                orig(an);
                taps.push({ ctx: this, an, buf });
              }
            } catch (_) {}
            return out;
          };
          return g;
        }
      }
      window.AudioContext = TapContext;
      window.webkitAudioContext = TapContext;
      window.__measure = (ms = 900) => new Promise(resolve => {
        const stats = window.__audioTaps.map(() => ({ peak: 0, sum: 0, n: 0 }));
        const t0 = performance.now();
        const iv = setInterval(() => {
          window.__audioTaps.forEach((t, ti) => {
            t.an.getFloatTimeDomainData(t.buf);
            const st = stats[ti];
            for (let i = 0; i < t.buf.length; i += 2) {
              const v = t.buf[i], a = Math.abs(v);
              if (a > st.peak) st.peak = a;
              st.sum += v * v; st.n++;
            }
          });
          if (performance.now() - t0 >= ms) {
            clearInterval(iv);
            let peak = 0, rms = 0;
            for (const st of stats) {
              if (st.peak > peak) peak = st.peak;
              const r = Math.sqrt(st.sum / Math.max(1, st.n));
              if (r > rms) rms = r;
            }
            resolve({ peak: +peak.toFixed(4), rms: +rms.toFixed(4), taps: window.__audioTaps.length,
              running: window.__audioTaps.filter(t => t.ctx.state === 'running').length });
          }
        }, 25);
      });
    })();
  ` });
  await S('Page.navigate', { url: file });
  await wait('!!window.__CLIENT_DEBUG__ && __CLIENT_DEBUG__.renderer.modelDebug().loaded.length===5');
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glbLoaded === true');
  await run("d.pause(true);document.getElementById('lock-hint').style.display='none';d.pump(0.05);");
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', x: 640, y: 360, clickCount: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', x: 640, y: 360, clickCount: 1 });
  await wait('window.__audioTaps && window.__audioTaps.some(t => t.ctx.state === "running")');
  await wait('__CLIENT_DEBUG__.renderer.bossAudioDebug().loaded === true');
  evidence.checks.boot = await run("return {bgm:d.bgm.debug(), settings:d.settings(), voiceDebug:('voice' in d), comms:!!document.getElementById('voice-comms')};");

  // BGM 响度：anchors / boss3（bgmVolume 0.65）
  await run("d.audio.stop(); d.bgm.setMuted(false); d.bgm.setMode('anchors'); d.pump(0.05);");
  await delay(900);
  evidence.audio.anchors = await evaluate('window.__measure(1400)');
  await run("d.bgm.setMode('boss3');");
  await delay(700);
  evidence.audio.boss3 = await evaluate('window.__measure(1400)');

  // Boss 笑声闪避：实际触发 renderer 大笑，再手动推进 frame 让 updateSoundscape 生效
  await run("d.restart(); m=d.match; p=m.players[0]; d.spawnBoss(); d.teleport(0,10.5); d.aimAt(0,1.4,5.5); document.getElementById('lock-hint').style.display='none'; d.pump(0.05);");
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await delay(300);
  const duck = await evaluate(`(async () => {
    const d = window.__CLIENT_DEBUG__;
    d.renderer.triggerBossLaugh();
    const base = d.bgm.debug();
    let t = performance.now();
    for (let i = 0; i < 8; i++) { t += 50; window.__testFrame(t); }
    const during = d.bgm.debug();
    d.renderer.setBossSoundMuted(true);
    for (let i = 0; i < 40; i++) { t += 50; window.__testFrame(t); }
    const after = d.bgm.debug();
    d.renderer.setBossSoundMuted(false);
    return { baseGain: base.targetGain, duringGain: during.targetGain, duckedDuring: during.ducked,
      afterGain: after.targetGain, duckedAfter: after.ducked, laugh: d.renderer.bossAudioDebug().active };
  })()`);
  evidence.audio.ducking = duck;

  // 生态环境音效逐项抽测（BGM 静音，避免叠加）
  await run("d.bgm.setMuted(true); d.audio.stop(); d.bgm.setMode('idle'); d.pump(0.05);");
  await delay(300);
  const effects = [
    ['footstep', "d.audio.footstep(true)"], ['jump', "d.audio.jump()"], ['land', "d.audio.land(7)"],
    ['craneCharge', "d.audio.craneCharge(0.9)"], ['eraserBite', "d.audio.eraserBite(0.7)"],
    ['planeDive', "d.audio.planeDive(0.6)"],
    ['bulletWhiz', "d.audio.bulletWhiz([{id:901,x:p.pos.x+1,y:p.pos.y-0.3,z:p.pos.z}], p.pos)"],
    ['anchorTick', "d.audio.anchorTick(0.6)"], ['anchorDone', "d.audio.anchorDone()"],
    ['heartbeat', "d.audio.heartbeat()"], ['bossSpawn', "d.audio.bossSpawn()"], ['paperTear', "d.audio.paperTear()"],
  ];
  for (const [name, call] of effects) {
    await run(`d.audio.stop(); ${call};`);
    const dbg = await run('return {active:d.audio.debug().active, kinds:d.audio.debug().voices.map(v=>v.kind)};');
    const m = await evaluate('window.__measure(420)');
    evidence.soundscape[name] = { ...m, ...dbg };
    await run('d.audio.stop();');
  }
  await delay(200);
  evidence.checks.audioCleanup = await run('const dg=d.audio.debug(); return {active:dg.active, sources:dg.sources, nodes:dg.nodes};');

  const pump = n => run(`for(let i=0;i<${n};i++)d.pump(0.05);`);
  const pictures = [];

  // 1) anchors 实战（干净 HUD，无字幕条）
  await run(`
    d.restart(); m = d.match; p = m.players[0];
    d.teleport(0, 10.4); d.aimAt(0, 1.35, 5.5); d.weapon(0);
    document.getElementById('lock-hint').style.display='none';
    d.bgm.setMuted(true);
    d.pump(0.05);
  `);
  await pump(70);
  await run("d.hud.toast(''); d.pump(0.05);");
  pictures.push(await capture());

  // 2) boss12 墨雨战斗
  await run(`
    d.restart(); m = d.match; p = m.players[0]; d.spawnBoss();
    d.teleport(0, 10.6); d.aimAt(1.2, 1.4, 5.6); d.weapon(1); p.ammo = 6;
    document.getElementById('lock-hint').style.display='none';
    const b = m.boss; b.phase = 2; b.raged = true; b.hp = Math.round(b.maxHp * 0.5);
    d.pump(0.05);
  `);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await pump(70);
  await run(`
    for (const [x, z, t] of [[2.2, 6.4, 0.35], [-2.0, 7.0, 0.18], [0.6, 4.8, 0.6]]) m.hazards.push({ id: m.nextId++, kind: 'mortar', x, z, r: 2.2, fuse: 1.15, t, damage: 16 });
    d.hud.showPhaseBanner(2, C.boss.phaseTitles[1]);
    d.pump(0.05);
  `);
  await pump(4);
  pictures.push(await capture());

  // 3) boss3 终焉墨潮
  await run(`
    d.restart(); m = d.match; p = m.players[0]; d.spawnBoss();
    d.teleport(0, 10.8); d.aimAt(0, 1.5, 5.5); d.weapon(2);
    document.getElementById('lock-hint').style.display='none';
    const b = m.boss; b.phase = 3; b.raged = true; b.hp = Math.round(b.maxHp * 0.27);
    d.pump(0.05);
  `);
  await wait('__CLIENT_DEBUG__.renderer.bossDebug().glb === true');
  await pump(120);
  await run(`
    const b = m.boss; b.stunT = 2.2;
    d.hud.showPhaseBanner(3, C.boss.phaseTitles[2]);
    for (let i = 0; i < 7; i++) m.projectiles.push({ id: m.nextId++, x: -2.7 + i * 0.9, y: 1.32, z: 7.6, vx: 0, vy: 0, vz: 13 });
    for (let i = 0; i < 8; i++) m.projectiles.push({ id: m.nextId++, x: -3.2 + i * 0.91, y: 1.15, z: 8.5, vx: 0, vy: 0, vz: 14.5 });
    d.hud.spawnDmgNumber({ x: 0.3, y: 2.0, z: 5.7 }, '暴击 -38!', 'crit');
    d.pump(0.05);
  `);
  await pump(4);
  pictures.push(await capture());

  // 4) 800×600 设置面板：5 滑杆 + 1 开关
  await S('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await run("document.getElementById('lock-hint').style.display='none'; d.toggleSettings(true); d.pump(0.05);");
  await delay(250);
  evidence.checks.settings = await evaluate(`(() => {
    const card = document.querySelector('#settings-card');
    const rows = card.querySelectorAll('.setting-row');
    return { rows: rows.length, labels: [...rows].map(r => r.querySelector('label').textContent),
      checkboxes: card.querySelectorAll('.setting-check').length,
      overflow: card.scrollHeight > card.clientHeight + 1, scroll: card.scrollHeight, client: card.clientHeight,
      voiceSlider: !!document.querySelector('#setting-voiceVolume'), comms: !!document.getElementById('voice-comms'),
      viewport: [innerWidth, innerHeight] };
  })()`);
  const settingsShot = await capture();

  const sheet = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=2560;c.height=1440;const x=c.getContext('2d');x.fillStyle='#F3F1E7';x.fillRect(0,0,2560,1440);
    const images=${JSON.stringify(pictures)};for(let i=0;i<images.length;i++){const image=new Image();image.src='data:image/png;base64,'+images[i];await image.decode();x.drawImage(image,i%2*1280,Math.floor(i/2)*720,1280,720);}
    const s=new Image();s.src='data:image/png;base64,'+${JSON.stringify(settingsShot)};await s.decode();x.drawImage(s,1280+240,720+60,800,600);
    return c.toDataURL('image/png').split(',')[1];})()`);
  fs.mkdirSync(path.join(root, 'N5-Open/renders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'N5-Open/renders/OVERHAUL-3B-verify.png'), Buffer.from(sheet, 'base64'));
  for (let i = 0; i < pictures.length; i++) fs.writeFileSync(path.join(root, `N5-Open/renders/OVERHAUL-3B-scene-${i + 1}.png`), Buffer.from(pictures[i], 'base64'));
  fs.writeFileSync(path.join(root, 'N5-Open/renders/OVERHAUL-3B-settings-800x600.png'), Buffer.from(settingsShot, 'base64'));

  const external = events.filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request.url).filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  const errors = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  evidence.externalRequests = external;
  evidence.consoleErrors = errors.map(e => e.method + ':' + JSON.stringify(e.params).slice(0, 300));
  evidence.finished = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'N5-Open/reports/OVERHAUL-3B-browser.json'), JSON.stringify(evidence, null, 2));

  const a = evidence.audio, s = evidence.soundscape, c = evidence.checks;
  const bgmOk = (m) => m && m.peak >= 0.18 && m.peak <= 0.45 && m.peak < 0.6 && m.rms >= 0.035;
  const fxOk = Object.values(s).every(m => m.peak > 0.004 && m.peak < 1 && m.active >= 1);
  const duckOk = a.ducking && Math.abs(a.ducking.duringGain - a.ducking.baseGain * 0.55) < 1e-3 &&
    a.ducking.duckedDuring === true && a.ducking.duckedAfter === false &&
    Math.abs(a.ducking.afterGain - a.ducking.baseGain) < 1e-3;
  const ok = bgmOk(a.anchors) && bgmOk(a.boss3) && fxOk && duckOk &&
    c.boot && c.boot.voiceDebug === false && c.boot.comms === false && c.boot.settings.bgmVolume === 0.65 &&
    c.audioCleanup && c.audioCleanup.active === 0 && c.audioCleanup.sources === 0 && c.audioCleanup.nodes <= 3 &&
    c.settings.rows === 5 && c.settings.checkboxes === 1 && c.settings.overflow === false &&
    c.settings.voiceSlider === false && c.settings.comms === false && c.settings.viewport[0] === 800 &&
    !c.settings.labels.includes('战术语音') &&
    external.length === 0 && errors.length === 0;
  console.log(JSON.stringify(evidence, null, 1));
  console.log(ok ? 'PASS: OVERHAUL-3B 浏览器验收' : 'FAIL: 检查未全部通过');
  process.exitCode = ok ? 0 : 1;
} finally {
  try { await send('Browser.close'); } catch (_) {}
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await delay(400);
  fs.rmSync(profile, { recursive: true, force: true });
}
