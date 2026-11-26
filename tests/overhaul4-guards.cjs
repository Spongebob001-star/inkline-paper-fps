// OVERHAUL-4 保护核验：src/models、src/audio、原型、既有 N5-Open 归档（含 OVERHAUL-3B）。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'snapshot';
const OUT = path.join(ROOT, 'N5-Open', 'reports', 'OVERHAUL-4-baseline.json');
const GUARD = path.join(ROOT, 'N5-Open', 'reports', 'OVERHAUL-4-guards.json');
const roots = ['src/models', 'src/audio', 'N5-Open', 'reference', '_original', 'docs'];
const extras = ['墨线突围.html', 'HANDOFF-SHARED.md', 'HANDOFF-MAIN.md'];
const allowNew = new Set([
  'N5-Open/reports/OVERHAUL-4-baseline.json',
  'N5-Open/reports/OVERHAUL-4-guards.json',
]);
const allowPrefix = ['N5-Open/reports/OVERHAUL-4-', 'N5-Open/renders/OVERHAUL-4-'];
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
}
let files = [...extras];
for (const r of roots) if (fs.existsSync(path.join(ROOT, r))) walk(r, files);
files = [...new Set(files)].sort();
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
  const result = { generated: new Date().toISOString(), baselineCount: base.count, currentCount: files.length,
    protectedChanged: changed, protectedMissing: missing, unexpectedAdded: added };
  fs.writeFileSync(GUARD, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ baselineCount: base.count, currentCount: files.length, changed: changed.length, missing: missing.length, added: added.length }));
  if (changed.length || missing.length || added.length) { console.error(changed.concat(missing, added).join('\n')); process.exit(1); }
}
