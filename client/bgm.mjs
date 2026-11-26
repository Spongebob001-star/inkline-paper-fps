// 零资产动态战斗配乐（OVERHAUL-3B）：D 小调和声、四层编曲、温暖压缩母线、8 分延时空间。
const CHORDS = [
  { root: 50, tones: [53, 57, 60, 64], bass: [50, 62], lead: [64, 69, 72, 76] }, // Dm9
  { root: 46, tones: [50, 53, 57], bass: [46, 58], lead: [62, 65, 69, 74] }, // Bbmaj7
  { root: 48, tones: [52, 55, 57], bass: [48, 60], lead: [64, 67, 72, 76] }, // C6
  { root: 45, tones: [50, 55, 60], bass: [45, 57], lead: [64, 67, 69, 74] }, // A7sus4
];
const F_MAJOR = { root: 41, tones: [53, 57, 60, 65], bass: [41, 53], lead: [65, 69, 72, 77] };
const MODES = {
  anchors: { bpm: 120, prog: 'dm', kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [9, 3, 7, 3, 8, 3, 7, 4, 9, 3, 7, 3, 8, 4, 9, 3], bass: [1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0], pluck: [0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 2, 0, 1], pad: 1, brass: 0 },
  boss12: { bpm: 132, prog: 'dm', kick: [1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0], hat: [7, 4, 8, 4, 7, 4, 8, 5, 7, 4, 8, 4, 7, 5, 8, 6], bass: [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1], pluck: [0, 1, 0, 2, 0, 1, 0, 0, 2, 0, 1, 0, 0, 2, 1, 0], pad: 1, brass: 0 },
  boss3: { bpm: 144, prog: 'dm', kick: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0], hat: [8, 5, 9, 5, 8, 6, 9, 5, 8, 5, 9, 6, 8, 5, 9, 7], bass: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], pluck: [1, 2, 1, 3, 2, 1, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3], pad: 1, brass: 1 },
  escape: { bpm: 136, prog: 'f', kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1], hat: [9, 4, 8, 4, 9, 4, 8, 4, 9, 4, 8, 4, 9, 4, 8, 5], bass: [1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0], pluck: [1, 2, 3, 4, 3, 2, 1, 2, 1, 2, 3, 4, 3, 2, 4, 3], pad: 1, brass: 0 },
  idle: null,
};
const freq = midi => 440 * Math.pow(2, (midi - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createBgm() {
  const host = globalThis.window || globalThis;
  let Audio = null, media = null, reduced = false;
  try {
    Audio = host.AudioContext || host.webkitAudioContext;
    media = host.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    reduced = !!media?.matches;
  } catch (_) {}
  let muted = false;
  try { muted = host.localStorage?.getItem('inkline-sound') === 'off'; } catch (_) {}
  let ctx = null, mix = null, toneBus = null, dry = null, delay = null, feedback = null, wet = null;
  let comp = null, duckGain = null, bgmGain = null, noise = null, timer = null;
  let mode = 'idle', step = 0, bar = 0, volume = 0.65, laugh = false, paused = false, mutedAll = muted || reduced;
  let nextTime = 0, notes = 0, skipped = 0, nodes = 0;
  const GAIN_SCALE = 0.78;

  function duckTarget() { return mutedAll ? 0 : (paused ? 0.4 : 1) * (laugh ? 0.55 : 1); }
  function gainTarget() { return volume * GAIN_SCALE; }
  function applyDuck(tau = 0.1) {
    if (!duckGain || !ctx) return;
    try { duckGain.gain.setTargetAtTime(duckTarget(), ctx.currentTime, tau); } catch (_) {}
  }
  function applyGain() {
    if (!bgmGain || !ctx) return;
    try { bgmGain.gain.setTargetAtTime(gainTarget(), ctx.currentTime, 0.06); } catch (_) {}
  }
  function ensureGraph() {
    if (ctx) return true;
    if (!Audio) return false;
    try {
      ctx = new Audio();
      mix = ctx.createGain(); mix.gain.value = 1;
      toneBus = ctx.createBiquadFilter(); toneBus.type = 'lowpass'; toneBus.frequency.value = 6200; toneBus.Q.value = 0.4;
      dry = ctx.createGain(); dry.gain.value = 1;
      delay = ctx.createDelay(1.5); delay.delayTime.value = 0.25;
      feedback = ctx.createGain(); feedback.gain.value = 0.20;
      wet = ctx.createGain(); wet.gain.value = 0.18;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
      duckGain = ctx.createGain(); duckGain.gain.value = duckTarget();
      bgmGain = ctx.createGain(); bgmGain.gain.value = gainTarget();
      mix.connect(toneBus);
      toneBus.connect(dry); dry.connect(comp);
      toneBus.connect(delay); delay.connect(feedback); feedback.connect(delay);
      delay.connect(wet); wet.connect(comp);
      comp.connect(duckGain); duckGain.connect(bgmGain); bgmGain.connect(ctx.destination);
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.3), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise = buf;
      nodes = 9;
      return true;
    } catch (_) { ctx = null; return false; }
  }
  function unlock(event) {
    if (!event.isTrusted || reduced) return;
    try {
      if (!ensureGraph()) return;
      if (ctx.state !== 'running') Promise.resolve(ctx.resume()).then(() => {
        applyDuck(0.08); applyGain();
        if (mode !== 'idle' && !timer) startScheduler();
      }, () => {});
      else if (mode !== 'idle' && !timer) startScheduler();
    } catch (_) {}
  }
  for (const name of ['pointerdown', 'mousedown', 'keydown', 'click']) {
    try { host.addEventListener(name, unlock, true); } catch (_) {}
  }
  try {
    const change = event => { reduced = !!event.matches; if (reduced) setMuted(true); };
    if (media?.addEventListener) media.addEventListener('change', change);
    else if (media?.addListener) media.addListener(change);
  } catch (_) {}

  function env(gainValue, at, attack, dur, decayTo = 0.0001) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gainValue, at + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(decayTo, 0.0001), at + dur);
    return g;
  }
  function finish(source, gain) {
    source.onended = () => {
      try { gain.disconnect(); source.disconnect(); } catch (_) {}
    };
  }
  function kick(at, chord) {
    const osc = ctx.createOscillator(), g = env(0.62, at, 0.006, 0.18);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(135, at);
    osc.frequency.exponentialRampToValueAtTime(44, at + 0.14);
    osc.connect(g); g.connect(mix); finish(osc, g);
    osc.start(at); osc.stop(at + 0.2);
    noiseHit('kick', at, 0.10, chord);
    notes++;
  }
  function noiseHit(kind, at, gainValue, chord) {
    if (!noise) return;
    const src = ctx.createBufferSource(); src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    const g = env(gainValue, at, 0.004, kind === 'hat' ? 0.045 : 0.13);
    if (kind === 'snare') { filter.type = 'bandpass'; filter.frequency.value = 1750; filter.Q.value = 0.7; }
    else if (kind === 'hat') { filter.type = 'highpass'; filter.frequency.value = 7000; }
    else { filter.type = 'lowpass'; filter.frequency.value = 320; }
    src.connect(filter); filter.connect(g); g.connect(mix); finish(src, g);
    src.start(at); src.stop(at + 0.15);
    if (kind === 'snare') {
      const osc = ctx.createOscillator(), og = env(0.12, at, 0.004, 0.09);
      osc.type = 'triangle'; osc.frequency.setValueAtTime(chord ? 190 : 180, at);
      osc.connect(og); og.connect(mix); finish(osc, og);
      osc.start(at); osc.stop(at + 0.1);
    }
    notes++;
  }
  function hat(at, velocity, ) {
    noiseHit('hat', at, clamp(velocity / 10, 0.02, 0.11));
  }
  function bass(at, midi, gainValue, dur, cutoffTop, cutoffBottom) {
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(cutoffTop, at);
    filter.frequency.exponentialRampToValueAtTime(cutoffBottom, at + dur);
    const g = env(gainValue, at, 0.006, dur);
    for (const [type, detune, level] of [['sawtooth', 0, 1], ['triangle', 7, 0.55]]) {
      const osc = ctx.createOscillator(), og = ctx.createGain();
      osc.type = type; osc.frequency.value = freq(midi); osc.detune.value = detune;
      og.gain.value = level;
      osc.connect(og); og.connect(filter); finish(osc, og);
      osc.start(at); osc.stop(at + dur + 0.02);
    }
    filter.connect(g); g.connect(mix);
    notes++;
  }
  function pluck(at, midi, gainValue, dur = 0.14, type = 'triangle') {
    const osc = ctx.createOscillator(), g = env(gainValue, at, 0.004, dur);
    osc.type = type; osc.frequency.value = freq(midi);
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 3200;
    osc.connect(filter); filter.connect(g); g.connect(mix); finish(osc, g);
    osc.start(at); osc.stop(at + dur + 0.02);
    notes++;
  }
  function pad(at, chord, dur) {
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 980; filter.Q.value = 0.3;
    const g = env(0.05, at, 0.05, dur, 0.0002);
    for (const [offset, detune] of [[0, -6], [0, 7], [-12, 3]]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = freq(chord.tones[0] + offset); osc.detune.value = detune;
      osc.connect(filter); finish(osc, filter);
      osc.start(at); osc.stop(at + dur + 0.05);
    }
    filter.connect(g); g.connect(mix);
    notes += 3;
  }
  function brass(at, chord, dur) {
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1500;
    filter.frequency.setValueAtTime(1900, at);
    filter.frequency.exponentialRampToValueAtTime(700, at + dur);
    const g = env(0.055, at, 0.02, dur);
    for (const [midi, detune] of [[chord.root + 12, -8], [chord.tones[1], 6]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth'; osc.frequency.value = freq(midi); osc.detune.value = detune;
      osc.connect(filter); finish(osc, filter);
      osc.start(at); osc.stop(at + dur + 0.05);
    }
    filter.connect(g); g.connect(mix);
    notes += 2;
  }
  function chordAt() {
    const pattern = MODES[mode];
    return pattern.prog === 'f' ? F_MAJOR : CHORDS[bar % 4];
  }
  function playStep(pattern, stepIndex, at) {
    const chord = chordAt();
    if (pattern.kick[stepIndex]) kick(at, chord);
    if (pattern.snare[stepIndex]) noiseHit('snare', at, 0.16, chord);
    if (pattern.hat[stepIndex]) hat(at, pattern.hat[stepIndex]);
    const bassStep = pattern.bass[stepIndex];
    if (bassStep) {
      const midi = bassStep === 2 ? chord.bass[1] : chord.bass[0];
      bass(at, midi, 0.17, 0.20, 900, 260);
    }
    const pluckStep = pattern.pluck[stepIndex];
    if (pluckStep) pluck(at, chord.lead[(pluckStep + stepIndex) % chord.lead.length], 0.075, 0.13);
    if (pattern.pad && stepIndex === 0) {
      const stepDur = 60 / pattern.bpm / 4;
      pad(at, chord, Math.min(1.9, stepDur * 15));
    }
    if (pattern.brass && (stepIndex === 0 || stepIndex === 8)) {
      brass(at, chord, 0.5);
    }
  }
  function schedule() {
    const pattern = MODES[mode];
    if (!pattern || !ctx || ctx.state !== 'running' || !noise) return;
    const stepDur = 60 / pattern.bpm / 4;
    if (delay) {
      try { delay.delayTime.setTargetAtTime(clamp(stepDur * 2, 0.08, 0.6), ctx.currentTime, 0.05); } catch (_) {}
    }
    if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.02;
    while (nextTime < ctx.currentTime + 0.15) {
      try { playStep(pattern, step, nextTime); } catch (_) { skipped++; }
      step = (step + 1) % 16;
      if (step === 0) bar++;
      nextTime += stepDur;
    }
  }
  function startScheduler() {
    if (timer || mode === 'idle') return;
    if (!ensureGraph()) return;
    nextTime = 0; step = 0; bar = 0;
    timer = host.setInterval(schedule, 25);
  }
  function stopScheduler() { if (timer) { host.clearInterval(timer); timer = null; } }
  function setMode(next) {
    if (!Object.hasOwn(MODES, next)) return mode;
    mode = next;
    step = 0; bar = 0;
    if (next === 'idle') { stopScheduler(); applyDuck(0.12); }
    else if (!mutedAll) { startScheduler(); applyDuck(0.08); }
    return mode;
  }
  function setDuck(on) { laugh = !!on; applyDuck(laugh ? 0.08 : 0.12); return laugh; }
  function setPaused(on) { paused = !!on; applyDuck(0.1); return paused; }
  function setVolume(v) { if (Number.isFinite(v)) volume = clamp(v, 0, 1); applyGain(); return volume; }
  function setMuted(v) {
    mutedAll = !!v || reduced;
    applyDuck(0.06);
    if (mutedAll) { stopScheduler(); }
    else if (mode !== 'idle') startScheduler();
    return mutedAll;
  }
  function stop() {
    stopScheduler();
    mode = 'idle';
    laugh = paused = false;
    if (duckGain && ctx) { try { duckGain.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch (_) {} }
  }
  function debug() {
    return {
      mode, bpm: MODES[mode] ? MODES[mode].bpm : 0, step, bar, running: !!timer,
      ducked: laugh, paused, muted: mutedAll, reduced,
      state: ctx ? ctx.state : (Audio ? 'locked' : 'unsupported'),
      volume, gain: +gainTarget().toFixed(3), duck: duckTarget(),
      targetGain: +(gainTarget() * duckTarget()).toFixed(4),
      notes, skipped, nodes, graph: ['mix', 'toneBus', 'dry', 'delay', 'feedback', 'wet', 'comp', 'duckGain', 'bgmGain'],
    };
  }
  return { setMode, setDuck, setPaused, setVolume, setMuted, stop, debug };
}
