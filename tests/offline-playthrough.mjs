// T7.5 §7.3-10 验收：断网 file:// 双击单文件 → 完整游玩至 won。
// 用法：node tests/offline-playthrough.mjs [dist/inkline.html 路径]
// 无头 Chrome + CDP（Node 内置 WebSocket，零依赖）；页内 bot 与 tests/sim-match.mjs 同一套判定，
// 每 tick 走客户端真实路径 aimAt/shoot/erase/botInput + runtime.tickOnce() + pump()（事件+渲染+HUD）。
// 不截图（截图由用户 review 时自行完成）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'inkline.html'));
const PORT = Number(process.env.CDP_PORT || 9333);
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find(p => fs.existsSync(p));
if (!CHROME) { console.error('未找到 Chrome，可用 CHROME_PATH 指定'); process.exit(2); }
if (!fs.existsSync(FILE)) { console.error('产物不存在：' + FILE + '（先跑 node client/build.mjs）'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkline-offline-'));
// 客户端默认用时间种子；固定 ?seed= 才能复现（与 tests/sim-match.mjs 同种子）
const SEED = Number(process.env.SEED || 11);
const fileUrl = 'file:///' + FILE.replace(/\\/g, '/') + '?seed=' + SEED;
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  // 断网：任何域名解析失败（CDP 走 127.0.0.1，不受影响）
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--disable-component-update', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function browserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('Chrome CDP 未就绪');
}

const ws = new WebSocket(await browserWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const events = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej, method } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(method + ': ' + msg.error.message)) : res(msg.result);
  } else if (msg.method) events.push(msg);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej, method });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 120000);
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Network.enable');
let offlineEmulation = false;
try {
  await S('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
  offlineEmulation = true;
} catch { /* 部分 Chrome 版本拒绝该参数；DNS 黑洞 + 请求日志已足以证明离线 */ }
await S('Page.enable');
await S('Runtime.enable');
await S('Log.enable');
await S('Page.navigate', { url: fileUrl });

const evalJs = async expression => {
  const r = await S('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
let ready = false;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  ready = await evalJs('!!(window.__CLIENT_DEBUG__ && window.__CLIENT_DEBUG__.match && window.THREE)');
  if (ready) break;
}
if (!ready) throw new Error('单文件未初始化');
console.log('boot(file://, offline):', await evalJs('JSON.stringify({seed:__CLIENT_DEBUG__.state().seed, phase:__CLIENT_DEBUG__.match.phase, enemies:__CLIENT_DEBUG__.match.enemies.length, players:__CLIENT_DEBUG__.match.players.length})'));

const setup = `(() => {
  const d = window.__CLIENT_DEBUG__;
  d.pause(true);
  d.restart();
  const K = d.kernel, C = K.CONFIG;
  const m = d.match, rt = d.runtime;
  const dist = (p, t) => Math.hypot(p.pos.x - t.x, p.pos.z - t.z);
  const center = e => ({ x: e.x, y: e.type === 'plane' ? e.y : 0.75, z: e.z });
  function steer(it, p, t) {
    const dx = t.x - p.pos.x, dz = t.z - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz); p.pitch = 0;
    it.f = 1; it.sprint = Math.hypot(dx, dz) > 6;
  }
  const bs = { stuck: 0, avoid: 0, side: 1, lx: 0, lz: 0 };
  function botTick() {
    const p = m.players[0];
    if (p.st !== 0) { rt.setInput(0, { f: 0, r: 0 }); rt.tickOnce(); d.pump(0.05); return; }
    const it = { f: 0, r: 0, sprint: false, jump: false, hold: false };
    const moved = Math.hypot(p.pos.x - bs.lx, p.pos.z - bs.lz);
    bs.lx = p.pos.x; bs.lz = p.pos.z;
    let enemy = null, ed = 18;
    for (const e of m.enemies) {
      if (e.dead || !K.HITBOX[e.type]) continue;
      const dd = dist(p, e);
      if (dd < ed) { ed = dd; enemy = e; }
    }
    const eye = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    const clear = t => !K.losBlocker(m, eye, t);
    const threat = enemy && ed < 13 && clear(center(enemy));
    let aim = null;
    const fight = () => { if (enemy && clear(center(enemy))) aim = center(enemy); };
    if (m.exitUnlocked) {
      if (dist(p, K.EXIT) < 1.8 && !threat) it.hold = true;
      else if (threat) fight();
      else steer(it, p, K.EXIT);
      if (!it.hold && !aim) fight();
    } else if (m.phase === 'boss' && m.boss && !m.boss.dead) {
      if (threat) fight();
      else {
        const bt = { x: m.boss.x, y: 1.1, z: m.boss.z };
        if (clear(bt)) aim = bt; else steer(it, p, m.boss);
        if (!aim && dist(p, m.boss) > 9) steer(it, p, m.boss);
      }
    } else {
      const a = m.anchors.find(x => !x.active);
      if (a) {
        if (dist(p, a) < 1.5 && !threat) it.hold = true;
        else if (threat) fight();
        else steer(it, p, a);
        if (!it.hold && !aim) fight();
      }
    }
    if (enemy && enemy.armor > 0 && ed <= C.ink.eraseRadius && p.eraseCd <= 0 && p.ink >= C.ink.eraseCost) d.erase();
    if (p.reload > 0 && enemy && clear(center(enemy))) {
      aim = null;
      const dx = p.pos.x - enemy.x, dz = p.pos.z - enemy.z;
      p.yaw = Math.atan2(-dx, -dz); p.pitch = 0;
      it.f = 1; it.sprint = true; it.hold = false;
    }
    if (bs.avoid > 0) {
      if (bs.avoid > 12) { it.f = -1; it.r = 0; } else { it.f = 0; it.r = bs.side; }
      it.sprint = true; it.hold = false; aim = null; bs.avoid--;
    } else if (it.f !== 0 && moved < 0.004) {
      if (++bs.stuck >= 5) { bs.avoid = 20; bs.side *= -1; bs.stuck = 0; }
    } else bs.stuck = 0;
    // 重铸包 2：地面警示域、折返冲锋与技能反制（真实走位 + 跳跃 + G 墙 + E 打断）
    const foot = p.pos.y - C.player.eyeHeight;
    let mortar = null, mortarGap = 99;
    for (const h of (m.hazards || [])) {
      if (h.k !== 'm') continue;
      const hd = Math.hypot(p.pos.x - h.x, p.pos.z - h.z) - h.r;
      if (hd < 0.7 && hd < mortarGap) { mortar = h; mortarGap = hd; }
    }
    if (mortar) {
      let best = null, bestScore = -Infinity;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        const nx = p.pos.x + Math.sin(a) * 3, nz = p.pos.z + Math.cos(a) * 3;
        let score = 0;
        for (const h of m.hazards) if (h.k === 'm') score += Math.min(9, Math.hypot(nx - h.x, nz - h.z) - h.r);
        if (score > bestScore) { bestScore = score; best = { nx, nz }; }
      }
      if (best) {
        const dx = best.nx - p.pos.x, dz = best.nz - p.pos.z;
        p.yaw = Math.atan2(-dx, -dz); p.pitch = 0;
        it.f = 1; it.sprint = true; it.r = 0; it.hold = false; aim = null; bs.avoid = 0;
      }
    } else if (m.phase === 'boss' && m.boss && !m.boss.dead) {
      const bossDist = dist(p, m.boss);
      if (m.boss.state === 'charge' && m.boss.telegraph < 0.15 && p.ink >= 30) d.quickWall();
      if (p.eraseCd <= 0 && p.ink >= 40 && bossDist <= 5.8 &&
        (m.boss.waveLeft > 0 || m.boss.laughExposeT > 0 || ['fan', 'mortar', 'summon'].includes(m.boss.state))) d.erase();
      if (aim) {
        if (bossDist < 5.2) { it.f = -1; it.r = 0.3; }
        else if (bossDist > 9) { it.f = 1; it.r = 0; }
        else { it.f = 0; it.r = bs.side; }
        it.sprint = bossDist > 11; it.hold = false;
      }
      bs.strafe = (bs.strafe || 0) + 1;
      if (bs.strafe > 80 || Math.abs(p.pos.x) > 15 || Math.abs(p.pos.z) > 15) { bs.strafe = 0; bs.side *= -1; }
    }
    if (foot < C.boss.waveJumpHeight) {
      for (const h of (m.hazards || [])) {
        if (h.k !== 'w') continue;
        const gap = Math.hypot(p.pos.x - h.x, p.pos.z - h.z) - h.r;
        if (gap > 3.3 && gap < 4.2) { it.jump = true; break; }
      }
    }
    if (it.f > 0 && !it.hold) {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const foot = p.pos.y - C.player.eyeHeight;
      if (K.groundHeightAt(p.pos.x + fx * 1.2, p.pos.z + fz * 1.2, m.folds) - foot > C.folds.stepLimit) {
        const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
        const hR = K.groundHeightAt(p.pos.x + rx * 1.2, p.pos.z + rz * 1.2, m.folds);
        const hL = K.groundHeightAt(p.pos.x - rx * 1.2, p.pos.z - rz * 1.2, m.folds);
        it.r = hR <= hL ? 1 : -1; it.f = 0.5;
      }
    }
    if (aim) { d.aimAt(aim.x, aim.y, aim.z); d.shoot(); }
    d.botInput(0, it);
    rt.tickOnce();
    d.pump(0.05);
  }
  window.__bot = {
    run(n) {
      for (let i = 0; i < n; i++) {
        if (m.phase === 'won' || m.phase === 'lost' || m.tick >= 20000) break;
        botTick();
      }
      const s = d.state();
      return { phase: s.phase, tick: s.tick, anchorsDone: s.anchorsDone, hp: s.hp, kills: s.kills,
        boss: s.boss, exitUnlocked: s.exitUnlocked, exitProgress: s.exitProgress,
        enemies: s.enemies.length, pos: s.pos, stats: s.stats };
    },
  };
  return JSON.stringify({ installed: true, phase: m.phase, enemies: m.enemies.length, tick: m.tick });
})()`;
console.log('bot:', await evalJs(setup));

let last = null;
const t0 = Date.now();
for (let chunk = 0; chunk < 140; chunk++) {
  last = await evalJs('JSON.stringify(window.__bot.run(150))');
  const st = JSON.parse(last);
  console.log(`chunk ${chunk}: phase=${st.phase} tick=${st.tick} anchors=${st.anchorsDone} hp=${st.hp} kills=${st.kills} exit=${st.exitUnlocked}:${st.exitProgress} enemies=${st.enemies}`);
  if (st.phase === 'won' || st.phase === 'lost' || st.tick >= 20000) break;
}
const final = JSON.parse(last);
const endUi = JSON.parse(await evalJs(`JSON.stringify({
  endOverlayDisplay: getComputedStyle(document.querySelector('#end-overlay')).display,
  endTitle: (document.querySelector('#end-title')||{}).innerText || null,
  endReason: (document.querySelector('#end-reason')||{}).innerText || null,
  endStats: (document.querySelector('#end-stats')||{}).innerText || null,
  endBest: (document.querySelector('#end-best')||{}).innerText || null,
  exitChip: (document.querySelector('#exit-chip')||{}).innerText || null,
  canvas: (()=>{const c=document.querySelector('canvas');return c?{w:c.width,h:c.height}:null})(),
})`));
const external = events.filter(e => e.method === 'Network.requestWillBeSent')
  .map(e => e.params.request.url).filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
const failed = events.filter(e => e.method === 'Network.loadingFailed').map(e => e.params.errorText);
const errors = events.filter(e =>
  e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
console.log('--- RESULT ---');
console.log(JSON.stringify({
  fileUrl, seed: SEED, offlineEmulation, hostResolverRules: 'MAP * ~NOTFOUND',
  wallSeconds: +((Date.now() - t0) / 1000).toFixed(1), final, endUi,
  externalRequests: external, loadingFailed: failed,
  consoleErrors: errors.map(e => e.method + ':' + JSON.stringify(e.params).slice(0, 300)),
}, null, 1));
const ok = final.phase === 'won' && external.length === 0 && errors.length === 0;
console.log(ok ? 'PASS: 断网 file:// 单文件完整通关（won）' : 'FAIL: 未通关或存在外部请求/控制台错误');

await send('Browser.close').catch(() => {});
try { ws.close(); } catch { /* ignore */ }
try { chrome.kill(); } catch { /* ignore */ }
await sleep(500);
fs.rmSync(profile, { recursive: true, force: true });
process.exit(ok ? 0 : 1);