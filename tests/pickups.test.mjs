import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';

const pickup = (m, ty, idx) => m.pickups.filter(p => p.ty === ty)[idx];
const near = (p, x, z) => { p.pos.x = x; p.pos.z = z; };

test('§3.10 坐标：墨水瓶 ×3 / 胶带 ×3 与配置一致', () => {
  const m = createMatch({ seed: 5 });
  const inks = m.pickups.filter(p => p.ty === 'ink').map(p => [p.x, p.z]);
  const tapes = m.pickups.filter(p => p.ty === 'tape').map(p => [p.x, p.z]);
  assert.deepEqual(inks, [[14, 8], [-14, 10], [12, -12]]);
  assert.deepEqual(tapes, [[-13, -6], [7, 13], [0, 10]]);
  assert.equal(m.pickups.length, 6);
  assert.ok(m.pickups.every(p => !p.taken));
});

test('1m 接触拾取：墨 +40；1.01m 不触发', () => {
  const m = createMatch({ seed: 5 });
  const p = m.players[0];
  p.ink = 50;
  near(p, 14 + 1.01, 8);
  stepMatch(m, {});
  assert.equal(pickup(m, 'ink', 0).taken, false);
  assert.equal(p.ink, 50.5); // 单步墨量自然恢复 10/s×0.05
  near(p, 14 + 0.99, 8);
  stepMatch(m, {});
  const pk = pickup(m, 'ink', 0);
  assert.equal(pk.taken, true);
  assert.equal(p.ink, 91); // 50.5 + 恢复 0.5 + 40
  const ev = m.events.find(e => e.type === 'pickup');
  assert.equal(ev.data.ty, 'ink');
  assert.equal(ev.data.playerId, 0);
  assert.equal(ev.data.x, 14); assert.equal(ev.data.z, 8);
});

test('胶带 +30 生命；两者均封顶 100', () => {
  const m = createMatch({ seed: 5 });
  const p = m.players[0];
  p.hp = 85;
  p.ink = 80;
  near(p, -13, -6);
  stepMatch(m, {});
  assert.equal(p.hp, 100);
  near(p, 12, -12);
  stepMatch(m, {});
  assert.equal(p.ink, 100);
});

test('先到先得：两人同时在 1m 内只结算一次给先到者', () => {
  const m = createMatch({ seed: 5, playerIds: [0, 1] });
  const [p0, p1] = m.players;
  p0.ink = 50; p1.ink = 50;
  near(p0, 14.5, 8);
  near(p1, 13.5, 8);
  stepMatch(m, {});
  const pk = pickup(m, 'ink', 0);
  assert.equal(pk.taken, true);
  assert.equal(p0.ink, 90.5);
  assert.equal(p1.ink, 50.5);
  assert.equal(m.events.filter(e => e.type === 'pickup').length, 1);
});

test('倒地玩家不拾取；快照 taken 同步', () => {
  const m = createMatch({ seed: 5, playerIds: [0, 1] });
  const p = m.players[0];
  p.st = 1;
  near(p, 14, 8);
  stepMatch(m, {});
  assert.equal(pickup(m, 'ink', 0).taken, false);
  assert.equal(snapshot(m).pickups[0].taken, false);
  p.st = 0;
  stepMatch(m, {});
  assert.equal(pickup(m, 'ink', 0).taken, true);
  assert.equal(snapshot(m).pickups[0].taken, true);
});

test('每局刷新：新 match 全部未拾取', () => {
  const a = createMatch({ seed: 5 });
  near(a.players[0], 14, 8);
  stepMatch(a, {});
  assert.equal(pickup(a, 'ink', 0).taken, true);
  assert.ok(createMatch({ seed: 5 }).pickups.every(p => !p.taken));
});