// 验收截图保存服务（仅开发用）：接收页内 canvas.toDataURL 的 POST，落盘 PNG。
// node dev/save-shot.mjs [port]
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'N5-Open', 'renders', process.argv[3] || 'M5-cells');
mkdirSync(outDir, { recursive: true });
const port = Number(process.argv[2]) || 8124;

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const { name, dataURL } = JSON.parse(body);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('bad name');
      const b64 = dataURL.slice(dataURL.indexOf(',') + 1);
      const file = join(outDir, name.endsWith('.png') ? name : name + '.png');
      writeFileSync(file, Buffer.from(b64, 'base64'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file, bytes: Buffer.byteLength(b64, 'base64') }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: String(e && e.message || e) }));
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`save-shot: http://127.0.0.1:${port}/ → ${outDir}`));