// 输入层：指针锁定 + 键位意图 30Hz + 射击射线直报（favor-the-shooter）。
// 锁定被拒绝时提示一次、不自动反复请求（T2.4）；点击画布可手动重试。
import CONFIG from '../shared/config.mjs';

export function createInput(canvas, { onIntent, onShot, onReload, onLock, onDraw, onCancelDraw, onErase, onFold }) {
  const keys = new Set();
  let yaw = 0, pitch = 0;
  let locked = false, fallback = false, firing = false, jumpQueued = false;
  let seq = 0, lastShot = 0, lockWarned = false, lockTimer = 0;
  const sens = 0.0022;

  // 指针锁定不可用时退回兼容模式：移动鼠标即转视角（内嵌浏览器/iframe 会拒绝锁）
  function enableFallback(msg) {
    if (fallback) return;
    fallback = true;
    clearTimeout(lockTimer);
    onLock(false, msg, true);
  }
  function requestLock() {
    if (fallback || locked) return;
    if (typeof canvas.requestPointerLock !== 'function') {
      if (!lockWarned) { lockWarned = true; enableFallback('兼容模式：移动鼠标转动视角（浏览器不支持指针锁定）'); }
      return;
    }
    try {
      const r = canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') {
        r.catch(() => {
          if (!lockWarned) { lockWarned = true; enableFallback('兼容模式：移动鼠标转动视角（指针锁定被拒绝）'); }
        });
      }
      clearTimeout(lockTimer);
      lockTimer = setTimeout(() => {
        if (!locked && !fallback && !lockWarned) { lockWarned = true; enableFallback('兼容模式：移动鼠标转动视角'); }
      }, 450);
    } catch {
      if (!lockWarned) { lockWarned = true; enableFallback('兼容模式：移动鼠标转动视角'); }
    }
  }
  canvas.addEventListener('click', () => { if (!locked) requestLock(); });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    if (locked) fallback = false;
    if (!locked) firing = false;
    onLock(locked, null, fallback);
  });
  document.addEventListener('pointerlockerror', () => {
    if (!lockWarned) { lockWarned = true; enableFallback('兼容模式：移动鼠标转动视角（指针锁定被拒绝）'); }
  });
  document.addEventListener('mousemove', e => {
    if (!locked && !fallback) return;
    yaw -= e.movementX * sens;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * sens));
  });
  document.addEventListener('mousedown', e => {
    if (!locked && !fallback) return;
    if (e.button === 0) firing = true;
    if (e.button === 2) onCancelDraw();
  });
  document.addEventListener('mouseup', e => { if (e.button === 0) firing = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
    if (e.code === 'KeyR') onReload();
    if (e.code === 'KeyQ') onDraw();
    if (e.code === 'KeyE') onErase();
    if (e.code === 'KeyC') onFold();
  });
  document.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); firing = false; });

  function dir() {
    const cp = Math.cos(pitch);
    return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  }

  // 30Hz 意图；射击按住连发，间隔客户端 mirrors 房主闸门（房主仍权威）
  setInterval(() => {
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const intent = {
      seq: ++seq, f, r,
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
      jump: jumpQueued, yaw, pitch,
      // 原型闸门：开火中不允许共持（内核不校验，客户端自律）
      hold: (locked || fallback) && keys.has('KeyF') && !firing,
    };
    jumpQueued = false;
    onIntent(intent);
    const now = performance.now();
    if (firing && (locked || fallback) && now - lastShot >= CONFIG.player.gun.fireInterval * 1000) {
      lastShot = now;
      onShot(dir());
    }
  }, 1000 / CONFIG.net.inputHz);

  return {
    dir,
    get yaw() { return yaw; },
    get locked() { return locked; },
    setView(y, p) { yaw = y; pitch = p; },
    pressFire() { firing = true; },
    releaseFire() { firing = false; },
  };
}