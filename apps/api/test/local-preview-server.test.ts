import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'tadawee-static-'));
  const root = join(directory, 'dist');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'index.html'), 'SYNTHETIC SPA');
  await writeFile(join(root, 'asset.js'), 'SYNTHETIC ASSET');
  await writeFile(join(root, 'nested/index.html'), 'SYNTHETIC NESTED');
  await writeFile(join(directory, 'outside.txt'), 'SYNTHETIC OUTSIDE');
  await symlink(join(directory, 'outside.txt'), join(root, 'escape.txt'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child: ChildProcess = spawn(process.execPath, [resolve('scripts/serve-web.mjs'), root, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
  });
  const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('request timed out'))); req.end();
  });
  return { get, root, async close() {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await rm(directory, { recursive: true, force: true });
  } };
}

describe('local exported-web server boundaries', () => {
  it('rejects malformed encodings without terminating subsequent requests', async () => {
    const ctx = await setup();
    try {
      for (const path of ['/%E0%A4%A', '/%00']) expect((await ctx.get(path)).status).toBe(400);
      expect(await ctx.get('/asset.js')).toEqual({ status: 200, body: 'SYNTHETIC ASSET' });
    } finally { await ctx.close(); }
  });
  it('refuses a symlink to a file outside the export root', async () => {
    const ctx = await setup();
    try { const response = await ctx.get('/escape.txt'); expect(response.status).toBe(403); expect(response.body).not.toContain('SYNTHETIC OUTSIDE'); }
    finally { await ctx.close(); }
  });
  it('serves nested indexes and SPA routes, and survives a missing fallback', async () => {
    const ctx = await setup();
    try {
      expect(await ctx.get('/nested/')).toEqual({ status: 200, body: 'SYNTHETIC NESTED' });
      expect(await ctx.get('/medication/detail')).toEqual({ status: 200, body: 'SYNTHETIC SPA' });
      await rm(join(ctx.root, 'index.html'));
      expect((await ctx.get('/missing')).status).toBe(404);
      expect((await ctx.get('/asset.js')).status).toBe(200);
    } finally { await ctx.close(); }
  });
});
