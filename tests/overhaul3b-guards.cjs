// OVERHAUL-3B 保护核验：shared/host/models/boss_laugh/原型/既有 N5-Open 归档。
// 授权删除 client/voice.mjs、src/audio/voice_pack.mp3、tools/build_voice_pack.py，其余不得变动。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'snapshot';
const OUT = path.join(ROOT, 'N5-Open', 'reports', 'OVERHAUL-3B-baseline.json');
const GUARD = path.join(ROOT, 'N5-Open', 'reports', 'OVERHAUL-3B-guards.json');
const roots = ['shared', 'host', 'src/models', 'src/audio', 'N5-Open', 'reference', '_original', 'docs'];
const extras = ['墨线突围.html', 'HANDOFF-SHARED.md', 'HANDOFF-MAIN.md'];
const allowedGone = new Set(['src/audio/voice_pack.mp3']);
const allowNew = new Set([
  'N5-Open/reports/OVERHAUL-3B-baseline.json',
  'N5-Open/reports/OVERHAUL-3B-guards.json',
  'N5-Open/reports/OVERHAUL-3B-voice-removal.json',
]);
const allowPrefix = ['N5-Open/reports/OVERHAUL-3B-', 'N5-Open/renders/OVERHAUL-3B-'];
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
}
let files = [...extras];
for (const r of roots) if (fs.existsSync(path.join(ROOT, r))) walk(r, files);
files = [...new Set(files)].filter(f => !allowedGone.has(f)).sort();
if (mode === 'snapshot') {
  const out = { generated: new Date().toISOString(), count: files.length, files: {} };
  for (const f of files) out.files[f] = hash(f);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('baseline files:', out.count);
} else {
  const base = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const current = {}, changed = [], missing = [], added = [];
  for (const f of files) current[f] = hash(f);
  for (const [f, h] of Object.entries(base.files)) {
    if (!(f in current)) missing.push(f);
    else if (current[f] !== h) changed.push(f);
  }
  const allowed = f => allowNew.has(f) || allowPrefix.some(p => f.startsWith(p));
  for (const f of files) if (!(f in base.files) && !allowed(f)) added.push(f);
  const gone = [...allowedGone].filter(f => fs.existsSync(path.join(ROOT, f)));
  const result = { generated: new Date().toISOString(), baselineCount: base.count, currentCount: files.length,
    protectedChanged: changed, protectedMissing: missing, unexpectedAdded: added, authorizedFilesStillPresent: gone };
  fs.writeFileSync(GUARD, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ baselineCount: base.count, currentCount: files.length, changed: changed.length, missing: missing.length, added: added.length, authorizedStillPresent: gone }));
  if (changed.length || missing.length || added.length || gone.length) { console.error(changed.concat(missing, added, gone).join('\n')); process.exit(1); }
}
