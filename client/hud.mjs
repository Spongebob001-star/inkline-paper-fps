// Paper HUD; reads snapshots, owns only presentation and transient feedback.
import CONFIG from '../shared/config.mjs';
import { perkMods } from '../shared/perks.mjs';
import { ANCHORS, EXIT, FOLDS, COVERS, pickupList } from '../shared/world.mjs';

export function computeRank({ won, time, hp, crits = 0, interrupts = 0 }) {
  if (!won) return null;
  if ((time <= 150 && hp >= 60) || ((crits + interrupts) >= 6 && hp >= 40)) return 'S';
  if (time <= 210 || hp >= 40) return 'A';
  return 'B';
}

export function damageAngle(me, sx, sz) {
  const dx = sx - me.x, dz = sz - me.z;
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
  const rx = Math.cos(me.yaw), rz = -Math.sin(me.yaw);
  const angle = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180 / Math.PI;
  const rounded = Math.round(angle * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

const fmtTime = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const PICKUPS = pickupList();
const INK = '#20242A', TEAL = '#007F7B', RED = '#E34B3F', GOLD = '#F2C14E';
const mapPos = v => 12 + (v + 18) * 128 / 36;

// North is -z. Canvas coordinates therefore share the world's x/z signs.
function drawMap(ctx, snap, time, unlocked) {
  if (!ctx) return;
  const scale = 128 / 36;
  const line = (x, y, xx, yy, color, width = 1) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(xx, yy); ctx.stroke();
  };
  const circle = (x, y, r, color, fill = false) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
    if (fill) ctx.fill(); else ctx.stroke();
  };
  ctx.clearRect(0, 0, 152, 152);
  ctx.fillStyle = '#F3F1E7'; ctx.fillRect(0, 0, 152, 152);
  ctx.save(); ctx.beginPath(); ctx.rect(11, 11, 130, 130); ctx.clip();
  for (let v = -18; v <= 18; v += 6) {
    line(mapPos(v), 12, mapPos(v), 140, '#20242A18');
    line(12, mapPos(v), 140, mapPos(v), '#20242A18');
  }
  ctx.fillStyle = '#D2D0C5'; ctx.strokeStyle = '#20242A90'; ctx.lineWidth = 1;
  for (const c of COVERS) {
    const x = mapPos(c.x - c.w / 2), z = mapPos(c.z - c.d / 2);
    ctx.fillRect(x, z, c.w * scale, c.d * scale);
    ctx.strokeRect(x, z, c.w * scale, c.d * scale);
  }
  for (const f of FOLDS) {
    const state = snap.folds.find(s => s.id === f.id);
    ctx.save(); ctx.translate(mapPos(f.x), mapPos(f.z)); ctx.rotate(-f.rotY);
    ctx.strokeStyle = INK; ctx.lineWidth = 1;
    ctx.fillStyle = '#E5DAB7';
    ctx.fillRect(-1.6 * scale, 1.6 * scale, 3.2 * scale, 3.2 * scale);
    ctx.strokeRect(-1.6 * scale, 1.6 * scale, 3.2 * scale, 3.2 * scale);
    if (state?.state === 'wall') line(-1.95 * scale, 0, 1.95 * scale, 0, TEAL, 2.5);
    else {
      ctx.fillStyle = '#F2C14E65';
      ctx.fillRect(-1.95 * scale, 0, 3.9 * scale, CONFIG.folds.rampRun * scale);
      ctx.setLineDash([2, 2]);
      line(-1.95 * scale, 0, 1.95 * scale, 0, TEAL);
    }
    ctx.restore();
  }
  for (const w of snap.walls) {
    // The client supplies ux/uz; legacy snapshots have no orientation.
    if (!Number.isFinite(w.ux) || !Number.isFinite(w.uz)) {
      circle(mapPos(w.x), mapPos(w.z), 2, TEAL, true); continue;
    }
    const dx = w.ux * w.len / 2, dz = w.uz * w.len / 2;
    line(mapPos(w.x - dx), mapPos(w.z - dz), mapPos(w.x + dx), mapPos(w.z + dz), TEAL, 2.5);
  }
  for (const p of snap.pickups) {
    if (p.taken) continue;
    const at = PICKUPS[p.id];
    if (!at) continue;
    const x = mapPos(at.x), z = mapPos(at.z);
    if (at.ty === 'ink') {
      ctx.fillStyle = TEAL; ctx.fillRect(x - 1.5, z - 2, 3, 4);
    } else {
      line(x - 2, z, x + 2, z, '#A78532', 1.5);
      line(x, z - 2, x, z + 2, '#A78532', 1.5);
    }
  }
  for (const a of snap.anchors) {
    const at = ANCHORS[a.i], x = mapPos(at.x), z = mapPos(at.z);
    if (a.active) circle(x, z, 4, TEAL, true);
    else { ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.strokeRect(x - 3.5, z - 3.5, 7, 7); }
    ctx.fillStyle = INK; ctx.font = 'bold 7px sans-serif';
    ctx.fillText(at.label, x + 5, z + 2);
  }
  const ex = mapPos(EXIT.x), ez = mapPos(EXIT.z);
  ctx.globalAlpha = unlocked ? .55 + .45 * Math.sin(time * 5) ** 2 : .5;
  ctx.strokeStyle = unlocked ? TEAL : INK; ctx.lineWidth = 2;
  ctx.strokeRect(ex - 6, ez - 2, 12, 4);
  if (unlocked) { line(ex, ez + 6, ex, ez - 1, TEAL, 1.5); }
  ctx.globalAlpha = 1;
  for (const e of snap.enemies) {
    if (e.hp <= 0) continue;
    const x = mapPos(e.x), z = mapPos(e.z);
    ctx.fillStyle = RED;
    if (e.type === 'eraser') ctx.fillRect(x - 2.5, z - 2.5, 5, 5);
    else if (e.type === 'plane') {
      ctx.beginPath(); ctx.moveTo(x, z - 3.5); ctx.lineTo(x + 3, z + 2.5);
      ctx.lineTo(x - 3, z + 2.5); ctx.closePath(); ctx.fill();
    } else circle(x, z, 2.5, RED, true);
  }
  if (snap.boss) {
    const b = snap.boss, x = mapPos(b.x), z = mapPos(b.z);
    circle(x, z, 6 + Math.sin(time * 6) * 1.5, b.raged ? RED : GOLD);
    circle(x, z, 3.5, RED); circle(x, z, 1.5, GOLD, true);
  }
  const me = snap.players[0];
  if (me) {
    const x = mapPos(me.x), z = mapPos(me.z), a = -Math.PI / 2 - me.yaw;
    const spread = 34 * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(x, z); ctx.arc(x, z, 17, a - spread, a + spread);
    ctx.closePath(); ctx.fillStyle = '#007F7B28'; ctx.fill();
    line(x, z, x - Math.sin(me.yaw) * 11, z - Math.cos(me.yaw) * 11, TEAL, 1.2);
    circle(x, z, 3.5, '#FFFDF4', true); circle(x, z, 2.3, INK, true);
  }
  ctx.restore();
  ctx.strokeStyle = '#20242A60'; ctx.lineWidth = 1; ctx.strokeRect(12, 12, 128, 128);
  ctx.fillStyle = INK; ctx.font = 'bold 8px sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('N', 76, 9); ctx.textAlign = 'left';
}

