// D7 合作内核：倒地倒计时 / 救援 / 1s 无敌（规格 §3.13，T7.1）。
// 倒地由 combat.damagePlayer 置 st=1（不改 combat）；本模块补 20s 倒计时、爬行期救援与无敌帧。
// 无敌期伤害为 0：不改 combat.mjs，由 sim.stepMatch 在伤害段前后调用 invulnGuard 拦截
// （hp/st 回滚 + 吞掉本次 playerHit/downed 事件），见文件底部注释。
import CONFIG from './config.mjs';

const DOWN = () => CONFIG.player.down;

// 存活救援者：距被救者 ≤1.5m 且本 tick 按住 F；按距离升序、id 次级排序（确定性）。
// 多人模式下倒地者自身排除（"自救"无效）；单人模式（players.length===1）每局允许 1 次按住 F 墨力自救（stats.rescues < 1）。
export function rescuersOf(match, downed, inputs) {
  const list = [];
  const soloSelf = match.players.length === 1 && (downed.stats?.rescues || 0) < 1;
  for (const p of match.players) {
    if (p.id === downed.id) {
      if (!soloSelf) continue;
    } else if (p.st !== 0) continue;
    const input = inputs && inputs[p.id];
    if (!input || !input.hold) continue;
    const d = p.id === downed.id ? 0 : Math.hypot(p.pos.x - downed.pos.x, p.pos.z - downed.pos.z);
    if (d > DOWN().reviveRange) continue;
    list.push({ p, d });
  }
  list.sort((a, b) => a.d - b.d || a.p.id - b.p.id);
  return list;
}

// 每 tick：无敌倒计时 → 倒地倒计时/救援 → 计时归零转 st=2。
export function stepRevive(match, inputs, dt) {
  const D = DOWN();
  for (const p of match.players) {
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
  }

  for (const d of match.players) {
    if (d.st !== 1) {
      if (d.reviveProgress) { d.reviveProgress = 0; d.reviveBy = null; }
      continue;
    }
    // 单人模式自救机会已用尽（rescues >= 1）：再次倒地不再干等 20s，立即转阵亡并交由 stepFlow 触发战败结算。
    if (match.players.length === 1 && (d.stats?.rescues || 0) >= 1) {
      d.downT = 0;
      d.st = 2;
      d.reviveProgress = 0;
      d.reviveBy = null;
      match.events.push({ type: 'downExpire', data: { id: d.id } });
      continue;
    }
    // 刚倒地：combat.damagePlayer 只置 st=1 + downed 事件（不可改 combat），
    // 因此以本 tick 事件队列里的 downed 作为"真实倒地"信号补 20s 倒计时。
    // 用 <=0 而非 <0：救起后 downT=0，再次倒地必须重新挂起倒计时。
    if (d.downT <= 0 && match.events.some(e => e.type === 'downed' && e.data && e.data.id === d.id)) {
      d.downT = D.time;
    }

    const rescuers = rescuersOf(match, d, inputs);
    // 救援者锁定：开救时取最近者；锁定者持续按住/在范围内则进度保留（"先到者"），
    // 中断/离开/倒地后进度归零，本 tick 重新选最近者从 0 开始。
    let rescuer = null;
    if (d.reviveBy !== null && d.reviveBy !== undefined) {
      rescuer = rescuers.find(r => r.p.id === d.reviveBy) || null;
    }
    if (!rescuer) {
      d.reviveProgress = 0;
      d.reviveBy = rescuers.length ? rescuers[0].p.id : null;
      rescuer = rescuers.length ? rescuers[0] : null;
    }

    if (rescuer) {
      d.reviveProgress = Math.min(1, d.reviveProgress + dt / D.reviveHold);
      if (d.reviveProgress >= 1 - 1e-9) {
        d.reviveProgress = 1;
        d.st = 0;
        d.hp = D.reviveHp;
        d.ink = D.reviveInk;
        d.invuln = D.reviveInvuln;
        d.downT = 0;
        d.reviveProgress = 0;
        d.reviveBy = null;
        rescuer.p.stats.rescues++;
        match.events.push({ type: 'revive', data: { id: d.id, by: rescuer.p.id, x: d.pos.x, z: d.pos.z } });
        continue; // 救起当 tick 不再扣倒计时
      }
    }

    if (d.downT > 0) {
      d.downT = Math.max(0, d.downT - dt);
      if (d.downT <= 1e-9) {
        d.downT = 0;
        d.st = 2;
        d.reviveProgress = 0;
        d.reviveBy = null;
        match.events.push({ type: 'downExpire', data: { id: d.id } });
      }
    }
  }
}

// 无敌期伤害为 0 的调用侧拦截：不改 combat.damagePlayer。
// fn 覆盖敌人/Boss/弹丸伤害段；对无敌玩家回滚 hp/st，并丢弃本段产生的 playerHit/downed 事件。
export function invulnGuard(match, fn) {
  const guarded = [];
  for (const p of match.players) {
    if (p.st === 0 && p.invuln > 0) guarded.push({ p, hp: p.hp });
  }
  if (!guarded.length) return fn();
  const mark = match.events.length;
  const out = fn();
  const ids = new Set(guarded.map(g => g.p.id));
  for (const g of guarded) {
    if (g.p.hp < g.hp) g.p.hp = g.hp;
    if (g.p.st !== 0) g.p.st = 0;
  }
  if (match.events.length > mark) {
    const kept = match.events.slice(mark).filter(ev =>
      !((ev.type === 'playerHit' || ev.type === 'downed') && ev.data && ids.has(ev.data.id)));
    match.events.length = mark;
    for (const ev of kept) match.events.push(ev);
  }
  return out;
}
