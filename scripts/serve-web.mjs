// Static server with SPA fallback for the exported Expo web build.
// The production host (Vercel/Cloudflare/nginx) does the same rewrite; this
// mirrors it so deep links can be exercised locally.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'apps/mobile/dist');
const port = Number(process.argv[3] ?? 8081);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let filePath = resolve(join(root, normalize(decodeURIComponent(url.pathname))));
  if (!filePath.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const indexed = join(filePath, 'index.html');
    filePath = existsSync(indexed) && statSync(filePath).isDirectory() ? indexed : join(root, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(filePath).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
