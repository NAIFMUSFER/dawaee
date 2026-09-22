// Static server with SPA fallback for the exported Expo web build.
// The production host (Vercel/Cloudflare/nginx) does the same rewrite; this
// mirrors it so deep links can be exercised locally.
import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = realpathSync(resolve(process.argv[2] ?? 'apps/mobile/dist'));
const port = Number(process.argv[3] ?? 8081);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};

function contained(filePath) {
  const part = relative(root, filePath);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname.includes('\0')) throw new Error('invalid path');
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  let filePath = resolve(root, `.${pathname}`);
  if (!contained(filePath)) { res.writeHead(403).end('forbidden'); return; }
  try {
    if (existsSync(filePath)) {
      filePath = realpathSync(filePath);
      if (!contained(filePath)) { res.writeHead(403).end('forbidden'); return; }
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      const indexed = join(filePath, 'index.html');
      filePath = existsSync(indexed) ? indexed : join(root, 'index.html');
    }
    filePath = realpathSync(filePath);
    if (!contained(filePath)) { res.writeHead(403).end('forbidden'); return; }
    if (!statSync(filePath).isFile()) { res.writeHead(404).end('not found'); return; }
    const stream = createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(404).end('not found');
      else res.destroy();
    });
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      stream.pipe(res);
    });
    res.once('close', () => stream.destroy());
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
