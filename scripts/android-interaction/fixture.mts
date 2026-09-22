/** Disposable CI only. No HTTP provisioning endpoint and no remote database. */
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.DAWAEE_DEVICE_CI !== '1'
  || process.env.DATABASE_URL !== 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test'
  || process.env.EXPO_PUBLIC_API_URL !== 'http://127.0.0.1:8080') {
  throw new Error('Refusing fixture outside disposable device CI');
}
await import('../../vitest.setup.js');
if (process.argv[2] === 'server') {
  const { buildServer } = await import('../../apps/api/src/server.js');
  const { app } = await buildServer();
  await app.listen({ host: '127.0.0.1', port: 8080 });
} else if (process.argv[2] === 'seed') {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw) as { email: string; password: string; displayName: string };
  if (!/^native-(?:dose-)?[a-f0-9]{32}@example\.invalid$/.test(input.email)) throw new Error('Invalid synthetic identity');
  const { hashPassword } = await import('../../apps/api/src/lib/password.js');
  const { withTransaction, closePool } = await import('../../apps/api/src/lib/db.js');
  const { default: pg } = await import('pg');
  const hash = await hashPassword(input.password);
  const created = await withTransaction(tx => tx.query<{ user_id: string }>(
    'SELECT * FROM app.register_email_account($1,$2,$3,$4,$5)',
    [null, input.email, input.displayName, hash, 'ar'],
  ));
  const owner = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5433/dawaee_test' });
  try {
    await owner.query('INSERT INTO user_email_verifications(user_id,email) VALUES($1,$2)',
      [created.rows[0]!.user_id, input.email]);
  } finally { await owner.end(); await closePool(); }
} else throw new Error('Unknown fixture operation');

export {};
