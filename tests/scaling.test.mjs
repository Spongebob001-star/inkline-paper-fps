// D7 T7.2：人数缩放全表 n=1–4（规格 §3.9）——开局/增援/同屏/生命倍率/Boss/扇形逐项。
import test from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot } from '../shared/sim.mjs';
import { createEnemy } from '../shared/enemies.mjs';
import { createBoss, stepBoss } from '../shared/boss.mjs';
import { spawnInitialEnemies, spawnReinforcements } from '../shared/flow.mjs';
import { ANCHORS } from '../shared/world.mjs';

const DT = CONFIG.net.dt;
const S = CONFIG.scaling;
const ids = n => Array.from({ length: n }, (_, i) => i);
const place = (p, x, z) => { p.pos.x = x; p.pos.z = z; };

test('缩放表逐项：开局 4/6/8/10、增援 +3/+4/+5/+6、上限 9/12/14/16、倍率 1.0/1.55/2.1/2.6', () => {
  const rows = {
    1: { initial: 4, reinforce: 3, cap: 9, hpMul: 1.0, bossHp: 1100, fan: 7 },
    2: { initial: 6, reinforce: 4, cap: 12, hpMul: 1.55, bossHp: 1650, fan: 8 },
    3: { initial: 8, reinforce: 5, cap: 14, hpMul: 2.1, bossHp: 2200, fan: 9 },
    4: { initial: 10, reinforce: 6, cap: 16, hpMul: 2.6, bossHp: 2750, fan: 10 },
  };
  for (let n = 1; n <= 4; n++) assert.deepEqual(S[n], rows[n], 'n=' + n);
  assert.deepEqual(S.spawn, { minDist: 3.5, landAnim: 0.35, attackBuffer: 1.5 });
});

test('开局波次：4/6/8/10 且构成 3+1 / 4+2 / 6+2 / 7+3（涂改灵+橡皮擦虫）', () => {
  for (let n = 1; n <= 4; n++) {
    const m = createMatch({ seed: 11, playerIds: ids(n) });
    const made = spawnInitialEnemies(m);
    assert.equal(made, S[n].initial, 'n=' + n);
    assert.equal(m.enemies.length, S[n].initial);
    const cranes = m.enemies.filter(e => e.type === 'crane').length;
    const erasers = m.enemies.filter(e => e.type === 'eraser').length;
    assert.deepEqual([cranes, erasers], CONFIG.waves.initialMix[n], 'n=' + n);
    assert.equal(cranes + erasers, S[n].initial);
    assert.ok(m.enemies.every(e => e.spawnT === 0)); // 落地动画
  }
});

test('敌人生命倍率：生成时应用 1.0/1.55/2.1/2.6（护甲不变）', () => {
  const base = { crane: CONFIG.enemy.hp, eraser: CONFIG.enemy.eraser.hp, plane: CONFIG.enemy.plane.hp };
  const spots = { crane: [-13, 4], eraser: [12, 11], plane: [3, 6] };
  for (let n = 1; n <= 4; n++) {
    const m = createMatch({ seed: 11, playerIds: ids(n) });
    for (const type of ['crane', 'eraser', 'plane']) {
      const [x, z] = spots[type];
      const e = createEnemy(m, type, x, z);
      assert.equal(e.hp, Math.round(base[type] * S[n].hpMul), `n=${n} ${type}`);
      assert.equal(e.armor, type === 'crane' ? CONFIG.enemy.armor : 0);
    }
  }
});

test('每锚点增援：数量 +3/+4/+5/+6，构成按 afterA1/afterA2 循环补齐', () => {
  for (let n = 1; n <= 4; n++) {
    const m = createMatch({ seed: 11, playerIds: ids(n) });
    for (const p of m.players) place(p, 0, -13 + p.id * 0.5); // 集中南侧

    m.anchorsDone = 1;
    const a1 = spawnReinforcements(m, ANCHORS[0]);
    assert.equal(a1.length, S[n].reinforce, 'A1 n=' + n);
    assert.equal(m.enemies.length, S[n].reinforce);
    for (let i = 0; i < a1.length; i++) assert.equal(a1[i].type, CONFIG.waves.afterA1[i % CONFIG.waves.afterA1.length]);

    m.enemies = [];
    m.anchorsDone = 2;
    const a2 = spawnReinforcements(m, ANCHORS[1]);
    assert.equal(a2.length, S[n].reinforce, 'A2 n=' + n);
    for (let i = 0; i < a2.length; i++) assert.equal(a2[i].type, CONFIG.waves.afterA2[i % CONFIG.waves.afterA2.length]);
  }
});

