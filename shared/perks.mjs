import CONFIG from './config.mjs';

// Shared, immutable identity: the legacy hot path does not allocate modifiers.
const DEFAULT_MODS = Object.freeze({
  speedMul: 1, inkRegenMul: 1, reloadMul: 1, drawCostMul: 1,
  wallHpMul: 1, wallLifeAdd: 0, wallHeal: 0, eraseRadiusAdd: 0,
  eraseCdMul: 1, dmgMul: 1, armorDmgMul: 1, shieldMulOverride: null,
});

const validPerk = id => typeof id === 'string' && Object.hasOwn(CONFIG.perks, id);

export function perkMods(p) {
  if (!p?.perks?.length) return DEFAULT_MODS;
  const mods = { ...DEFAULT_MODS };
  for (const id of new Set(p.perks)) {
    if (!validPerk(id)) continue;
    for (const [key, value] of Object.entries(CONFIG.perks[id].mods)) {
      if (key === 'shieldMulOverride') mods[key] = value;
      else if (key.endsWith('Mul')) mods[key] *= value;
      else mods[key] += value;
    }
  }
  return Object.freeze(mods);
}

// Hash each candidate independently so offers never advance the simulation RNG.
function choiceHash(seed, anchorIdx, id) {
  const text = `${seed}:${anchorIdx}:${id}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function rollPerkChoices(seed, anchorIdx, ownedPerks = []) {
  const owned = new Set(ownedPerks);
  return Object.keys(CONFIG.perks)
    .filter(id => !owned.has(id))
    .map((id, index) => ({ id, index, hash: choiceHash(seed, anchorIdx, id) }))
    .sort((a, b) => a.hash - b.hash || a.index - b.index)
    .slice(0, 3)
    .map(choice => choice.id);
}

export function applyPerk(match, playerId, perkId) {
  const p = match.players.find(player => player.id === playerId);
  if (!p) return { ok: false, reason: 'noPlayer' };
  if (p.st !== 0) return { ok: false, reason: 'dead' };
  if (!validPerk(perkId)) return { ok: false, reason: 'invalidPerk' };
  if (p.perks?.includes(perkId)) return { ok: false, reason: 'owned' };
  if (!p.perks) p.perks = [];
  p.perks.push(perkId);
  match.events.push({ type: 'perkPick', data: { playerId, perkId, name: CONFIG.perks[perkId].name } });
  return { ok: true, perkId };
}
