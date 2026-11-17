import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { applyDraw, validateDraw, drawCost, stepWalls } from '../shared/walls.mjs';
import { damageWall } from '../shared/combat.mjs';

const mk = () => createMatch({ seed: 5 });
// 开阔走廊 x=10：画墙不与掩体/折页重叠
const lane = (z1, z2) => [{ x: 10, z: z1 }, { x: 10, z: z2 }];

test('合法 4m 墙：费 36=20+4×4，扣墨/字段/统计/事件齐全', () => {
  const m = mk();
  const p = m.players[0];
  const r = applyDraw(m, 0, ...lane(-12, -8));
  assert.equal(r.ok, true);
  assert.equal(r.wall.len, 4);
  assert.equal(p.ink, 100 - 36);
  assert.equal(r.wall.hp, 120);
  assert.equal(r.wall.life, 18);
  assert.equal(r.wall.halfThickness, 0.06);
  assert.equal(r.wall.ux, 0); assert.equal(r.wall.uz, 1);
  assert.equal(r.wall.nx, -1); assert.equal(r.wall.nz, 0);
  assert.equal(p.stats.walls, 1);
  assert.ok(m.events.some(e => e.type === 'wallDraw'));
  assert.equal(p.lastSkill, m.elapsed);
});

test('太短 1.5m / 太长 7m：拒绝且不扣墨', () => {
  const m = mk();
  const p = m.players[0];
  const short = applyDraw(m, 0, ...lane(-12, -10.5));
  assert.equal(short.ok, false); assert.equal(short.reason, 'short');
  const long = applyDraw(m, 0, ...lane(-12, -5));
  assert.equal(long.ok, false); assert.equal(long.reason, 'long');
  assert.equal(p.ink, 100);
  assert.equal(m.walls.length, 0);
});

test('画在自己身上（点段距 <0.75）拒绝', () => {
  const m = mk();
  const r = applyDraw(m, 0, { x: -2, z: -13 }, { x: 2, z: -13 });
  assert.equal(r.ok, false); assert.equal(r.reason, 'self');
  assert.equal(m.players[0].ink, 100);
});

test('墨不足拒绝；预览与终判同函数', () => {
  const m = mk();
  m.players[0].ink = 30;
  const v = validateDraw(m, m.players[0], ...lane(-12, -8));
  assert.equal(v.ok, false); assert.equal(v.reason, 'ink');
  assert.equal(v.cost, drawCost(4));
  const r = applyDraw(m, 0, ...lane(-12, -8));
  assert.equal(r.ok, false);
  assert.equal(m.walls.length, 0);
});

test('端点钳制 ±16.5（与原型 aimGround 一致）', () => {
  const m = mk();
  const r = applyDraw(m, 0, { x: 20, z: -12 }, { x: 20, z: -8 });
  assert.equal(r.ok, true);
  assert.equal(r.wall.x, 16.5);
  assert.equal(r.wall.len, 4);
});

test('每人 3 面：第 4 面移除本人最旧（FIFO）', () => {
  const m = mk();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    m.players[0].ink = 100;
    const z = -12 + i * 0.9;
    const r = applyDraw(m, 0, { x: 8, z }, { x: 12, z });
    assert.equal(r.ok, true);
    ids.push(r.wall.id);
  }
  assert.equal(m.walls.length, 3);
  assert.ok(!m.walls.some(w => w.id === ids[0]));
  assert.ok(m.events.some(e => e.type === 'wallRemove' && e.data.id === ids[0]));
});

test('团队 10 面：4 人各画 3 面后全局最旧被移除', () => {
  const m = createMatch({ seed: 5, playerIds: [0, 1, 2, 3] });
  const all = [];
  for (const p of m.players) {
    for (let i = 0; i < 3; i++) {
      p.ink = 100;
      p.pos.x = 10; p.pos.z = -13;
      const z = -12 + i * 0.9 + p.id * 0.05;
      const r = applyDraw(m, p.id, { x: 8, z }, { x: 12, z });
      assert.equal(r.ok, true);
      all.push(r.wall.id);
      assert.ok(m.walls.length <= CONFIG.wall.teamMax);
    }
  }
  assert.equal(m.walls.length, 10);
  assert.ok(!m.walls.some(w => w.id === all[0]));
  assert.ok(!m.walls.some(w => w.id === all[1]));
});

test('存续 18s：17s 时进入渐隐窗（life<3），18s 到期移除+事件', () => {
  const m = mk();
  applyDraw(m, 0, ...lane(-12, -8));
  for (let i = 0; i < 340; i++) stepMatch(m, {});
  assert.equal(m.walls.length, 1);
  assert.ok(m.walls[0].life < 3 && m.walls[0].life > 0);
  for (let i = 0; i < 25; i++) stepMatch(m, {});
  assert.equal(m.walls.length, 0);
  assert.ok(m.events.some(e => e.type === 'wallExpire'));
});

test('墙阻挡玩家移动（stepPlayer 碰撞接入）', () => {
  const m = mk();
  applyDraw(m, 0, { x: 8, z: -10 }, { x: 12, z: -10 });
  const p = m.players[0];
  p.pos.x = 10; p.pos.z = -11;
  for (let i = 0; i < 40; i++) stepMatch(m, { 0: { f: -1 } });
  assert.ok(p.pos.z < -10.3, '玩家应被墙挡在北侧: z=' + p.pos.z);
});

test('墙耐久归零：damageWall → wallBreak → stepMatch 清出快照', () => {
  const m = mk();
  const r = applyDraw(m, 0, ...lane(-12, -8));
  damageWall(m, r.wall, 120);
  assert.ok(m.events.some(e => e.type === 'wallBreak'));
  stepMatch(m, {});
  assert.equal(m.walls.length, 0);
  assert.equal(snapshot(m).walls.length, 0);
});

test('stepWalls 单独调用：到期 splice', () => {
  const m = mk();
  applyDraw(m, 0, ...lane(-12, -8));
  stepWalls(m, 18.1);
  assert.equal(m.walls.length, 0);
});