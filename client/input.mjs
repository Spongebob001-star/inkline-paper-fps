// 输入层：指针锁定 + 键位意图 30Hz + 射击射线直报（favor-the-shooter）。
import CONFIG from '../shared/config.mjs';

export function createInput(canvas, { onIntent, onShot, onReload, onLock, onDraw, onCancelDraw, onErase, onFold,
  onWeapon, onQuickWall, onLook, onTouchMode, getWeapon = () => 0, getFireInterval = () => CONFIG.player.gun.fireInterval,
  isDrawing = () => false, canADS = () => true, isBlocked = () => false }) {
  const keys = new Set();
  let yaw = 0, pitch = 0;
  let locked = false, fallback = false, firing = false, jumpQueued = false, dashQueued = false;
  let seq = 0, lastShot = 0;
  let lockRequest = 0, promiseRequest = 0, unlockedAt = -Infinity, lockWarning = null;
  let sens = 0.0022;
  let ads = false, lastWheel = -Infinity;
  const MAX_R = 52;
  let touchMode = false, touchHold = false, touchF = 0, touchR = 0, touchSprint = false;
  let touchIdMove = null, touchIdLook = null, lookX = 0, lookY = 0, stickX = 0, stickY = 0;
  const byId = id => document.getElementById?.(id) || null;
  const forceLandscape = () => document.documentElement?.classList?.contains?.('force-landscape') === true;
  function playPoint(x, y) {
    return forceLandscape() ? { x: y, y: (window.innerWidth || 0) - x } : { x, y };
  }
  function viewWidth() {
    return forceLandscape() ? (window.innerHeight || 0) : (window.innerWidth || 0);
  }
  function setSensitivity(v) {
    if (Number.isFinite(v)) sens = Math.max(0.0008, Math.min(0.005, v));
    return sens;
  }
  function resetStick() {
    const knob = byId('touch-stick-knob');
    if (knob) knob.style.transform = 'translate(0px,0px)';
  }
  function clear() {
    keys.clear(); firing = jumpQueued = dashQueued = ads = touchHold = false;
    touchF = touchR = 0; touchSprint = false; resetStick();
  }
  function syncADS() {
    if (isBlocked() || (!locked && !fallback) || getWeapon() !== 2 || !canADS() || isDrawing()) ads = false;
    return ads;
  }
  function cancelADS() { ads = false; }
  function chooseWeapon(idx) {
    if (idx === getWeapon()) return;
    cancelADS();
    onWeapon?.(idx);
  }

  function enableTouch() {
    if (touchMode) return;
    touchMode = true; fallback = true;
    ++lockRequest; promiseRequest = 0;
    document.body?.classList?.add('touch-mode');
    const hint = byId('lock-hint');
    if (hint) hint.style.display = 'none';
    onTouchMode?.(true);
  }
  function setTouchMove(f, r, sprint) {
    touchF = Math.max(-1, Math.min(1, Number(f) || 0));
    touchR = Math.max(-1, Math.min(1, Number(r) || 0));
    touchSprint = !!sprint || Math.hypot(touchF, touchR) > .82 + 1e-9;
  }
  function lookDelta(dx, dy) {
    if (isBlocked() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const k = sens * 2.2 * (syncADS() ? .42 : 1);
    yaw -= dx * k;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * k));
    onLook?.(yaw, pitch);
  }
  function setTouchFire(on) { firing = !!on && !isBlocked(); }
  function setTouchHold(on) { touchHold = !!on; }
  function triggerJump() { if (!isBlocked()) jumpQueued = true; }
  function triggerDash() { if (!isBlocked()) dashQueued = true; }
  function toggleADS() {
    if (isBlocked() || getWeapon() !== 2 || !canADS() || isDrawing()) return ads = false;
    return ads = !ads;
  }
  function stickTo(x, y) {
    const dx = x - stickX, dy = y - stickY, mag = Math.hypot(dx, dy), k = mag > MAX_R ? MAX_R / mag : 1;
    setTouchMove(-dy / MAX_R, dx / MAX_R, mag > MAX_R * .82 + 1e-9);
    const knob = byId('touch-stick-knob');
    if (knob) knob.style.transform = `translate(${(dx * k).toFixed(1)}px,${(dy * k).toFixed(1)}px)`;
  }
  function beginTouch(t) {
    const p = playPoint(t.clientX, t.clientY), x = p.x, y = p.y, target = t.target;
    const zone = byId('touch-stick-zone');
    if (touchIdMove === null && zone?.contains?.(target)) {
      touchIdMove = t.identifier;
      const r = zone.getBoundingClientRect?.();
      if (r) {
        const c = playPoint(r.left + r.width / 2, r.top + r.height / 2);
        stickX = c.x; stickY = c.y;
      } else {
        stickX = x; stickY = y;
      }
      stickTo(x, y);
      return true;
    }
    const fire = byId('touch-fire');
    if (touchIdLook === null && (fire?.contains?.(target) || (target === canvas && x >= viewWidth() / 2))) {
      touchIdLook = t.identifier; lookX = x; lookY = y;
      return true;
    }
    return false;
  }
  function resetTouch() {
    touchIdMove = touchIdLook = null;
    touchHold = false; touchF = touchR = 0; touchSprint = false;
    resetStick();
  }
  const touchList = e => e.changedTouches || [e];
  document.addEventListener('touchstart', e => {
    enableTouch();
    let owned = false;
    for (const t of touchList(e)) owned = beginTouch(t) || owned;
    if (owned) e.preventDefault?.();
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    let owned = false;
    for (const t of touchList(e)) {
      const p = playPoint(t.clientX, t.clientY);
      if (t.identifier === touchIdMove) {
        stickTo(p.x, p.y); owned = true;
      } else if (t.identifier === touchIdLook) {
        const dx = p.x - lookX, dy = p.y - lookY;
        lookX = p.x; lookY = p.y;
        lookDelta(dx, dy); owned = true;
      }
    }
    if (owned) e.preventDefault?.();
  }, { passive: false });
  const endTouch = e => {
    for (const t of touchList(e)) {
      if (t.identifier === touchIdMove) { touchIdMove = null; setTouchMove(0, 0, false); resetStick(); }
      if (t.identifier === touchIdLook) touchIdLook = null;
    }
  };
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  function lockFailed(error, request) {
    if (locked || request !== lockRequest) return;
    fallback = error?.name === 'NotSupportedError';
    const cooling = performance.now() - unlockedAt < 1250;
    const msg = fallback
      ? '兼容模式：浏览器不支持指针锁定，点击画面可重试'
      : cooling && (!error || error.name === 'SecurityError')
        ? '请稍等 1 秒后再次点击画面锁定鼠标'
        : '鼠标未锁定，请再次点击画面；若仍失败，请在 Chrome / Edge 中直接打开游戏';
    onLock(false, lockWarning === msg ? null : msg, fallback);
    lockWarning = msg;
  }
  function requestLock() {
    if (touchMode || isBlocked() || locked) return;
    const request = ++lockRequest;
    promiseRequest = 0;
    if (typeof canvas.requestPointerLock !== 'function') {
      lockFailed({ name: 'NotSupportedError' }, request);
      return;
    }
    try {
      const result = canvas.requestPointerLock();
      if (result && typeof result.catch === 'function') {
        promiseRequest = request;
        result.catch(error => lockFailed(error, request));
      }
    } catch (error) {
      promiseRequest = request;
      lockFailed(error, request);
    }
  }
  canvas.addEventListener('click', requestLock);
  document.addEventListener('pointerlockchange', () => {
    const wasLocked = locked;
    locked = document.pointerLockElement === canvas;
    ++lockRequest;
    promiseRequest = 0;
    lockWarning = null;
    if (locked) fallback = false;
    else {
      firing = false;
      cancelADS();
      if (wasLocked) unlockedAt = performance.now();
    }
    onLock(locked, null, fallback);
  });
  document.addEventListener('pointerlockerror', () => {
    // Promise rejection carries the error type; the legacy event does not.
    if (promiseRequest !== lockRequest) lockFailed(null, lockRequest);
  });
  document.addEventListener('mousemove', e => {
    if (e.sourceCapabilities?.firesTouchEvents || isBlocked() || (!locked && (!fallback || e.target !== canvas))) return;
    const dx = e.movementX, dy = e.movementY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 300 || Math.abs(dy) > 300) return;
    const scale = syncADS() ? 0.42 : 1;
    yaw -= dx * sens * scale;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * sens * scale));
    // 原生刷新率转头：mousemove 内同步直报（30Hz onIntent 保留为移动/射击意图）
    onLook?.(yaw, pitch);
  });
  document.addEventListener('mousedown', e => {
    if (e.sourceCapabilities?.firesTouchEvents || isBlocked() || (!locked && !fallback)) return;
    if (e.button === 0) firing = true;
    if (e.button === 2) {
      if (isDrawing()) { cancelADS(); onCancelDraw(); }
      else if (getWeapon() === 2 && canADS()) ads = true;
      else onCancelDraw();
    }
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) firing = false;
    if (e.button === 2) cancelADS();
  });
  document.addEventListener('wheel', e => {
    if (isBlocked() || (!locked && !fallback) || !e.deltaY) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 120) return;
    lastWheel = now;
    chooseWeapon((getWeapon() + (e.deltaY > 0 ? 1 : 2)) % 3);
  }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (isBlocked() || e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dashQueued = true;
    if (e.code === 'KeyR') { cancelADS(); onReload(); }
    if (e.code === 'KeyQ') { cancelADS(); onDraw(); }
    if (e.code === 'KeyG') { cancelADS(); onQuickWall?.(); }
    if (/^Digit[123]$/.test(e.code)) { e.preventDefault(); chooseWeapon(Number(e.code.slice(-1)) - 1); }
    if (e.code === 'KeyE') onErase();
    if (e.code === 'KeyC') onFold();
  });
  document.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); firing = false; cancelADS(); resetTouch(); });

  function dir() {
    const cp = Math.cos(pitch);
    return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  }

  // 30Hz 意图；射击按住连发，间隔客户端 mirrors 房主闸门（房主仍权威）
  setInterval(() => {
    // Send neutral intent while a modal is open; the simulation keeps ticking.
    if (isBlocked()) clear();
    const f = Math.max(-1, Math.min(1, (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + touchF));
    const r = Math.max(-1, Math.min(1, (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + touchR));
    const intent = {
      seq: ++seq, f, r,
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight') || touchSprint,
      jump: jumpQueued, dash: dashQueued, yaw, pitch,
      // 原型闸门：开火中不允许共持（内核不校验，客户端自律）
      hold: ((locked || fallback) && keys.has('KeyF') && !firing) || touchHold,
    };
    jumpQueued = false;
    dashQueued = false;
    onIntent(intent);
    syncADS();
    const now = performance.now();
    if (firing && (locked || fallback) && now - lastShot >= getFireInterval() * 1000) {
      lastShot = now;
      onShot(dir());
    }
  }, 1000 / CONFIG.net.inputHz);

  return {
    dir, requestLock, cancelADS, clear, setSensitivity, enableTouch, isTouch: () => touchMode,
    setTouchMove, lookDelta, setTouchFire, setTouchHold, triggerJump, triggerDash, toggleADS,
    get ads() { return syncADS(); },
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get locked() { return locked; },
    setView(y, p) { yaw = y; pitch = p; },
    pressFire() { if (!isBlocked()) firing = true; },
    releaseFire() { firing = false; },
  };
}