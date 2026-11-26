import { CONFIG } from '../shared/config.mjs';

export function createAudio({ onMuteChange } = {}) {
  const host = globalThis.window || globalThis;
  const voices = new Set();
  const limit = 18, peak = 0.62, drive = 1.5;
  let Audio, media, ctx = null, master = null, punch = null, compressor = null;
  let noise = null, curve = null;
  let muted = false, reduced = false, resuming = false, starts = 0, skipped = 0, volume = 0.85;
  let combo = 0, lastKill = -Infinity;
  const fxLast = new Map(), whizSeen = new Set();
  const nowMs = () => { try { return host.performance?.now?.() ?? Date.now(); } catch (_) { return Date.now(); } };
  function cooldown(key, ms) {
    const t = nowMs(), last = fxLast.get(key) ?? -1e12;
    if (t - last < ms) return false;
    fxLast.set(key, t);
    return true;
  }
  // .62 is the master BUS gain at volume .85, not a measured acoustic peak.
  const masterPeak = () => peak * (volume / 0.85);
  function setVolume(v) {
    if (Number.isFinite(v)) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = masterPeak();
    }
    return volume;
  }
  try { Audio = host.AudioContext || host.webkitAudioContext; } catch (_) {}
  try { muted = host.localStorage.getItem(CONFIG.storage.sound) === 'off'; } catch (_) {}
  try {
    media = host.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = media.matches;
  } catch (_) {}
  muted = muted || reduced;

  function dispose(voice) {
    if (!voices.delete(voice)) return;
    if (voice.timer) clearTimeout(voice.timer);
    for (const source of voice.sources) {
      source.onended = null;
      try { source.stop(); } catch (_) {}
    }
    for (const node of voice.nodes) {
      try { node.disconnect(); } catch (_) {}
    }
  }

  // The gate also cancels future layers; pause never queues playback for resume.
  function stop() {
    combo = 0;
    lastKill = -Infinity;
    for (const voice of voices) {
      try {
        if (!ctx || ctx.state !== 'running') { dispose(voice); continue; }
        if (voice.stopping) continue;
        voice.stopping = true;
        const now = ctx.currentTime;
        voice.gate.gain.setValueAtTime(1, now);
        voice.gate.gain.linearRampToValueAtTime(0, now + 0.012);
        for (const source of voice.sources) source.stop(now + 0.012);
        // Cleanup fallback only, never delayed playback.
        voice.timer = setTimeout(() => dispose(voice), 40);
      } catch (_) { dispose(voice); }
    }
  }

  function setMuted(value) {
    const next = !!value || reduced;
    const changed = next !== muted;
    muted = next;
    if (muted) stop();
    try { host.localStorage.setItem(CONFIG.storage.sound, muted ? 'off' : 'on'); } catch (_) {}
    if (changed) {
      try {
        if (typeof onMuteChange === 'function') Promise.resolve(onMuteChange(muted)).catch(() => {});
      } catch (_) {}
    }
    return muted;
  }

  try {
    const change = event => {
      reduced = !!event.matches;
      // Reduction forces sound off; removing it requires an explicit opt-in again.
      if (reduced) setMuted(true);
    };
    if (media?.addEventListener) media.addEventListener('change', change);
    else if (media?.addListener) media.addListener(change);
  } catch (_) {}

  function createGraph() {
    if (!curve) {
      curve = new Float32Array(2049);
      const normal = Math.tanh(drive);
      for (let i = 0; i < curve.length; i++) {
        curve[i] = Math.tanh(drive * (2 * i / (curve.length - 1) - 1)) / normal;
      }
    }
    const allocated = [];
    const keep = node => { allocated.push(node); return node; };
    try {
      const gain = keep(ctx.createGain());
      const shaper = keep(ctx.createWaveShaper());
      const comp = keep(ctx.createDynamicsCompressor());
      shaper.curve = curve;
      shaper.oversample = '2x';
      comp.threshold.value = -14;
      comp.knee.value = 18;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.16;
      gain.gain.value = masterPeak();
      shaper.connect(comp);
      comp.connect(gain);
      gain.connect(ctx.destination);
      punch = shaper;
      compressor = comp;
      master = gain;
    } catch (error) {
      for (const node of allocated) { try { node.disconnect(); } catch (_) {} }
      throw error;
    }
  }

  function unlock(event) {
    try {
      if (!event.isTrusted || !Audio || reduced) return;
      const activation = host.navigator?.userActivation;
      if (activation && !activation.isActive) return;
      // Capture runs before gameplay/unmute handlers, still inside the gesture.
      if (!ctx) {
        ctx = new Audio();
        ctx.onstatechange = () => { if (ctx.state !== 'running') stop(); };
      }
      if (ctx.state !== 'running') stop();
      if (ctx.state === 'closed') return;
      if (!master) createGraph();
      if (!noise) {
        const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate / 2), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        noise = buffer;
      }
      if (ctx.state !== 'running' && !resuming) {
        resuming = true;
        Promise.resolve(ctx.resume()).then(
          () => { resuming = false; if (ctx.state !== 'running') stop(); },
          () => { resuming = false; stop(); },
        );
      }
    } catch (_) { resuming = false; stop(); }
  }
  for (const name of ['pointerdown', 'mousedown', 'keydown', 'click']) {
    try { host.addEventListener(name, unlock, true); } catch (_) {}
  }

  // Parts [wave, fromHz, toHz, seconds, gain, delay=0, noiseQ=.8] use only the audio clock.
  function play(parts, kind, pitch = 1, jitter = false, scale = 1) {
    let voice;
    try {
      if (muted || reduced || !ctx || ctx.state !== 'running' || !master || !noise) {
        skipped++;
        if (ctx && ctx.state !== 'running') stop();
        return false;
      }
      if (voices.size >= limit) { skipped++; return false; }
      // One audio-only random draw per accepted shot; no simulation RNG access.
      if (jitter) pitch *= 0.94 + Math.random() * 0.12;
      const level = Math.max(0, Math.min(1.5, scale));
      voice = { kind, pitch, nodes: [], sources: [], gate: null, left: parts.length, stopping: false, timer: 0 };
      voices.add(voice);
      const keep = node => { voice.nodes.push(node); return node; };
      voice.gate = keep(ctx.createGain());
      voice.gate.connect(punch);
      const now = ctx.currentTime;
      for (const [wave, from, to, duration, gain, delay = 0, q = 0.8] of parts) {
        const at = now + delay, end = at + duration;
        const source = keep(wave === 'noise' ? ctx.createBufferSource() : ctx.createOscillator());
        voice.sources.push(source);
        const envelope = keep(ctx.createGain());
        let frequency;
        if (wave === 'noise') {
          source.buffer = noise;
          const filter = keep(ctx.createBiquadFilter());
          filter.type = 'bandpass';
          filter.Q.value = q;
          source.connect(filter);
          filter.connect(envelope);
          frequency = filter.frequency;
        } else {
          source.type = wave;
          frequency = source.frequency;
          source.connect(envelope);
        }
        frequency.setValueAtTime(from * pitch, at);
        frequency.exponentialRampToValueAtTime(to * pitch, end);
        envelope.connect(voice.gate);
        // Short clicks must not schedule decay before attack (notably the 4ms click).
        const attack = Math.min(0.004, duration * 0.2);
        const release = Math.min(0.005, duration * 0.2);
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime(gain * level, at + attack);
        envelope.gain.exponentialRampToValueAtTime(0.0001, end - release);
        envelope.gain.linearRampToValueAtTime(0, end);
        source.onended = () => { if (--voice.left === 0) dispose(voice); };
        source.start(at);
        source.stop(end + 0.002);
      }
      starts++;
      return true;
    } catch (_) {
      if (voice) dispose(voice);
      return false;
    }
  }

  function shot(weaponIdx = 0) {
    return play(weaponIdx === 1
      // Heavy bass and two hot noise bands drive the shared soft saturator.
      ? [['sine', 115, 30, 0.24, 0.98], ['noise', 1400, 180, 0.16, 0.78, 0, 0.65],
        ['noise', 3200, 600, 0.095, 0.48, 0, 1.1], ['noise', 1900, 1000, 0.022, 0.3, 0.210, 3],
        ['noise', 2600, 1200, 0.016, 0.26, 0.290, 4]]
      : weaponIdx === 2
        ? [['noise', 5800, 750, 0.105, 0.68], ['sawtooth', 2200, 280, 0.09, 0.34],
          ['sine', 150, 38, 0.26, 0.9], ['noise', 3800, 2000, 0.012, 0.3, 0.310, 7],
          ['triangle', 2300, 1400, 0.014, 0.28, 0.390]]
        : [['noise', 3400, 3400, 0.004, 0.55, 0, 9], ['sine', 175, 52, 0.14, 0.82],
          ['noise', 1800, 420, 0.085, 0.52], ['noise', 760, 240, 0.12, 0.2, 0.025, 1.2]],
    'shot', 1, true);
  }

  // weaponIdx matches p.weapon: 0 rifle pouch, 1 shells, 2 sniper latch.
  function reload(weaponIdx = 0) {
    return play(weaponIdx === 1
      ? [['noise', 1100, 420, 0.045, 0.4], ['triangle', 720, 480, 0.035, 0.32, 0.12],
        ['noise', 2100, 900, 0.025, 0.36, 0.24, 3], ['triangle', 720, 480, 0.035, 0.32, 0.36]]
      : weaponIdx === 2
        ? [['noise', 3400, 1600, 0.018, 0.42, 0, 5], ['triangle', 1650, 850, 0.065, 0.32, 0.075],
          ['noise', 2800, 1100, 0.026, 0.42, 0.27, 4]]
        : [['noise', 900, 320, 0.14, 0.36], ['noise', 1700, 700, 0.055, 0.4, 0.105],
          ['triangle', 380, 220, 0.045, 0.32, 0.19]], 'reload');
  }

  // Optional main-owned combo overrides the local 3.5s audio-clock window.
  function kill(suppliedCombo) {
    const now = ctx ? ctx.currentTime : 0;
    const next = Number.isFinite(suppliedCombo) && suppliedCombo >= 1
      ? Math.floor(suppliedCombo) : (now - lastKill <= 3.5 ? combo + 1 : 1);
    const factor = 2 ** (Math.min(next - 1, 6) / 12);
    const played = play([['noise', 850, 180, 0.055, 0.48], ['sine', 165, 70, 0.075, 0.5],
      ['triangle', 660, 660, 0.1, 0.3, 0.025], ['sine', 660 * 2 ** (4 / 12), 660 * 2 ** (4 / 12), 0.14, 0.32, 0.075],
      ['sine', 660 * 2 ** (7 / 12), 660 * 2 ** (7 / 12), 0.18, 0.28, 0.125]], 'kill', factor);
    if (played) { combo = next; lastKill = now; }
    return played;
  }

  function bulletWhiz(list, pos) {
    if (!Array.isArray(list) || !pos) return false;
    const alive = new Set();
    for (const pr of list) alive.add(pr.id);
    for (const id of whizSeen) if (!alive.has(id)) whizSeen.delete(id);
    let fired = false;
    for (const pr of list) {
      if (whizSeen.has(pr.id)) continue;
      const d = Math.hypot(pr.x - pos.x, (pr.y || 0) - (pos.y - 0.35), pr.z - pos.z);
      if (d > 2.2) continue;
      whizSeen.add(pr.id);
      if (cooldown('whiz', 320)) {
        fired = play([['noise', 2800, 650, 0.12, 0.34, 0, 2.4], ['triangle', 2400, 700, 0.09, 0.18]], 'bulletWhiz', 1, true) || fired;
      }
    }
    return fired;
  }

  return {
    shot, reload, kill,
    footstep: sprint => cooldown('footstep', 60) && play([
      ['sine', 120, 55, 0.055, 0.42], ['noise', 2200, 3800, 0.045, 0.2, 0, 1.4]], 'footstep', sprint ? 1.06 : 0.96, true),
    jump: () => cooldown('jump', 180) && play([
      ['sine', 150, 70, 0.09, 0.34], ['noise', 900, 2600, 0.11, 0.2, 0.01, 0.9]], 'jump', 1, true),
    land: fallSpeed => cooldown('land', 120) && play([
      ['noise', 520, 140, 0.1, 0.4, 0, 1.1], ['sine', 92, 38, 0.13, 0.46]],
      'land', 1, true, Math.max(0.45, Math.min(1.35, 0.3 + Math.abs(fallSpeed) / 9))),
    craneCharge: distFactor => cooldown('craneCharge', 800) && play([
      ['sawtooth', 260, 620, 0.4, 0.22], ['triangle', 390, 780, 0.36, 0.16, 0.02]], 'craneCharge', 1, false, distFactor),
    eraserBite: distFactor => cooldown('eraserBite', 350) && play([
      ['noise', 950, 180, 0.16, 0.4, 0, 1.3], ['sawtooth', 210, 90, 0.14, 0.24, 0.02], ['noise', 2600, 900, 0.05, 0.2, 0, 2]],
      'eraserBite', 1, true, distFactor),
    planeDive: distFactor => cooldown('planeDive', 500) && play([
      ['sawtooth', 1500, 420, 0.34, 0.3], ['noise', 2400, 500, 0.3, 0.26, 0, 0.7]], 'planeDive', 1, true, distFactor),
    bulletWhiz,
    anchorTick: progress => cooldown('anchorTick', 70) && play([
      ['triangle', 900, 610, 0.05, 0.3], ['noise', 3200, 1600, 0.03, 0.18, 0, 3]],
      'anchorTick', 0.85 + Math.max(0, Math.min(1, progress)) * 0.75),
    anchorDone: () => play([
      ['noise', 1400, 300, 0.14, 0.5, 0, 0.9], ['triangle', 660, 660, 0.16, 0.32, 0.06],
      ['triangle', 880, 880, 0.18, 0.3, 0.12], ['sine', 1320, 1320, 0.24, 0.26, 0.18]], 'anchorDone'),
    heartbeat: () => cooldown('heartbeat', 420) && play([
      ['sine', 68, 38, 0.12, 0.6], ['sine', 66, 36, 0.12, 0.5, 0.18]], 'heartbeat'),
    bossSpawn: () => play([
      ['sine', 70, 30, 0.55, 0.85], ['sawtooth', 110, 55, 0.5, 0.3, 0.02], ['noise', 420, 80, 0.32, 0.4]], 'bossSpawn'),
    dash: () => cooldown('dash', 120) && play([
      ['noise', 1800, 420, 0.16, 0.34, 0, 1.6], ['sine', 92, 45, 0.1, 0.42, 0.005]], 'dash', 1, true),
    stamp: () => play([
      ['sine', 92, 34, 0.16, 0.75], ['triangle', 220, 90, 0.12, 0.34, 0.01],
      ['noise', 620, 190, 0.06, 0.3, 0, 1.4]], 'stamp'),
    paperTear: () => play([
      ['noise', 2600, 900, 0.07, 0.3, 0, 2.2], ['noise', 1200, 420, 0.05, 0.22, 0.02, 1.5]], 'paperTear'),
    weaponSwitch: () => play([['noise', 1800, 900, 0.035, 0.2], ['triangle', 480, 680, 0.055, 0.16, 0.05]], 'weaponSwitch'),
    crit: () => play([['sine', 1760, 1760, 0.11, 0.4], ['triangle', 2637, 2637, 0.15, 0.28, 0.028]], 'crit'),
    bossStun: () => play([['noise', 420, 65, 0.3, 0.65], ['sine', 115, 28, 0.38, 0.86],
      ['triangle', 1100, 220, 0.32, 0.32, 0.065], ['noise', 2700, 700, 0.12, 0.3]], 'bossStun'),
    bossWave: () => play([['sine', 210, 58, 0.34, 0.7], ['noise', 700, 150, 0.26, 0.4],
      ['triangle', 330, 120, 0.2, 0.3, 0.05]], 'bossWave'),
    mortarBoom: () => play([['sine', 96, 26, 0.32, 0.92], ['noise', 1300, 90, 0.26, 0.62],
      ['triangle', 420, 160, 0.12, 0.3, 0.02]], 'mortarBoom'),
    bossSlam: () => play([['sine', 74, 24, 0.3, 0.9], ['noise', 900, 120, 0.18, 0.55],
      ['triangle', 260, 90, 0.16, 0.35, 0.03]], 'bossSlam'),
    bossPhase: phase => play(phase === 3
      ? [['sine', 98, 49, 0.5, 0.85], ['triangle', 196, 98, 0.5, 0.5, 0.05], ['noise', 2200, 300, 0.35, 0.32]]
      : [['sine', 220, 110, 0.36, 0.6], ['triangle', 330, 220, 0.3, 0.36, 0.04]], 'bossPhase'),
    hit: armored => play(armored
      ? [['triangle', 620, 380, 0.085, 0.46], ['noise', 1800, 1800, 0.006, 0.3, 0, 6]]
      : [['sine', 190, 95, 0.09, 0.48], ['triangle', 1450, 1450, 0.04, 0.22, 0.006]], 'hit'),
    armorStrip: () => play([['noise', 3400, 650, 0.18, 0.55], ['triangle', 2100, 380, 0.18, 0.32],
      ['sine', 170, 55, 0.15, 0.6]], 'armorStrip'),
    wallDraw: () => play([['noise', 700, 2900, 0.24, 0.42], ['noise', 280, 850, 0.2, 0.3, 0.025],
      ['triangle', 130, 190, 0.18, 0.22]], 'wallDraw'),
    erase: () => play([['triangle', 260, 55, 0.18, 0.54], ['noise', 1900, 230, 0.16, 0.48],
      ['sine', 100, 35, 0.2, 0.45]], 'erase'),
    fold: () => play([['noise', 3000, 1400, 0.042, 0.33], ['triangle', 180, 95, 0.05, 0.19]], 'fold'),
    pickup: () => play([['sine', 1046.5, 1046.5, 0.16, 0.24], ['sine', 1318.51, 1318.51, 0.22, 0.22, 0.1]], 'pickup'),
    perkPick: () => play([['sine', 523.25, 523.25, 0.18, 0.2], ['sine', 659.25, 659.25, 0.2, 0.18, 0.02], ['sine', 783.99, 783.99, 0.24, 0.16, 0.04]], 'perkPick'),
    playerHit: () => play([['sine', 105, 32, 0.22, 0.78], ['noise', 950, 160, 0.14, 0.46],
      ['triangle', 620, 380, 0.095, 0.24, 0.035]], 'playerHit'),
    isMuted: () => muted,
    setMuted, setVolume,
    toggleMute: () => setMuted(!muted),
    stop, reset: stop,
    debug: () => Object.freeze({
      muted, reducedMotion: reduced, resuming,
      state: ctx ? ctx.state : (Audio ? 'locked' : 'unsupported'),
      active: voices.size,
      stopping: [...voices].filter(voice => voice.stopping).length,
      sources: [...voices].reduce((count, voice) => count + voice.sources.length, 0),
      nodes: [...voices].reduce((count, voice) => count + voice.nodes.length, master ? 3 : 0),
      noiseBuffers: noise ? 1 : 0, starts, skipped, maxVoices: limit, whizTracked: whizSeen.size,
      // Legacy *Peak fields are gain coefficients, never acoustic measurements.
      volume, peak, masterGain: masterPeak(), masterPeak: masterPeak(), maxMasterPeak: peak / 0.85,
      graph: Object.freeze(['voice.gate', 'punch', 'compressor', 'masterGain', 'destination']),
      curve: curve ? Object.freeze({ length: curve.length, peak: curve[curve.length - 1], drive, oversample: punch?.oversample }) : null,
      compressor: compressor ? Object.freeze({ threshold: compressor.threshold.value, knee: compressor.knee.value,
        ratio: compressor.ratio.value, attack: compressor.attack.value, release: compressor.release.value,
        reduction: compressor.reduction }) : null,
      combo,
      voices: Object.freeze([...voices].map(voice => Object.freeze({ kind: voice.kind, pitch: voice.pitch,
        sources: voice.sources.length, nodes: voice.nodes.length, stopping: voice.stopping }))),
    }),
  };
}
