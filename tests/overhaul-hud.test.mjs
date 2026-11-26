import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHud, computeRank, damageAngle } from '../client/hud.mjs';
import { createRuntime } from '../host/runtime.mjs';

function harness() {
  const nodes = new Map();
  const ctx = new Proxy({}, { get: (o, k) => o[k] || (() => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const node = key => {
    if (nodes.has(key)) return nodes.get(key);
    const classes = new Set(), children = [];
    const n = {
      children, textContent: '', value: '0', valueAsNumber: 0, dataset: {},
      style: { setProperty(k, v) { this[k] = v; } },
      classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k),
        toggle(k, yes) { if (yes) classes.add(k); else classes.delete(k); } },
      addEventListener() {}, setAttribute() {}, getContext: () => ctx,
      querySelector: s => node(key + s), querySelectorAll: () => [],
      replaceChildren(...items) { children.splice(0, children.length, ...items); },
      append(...items) { children.push(...items); },
      get childElementCount() { return children.length; },
    };
    nodes.set(key, n); return n;
  };
  let next = 0;
  const root = node('root');
  root.ownerDocument = { createElement: tag => node(tag + next++), pointerLockElement: null };
  const hud = createHud(root), runtime = createRuntime();
  const tick = dt => hud.update(runtime.snapshot(), 0, dt);
  return { hud, tick, get: id => node('root#' + id) };
}

test('Overhaul HUD: hit bounces the reticle and critical hit uses a double-cross class', () => {
  const h = harness();
  h.hud.hitmarker(false, true); h.tick(.01);
  assert.ok(Number(h.get('crosshair').style['--hit-scale']) > 1.3);
  assert.equal(h.get('hitmark').classList.contains('critical'), true);
  h.tick(.2);
  assert.equal(Number(h.get('crosshair').style['--hit-scale']), 1);
  h.hud.hitmarker();
  assert.equal(h.get('hitmark').classList.contains('critical'), false);
});

test('Overhaul HUD: kill stamps escalate and fade without lingering edge flashes', () => {
  const h = harness();
  for (const [n, label] of [[1, '击杀!'], [2, '双杀 ×2!'], [3, '三杀 ×3!'], [4, '墨影无双 ×4!'], [8, '墨影无双 ×8!']]) {
    h.hud.hitmarker(true, false, n); h.tick(.01);
    assert.equal(h.get('kill-stamp-label').textContent, label);
    assert.equal(h.get('kill-stamp').classList.contains('hot'), n >= 4);
    assert.ok(h.get('kill-vignette').style.opacity > 0);
    assert.ok(h.get('kill-vignette').style.opacity <= .55);
  }
  h.tick(.2);
  assert.equal(h.get('kill-vignette').style.opacity, 0);
  assert.equal(h.get('kill-stamp').style.opacity, 1);
  h.tick(1.2);
  assert.equal(h.get('kill-stamp').style.opacity, 0);
});

test('Overhaul HUD: restart clears every hit and combo presentation timer', () => {
  const h = harness();
  h.hud.hitmarker(true, true, 4); h.tick(.01); h.hud.resetCache();
  assert.deepEqual(h.hud.feedbackDebug(), { combo: 0, hitBounce: 0, killGlow: 0, stampT: 0 });
  assert.equal(Number(h.get('crosshair').style['--hit-scale']), 1);
  assert.equal(h.get('kill-stamp').style.opacity, 0);
  assert.equal(h.get('kill-vignette').style.opacity, 0);
  assert.equal(h.get('hitmark').classList.contains('critical'), false);
});

test('Overhaul4 HUD: victory stamp shows S/A/B with god annotation and hides on failure', () => {
  const h = harness();
  const settlement = { won: true, reason: 'ok', time: 150, kills: 5, players: [{ id: 0, kills: 1, walls: 1, erases: 1, rescues: 0 }],
    best: 150, isNew: false, perks: [], crits: 6, interrupts: 0, hp: 60 };
  h.hud.showSettlement({ ...settlement, rank: computeRank(settlement), god: true });
  let dbg = h.hud.rankDebug();
  assert.deepEqual([dbg.hidden, dbg.letter, dbg.mode], [false, 'S', true]);
  assert.equal(dbg.title, '神笔惊墨 · 完美归档');
  const b = { ...settlement, time: 400, hp: 20, crits: 0 };
  h.hud.showSettlement({ ...b, rank: computeRank(b), god: false });
  dbg = h.hud.rankDebug();
  assert.deepEqual([dbg.letter, dbg.mode], ['B', false]);
  h.hud.showSettlement({ ...settlement, won: false, rank: null });
  assert.equal(h.hud.rankDebug().hidden, true);
  h.hud.resetCache();
  assert.equal(h.hud.rankDebug().hidden, true);
});

test('Overhaul4 HUD: dash ability card reflects cooldown and active dash, arcs fade timer resets', () => {
  const h = harness();
  const p = h.hud; const runtime = createRuntime();
  const me = runtime.match.players[0];
  me.dashCd = 1.1; p.update(runtime.snapshot(), 0, 0.05);
  assert.equal(h.get('dash-state').textContent, '1.1s');
  me.dashT = 0.1; p.update(runtime.snapshot(), 0, 0.05);
  assert.equal(h.get('dash-state').textContent, '闪避中');
  me.dashT = 0; me.dashCd = 0; p.update(runtime.snapshot(), 0, 0.05);
  assert.equal(h.get('dash-state').textContent, '就绪');
  p.damageFrom(1, 0);
  p.dashFlash();
  p.resetCache();
  assert.equal(h.get('dash-state').textContent, '就绪');
});
