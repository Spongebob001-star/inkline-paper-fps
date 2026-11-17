import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, encode, decode, validate, messageTypes } from '../shared/protocol.mjs';

const C2S = {
  hello: { m: 'hello', protocol: 1, name: '测试员' },
  create: { m: 'create' },
  join: { m: 'join', code: 'AB12' },
  ready: { m: 'ready', ready: true },
  input: { m: 'input', seq: 7, mvx: 0, mvz: 1, yaw: 1.2, pitch: -0.1, btn: 3 },
  drawStart: { m: 'drawStart', seq: 8, x: 1, z: 2, y: 0 },
  drawEnd: { m: 'drawEnd', seq: 9, ax: 1, az: 2, bx: 4, bz: 2 },
  shot: { m: 'shot', seq: 10, ox: 0, oy: 1.65, oz: -13, dx: 0, dy: 0, dz: 1 },
  fold: { m: 'fold', seq: 11, foldId: 0 },
  interact: { m: 'interact', seq: 12, hold: true },
  ping: { m: 'ping', t: 1234 },
  leave: { m: 'leave' },
};

const S2C = {
  welcome: { m: 'welcome', playerId: 0, token: 'tok' },
  room: { m: 'room', code: 'AB12', hostId: 0, players: [], state: 'lobby' },
  start: { m: 'start', seed: 42, players: [0], spawns: [{ x: 0, z: -13 }] },
  snapshot: {
    m: 'snapshot', tick: 100, ack: 9, timeLeft: 239.5, phase: 'anchors',
    players: [], enemies: [], projectiles: [], walls: [], folds: [], pickups: [], anchors: [],
  },
  event: { m: 'event', type: 'anchorDone', data: { i: 0 } },
  pong: { m: 'pong', t: 1234 },
  error: { m: 'error', code: 'room_full', msg: '房间已满' },
};

test('协议版本 = 1', () => {
  assert.equal(PROTOCOL, 1);
});

test('c2s 全类型往返 + 校验通过', () => {
  for (const ty of messageTypes('c2s')) {
    const msg = C2S[ty];
    assert.ok(msg, `样例缺失: ${ty}`);
    const d = decode(encode(msg));
    assert.equal(d.ok, true, ty);
    assert.deepEqual(d.msg, msg, ty);
    assert.equal(validate(d.msg, 'c2s').ok, true, ty);
  }
});

test('s2c 全类型往返 + 校验通过', () => {
  for (const ty of messageTypes('s2c')) {
    const msg = S2C[ty];
    assert.ok(msg, `样例缺失: ${ty}`);
    const d = decode(encode(msg));
    assert.equal(d.ok, true, ty);
    assert.deepEqual(d.msg, msg, ty);
    assert.equal(validate(d.msg, 's2c').ok, true, ty);
  }
});

test('ping/pong 时间戳字段 t 与信封键 m 不冲突', () => {
  const d = decode(encode(C2S.ping));
  assert.equal(d.msg.m, 'ping');
  assert.equal(d.msg.t, 1234);
  assert.equal(validate(d.msg, 'c2s').ok, true);
});

test('可选字段：hello.token / interact.targetId', () => {
  assert.equal(validate({ m: 'hello', protocol: 1, name: 'x', token: 'abc' }, 'c2s').ok, true);
  assert.equal(validate({ m: 'interact', seq: 1, hold: false, targetId: 3 }, 'c2s').ok, true);
  assert.equal(validate({ m: 'hello', protocol: 1, name: 'x', token: 5 }, 'c2s').ok, false);
});

test('decode 拒绝坏 JSON / 非对象 / 超大包', () => {
  assert.equal(decode('not json').ok, false);
  assert.equal(decode('"str"').ok, false);
  assert.equal(decode('null').ok, false);
  assert.equal(decode('{"x":1}').ok, false);
  assert.equal(decode('x'.repeat(65537)).ok, false);
});

test('validate 拒绝未知类型 / 缺字段 / 错类型 / 方向错误', () => {
  assert.equal(validate({ m: 'hack' }, 'c2s').reason, 'unknown_type');
  assert.equal(validate({ m: 'input', seq: 1 }, 'c2s').ok, false);
  assert.equal(validate({ m: 'join', code: 123 }, 'c2s').reason, 'field_code');
  assert.equal(validate({ m: 'snapshot', tick: 1 }, 's2c').ok, false);
  assert.equal(validate(C2S.input, 's2c').reason, 'unknown_type');
  assert.equal(validate({ m: 'input' }, 'bad').reason, 'bad_dir');
});

test('hello 协议不匹配拒绝', () => {
  assert.equal(validate({ m: 'hello', protocol: 2, name: 'x' }, 'c2s').reason, 'protocol_mismatch');
});

test('snapshot 允许省略 boss（未激活）', () => {
  const d = decode(encode(S2C.snapshot));
  assert.equal(validate(d.msg, 's2c').ok, true);
});

test('input 拒绝 NaN / Infinity（边界防护）', () => {
  const bad = { m: 'input', seq: NaN, mvx: 0, mvz: 1, yaw: 0, pitch: 0, btn: 0 };
  assert.equal(validate(bad, 'c2s').ok, false);
  bad.seq = 1; bad.mvx = Infinity;
  assert.equal(validate(bad, 'c2s').ok, false);
});