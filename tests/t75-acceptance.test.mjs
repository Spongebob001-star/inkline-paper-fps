// T7.5 M2 验收补测：§7.3 第 4 条「平台可越过 1.65m 墙射击」的显式断言。
// 其余九条由既有专项测试覆盖（见 docs/T7.5-M2-验收.md 的逐条证据表）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { applyShot, losBlocker } from '../shared/combat.mjs';

const WALL_H = CONFIG.wall.height; // 1.65
const PLAT_EYE = CONFIG.folds.platformHeight + CONFIG.player.eyeHeight; // 1.5 + 1.65 = 3.15

function makeWall(match, x, z) {
  const w = {
    id: match.nextId++, x, z, len: 4,
    ux: 1, uz: 0, nx: 0, nz: 1,
    halfThickness: CONFIG.wall.halfThickness,
    hp: CONFIG.wall.hp, life: CONFIG.wall.lifetime, dead: false,
  };
  match.walls.push(w);
  return w;
}

// 玩家 (0,-13) → 涂改灵 (0,-5)，中间 (0,-9) 一面 1.65m 纸墙
function setup(eyeY) {
  const m = createMatch();
  const p = m.players[0];
  p.pos.x = 0; p.pos.z = -13; p.pos.y = eyeY;
  p.fireCd = 0;
  const e = createEnemy(m, 'crane', 0, -5);
  const w = makeWall(m, 0, -9);
  const target = { x: 0, y: 0.75, z: -5 };
  const dx = target.x - p.pos.x, dy = target.y - p.pos.y, dz = target.z - p.pos.z;
  const l = Math.hypot(dx, dy, dz);
  const dir = { x: dx / l, y: dy / l, z: dz / l };
  return { m, p, e, w, target, dir };
}

test('§7.3-4 地面视角：1.65m 纸墙挡住射向墙后敌人的子弹', () => {
  const { m, p, e, w, target, dir } = setup(CONFIG.player.eyeHeight);
  const block = losBlocker(m, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, target);
  assert.ok(block && block.wall === w, '地面视线应被纸墙遮挡');
  const r = applyShot(m, 0, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, dir);
  assert.equal(r.kind, 'wall');
  assert.equal(e.hp, CONFIG.enemy.hp);
  assert.equal(e.armor, CONFIG.enemy.armor);
});

test('§7.3-4 平台视角（y=3.15）：同一射线越过 1.65m 纸墙命中墙后敌人', () => {
  const { m, p, e, target, dir } = setup(PLAT_EYE);
  assert.equal(losBlocker(m, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, target), null);
  const r = applyShot(m, 0, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, dir);
  assert.equal(r.kind, 'enemy');
  assert.equal(e.armor, CONFIG.enemy.armor - CONFIG.player.gun.armorDamage);
  // 越墙高度余量：射线在墙位 (z=-9) 的 y 必须高于墙顶
  const t = (-9 - p.pos.z) / dir.z;
  assert.ok(p.pos.y + dir.y * t > WALL_H, '墙位射线高度应 > 1.65');
});