test('增援选点：距任意玩家 ≥3.5m；落地 0.35s；首攻缓冲 1.5s', () => {
  for (let n = 1; n <= 4; n++) {
    const m = createMatch({ seed: 11, playerIds: ids(n) });
    // 玩家贴近锚点 A1 的候选环，逼迫选点推远
    for (const p of m.players) place(p, ANCHORS[0].x + p.id * 0.3, ANCHORS[0].z + 0.8);
    m.anchorsDone = 1;
    const made = spawnReinforcements(m, ANCHORS[0]);
    assert.equal(made.length, S[n].reinforce);
    for (const e of made) {
      for (const p of m.players) {
        assert.ok(Math.hypot(e.x - p.pos.x, e.z - p.pos.z) >= 3.5, `n=${n} enemy=${e.x},${e.z} player=${p.pos.x},${p.pos.z}`);
      }
      assert.equal(e.spawnT, 0); // 0.35s 落地动画起点
      assert.equal(e.attackCd, CONFIG.scaling.spawn.attackBuffer);
    }
  }
});

test('同屏上限：满 cap 时增援为 0；跨过 cap 差额按剩余位补齐', () => {
  for (let n = 1; n <= 4; n++) {
    const m = createMatch({ seed: 11, playerIds: ids(n) });
    for (const p of m.players) place(p, 0, -13);
    for (let i = 0; i < S[n].cap; i++) m.enemies.push({ id: 1000 + i, dead: false });
    m.anchorsDone = 1;
    assert.equal(spawnReinforcements(m, ANCHORS[0]).length, 0, 'cap n=' + n);
    assert.equal(m.enemies.length, S[n].cap);

    const k = createMatch({ seed: 11, playerIds: ids(n) });
    for (const p of k.players) place(p, 0, -13);
    for (let i = 0; i < S[n].cap - 2; i++) k.enemies.push({ id: 2000 + i, dead: false });
    k.anchorsDone = 1;
    assert.equal(spawnReinforcements(k, ANCHORS[0]).length, 2, '剩余位 n=' + n);
    assert.equal(k.enemies.length, S[n].cap);
  }
});

test('Boss 生命 1100/1650/2200/2750 与扇形 7/8/9/10 按人数', () => {
  for (let n = 1; n <= 4; n++) {
    const m = createMatch({ seed: 11, playerIds: ids(n) });
    const b = createBoss(m);
    assert.equal(b.hp, S[n].bossHp, 'n=' + n);
    assert.equal(b.maxHp, S[n].bossHp);
    b.nextAttack = 0;
    b.attackCd = 0;
    for (let i = 0; i < 14; i++) stepBoss(m, DT);
    assert.equal(m.projectiles.length, S[n].fan, 'fan n=' + n);
    for (const pr of m.projectiles) assert.equal(pr.damage, CONFIG.boss.fanDamage);
  }
});

test('确定性：4 人 + 10 敌人同种子 300 步双跑快照逐位相等', () => {
  const run = () => {
    const m = createMatch({ seed: 20261122, playerIds: [0, 1, 2, 3] });
    spawnInitialEnemies(m);
    for (let i = 0; i < 300; i++) {
      stepMatch(m, {
        0: { f: i % 40 < 20 ? 1 : 0, r: 0.3, seq: i },
        1: { f: 1, r: i % 30 < 15 ? 0.4 : -0.4, seq: i },
        2: { hold: i % 20 === 0, seq: i },
        3: { f: i % 50 < 25 ? -1 : 0, seq: i },
      });
    }
    return snapshot(m);
  };
  assert.deepEqual(run(), run());
});
