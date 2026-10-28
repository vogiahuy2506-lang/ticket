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
 *   E2E_KEEP_SCHEMA  set to 1 to keep the private schema (so a later step
 *                  can audit the journal this run wrote). The name of the
 *                  schema is written to E2E_SCHEMA_FILE.
 */

import { writeFileSync } from 'node:fs';
import { buildServer } from '../src/server.js';
import { getSql } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import {
  createIsolatedDb,
  deleteE2eRows,
  useIsolatedDb,
  type IsolatedDb,
} from '../src/db/isolated.js';

/**
 * Creates a throwaway event with one listing, so the assertions never depend
 * on what the seed data happens to look like.
 */
async function provisionFixture(): Promise<{ eventId: string; listingId: string }> {
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

  const listings = await sql<{ id: string }[]>`
    INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
    VALUES (${events[0]!.id}, ${sellers[0].id}, 'E2E listing', 100, 1200000)
    RETURNING id
  `;

  console.log('[e2e] fixture provisioned');
  return { eventId: events[0]!.id, listingId: listings[0]!.id };
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
    // The run wrote into the real database, so the rows it created are
    // removed again. The demo data (the seeded events) is untouched.
    const removed = await deleteE2eRows(getSql());
    console.log(`[e2e] cleaned up ${removed} row(s) of test data`);
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

  // The run happens in a private schema, so it never touches the
  // developer's database. Without this the e2e run would leave a trail of
  // "E2E event ..." rows in the demo data, and the storefront would fill
  // up with events nobody booked.
  let isolated: IsolatedDb | null = null;
  const keepSchema = process.env.E2E_KEEP_SCHEMA === '1';
  try {
    isolated = await createIsolatedDb('e2e');
    useIsolatedDb(isolated.sql);

    // A fresh clone has no schema and no seed users yet, so the runner
    // brings the database up to date itself. Both steps are idempotent.
    await migrate();
    await seed();

    const fixture = await provisionFixture();
    const app = await buildServer();

    try {
      await app.listen({ port, host: '127.0.0.1' });
      await waitForServer(base);
      console.log(`[e2e] API is up on ${base}`);

      const { runAssertions, setApiBase, setFixture } = await import('./e2e.js');
      setApiBase(base);
      setFixture(fixture);
      await runAssertions();
      console.log('\n[e2e] done.');
    } finally {
      await app.close();
    }
  } finally {
    if (isolated && keepSchema) {
      // The schema is kept so that a later step can audit the journal this
      // run produced - the ledger audit has to look at the very rows the
      // money flow wrote, not at an empty database. It is named in the
      // output and can be dropped with:
      //   DROP SCHEMA "<name>" CASCADE;
      console.log(`[e2e] kept the private schema ${isolated.schema} for auditing`);

      // The name is written to a file so that the next step does not have
      // to guess it (the schema name is random).
      const schemaFile = process.env.E2E_SCHEMA_FILE;
      if (schemaFile) {
        writeFileSync(schemaFile, isolated.schema, 'utf8');
        console.log(`[e2e] schema name written to ${schemaFile}`);
      }

      // The connection is closed, but the schema itself stays.
      await isolated.sql.end();
      isolated = null;
    } else {
      await isolated?.drop();
    }
  }
}

main().catch((err) => {
  console.error('\nE2E failed:', err);
  process.exit(1);
});
