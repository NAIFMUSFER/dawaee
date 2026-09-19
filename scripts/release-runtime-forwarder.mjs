// Child process for the owned CI fixture. Keeping forwarding outside the
// controller lets synchronous psql/pg_dump children use it without deadlock.
import assert from 'node:assert/strict';
import { createConnection, createServer, isIP } from 'node:net';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DAWAEE_RUNTIME_FORWARDER, 'owned-ci-fixture');
assert.equal(typeof process.send, 'function', 'forwarder requires its parent IPC channel');
const [target, rawTargetPort, rawLocalPort] = process.argv.slice(2);
assert.equal(isIP(target), 4);
const [a, b] = target.split('.').map(Number);
assert.ok(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168),
  'only an owned private Docker address may be forwarded');
const targetPort = Number(rawTargetPort);
const localPort = Number(rawLocalPort);
assert.ok(Number.isInteger(targetPort) && targetPort > 0 && targetPort <= 65535);
assert.ok(Number.isInteger(localPort) && localPort >= 0 && localPort <= 65535);
const sockets = new Set();
const server = createServer(downstream => {
  const upstream = createConnection({ host: target, port: targetPort });
  sockets.add(downstream); sockets.add(upstream);
  downstream.on('error', () => upstream.destroy());
  upstream.on('error', () => downstream.destroy());
  downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
  upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  downstream.pipe(upstream).pipe(downstream);
});
server.on('error', error => { console.error(error.code ?? 'forwarder failed'); process.exitCode = 1; });
server.listen({ host: '127.0.0.1', port: localPort }, () => {
  process.send({ host: '127.0.0.1', port: server.address().port });
});
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
