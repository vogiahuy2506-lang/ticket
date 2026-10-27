/**
 * Boots the API in-process and runs the end-to-end money-flow assertions
 * against it, in one command.
 *
 * Why: the reviewer should be able to clone the repo, point at a database and
 * run `npm run e2e` without juggling two terminals or a separately started
 * server. Booting the server in the same process also avoids any port
 * conflicts with an already-running dev stack.
 *
 * The runner also provisions its own fixture (a fresh event + listing) so
 * the assertions always run against a known state and can be repeated as
 * often as you like against the same database.
 *
 * Usage:
 *   npm run e2e -w @tce/api
 *
 * Environment:
 *   E2E_PORT      port for the temporary server (default 3199)
 *   E2E_EXTERNAL  set to 1 to use an already-running stack instead
 */

import { buildServer } from '../src/server.js';
import { getSql } from '../src/db/client.js';

/**
 * Creates a throwaway event with one listing, so the assertions never depend
 * on what the seed data happens to look like.
 */
async function provisionFixture(): Promise<void> {
  const sql = getSql();

  const sellers = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE role = 'seller' ORDER BY created_at LIMIT 1
  `;
  if (!sellers[0]) {
    throw new Error('No seller user found - run `npm run db:init` first');
  }

  const events = await sql<{ id: string }[]>`
    INSERT INTO events (name, venue, starts_at)
    VALUES ('E2E event ' || now()::text, 'E2E venue', now() + interval '30 days')
    RETURNING id
  `;

  await sql`
    INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
    VALUES (${events[0]!.id}, ${sellers[0].id}, 'E2E listing', 100, 1200000)
  `;

  console.log('[e2e] fixture provisioned');
}

async function waitForServer(base: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${base}/api/users`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`API did not start within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  if (process.env.E2E_EXTERNAL === '1') {
    const base = process.env.API_BASE_URL ?? 'http://localhost:3001';
    console.log(`[e2e] using the running stack at ${base}`);
    const { runAssertions } = await import('./e2e.js');
    await runAssertions();
    console.log('\n[e2e] done.');
    return;
  }

  const port = Number(process.env.E2E_PORT ?? 3199);
  const base = `http://localhost:${port}`;

  // The server reads its configuration from the environment, so the port and
  // the public URL have to be in place before it is built.
  process.env.PORT = String(port);
  process.env.PUBLIC_BASE_URL = base;
  process.env.WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
  process.env.MOCK_GATEWAY = process.env.MOCK_GATEWAY ?? 'true';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

  await provisionFixture();

  const app = await buildServer();

  try {
    await app.listen({ port, host: '127.0.0.1' });
    await waitForServer(base);
    console.log(`[e2e] API is up on ${base}`);

    const { runAssertions, setApiBase } = await import('./e2e.js');
    setApiBase(base);
    await runAssertions();
    console.log('\n[e2e] done.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('\nE2E failed:', err);
  process.exit(1);
});
