// 规格书 v2 §4.3 房间码信箱 + P2P 游戏消息协议（protocol: 1）。
// 信封 {m: 类型, ...字段}；规格未规定信封键名，取 m 以避开 ping/pong 的 t 字段与 event 的 type 字段。
// DataChannel 与信令 Function 共用同一套校验。
export const PROTOCOL = 1;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => typeof v === 'string';
const bool = (v) => typeof v === 'boolean';
const arr = (v) => Array.isArray(v);
const any = (v) => v !== undefined && v !== null;
const optStr = (v) => v === undefined || typeof v === 'string';
const optNum = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));

const FIELDS = {
  c2s: {
    hello: { protocol: num, name: str, token: optStr },
    create: {},
    join: { code: str },
    ready: { ready: bool },
    input: { seq: num, mvx: num, mvz: num, yaw: num, pitch: num, btn: num },
    drawStart: { seq: num, x: num, z: num, y: num },
    drawEnd: { seq: num, ax: num, az: num, bx: num, bz: num },
    shot: { seq: num, ox: num, oy: num, oz: num, dx: num, dy: num, dz: num },
    fold: { seq: num, foldId: num },
    interact: { seq: num, hold: bool, targetId: optNum },
    ping: { t: num },
    leave: {},
  },
  s2c: {
    welcome: { playerId: num, token: str },
    room: { code: str, hostId: num, players: arr, state: str },
    start: { seed: num, players: arr, spawns: arr },
    snapshot: {
      tick: num, ack: num, timeLeft: num, phase: str,
      players: arr, enemies: arr, projectiles: arr, walls: arr,
      folds: arr, pickups: arr, anchors: arr,
    },
    event: { type: str, data: any },
    pong: { t: num },
    error: { code: str, msg: str },
  },
};

export function encode(msg) {
  return JSON.stringify(msg);
}

export function decode(text) {
  if (typeof text !== 'string' || text.length > 65536) return { ok: false, reason: 'bad_size' };
  let msg;
  try { msg = JSON.parse(text); } catch { return { ok: false, reason: 'bad_json' }; }
  if (!msg || typeof msg !== 'object' || typeof msg.m !== 'string') return { ok: false, reason: 'bad_message' };
  return { ok: true, msg };
}

export function validate(msg, dir) {
  const table = FIELDS[dir];
  if (!table) return { ok: false, reason: 'bad_dir' };
  const fields = table[msg.m];
  if (!fields) return { ok: false, reason: 'unknown_type' };
  for (const k in fields) {
    if (!fields[k](msg[k])) return { ok: false, reason: 'field_' + k };
  }
  if (msg.m === 'hello' && msg.protocol !== PROTOCOL) return { ok: false, reason: 'protocol_mismatch' };
  return { ok: true };
}

export function messageTypes(dir) {
  return Object.keys(FIELDS[dir] || {});
}