// HUD：准星/命中标记/生命/墨量/弹药/换弹/倒计时/击杀/保护期横幅 +
// D4：目标条/锚点 chips/Boss 血条/共持提示/画线提示/结算页（再来一局）。
// 只读快照；D9 换全套 HUD 与设置面板。
import CONFIG from '../shared/config.mjs';
import { ANCHORS, EXIT, FOLDS } from '../shared/world.mjs';

const fmtTime = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

export function createHud(root, { onRestart } = {}) {
  root.innerHTML = `
    <div id="hud-top">
      <div id="hud-vitals">
        <div class="vrow"><span class="vlabel">生命</span><div class="vbar"><div id="hp-fill"></div></div><span id="hp-num"></span></div>
        <div class="vrow"><span class="vlabel">墨量</span><div class="vbar"><div id="ink-fill"></div></div><span id="ink-num"></span></div>
      </div>
      <div id="hud-mid">
        <div id="objective"></div>
        <div id="anchor-chips">${ANCHORS.map(a => `<div class="chip" id="chip-${a.i}"><span>${a.label}</span><div class="chip-track"><div class="chip-fill"></div></div></div>`).join('')}</div>
        <div id="boss-bar"><span id="boss-label">涂改大王</span><div id="boss-track"><div id="boss-fill"></div></div><span id="boss-rage">狂暴</span></div>
      </div>
      <div id="hud-right">
        <div id="timer">4:00</div>
        <div id="kills">击杀 0</div>
      </div>
    </div>
    <div id="grace-banner"></div>
    <div id="crosshair"><div id="hitmark"></div></div>
    <div id="hud-ammo"><span id="ammo-num">18</span><span id="ammo-cap">/18</span><div id="reload-bar"><div id="reload-fill"></div></div><div id="reload-text">换弹中</div></div>
    <div id="draw-hint">Q 已落起点 · 再按 Q 实体化 · 右键取消</div>
    <div id="prompt"><span id="prompt-text"></span><div id="use-track"><div id="use-fill"></div></div></div>
    <div id="hud-abilities">
      <div class="ab" id="ab-erase"><span class="ab-key">E</span><span class="ab-name">擦除</span><div class="ab-track"><div class="ab-fill" id="erase-fill"></div></div><span class="ab-state" id="erase-state">就绪</span></div>
      <div class="ab" id="ab-fold"><span class="ab-key">C</span><span class="ab-name">折纸</span><div class="ab-track"><div class="ab-fill" id="fold-fill"></div></div><span class="ab-state" id="fold-state">靠近折角</span></div>
    </div>
    <div id="hud-hint">WASD 移动 · 鼠标射击 · Q 画墙 · E 擦除 · C 折纸 · F 共持锚点/撤离 · R 换弹</div>
    <div id="dmg-vignette"></div>
    <div id="hud-toast"></div>
    <div id="end-overlay">
      <div id="end-card">
        <h2 id="end-title"></h2>
        <p id="end-reason"></p>
        <table id="end-stats"><thead><tr><th>玩家</th><th>击杀</th><th>掩体</th><th>涂改</th><th>救援</th></tr></thead><tbody></tbody></table>
        <div id="end-team"></div>
        <div id="end-best"></div>
        <button id="restart-btn">再来一局</button>
      </div>
    </div>`;
  const $ = id => root.querySelector('#' + id);
  const hpFill = $('hp-fill'), inkFill = $('ink-fill'), hpNum = $('hp-num'), inkNum = $('ink-num');
  const timer = $('timer'), kills = $('kills'), ammoNum = $('ammo-num');
  const reloadBar = $('reload-bar'), reloadFill = $('reload-fill'), reloadText = $('reload-text');
  const grace = $('grace-banner'), hitmark = $('hitmark'), vignette = $('dmg-vignette'), toast = $('hud-toast');
  const objective = $('objective'), chips = ANCHORS.map(a => ({ root: $('chip-' + a.i), fill: $('chip-' + a.i).querySelector('.chip-fill') }));
  const bossBar = $('boss-bar'), bossFill = $('boss-fill'), bossRage = $('boss-rage');
  const prompt = $('prompt'), promptText = $('prompt-text'), useFill = $('use-fill');
  const drawHint = $('draw-hint');
  const abErase = $('ab-erase'), eraseFill = $('erase-fill'), eraseState = $('erase-state');
  const abFold = $('ab-fold'), foldFill = $('fold-fill'), foldState = $('fold-state');
  const endOverlay = $('end-overlay'), endTitle = $('end-title'), endReason = $('end-reason');
  const endBody = $('end-stats').querySelector('tbody'), endTeam = $('end-team'), endBest = $('end-best');
  $('restart-btn').addEventListener('click', () => onRestart && onRestart());
  let hitT = 0, dmgT = 0, toastT = 0, lastObjective = '';

  function update(snap, graceLeft, dt) {
    const me = snap.players[0];
    if (me) {
      hpFill.style.width = me.hp + '%';
      hpNum.textContent = Math.ceil(me.hp);
      inkFill.style.width = me.ink + '%';
      inkNum.textContent = Math.floor(me.ink);
      ammoNum.textContent = me.ammo;
      const reloading = me.rl > 0;
      reloadBar.style.display = reloading ? 'block' : 'none';
      reloadText.style.display = reloading ? 'block' : 'none';
      if (reloading) reloadFill.style.width = (100 * (1 - me.rl / CONFIG.player.gun.reloadTime)) + '%';
    }
    const t = Math.max(0, snap.timeLeft);
    timer.textContent = fmtTime(t);
    kills.textContent = '击杀 ' + snap.kills;
    grace.style.display = graceLeft > 0 ? 'block' : 'none';
    if (graceLeft > 0) grace.textContent = '保护期 ' + graceLeft.toFixed(1) + 's · 敌人不会开火';

    const exitUnlocked = snap.phase !== 'anchors' && !snap.boss;
    const obj = snap.boss ? 'boss' : exitUnlocked ? 'exit' : 'a' + snap.anchors.filter(a => a.active).length;
    if (obj !== lastObjective) {
      lastObjective = obj;
      objective.innerHTML = snap.boss
        ? '击败涂改大王<small>击败后裁切线开启</small>'
        : exitUnlocked
          ? '裁切线已开启<small>前往南侧出口，按住 F 撤离</small>'
          : '装订锚点 ' + snap.anchors.filter(a => a.active).length + ' / 3<small>启动全部锚点后撤离</small>';
    }
    for (const a of snap.anchors) {
      const c = chips[a.i];
      c.root.classList.toggle('done', a.active);
      c.fill.style.width = (a.active ? 100 : a.progress * 100) + '%';
    }
    bossBar.style.display = snap.boss ? 'flex' : 'none';
    if (snap.boss) {
      bossFill.style.width = (100 * snap.boss.hp / CONFIG.scaling[snap.players.length].bossHp) + '%';
      bossRage.style.display = snap.boss.raged ? 'inline' : 'none';
    }

    // 共持提示：最近的未激活锚点 / 已开启的出口（内核同半径判定）
    let promptMsg = '', progress = 0;
    if (me) {
      const near = snap.anchors.find(a => !a.active && Math.hypot(me.x - ANCHORS[a.i].x, me.z - ANCHORS[a.i].z) < CONFIG.anchor.radius);
      if (near) { promptMsg = '按住 F 启动 ' + ANCHORS[near.i].label; progress = near.progress; }
      else if (exitUnlocked && Math.hypot(me.x - EXIT.x, me.z - EXIT.z) < CONFIG.anchor.exitRadius) { promptMsg = '按住 F 完成撤离'; progress = snap.exit; }
    }
    prompt.style.display = promptMsg ? 'block' : 'none';
    if (promptMsg) { promptText.textContent = promptMsg; useFill.style.width = Math.min(100, progress * 100) + '%'; }

    // 能力 chips：E 冷却/墨量门槛；C 最近折角情境（与内核同半径）
    if (me) {
      const cooling = me.ec > 0;
      const poor = me.ink < CONFIG.ink.eraseCost;
      abErase.classList.toggle('cooling', cooling);
      abErase.classList.toggle('poor', !cooling && poor);
      eraseFill.style.width = (cooling ? (1 - me.ec / CONFIG.ink.eraseCooldown) * 100 : 100) + '%';
      eraseState.textContent = cooling ? me.ec.toFixed(1) + 's' : poor ? '需 ' + CONFIG.ink.eraseCost + ' 墨' : '就绪';
      let nf = null, nd = Infinity;
      for (const f of FOLDS) {
        const d = Math.hypot(me.x - f.x, me.z - f.z);
        if (d < nd) { nd = d; nf = f; }
      }
      const nearFold = nf && nd <= CONFIG.folds.interactRadius;
      const fs = snap.folds[nf ? nf.id : 0];
      abFold.classList.toggle('near', !!nearFold);
      foldFill.style.width = (fs && fs.anim < 1 ? fs.anim * 100 : 100) + '%';
      foldState.textContent = nearFold
        ? (fs.state === 'ramp' ? '立起纸墙' : '展开坡道')
        : '靠近折角 ' + CONFIG.folds.interactRadius + 'm';
    }

    hitT = Math.max(0, hitT - dt);
    hitmark.style.opacity = hitT > 0 ? 1 : 0;
    dmgT = Math.max(0, dmgT - dt);
    vignette.style.opacity = dmgT > 0 ? Math.min(0.55, dmgT * 2) : 0;
    toastT = Math.max(0, toastT - dt);
    toast.style.opacity = toastT > 0 ? 1 : 0;
  }

  function showSettlement(d) {
    endTitle.textContent = d.won ? '纸页已锚定' : '修订失败';
    endReason.textContent = d.reason;
    endBody.innerHTML = d.players.map(p =>
      `<tr><td>玩家 ${p.id + 1}</td><td>${p.kills}</td><td>${p.walls}</td><td>${p.erases}</td><td>${p.rescues}</td></tr>`).join('');
    endTeam.textContent = '团队用时 ' + fmtTime(d.time) + ' · 总击杀 ' + d.kills;
    endBest.textContent = d.best ? (d.isNew ? '新纪录！最快撤离 ' + fmtTime(d.best) : '最快撤离纪录 ' + fmtTime(d.best)) : '';
    endBest.classList.toggle('new-record', !!d.isNew);
    endOverlay.style.display = 'flex';
  }

  return {
    update,
    hitmarker() { hitT = 0.13; },
    damage() { dmgT = 0.35; },
    toast(msg) { toast.textContent = msg; toastT = 3; },
    drawHint(show) { drawHint.style.display = show ? 'block' : 'none'; },
    showSettlement,
    hideSettlement() { endOverlay.style.display = 'none'; },
    resetCache() { lastObjective = ''; },
  };
}