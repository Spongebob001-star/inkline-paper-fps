import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createEnemy, stepEnemies } from '../shared/enemies.mjs';
import { applyErase } from '../shared/erase.mjs';
import { createRuntime } from '../host/runtime.mjs';

const mk = () => createMatch({ seed: 5 });
// 开阔走廊 x=10（掩体/折页平台均不覆盖）
function arena(m) {
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = -10;
  const a = createEnemy(m, 'crane', 16, -10);
  const b = createEnemy(m, 'crane', 16.1, -10);
  const c = createEnemy(m, 'eraser', 10, -4);
  a.x = 16; a.z = -10; b.x = 16.1; b.z = -10; c.x = 10; c.z = -4;
  return { p, a, b, c };
}

test('擦除：35 墨 / CD 3.5 / 统计 / 事件 / lastSkill 齐全', () => {
  const m = mk();
  const { p, a, c } = arena(m);
  const r = applyErase(m, 0);
  assert.equal(r.ok, true);
  assert.equal(p.ink, 100 - CONFIG.ink.eraseCost);
  assert.equal(p.eraseCd, CONFIG.ink.eraseCooldown);
  assert.equal(p.stats.erases, 1);
  assert.equal(p.lastSkill, m.elapsed);
  assert.deepEqual(r.hit, [a.id, c.id]);
  assert.equal(r.stripped, 1);
  const ev = m.events.find(e => e.type === 'erase');
  assert.equal(ev.data.owner, 0);
  assert.equal(ev.data.stripped, 1);
  assert.equal(ev.data.x, 10); assert.equal(ev.data.z, -10);
});

test('半径 6m 边界：6.0 命中 / 6.1 不命中', () => {
  const m = mk();
  const { a, b } = arena(m);
  const r = applyErase(m, 0);
  assert.ok(r.hit.includes(a.id));
  assert.ok(!r.hit.includes(b.id));
  assert.equal(b.stun, 0);
  assert.equal(b.armor, CONFIG.enemy.armor);
});

test('剥甲 + 眩晕 1s + 减速计时 3.5s（眩晕后足额 2.5s）+ 打断蓄力 + 无生命伤害', () => {
  const m = mk();
  const { a, c } = arena(m);
  a.telegraph = 0.4;
  const hpBefore = a.hp;
  applyErase(m, 0);
  assert.equal(a.armor, 0);
  assert.equal(a.stun, CONFIG.ink.eraseStun);
  assert.equal(a.slow, CONFIG.ink.eraseStun + CONFIG.ink.eraseSlow);
  assert.equal(a.telegraph, 0);
  assert.equal(a.hp, hpBefore);
  assert.equal(c.armor, 0);
  assert.equal(c.stun, CONFIG.ink.eraseStun);
});

test('冷却中拒绝：不扣墨不加统计；3.5s 后可再释放', () => {
  const m = mk();
  const { p } = arena(m);
  applyErase(m, 0);
  const ink = p.ink;
  const r = applyErase(m, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(p.ink, ink);
  assert.equal(p.stats.erases, 1);
  for (let i = 0; i < 70; i++) stepMatch(m, {});
  assert.equal(p.eraseCd, 0);
  assert.equal(applyErase(m, 0).ok, true);
  assert.equal(p.stats.erases, 2);
});

test('墨量不足拒绝：不进入冷却', () => {
  const m = mk();
  const { p } = arena(m);
  p.ink = CONFIG.ink.eraseCost - 1;
  const r = applyErase(m, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ink');
  assert.equal(r.need, CONFIG.ink.eraseCost);
  assert.equal(p.eraseCd, 0);
  assert.equal(p.stats.erases, 0);
});

test('倒地玩家拒绝擦除', () => {
  const m = mk();
  const { p } = arena(m);
  p.st = 1;
  assert.equal(applyErase(m, 0).reason, 'dead');
});

test('眩晕期间不移动不蓄力；眩晕后减速位移为正常 50%', () => {
  const m = mk();
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = 4;
  const e = createEnemy(m, 'crane', 10, -10);
  e.x = 10; e.z = -10; e.stun = 1;
  const x0 = e.x, z0 = e.z;
  for (let i = 0; i < 10; i++) stepEnemies(m, CONFIG.net.dt);
  assert.equal(e.x, x0); assert.equal(e.z, z0);
  assert.equal(e.telegraph, 0);
  assert.ok(e.stun > 0);

  const ms = mk(), mn = mk();
  for (const mm of [ms, mn]) {
    const pp = mm.players[0];
    pp.pos.x = 10; pp.pos.z = 4;
    const ee = createEnemy(mm, 'crane', 10, -10);
    ee.x = 10; ee.z = -10; ee.attackCd = 9;
  }
  const es = ms.enemies[0], en = mn.enemies[0];
  es.slow = 2.5;
  stepEnemies(ms, CONFIG.net.dt);
  stepEnemies(mn, CONFIG.net.dt);
  const ds = Math.hypot(es.x - 10, es.z + 10);
  const dn = Math.hypot(en.x - 10, en.z + 10);
  assert.ok(Math.abs(ds / dn - CONFIG.enemy.slowFactor) < 1e-9);
});

test('快照带擦除冷却 ec；同种子同操作逐位可复现', () => {
  const runs = [];
  for (let k = 0; k < 2; k++) {
    const m = createMatch({ seed: 9 });
    arena(m);
    applyErase(m, 0);
    for (let i = 0; i < 30; i++) stepMatch(m, { 0: { f: 1, seq: i } });
    runs.push(JSON.stringify(snapshot(m)));
  }
  assert.equal(runs[0], runs[1]);
  const s = JSON.parse(runs[0]);
  assert.equal(typeof s.players[0].ec, 'number');
});

test('runtime.action erase 入口；未知折角 id 拒绝', () => {
  const rt = createRuntime({ seed: 3 });
  assert.equal(rt.action(0, { m: 'erase' }).ok, true);
  assert.equal(rt.action(0, { m: 'fold', foldId: 99 }).reason, 'noFold');
  assert.equal(rt.action(0, { m: 'fold', foldId: 2 }).reason, 'far');
});