import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../host/runtime.mjs';

test('60fps 驱动 2s → 40 个 20Hz tick，快照回调同数', () => {
  let snaps = 0;
  const rt = createRuntime({ onSnapshot: () => snaps++ });
  rt.advance(0);
  let t = 0;
  for (let i = 0; i < 120; i++) { t += 1000 / 60; rt.advance(t); }
  assert.equal(rt.match.tick, 40);
  assert.equal(snaps, 40);
  assert.ok(Math.abs(rt.match.timeLeft - 238) < 0.06);
});

test('追帧上限 3：单次 +1s 只补 3 步，积压丢弃', () => {
  const rt = createRuntime();
  rt.advance(0);
  const steps = rt.advance(1000);
  assert.equal(steps, 3);
  assert.equal(rt.match.tick, 3);
  const again = rt.advance(1016);
  assert.equal(again, 0);
});

test('时钟回拨不产生负步', () => {
  const rt = createRuntime();
  rt.advance(1000);
  assert.equal(rt.advance(900), 0);
});

test('输入意图驱动玩家：setInput 后位移生效', () => {
  const rt = createRuntime();
  rt.setInput(0, { f: 1, seq: 1 });
  let t = 0;
  for (let i = 0; i < 60; i++) { t += 1000 / 60; rt.advance(t); }
  const p = rt.match.players[0];
  assert.ok(p.pos.z < -13.5, `z=${p.pos.z}`);
  assert.equal(rt.match.ack[0], 1);
});

test('无头 20s 冒烟：状态 sane，无 NaN', () => {
  const rt = createRuntime({ seed: 99 });
  rt.setInput(0, { f: 1, r: 0.3, sprint: true });
  rt.advance(0);
  for (let i = 1; i <= 400; i++) rt.advance(i * 50);
  const s = rt.snapshot();
  assert.equal(s.tick, 400);
  for (const v of [s.players[0].x, s.players[0].z, s.players[0].y, s.timeLeft]) {
    assert.ok(Number.isFinite(v));
  }
  assert.ok(Math.abs(s.players[0].x) <= 17.01 && Math.abs(s.players[0].z) <= 17.01);
});