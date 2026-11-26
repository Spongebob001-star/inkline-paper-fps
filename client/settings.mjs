import CONFIG from '../shared/config.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 0.0022,
  fov: 68,
  sfxVolume: 0.85,
  bossVolume: 0.35,
  bgmVolume: 0.65,
  showGuide: true,
});

function finiteSetting(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    sensitivity: finiteSetting(value.sensitivity, DEFAULT_SETTINGS.sensitivity, 0.0008, 0.005),
    fov: finiteSetting(value.fov, DEFAULT_SETTINGS.fov, 60, 95),
    sfxVolume: finiteSetting(value.sfxVolume, DEFAULT_SETTINGS.sfxVolume, 0, 1),
    bossVolume: finiteSetting(value.bossVolume, DEFAULT_SETTINGS.bossVolume, 0, 1),
    bgmVolume: finiteSetting(value.bgmVolume, DEFAULT_SETTINGS.bgmVolume, 0, 1),
    showGuide: typeof value.showGuide === 'boolean' ? value.showGuide : DEFAULT_SETTINGS.showGuide,
  };
}

// Resolve the browser getter inside try: even accessing localStorage can throw.
export function loadSettings(storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    return normalizeSettings(JSON.parse(store?.getItem(CONFIG.storage.settings) ?? 'null'));
  } catch (_) {
    return normalizeSettings();
  }
}

export function saveSettings(settings, storage) {
  const normalized = normalizeSettings(settings);
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    store?.setItem(CONFIG.storage.settings, JSON.stringify(normalized));
  } catch (_) {}
  return normalized;
}

export function applySettings(settings, { input, renderer, audio, guide, bgm }) {
  const normalized = normalizeSettings(settings);
  input.setSensitivity(normalized.sensitivity);
  renderer.setBaseFov(normalized.fov);
  audio.setVolume(normalized.sfxVolume);
  renderer.setBossLaughVolume(normalized.bossVolume);
  bgm?.setVolume(normalized.bgmVolume);
  guide.setEnabled(normalized.showGuide);
  return normalized;
}
