// 房主权威运行时：20Hz 固定步累积器（规格 §4.1）。
// 同一份代码跑在浏览器（联机房主/单人本地）与 Node（无头回归）。
import CONFIG from '../shared/config.mjs';
import { createMatch, stepMatch, snapshot, startReload, switchWeapon } from '../shared/sim.mjs';
import { applyShot } from '../shared/combat.mjs';
import { applyDraw } from '../shared/walls.mjs';
import { applyErase } from '../shared/erase.mjs';
import { applyFold } from '../shared/folds.mjs';
import { applyPerk, perkMods } from '../shared/perks.mjs';

export function createRuntime({ seed = 1, playerIds = [0], onSnapshot = null, onBeforeStep = null } = {}) {
  const match = createMatch({ seed, playerIds });
  const inputs = {};
  let acc = 0;
  let last = null;

  return {
    match,
    // 视角由客户端直报（房主不模拟转头）；移动意图进 20Hz 步进
    setInput(id, input) {
      inputs[id] = input;
      const p = match.players.find(pl => pl.id === id);
      if (p && p.st === 0) {
        if (Number.isFinite(input.yaw)) p.yaw = input.yaw;
        if (Number.isFinite(input.pitch)) p.pitch = Math.max(-1.5, Math.min(1.5, input.pitch));
      }
    },
    clearInput(id) { delete inputs[id]; },
    // 离散动作：与联机客机同一入口（D10 起走 DataChannel）
    action(id, msg) {
      const p = match.players.find(pl => pl.id === id);
      if (!p) return { ok: false, reason: 'noPlayer' };
      if (msg.m === 'shot') {
        const origin = { x: msg.ox, y: msg.oy, z: msg.oz };
        const d = Math.hypot(origin.x - p.pos.x, origin.y - p.pos.y, origin.z - p.pos.z);
        if (d > CONFIG.net.shotOriginTol) return { ok: false, reason: 'origin' };
        return applyShot(match, id, origin, { x: msg.dx, y: msg.dy, z: msg.dz });
      }
      if (msg.m === 'reload') return { ok: startReload(p) };
      if (msg.m === 'weapon') return { ok: switchWeapon(p, msg.weapon), weapon: p.weapon };
      if (msg.m === 'perk') return applyPerk(match, id, msg.perkId);
      if (msg.m === 'drawStart') {
        const ok = p.ink >= CONFIG.ink.minDrawCost * perkMods(p).drawCostMul;
        return { ok, reason: ok ? undefined : 'ink' };
      }
      if (msg.m === 'drawEnd') return applyDraw(match, id, { x: msg.ax, z: msg.az }, { x: msg.bx, z: msg.bz });
      if (msg.m === 'erase') return applyErase(match, id);
      if (msg.m === 'fold') return applyFold(match, id, msg.foldId);
      if (msg.m === 'god') {
        p.god = !!msg.on;
        return { ok: true, god: p.god };
      }
      return { ok: false, reason: 'unknown' };
    },
    // nowMs 单调时钟；返回本帧推进的步数
    advance(nowMs) {
      if (last === null) last = nowMs;
      let delta = (nowMs - last) / 1000;
      last = nowMs;
      if (delta < 0) delta = 0;
      if (delta > 0.25) delta = 0.25;
      acc += delta;
      let steps = 0;
      while (acc >= CONFIG.net.dt && steps < CONFIG.net.catchupMax) {
        if (onBeforeStep) onBeforeStep(match, steps);
        stepMatch(match, inputs);
        acc -= CONFIG.net.dt;
        steps++;
      }
      if (acc >= CONFIG.net.dt) acc = 0;
      if (steps > 0 && onSnapshot) onSnapshot(snapshot(match));
      return steps;
    },
    // 帧间插值权重：0..1 的 20Hz 步进余量（表现层专用，不影响权威模拟）
    alpha() {
      return Math.max(0, Math.min(1, acc / CONFIG.net.dt));
    },
    snapshot() { return snapshot(match); },
    // 手动单步（无头回归 / 浏览器确定性验收用，绕过累积器时钟）
    tickOnce() { stepMatch(match, inputs); return snapshot(match); },
  };
}