export function createHud(root, { onRestart, onToggleMute, onSettings, onPickPerk, onSkipPerk, onGuideToggle, onSettingChange, onSettingsClose, onSettingsReset, onNewSeed,
  onWeapon, onQuickWall, onErase, onFold, onDash, onReload, onTouchFire, onTouchHold, onTouchJump, onTouchWall, onTouchADS } = {}) {
  const settingFields = [
    ['sensitivity', '鼠标灵敏度', .0008, .005, .0001],
    ['fov', '视野角度', 60, 95, 1],
    ['sfxVolume', '音效音量', 0, 1, .01],
    ['bgmVolume', '战斗配乐', 0, 1, .01],
    ['bossVolume', '首领语音', 0, 1, .01],
  ];
  root.innerHTML = `
    <div id="scope-overlay" aria-hidden="true"><div class="scope-lens"><span class="scope-axis scope-h"></span><span class="scope-axis scope-v"></span><span class="scope-label">2.5× / mm</span></div></div>
    <div id="hud-top">
      <div id="vitals-stack">
        <div id="hud-vitals">
          <div class="vrow"><span class="vlabel">生命</span><div class="vbar"><div id="hp-fill"></div></div><span id="hp-num"></span></div>
          <div class="vrow"><span class="vlabel">墨量</span><div class="vbar"><div id="ink-fill"></div></div><span id="ink-num"></span></div>
        </div>
        <div id="perk-chips" aria-label="已装订强化" hidden></div>
        <aside id="guide-card" aria-labelledby="guide-title" hidden>
          <div class="guide-top"><span>随行手记 <b id="guide-step">1 / 5</b></span><button id="guide-close" type="button" aria-label="收起引导（H）" title="收起引导（H）">×</button></div>
          <h3 id="guide-title"></h3><p id="guide-text"></p><small id="guide-complete" hidden>引导完成 · H 可收起或展开手记</small>
        </aside>
        <div id="team-roster"></div>
      </div>
      <div id="hud-mid">
        <div id="objective"></div>
        <div id="anchor-chips">${ANCHORS.map(a => `<div class="chip" id="chip-${a.i}"><span>${a.label}</span><div class="chip-track"><div class="chip-fill"></div></div></div>`).join('')}</div>
        <div id="boss-bar"><span id="boss-label">奶龙 · I · 涂改霸主</span><div id="boss-track"><div id="boss-fill"></div><i class="boss-tick tick-65" title="65% 狂笑暴走"></i><i class="boss-tick tick-30" title="30% 终焉墨潮"></i></div><span id="boss-hp-num">1100/1100</span><span id="boss-rage">暴走</span><span id="boss-state-chip"></span></div>
      </div>
      <div id="hud-right">
        <div class="timer-row"><button id="mute-btn" type="button" aria-label="静音（M）" aria-pressed="false" title="静音（M）"><span class="speaker" aria-hidden="true"></span><span aria-hidden="true">M</span></button><button id="settings-btn" type="button" class="paper-button" aria-label="设置（O）" aria-haspopup="dialog" aria-controls="settings-overlay" title="设置（O）">⚙ O</button><div id="timer">4:00</div></div>
        <div id="minimap-card"><div class="map-caption">战术草图 <span>01 / N↑</span></div><canvas id="minimap" width="152" height="152" role="img" aria-label="战术地图，北方朝上：锚点、出口与敌人"></canvas></div>
        <div class="map-footer"><div id="kills">击杀 0</div><div id="exit-chip">出口 LOCKED</div></div>
      </div>
    </div>
    <div id="grace-banner"></div>
    <div id="boss-phase-banner" aria-live="polite"><strong id="phase-banner-title"></strong><small id="phase-banner-tip"></small></div>
    <div id="dash-lines" aria-hidden="true"></div>
    <div id="crosshair"><span class="ch-stroke ch-n"></span><span class="ch-stroke ch-e"></span><span class="ch-stroke ch-s"></span><span class="ch-stroke ch-w"></span><div id="hitmark"></div></div>
    <div id="dmg-dir-layer" aria-hidden="true"><b class="dmg-dir"></b><b class="dmg-dir"></b><b class="dmg-dir"></b></div>
    <div id="dmg-float-layer" aria-hidden="true">${'<span class="dmg-float"></span>'.repeat(16)}</div>
    <div id="nav-arrow"><div id="nav-tri"></div><div id="nav-text"></div></div>
    <div id="iv-chip">无敌 1.0s</div>
    <div id="god-chip">无敌观测 ON · I 关闭</div>
    <div id="downed-banner">
      <div id="downed-title">你已倒地</div>
      <div id="downed-count">20.0s</div>
      <div id="downed-sub">按住 F 键 2 秒墨力自救（每局 1 次）</div>
      <div id="revive-track"><div id="revive-fill"></div></div>
    </div>
    <div id="weapon-bar" role="list" aria-label="武器 1 / 2 / 3">${CONFIG.player.weapons.map((w, i) => `<div class="weapon-tag${i === 0 ? ' selected' : ''}" role="listitem" data-weapon="${i}"><b>${i + 1}</b>${w.name}</div>`).join('')}<span id="scope-hint">右键 2.5×开镜</span></div>
    <div id="hud-ammo"><span id="ammo-num">18</span><span id="ammo-cap">/18</span><div id="reload-bar"><div id="reload-fill"></div></div><div id="reload-text">换弹中</div></div>
    <div id="draw-hint">Q 已落起点 · 再按 Q 实体化 · 右键取消</div>
    <div id="prompt"><span id="prompt-text"></span><div id="use-track"><div id="use-fill"></div></div></div>
    <div id="hud-abilities">
      <div class="ab" id="ab-wall"><span class="ab-key">Q / G</span><span class="ab-name">画墙</span><div class="ab-track"><div class="ab-fill" id="wall-fill"></div></div><span class="ab-state" id="wall-state">就绪</span></div>
      <div class="ab" id="ab-erase"><span class="ab-key">E</span><span class="ab-name">擦除</span><div class="ab-track"><div class="ab-fill" id="erase-fill"></div></div><span class="ab-state" id="erase-state">就绪</span></div>
      <div class="ab" id="ab-fold"><span class="ab-key">C</span><span class="ab-name">折纸</span><div class="ab-track"><div class="ab-fill" id="fold-fill"></div></div><span class="ab-state" id="fold-state">靠近折角</span></div>
      <div class="ab" id="ab-dash"><span class="ab-key">Shift</span><span class="ab-name">闪避</span><div class="ab-track"><div class="ab-fill" id="dash-fill"></div></div><span class="ab-state" id="dash-state">就绪</span></div>
    </div>
    <div id="hud-hint">WASD 移动 · Shift 闪避 · 左键 射击 · 1/2/3 切枪 · RMB 开镜 · Q 画墙 / G 速墙 · E 擦除 · C 折纸 · F 交互 · R 换弹 · M 静音 · H 引导 · O 设置</div>
    <div id="touch-layer" hidden>
      <div id="touch-stick-zone"><div id="touch-stick-knob"></div></div>
      <div id="touch-actions">
        <button id="touch-ads">镜</button><button id="touch-jump">跃</button><button id="touch-reload">换</button><button id="touch-wall">速墙</button>
        <button id="touch-fire"><b>开火</b><small>拖动瞄准</small></button>
      </div>
    </div>
    <div id="dmg-vignette"></div>
    <div id="kill-vignette" aria-hidden="true"></div>
    <div id="kill-stamp" role="status"><small>INK CONFIRMED</small><strong id="kill-stamp-label"></strong></div>
    <div id="hud-toast"></div>
    <div id="end-overlay">
      <div id="end-card">
        <div id="end-rank-stamp" hidden><span id="rank-letter"></span><small id="rank-title"></small><em id="rank-mode" hidden>观摩模式</em></div>
        <h2 id="end-title"></h2>
        <p id="end-reason"></p>
        <table id="end-stats"><thead><tr><th>玩家</th><th>击杀</th><th>掩体</th><th>涂改</th><th>救援</th></tr></thead><tbody></tbody></table>
        <div id="end-team"></div>
        <div id="end-best"></div>
        <div id="end-perks" aria-label="本局强化与战斗记录"></div>
        <div class="paper-actions"><button id="restart-btn">再来一局</button><button id="new-seed-btn" type="button" class="paper-button" title="换一张新纸，开始新的种子局">换张新纸</button></div>
      </div>
    </div>
    <div id="perk-overlay" class="paper-overlay" role="dialog" aria-modal="true" aria-labelledby="perk-title" aria-describedby="perk-subtitle" hidden>
      <section id="perk-sheet">
        <div class="title-kicker">BIND / 强化装订</div><h2 id="perk-title">为下一页，添一笔。</h2>
        <p id="perk-subtitle">选择一张强化纸片 · 本局持续生效</p>
        <div id="perk-cards"></div>
        <button id="perk-skip-btn" type="button" class="paper-button" title="暂时跳过强化选择（Tab）"><kbd>Tab</kbd> 暂跳过</button>
      </section>
    </div>
    <div id="settings-overlay" class="paper-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-note" hidden>
      <section id="settings-card">
        <div class="title-kicker">MARGIN NOTES / 偏好</div><h2 id="settings-title">调整手感</h2><p id="settings-note">按你的习惯，留好页边距。<span>O 开关设置</span></p>
        ${settingFields.map(([key, label, min, max, step]) => `<div class="setting-row"><label for="setting-${key}">${label}</label><output id="setting-${key}-value" for="setting-${key}"></output><input id="setting-${key}" type="range" min="${min}" max="${max}" step="${step}"></div>`).join('')}
        <label class="setting-check" for="setting-showGuide"><input id="setting-showGuide" type="checkbox">显示随行引导 <small>H 随时收起 / 展开</small></label>
        <div class="paper-actions"><button id="settings-close-btn" type="button" class="paper-button paper-primary">继续</button><button id="settings-reset-btn" type="button" class="paper-button">恢复默认</button></div>
      </section>
    </div>`;
  const $ = id => root.querySelector('#' + id);
  const hpFill = $('hp-fill'), inkFill = $('ink-fill'), hpNum = $('hp-num'), inkNum = $('ink-num');
  const timer = $('timer'), kills = $('kills'), ammoNum = $('ammo-num'), ammoCap = $('ammo-cap');
  const weaponTags = [...$('weapon-bar').querySelectorAll('.weapon-tag')];
  const scopeHint = $('scope-hint'), scopeOverlay = $('scope-overlay');
  const reloadBar = $('reload-bar'), reloadFill = $('reload-fill'), reloadText = $('reload-text');
  const grace = $('grace-banner'), hitmark = $('hitmark'), vignette = $('dmg-vignette'), toast = $('hud-toast');
  const objective = $('objective'), chips = ANCHORS.map(a => ({ root: $('chip-' + a.i), fill: $('chip-' + a.i).querySelector('.chip-fill') }));
  const bossBar = $('boss-bar'), bossFill = $('boss-fill'), bossRage = $('boss-rage'), bossState = $('boss-state-chip');
  const bossLabel = $('boss-label'), bossHpNum = $('boss-hp-num');
  const phaseBanner = $('boss-phase-banner'), phaseTitle = $('phase-banner-title'), phaseTip = $('phase-banner-tip');
  const PHASE_TIPS = ['扇形弹幕 · 空格跃过音浪 · 红圈墨雨立刻离位 · 贴身防砸地',
    '双层交错弹幕 · 二连折返冲锋 · G 速墙撞晕奶龙',
    '护盾尽碎 · 三连冲锋留灼痕 · 墨雨八连']; 
  const prompt = $('prompt'), promptText = $('prompt-text'), useFill = $('use-fill');
  const drawHint = $('draw-hint');
  const abWall = $('ab-wall'), wallFill = $('wall-fill'), wallState = $('wall-state');
  const abErase = $('ab-erase'), eraseFill = $('erase-fill'), eraseState = $('erase-state');
  const abFold = $('ab-fold'), foldFill = $('fold-fill'), foldState = $('fold-state');
  const abDash = $('ab-dash'), dashFill = $('dash-fill'), dashState = $('dash-state');
  const dashLines = $('dash-lines'), dmgDirs = [...root.querySelectorAll('.dmg-dir')];
  const rankStamp = $('end-rank-stamp'), rankLetter = $('rank-letter'), rankTitle = $('rank-title'), rankMode = $('rank-mode');
  const RANK_TITLES = { S: '神笔惊墨 · 完美归档', A: '妙笔生花 · 迅捷突围', B: '墨线稳健 · 安全撤离' };
  let dashLinesT = 0;
  const hurtDirs = [{ x: 0, z: 0, t: 0 }, { x: 0, z: 0, t: 0 }, { x: 0, z: 0, t: 0 }];
  let hurtCursor = 0;
  const endOverlay = $('end-overlay'), endTitle = $('end-title'), endReason = $('end-reason');
  const endBody = $('end-stats').querySelector('tbody'), endTeam = $('end-team'), endBest = $('end-best');
  const exitChip = $('exit-chip'), crosshair = $('crosshair');
  const roster = $('team-roster');
  const navArrow = $('nav-arrow'), navTri = $('nav-tri'), navText = $('nav-text');
  const ivChip = $('iv-chip'), godChip = $('god-chip');
  const downedBanner = $('downed-banner'), downedTitle = $('downed-title'), downedCount = $('downed-count');
  const downedSub = $('downed-sub'), reviveFill = $('revive-fill');
  const perkOverlay = $('perk-overlay'), perkCards = $('perk-cards'), perkChips = $('perk-chips');
  const guideCard = $('guide-card'), settingsOverlay = $('settings-overlay');
  const doc = root.ownerDocument;
  const touchLayer = $('touch-layer'), touchFire = $('touch-fire'), touchAds = $('touch-ads');
  let touchMode = false, touchHolding = false, touchFiring = false, touchHoldEl = null, firePid = null, holdPid = null;
  let perksSig = '';
  const perkMeta = id => Object.hasOwn(CONFIG.perks || {}, id) ? CONFIG.perks[id] : { name: '未知强化', color: TEAL, effect: '' };
  const paperEvents = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel'];
  // Keep gameplay keys bubbling to main; paper controls never request pointer lock.
  for (const el of [perkOverlay, settingsOverlay, guideCard, endOverlay, $('settings-btn'), $('mute-btn')]) {
    for (const type of paperEvents) el.addEventListener(type, ev => {
      ev.stopPropagation();
      if (type === 'contextmenu') ev.preventDefault();
    });
  }
  const bindClick = (id, fn) => $(id).addEventListener('click', ev => { ev.stopPropagation(); fn?.(); });
  bindClick('settings-btn', onSettings);
  bindClick('perk-skip-btn', onSkipPerk);
  bindClick('guide-close', onGuideToggle);
  bindClick('settings-close-btn', onSettingsClose);
  bindClick('settings-reset-btn', onSettingsReset);
  bindClick('new-seed-btn', onNewSeed);
  const tap = (el, fn) => {
    el.addEventListener('pointerdown', ev => { ev.stopPropagation(); ev.preventDefault?.(); fn?.(); });
    el.addEventListener('mousedown', ev => { ev.stopPropagation(); ev.preventDefault?.(); });
  };
  weaponTags.forEach((tag, i) => tap(tag, () => onWeapon?.(i)));
  tap(abWall, onQuickWall); tap(abErase, onErase); tap(abFold, onFold); tap(abDash, onDash);
  tap($('touch-jump'), onTouchJump); tap($('touch-reload'), onReload);
  tap($('touch-wall'), onTouchWall); tap(touchAds, onTouchADS);
  function setTouchFireUi(on) {
    if (!on) firePid = null;
    if (touchFiring === on) return;
    touchFiring = on; touchFire.classList.toggle('active', on); onTouchFire?.(on);
  }
  touchFire.addEventListener('pointerdown', ev => {
    ev.stopPropagation(); ev.preventDefault?.(); firePid = ev.pointerId ?? null; touchFire.setPointerCapture?.(ev.pointerId); setTouchFireUi(true);
  });
  function releaseHold() {
    holdPid = null;
    if (!touchHolding) return;
    touchHolding = false; touchHoldEl?.classList.remove('holding'); touchHoldEl = null; onTouchHold?.(false);
  }
  function startHold(ev) {
    if (!touchMode) return;
    ev.stopPropagation(); ev.preventDefault?.();
    if (touchHolding) return;
    holdPid = ev.pointerId ?? null;
    touchHolding = true; touchHoldEl = ev.currentTarget; touchHoldEl.classList.add('holding'); onTouchHold?.(true);
  }
  for (const el of [prompt, downedBanner]) el.addEventListener('pointerdown', startHold);
  for (const type of ['pointerup', 'pointercancel']) {
    doc.addEventListener?.(type, ev => {
      if (ev?.pointerId === undefined || ev.pointerId === firePid) setTouchFireUi(false);
      if (ev?.pointerId === undefined || ev.pointerId === holdPid) releaseHold();
    });
  }
  function setTouchVisible(show) {
    show = show && touchMode;
    touchLayer.hidden = !show;
    if (!show) { releaseHold(); setTouchFireUi(false); }
  }
  function setTouchMode(on) {
    touchMode = !!on;
    doc.body?.classList?.toggle('touch-mode', touchMode);
    setTouchVisible(touchMode);
  }
  function perkBadge(id) {
    const p = perkMeta(id), el = doc.createElement('span');
    el.className = 'perk-badge'; el.dataset.perk = id;
    el.style.setProperty('--perk-color', p.color || TEAL);
    el.textContent = p.name; el.title = p.name + ' · ' + p.effect;
    return el;
  }
  function showPerks(ids) {
    perkCards.replaceChildren(...ids.slice(0, 3).map((id, i) => {
      const p = perkMeta(id), card = doc.createElement('button');
      card.type = 'button'; card.className = 'perk-card'; card.dataset.perk = id;
      card.style.setProperty('--perk-color', p.color || TEAL);
      card.innerHTML = `<span class="perk-number">强化纸片 / 0${i + 1}</span><strong class="perk-name"></strong><span class="perk-effect"></span><kbd>[${['Z', 'X', 'V'][i]}]</kbd>`;
      card.querySelector('.perk-name').textContent = p.name;
      card.querySelector('.perk-effect').textContent = p.effect;
      card.title = p.name + '（' + ['Z', 'X', 'V'][i] + '）';
      card.addEventListener('click', ev => { ev.stopPropagation(); onPickPerk?.(id); });
      return card;
    }));
    perkOverlay.hidden = false;
    if (!doc.pointerLockElement) perkCards.firstElementChild?.focus({ preventScroll: true });
  }
  function hidePerks() { perkOverlay.hidden = true; }
  function updateGuide(state) {
    guideCard.hidden = !state.visible;
    $('guide-step').textContent = Math.max(1, Math.min(5, Number(state.step) || 1)) + ' / 5';
    $('guide-title').textContent = state.title || '';
    $('guide-text').textContent = state.text || '';
    $('guide-complete').hidden = !state.complete;
    guideCard.classList.toggle('complete', !!state.complete);
  }
  function settingOutput(key) {
    const input = $('setting-' + key), value = input.valueAsNumber;
    const text = key === 'sensitivity' ? value.toFixed(4) : key === 'fov' ? value + '°' : Math.round(value * 100) + '%';
    $('setting-' + key + '-value').value = text;
    input.setAttribute('aria-valuetext', text);
  }
  for (const [key] of settingFields) {
    $('setting-' + key).addEventListener('input', ev => {
      settingOutput(key); onSettingChange?.(key, ev.target.valueAsNumber);
    });
    settingOutput(key);
  }
  $('setting-showGuide').addEventListener('change', ev => onSettingChange?.('showGuide', ev.target.checked));
  function syncSettings(settings) {
    for (const [key] of settingFields) {
      if (Number.isFinite(settings[key])) $('setting-' + key).value = settings[key];
      settingOutput(key);
    }
    if (typeof settings.showGuide === 'boolean') $('setting-showGuide').checked = settings.showGuide;
  }
  function showSettings(settings) {
    syncSettings(settings); settingsOverlay.hidden = false;
    if (!doc.pointerLockElement) $('setting-sensitivity').focus({ preventScroll: true });
  }
  function hideSettings() { settingsOverlay.hidden = true; }
  $('restart-btn').addEventListener('click', () => onRestart && onRestart());
  const mapCtx = $('minimap').getContext('2d'), muteBtn = $('mute-btn');
  const floats = [...$('dmg-float-layer').children].map(el => ({ el, x: 0, y: 0, z: 0, life: 0, projected: {} }));
  let floatNext = 0, shotT = 0, mapTime = 0;
  let hitT = 0, dmgT = 0, toastT = 0, lastObjective = '', rosterSig = '', rosterRows = new Map();
  let hitBounce = 0, killGlow = 0, stampT = 0, combo = 0, phaseT = 0;
  const killVignette = $('kill-vignette'), killStamp = $('kill-stamp');
  muteBtn.addEventListener('click', ev => {
    ev.stopPropagation(); muteBtn.blur(); onToggleMute?.();
  });
  function setMuted(muted) {
    muteBtn.setAttribute('aria-pressed', String(!!muted));
    const label = muted ? '取消静音（M）' : '静音（M）';
    muteBtn.setAttribute('aria-label', label); muteBtn.title = label;
  }
  function spawnDmgNumber(point, text, tone = 'damage') {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return;
    const f = floats[floatNext];
    floatNext = (floatNext + 1) % floats.length;
    f.x = point.x; f.y = point.y; f.z = point.z; f.life = .65;
    f.el.textContent = String(text);
    f.el.style.color = tone === 'crit' ? GOLD : tone === 'head' ? '#FFAA38'
      : tone === 'armor' || tone === 'strip' ? TEAL : tone === 'shield' ? '#A78532' : RED;
    f.el.style.fontWeight = tone === 'crit' || tone === 'head' ? '900' : '700';
    f.el.style.display = 'none';
  }

  function update(snap, graceLeft, dt, project) {
    const me = snap.players[0];
    const mods = perkMods({ perks: me?.pk || [] });
    const nextPerksSig = JSON.stringify(me?.pk || []);
    if (nextPerksSig !== perksSig) {
      perksSig = nextPerksSig;
      perkChips.replaceChildren(...(me?.pk || []).map(perkBadge));
      perkChips.hidden = !perkChips.childElementCount;
    }
    if (me) {
      hpFill.style.width = me.hp + '%';
      hpNum.textContent = Math.ceil(me.hp);
      inkFill.style.width = me.ink + '%';
      inkNum.textContent = Math.floor(me.ink);
      const weaponIdx = CONFIG.player.weapons[me.wp] ? me.wp : 0;
      const weapon = CONFIG.player.weapons[weaponIdx];
      touchAds.classList.toggle('ready', weaponIdx === 2);
      touchAds.classList.toggle('active', me.ads === true);
      ammoNum.textContent = me.ammo;
      ammoCap.textContent = '/' + weapon.magazine;
      weaponTags.forEach((tag, i) => {
        tag.classList.toggle('selected', i === weaponIdx);
        tag.setAttribute('aria-current', String(i === weaponIdx));
      });
      scopeHint.style.display = weaponIdx === 2 ? 'block' : 'none';
      const reloading = me.rl > 0;
      reloadBar.style.display = reloading ? 'block' : 'none';
      reloadText.style.display = reloading ? 'block' : 'none';
      if (reloading) reloadFill.style.width = (100 * Math.max(0, Math.min(1, 1 - me.rl / (weapon.reloadTime * mods.reloadMul)))) + '%';
    }
    const t = Math.max(0, snap.timeLeft);
    timer.textContent = fmtTime(t);
    kills.textContent = '击杀 ' + snap.kills;
    const showGrace = graceLeft > 0 && !snap.boss;
    grace.style.display = showGrace ? 'block' : 'none';
    if (showGrace) grace.textContent = '保护期 ' + graceLeft.toFixed(1) + 's · 敌人不会开火';

    const exitUnlocked = snap.phase !== 'anchors' && !snap.boss;
    const obj = snap.boss ? 'boss' : exitUnlocked ? 'exit' : 'a' + snap.anchors.filter(a => a.active).length;
    if (obj !== lastObjective) {
      lastObjective = obj;
      objective.innerHTML = snap.boss
        ? '击败涂改大王<small>击败后裁切线开启</small>'
        : exitUnlocked
          ? '裁切线已开启<small>前往北侧出口，按住 F 撤离</small>'
          : '装订锚点 ' + snap.anchors.filter(a => a.active).length + ' / 3<small>启动全部锚点后撤离</small>';
    }
    for (const a of snap.anchors) {
      const c = chips[a.i];
      c.root.classList.toggle('done', a.active);
      c.fill.style.width = (a.active ? 100 : a.progress * 100) + '%';
    }
    bossBar.style.display = snap.boss ? 'flex' : 'none';
    const bossStatus = snap.boss?.st > 0 ? '破盾眩晕 ' + snap.boss.st.toFixed(1) + 's · 集火!'
      : snap.boss?.ex > 0 ? '大笑破绽 · 射肚皮暴击 / E 打断' : '';
    bossState.style.display = bossStatus ? 'block' : 'none';
    bossState.textContent = bossStatus;
    bossState.classList.toggle('stunned', snap.boss?.st > 0);
    if (snap.boss) {
      const bossMax = snap.boss.max || CONFIG.scaling[snap.players.length].bossHp;
      const phase = snap.boss.ph || 1;
      bossFill.style.width = (100 * snap.boss.hp / bossMax) + '%';
      bossLabel.textContent = '奶龙 · ' + CONFIG.boss.phaseTitles[phase - 1];
      bossHpNum.textContent = snap.boss.hp + '/' + bossMax;
      bossRage.textContent = phase === 3 ? '终焉' : '暴走';
      bossRage.style.display = snap.boss.raged ? 'inline' : 'none';
    }
    const exitChipText = exitUnlocked ? '出口 OPEN' : '出口 LOCKED';
    if (exitChip.textContent !== exitChipText) {
      exitChip.textContent = exitChipText;
      exitChip.classList.toggle('open', exitUnlocked);
    }

    // 共持提示：最近的未激活锚点 / 已开启的出口（内核同半径判定）；倒地/阵亡不显示交互提示
    let promptMsg = '', progress = 0;
    if (me && me.st === 0) {
      const near = snap.anchors.find(a => !a.active && Math.hypot(me.x - ANCHORS[a.i].x, me.z - ANCHORS[a.i].z) < CONFIG.anchor.radius);
      if (near) { promptMsg = (touchMode ? '按住此处启动 ' : '按住 F 启动 ') + ANCHORS[near.i].label; progress = near.progress; }
      else if (exitUnlocked && Math.hypot(me.x - EXIT.x, me.z - EXIT.z) < CONFIG.anchor.exitRadius) { promptMsg = touchMode ? '按住此处完成撤离' : '按住 F 完成撤离'; progress = snap.exit; }
    }
    prompt.style.display = promptMsg ? 'block' : 'none';
    if (promptMsg) { promptText.textContent = promptMsg; useFill.style.width = Math.min(100, progress * 100) + '%'; }

    // T7.4：队友状态条（hp / 倒地倒计时 / 救援进度 / 无敌）
    const sig = snap.players.map(p => p.id).join(',');
    if (sig !== rosterSig) {
      rosterSig = sig;
      roster.innerHTML = snap.players.map((p, i) =>
        `<div class="team-row" data-id="${p.id}"><span class="team-dot" style="background:#${CONFIG.colors.playerMarks[i % CONFIG.colors.playerMarks.length]}"></span><span class="team-name">P${p.id + 1}${p.id === 0 ? ' 你' : ''}</span><div class="team-track"><div class="team-hp"></div></div><span class="team-state"></span></div>`
      ).join('');
      rosterRows = new Map([...roster.querySelectorAll('.team-row')].map(r => [Number(r.dataset.id), {
        root: r, hp: r.querySelector('.team-hp'), state: r.querySelector('.team-state'), last: '',
      }]));
    }
    roster.style.display = snap.players.length > 1 ? 'block' : 'none';
    if (snap.players.length > 1) {
      for (const p of snap.players) {
        const row = rosterRows.get(p.id);
        if (!row) continue;
        row.hp.style.width = Math.max(0, Math.min(100, p.hp)) + '%';
        const isDown = p.st === 1, isDead = p.st === 2;
        row.root.classList.toggle('downed', isDown);
        row.root.classList.toggle('dead', isDead);
        const st = isDead ? '阵亡'
          : isDown ? (p.rv > 0 ? '救援 ' + Math.round(p.rv * 100) + '%' : '倒地 ' + p.dt.toFixed(1) + 's')
            : p.iv > 0 ? '无敌 ' + p.iv.toFixed(1) + 's' : '正常';
        if (row.last !== st) { row.state.textContent = st; row.last = st; }
      }
    }

    // T7.4：自己倒地横幅 / 救援进度（单人模式显示按住 F 墨力自救，多人模式显示等待队友救援）
    const isSolo = snap.players.length === 1;
    let showDowned = false;
    if (me && me.st === 1) {
      showDowned = true;
      downedTitle.textContent = isSolo ? '你已倒地 · 绝境续写' : '你已倒地';
      downedTitle.classList.remove('dead');
      downedCount.textContent = me.dt.toFixed(1) + 's';
      downedSub.textContent = isSolo
        ? (me.rv > 0 ? '正在重绘纸身… ' + Math.round(me.rv * 100) + '%' : (touchMode ? '按住此处 2 秒墨力自救（每局 1 次）' : '按住 F 键 2 秒墨力自救（每局 1 次）'))
        : (me.rv > 0 ? '队友救援中…' : (touchMode ? '等待队友靠近救援' : '等待队友靠近按住 F 救援'));
      reviveFill.style.width = (me.rv * 100) + '%';
    } else if (me && me.st === 2) {
      showDowned = true;
      downedTitle.textContent = '你已阵亡';
      downedTitle.classList.add('dead');
      downedCount.textContent = '';
      downedSub.textContent = isSolo ? '纸身溃散，战局结束' : '等待队伍撤离结果';
      reviveFill.style.width = '0%';
    }
    downedBanner.style.display = showDowned ? 'block' : 'none';
    if (touchHolding && !promptMsg && !showDowned) releaseHold();
    // ADS is a local presentation flag supplied by main.viewSnapshot(), never simulation state.
    const ads = me?.ads === true && me.st === 0;
    scopeOverlay.style.display = ads ? 'block' : 'none';
    crosshair.style.display = ads || (me && me.st !== 0) ? 'none' : 'block';
    const showIv = !!(me && me.st === 0 && me.iv > 0);
    ivChip.style.display = showIv ? 'block' : 'none';
    if (showIv) ivChip.textContent = '无敌 ' + me.iv.toFixed(1) + 's';

    // T7.3：导航目标边缘箭头（目标名 + 距离；3m 内隐藏；在视野内不显示箭头）
    let nav = null;
    if (me && me.st === 0 && project) {
      if (snap.phase === 'anchors') {
        let best = Infinity, ai = -1;
        for (const a of snap.anchors) {
          if (a.active) continue;
          const d = Math.hypot(me.x - ANCHORS[a.i].x, me.z - ANCHORS[a.i].z);
          if (d < best) { best = d; ai = a.i; }
        }
        if (ai >= 0) nav = { x: ANCHORS[ai].x, z: ANCHORS[ai].z, label: ANCHORS[ai].label, d: best, status: '' };
      } else if (snap.boss) {
        nav = { x: snap.boss.x, z: snap.boss.z, label: '涂改大王', d: Math.hypot(me.x - snap.boss.x, me.z - snap.boss.z), status: '' };
      } else {
        nav = { x: EXIT.x, z: EXIT.z, label: '裁切线', d: Math.hypot(me.x - EXIT.x, me.z - EXIT.z), status: exitUnlocked ? 'OPEN' : 'LOCKED' };
      }
    }
    let navShown = false;
    if (nav && nav.d > CONFIG.anchor.arrowHideDist) {
      const s = project(nav.x, 1.3, nav.z);
      if (s && !s.onScreen) {
        const cx = s.w / 2, cy = s.h / 2;
        const dx = s.x - cx, dy = s.y - cy;
        if (Math.hypot(dx, dy) > 1e-3) {
          const k = Math.min((s.w / 2 - 56) / Math.max(Math.abs(dx), 1e-3), (s.h / 2 - 56) / Math.max(Math.abs(dy), 1e-3));
          navArrow.style.display = 'flex';
          navArrow.style.left = (cx + dx * k).toFixed(0) + 'px';
          navArrow.style.top = (cy + dy * k).toFixed(0) + 'px';
          navTri.style.transform = 'rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI + 90).toFixed(1) + 'deg)';
          navText.textContent = nav.label + (nav.status ? ' ' + nav.status : '') + ' · ' + Math.max(1, Math.round(nav.d)) + 'm';
          navShown = true;
        }
      }
    }
    if (!navShown) navArrow.style.display = 'none';

    // 能力 chips：Q/G 墨量门槛；E 冷却；C 最近折角情境（与内核同半径）
    if (me) {
      const drawCost = CONFIG.ink.minDrawCost * mods.drawCostMul;
      const wallPoor = me.ink < drawCost;
      abWall.classList.toggle('poor', wallPoor);
      wallFill.style.width = Math.max(0, Math.min(100, me.ink / drawCost * 100)) + '%';
      wallState.textContent = wallPoor ? '需' + Number(drawCost.toFixed(1)) + '墨' : '就绪';
      const cooling = me.ec > 0;
      const poor = me.ink < CONFIG.ink.eraseCost;
      abErase.classList.toggle('cooling', cooling);
      abErase.classList.toggle('poor', !cooling && poor);
      eraseFill.style.width = (cooling ? Math.max(0, Math.min(1, 1 - me.ec / (CONFIG.ink.eraseCooldown * mods.eraseCdMul))) * 100 : 100) + '%';
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

    if (me) {
      const cooling = me.dc > 0, dashing = me.da === 1;
      abDash.classList.toggle('cooling', cooling && !dashing);
      abDash.classList.toggle('active', dashing);
      dashFill.style.width = (dashing ? 100 : cooling ? Math.max(0, 1 - me.dc / CONFIG.player.dash.cooldown) * 100 : 100) + '%';
      dashState.textContent = dashing ? '闪避中' : cooling ? me.dc.toFixed(1) + 's' : '就绪';
      dashLinesT = Math.max(0, dashLinesT - dt);
      dashLines.style.opacity = dashLinesT > 0 ? Math.min(1, dashLinesT / 0.12) * 0.9 : 0;
      for (let i = 0; i < dmgDirs.length; i++) {
        const hd = hurtDirs[i % hurtDirs.length], el = dmgDirs[i];
        if (hd.t <= 0) { el.style.opacity = 0; continue; }
        hd.t = Math.max(0, hd.t - dt);
        const angle = damageAngle(me, hd.x, hd.z);
        el.style.transform = 'translate(-50%,-50%) rotate(' + angle.toFixed(1) + 'deg) translateY(-80px)';
        el.style.opacity = Math.min(1, hd.t / 0.22) * 0.9;
      }
    }

    mapTime += dt;
    drawMap(mapCtx, snap, mapTime, exitUnlocked);
    for (const f of floats) {
      if (f.life <= 0) continue;
      f.life = Math.max(0, f.life - dt);
      const s = f.life > 0 && project ? project(f.x, f.y, f.z, f.projected) : null;
      const visible = s && !s.behind && Number.isFinite(s.x) && Number.isFinite(s.y);
      f.el.style.display = visible ? 'block' : 'none';
      if (!visible) continue;
      const age = 1 - f.life / .65;
      f.el.style.left = s.x.toFixed(1) + 'px';
      f.el.style.top = (s.y - 12 - age * 32).toFixed(1) + 'px';
      f.el.style.opacity = Math.min(1, f.life / .18);
      f.el.style.transform = 'translate(-50%,-100%) rotate(-5deg) scale(' + (1 + .18 * (1 - age) ** 3).toFixed(2) + ')';
    }
    shotT = Math.max(0, shotT - dt);
    crosshair.style.setProperty('--kick', (7 * (shotT / .18) ** 2).toFixed(2) + 'px');
    hitT = Math.max(0, hitT - dt);
    hitmark.style.opacity = hitT > 0 ? 1 : 0;
    hitBounce = Math.max(0, hitBounce - dt * 7);
    crosshair.style.setProperty('--hit-scale', (1 + hitBounce * .4).toFixed(3));
    killGlow = Math.max(0, killGlow - dt);
    killVignette.style.opacity = Math.min(.55, killGlow * 3);
    stampT = Math.max(0, stampT - dt);
    killStamp.style.opacity = Math.min(1, stampT * 4);
    killStamp.style.transform = 'rotate(-7deg) scale(' + (1 + .2 * Math.exp(-(1.3 - stampT) * 16)).toFixed(3) + ')';
    dmgT = Math.max(0, dmgT - dt);
    vignette.style.opacity = dmgT > 0 ? Math.min(0.55, dmgT * 2) : 0;
    phaseT = Math.max(0, phaseT - dt);
    phaseBanner.style.opacity = phaseT <= 0 ? 0 : Math.min(1, phaseT / 0.5);
    toastT = Math.max(0, toastT - dt);
    toast.style.opacity = toastT > 0 ? 1 : 0;
  }


  function showPhaseBanner(phase = 1, title = '') {
    const p = Math.max(1, Math.min(3, Number(phase) || 1));
    phaseTitle.textContent = title || CONFIG.boss.phaseTitles[p - 1];
    phaseTip.textContent = PHASE_TIPS[p - 1];
    phaseBanner.className = 'phase-' + p;
    phaseT = 3.2;
    phaseBanner.style.opacity = 1;
  }

  function showSettlement(d) {
    endTitle.textContent = d.won ? '纸页已锚定' : '修订失败';
    endReason.textContent = d.reason;
    endBody.innerHTML = d.players.map(p =>
      `<tr><td>玩家 ${p.id + 1}</td><td>${p.kills}</td><td>${p.walls}</td><td>${p.erases}</td><td>${p.rescues}</td></tr>`).join('');
    endTeam.textContent = '团队用时 ' + fmtTime(d.time) + ' · 总击杀 ' + d.kills;
    endBest.textContent = d.best ? (d.isNew ? '新纪录！最快撤离 ' + fmtTime(d.best) : '最快撤离纪录 ' + fmtTime(d.best)) : '';
    endBest.classList.toggle('new-record', !!d.isNew);
    const rank = d.rank || computeRank({ won: d.won, time: d.time, hp: d.hp ?? 100, crits: d.crits, interrupts: d.interrupts });
    if (rank) {
      rankStamp.hidden = false;
      rankLetter.textContent = rank;
      rankTitle.textContent = RANK_TITLES[rank];
      rankMode.hidden = !d.god;
    } else {
      rankStamp.hidden = true;
    }
    const summary = doc.createElement('p'), badges = doc.createElement('div');
    summary.textContent = '暴击 ' + (d.crits || 0) + ' · 打断 ' + (d.interrupts || 0);
    badges.className = 'end-perk-badges';
    if (d.perks?.length) badges.append(...d.perks.map(perkBadge));
    else badges.textContent = d.won ? '纯手打无强化通关' : '未装订强化';
    $('end-perks').replaceChildren(summary, badges);
    hidePerks(); hideSettings();
    endOverlay.style.display = 'flex';
  }

  return {
    update, spawnDmgNumber, setMuted, showPerks, hidePerks, updateGuide, showSettings, hideSettings, syncSettings, showPhaseBanner,
    setTouchMode, setTouchVisible,
    touchDebug: () => ({ mode: touchMode, visible: !touchLayer.hidden, holding: touchHolding, firing: touchFiring, ads: touchAds.classList.contains('active') }),
    dashFlash() {
      if (doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
      dashLinesT = 0.22;
      dashLines.style.opacity = 0.9;
    },
    damageFrom(sx, sz) {
      if (!Number.isFinite(sx) || !Number.isFinite(sz)) return;
      const hd = hurtDirs[hurtCursor];
      hurtCursor = (hurtCursor + 1) % hurtDirs.length;
      hd.x = sx; hd.z = sz; hd.t = 0.65;
    },
    rankDebug: () => ({ hidden: rankStamp.hidden, letter: rankLetter.textContent, title: rankTitle.textContent, mode: !rankMode.hidden }),
    setGod(on) { godChip.style.display = on ? 'block' : 'none'; },
    phaseBannerState: () => ({ phaseT, title: phaseTitle.textContent, tip: phaseTip.textContent, opacity: phaseBanner.style.opacity }),
    shot() { shotT = .18; crosshair.style.setProperty('--kick', '7px'); },
    hitmarker(killed = false, critical = false, count = 1) {
      hitT = killed ? .24 : .13;
      hitBounce = 1;
      hitmark.classList.toggle('kill', killed);
      hitmark.classList.toggle('critical', critical);
      hitmark.style.opacity = 1;
      if (killed) {
        combo = count;
        killGlow = .18;
        stampT = 1.3;
        $('kill-stamp-label').textContent = combo === 1 ? '击杀!' : combo === 2 ? '双杀 ×2!' : combo === 3 ? '三杀 ×3!' : '墨影无双 ×' + combo + '!';
        killStamp.classList.toggle('hot', combo >= 4);
      }
    },
    feedbackDebug: () => ({ combo, hitBounce, killGlow, stampT }),
    damage() { dmgT = 0.35; },
    toast(msg) { toast.textContent = msg; toastT = 3; },
    drawHint(show) { drawHint.style.display = show ? 'block' : 'none'; },
    showSettlement,
    hideSettlement() { endOverlay.style.display = 'none'; },
    resetCache() {
      hidePerks(); hideSettings(); guideCard.hidden = true;
      perkCards.replaceChildren(); perkChips.replaceChildren(); perkChips.hidden = true; perksSig = '';
      lastObjective = ''; shotT = hitT = dmgT = toastT = mapTime = floatNext = 0;
      hitBounce = killGlow = stampT = combo = phaseT = 0;
      phaseBanner.style.opacity = 0;
      rankStamp.hidden = true; dashLinesT = 0; dashLines.style.opacity = 0;
      for (const hd of hurtDirs) hd.t = 0;
      for (const el of dmgDirs) el.style.opacity = 0;
      killVignette.style.opacity = killStamp.style.opacity = 0;
      crosshair.style.setProperty('--hit-scale', '1');
      hitmark.classList.remove('critical');
      crosshair.style.setProperty('--kick', '0px'); crosshair.style.display = 'block';
      scopeOverlay.style.display = scopeHint.style.display = bossState.style.display = 'none';
      godChip.style.display = 'none';
      hitmark.classList.remove('kill'); hitmark.style.opacity = 0;
      vignette.style.opacity = toast.style.opacity = 0;
      for (const f of floats) { f.life = 0; f.el.style.display = 'none'; f.el.textContent = ''; }
    },
  };
}