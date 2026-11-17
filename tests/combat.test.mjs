import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, drainEvents } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { applyShot, fireProjectile, stepProjectiles, damageWall, losBlocker } from '../shared/combat.mjs';
import { createBoss, damageBoss } from '../shared/boss.mjs';

const DT = CONFIG.net.dt;
const AIM = { x: 0, y: -0.1, z: 1 }; // 略俯，命中 1.49m 以下躯干

function makeWall(match, x, z, len = 4, rot = 0) {
  const ux = Math.cos(rot), uz = -Math.sin(rot);
  const w = {
    id: match.nextId++, x, z, len,
    ux, uz, nx: -uz, nz: ux,
    halfThickness: CONFIG.wall.halfThickness,
    hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, dead: false,
  };
  match.walls.push(w);
  return w;
}

function shoot(match, id = 0) {
  const p = match.players.find(pl => pl.id === id);
  p.fireCd = 0;
  return applyShot(match, id, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, AIM);
}

test('射击闭环：8 发削甲（每发 3）→ 2 发击杀（每发 24）', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5);
  for (let i = 0; i < 8; i++) {
    const r = shoot(m);
    assert.equal(r.kind, 'enemy');
  }
  assert.equal(e.armor, 0);
  assert.equal(e.hp, 48);
  assert.ok(drainEvents(m).some(ev => ev.type === 'armorStrip'));
  shoot(m);
  assert.equal(e.hp, 24);
  shoot(m);
  assert.equal(e.dead, true);
  assert.equal(m.kills, 1);
  assert.ok(drainEvents(m).some(ev => ev.type === 'kill'));
});

test('玩家墙挡弹：敌人不掉血，留 impact 事件', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, -5);
  makeWall(m, 0, -9);
  const r = shoot(m);
  assert.equal(r.kind, 'wall');
  assert.equal(e.hp, 48);
  assert.equal(e.armor, 24);
});

test('射程 48m：无目标时射线止于 48m', () => {
  const m = createMatch();
  const p = m.players[0];
  p.fireCd = 0;
  const r = applyShot(m, 0, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, { x: 0, y: 1, z: 0 });
  assert.equal(r.kind, 'none');
  assert.ok(Math.abs(r.end.y - (1.65 + 48)) < 1e-6);
});

test('无友伤：射线穿过队友不掉血', () => {
  const m = createMatch({ playerIds: [0, 1] });
  m.players[1].pos.x = 0; m.players[1].pos.z = -9;
  createEnemy(m, 'crane', 0, -5);
  const r = shoot(m);
  assert.equal(r.kind, 'enemy');
  assert.equal(m.players[1].hp, 100);
});

test('固定掩体挡弹（平台也挡）', () => {
  const m = createMatch();
  const e = createEnemy(m, 'crane', 0, 2); // 中心掩体 (0,0) 之后
  const r = shoot(m);
  assert.equal(r.kind, 'static');
  assert.equal(e.hp, 48);
});

test('墨弹：9m/s 飞向玩家，命中扣 8，事件 playerHit', () => {
  const m = createMatch();
  const p = m.players[0];
  fireProjectile(m, { x: 0, y: 0.88, z: -5 }, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, 9, 8);
  assert.equal(m.projectiles.length, 1);
  for (let i = 0; i < 40 && m.projectiles.length; i++) stepProjectiles(m, DT);
  assert.equal(m.projectiles.length, 0);
  assert.equal(p.hp, 92);
  assert.ok(drainEvents(m).some(ev => ev.type === 'playerHit'));
});

test('墨弹打玩家墙：墙扣 18 并消散', () => {
  const m = createMatch();
  const w = makeWall(m, 0, -9);
  fireProjectile(m, { x: 0, y: 0.88, z: -5 }, { x: 0, y: 1.65, z: -13 }, 9, 8);
  for (let i = 0; i < 40 && m.projectiles.length; i++) stepProjectiles(m, DT);
  assert.equal(w.hp, 102);
  assert.equal(m.players[0].hp, 100);
});

test('墨弹寿命 1.8s：y=3 水平弹道超时消散', () => {
  const m = createMatch();
  fireProjectile(m, { x: 0, y: 3, z: -13 }, { x: 10, y: 3, z: -13 }, 9, 8);
  for (let i = 0; i < 35; i++) stepProjectiles(m, DT); // 1.75s
  assert.equal(m.projectiles.length, 1);
  for (let i = 0; i < 2; i++) stepProjectiles(m, DT); // 1.85s
  assert.equal(m.projectiles.length, 0);
});

test('折纸墙挡墨弹且不扣耐久', () => {
  const m = createMatch();
  m.folds[2].state = 'wall'; // (0,-6)  rotY -π/2
  stepMatch(m, {});
  fireProjectile(m, { x: 0, y: 0.88, z: -3 }, { x: 0, y: 1.65, z: -13 }, 9, 8);
  for (let i = 0; i < 40 && m.projectiles.length; i++) stepProjectiles(m, DT);
  assert.equal(m.projectiles.length, 0);
  assert.equal(m.players[0].hp, 100);
});

test('墨弹可躲：横向移动离开弹道', () => {
  const m = createMatch();
  const p = m.players[0];
  fireProjectile(m, { x: 0, y: 1.3, z: -5 }, { x: 0, y: 1.3, z: -13 }, 9, 8);
  p.pos.x = 3; // 瞬移模拟躲开（弹道直線）
  for (let i = 0; i < 40 && m.projectiles.length; i++) stepProjectiles(m, DT);
  assert.equal(p.hp, 100);
});

test('losBlocker：墙后视线被挡，返回墙引用与命中点', () => {
  const m = createMatch();
  const w = makeWall(m, 0, -9);
  const b = losBlocker(m, { x: 0, y: 0.86, z: -5 }, { x: 0, y: 1.65, z: -13 });
  assert.equal(b.kind, 'wall');
  assert.equal(b.wall.id, w.id);
  assert.ok(Math.abs(b.point.z - (-9)) < 0.2);
});

test('Boss 护盾：常态 ceil(24×0.35)=9，狂暴后全额 24', () => {
  const m = createMatch();
  createBoss(m);
  assert.equal(damageBoss(m, 24), 9);
  assert.equal(m.boss.hp, 471);
  m.boss.hp = 240; // ≤50%
  damageBoss(m, 24);
  assert.equal(m.boss.raged, true);
  const before = m.boss.hp;
  assert.equal(damageBoss(m, 24), 24);
  assert.equal(m.boss.hp, before - 24);
});

test('Boss 死亡解锁出口', () => {
  const m = createMatch();
  createBoss(m);
  m.boss.hp = 9;
  damageBoss(m, 24);
  assert.equal(m.boss.dead, true);
  assert.equal(m.exitUnlocked, true);
  assert.ok(drainEvents(m).some(ev => ev.type === 'bossDown'));
});

test('射击命中 Boss 走护盾结算', () => {
  const m = createMatch();
  createBoss(m);
  m.boss.x = 0; m.boss.z = -5;
  const r = shoot(m);
  assert.equal(r.kind, 'boss');
  assert.equal(m.boss.hp, 471);
});

test('墙耐久归零死亡并事件', () => {
  const m = createMatch();
  const w = makeWall(m, 0, -9);
  damageWall(m, w, 120);
  assert.equal(w.dead, true);
  assert.ok(drainEvents(m).some(ev => ev.type === 'wallBreak'));
});