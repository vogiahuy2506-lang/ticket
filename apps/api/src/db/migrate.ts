import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql } from './client.js';
import { fixLegacyAccountNames, fixLegacyUserNames } from './legacy-text.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locates `schema.sql`.
 *
 * When the API runs from the sources (`tsx src/db/init.ts`) the file sits
 * next to this module. When it runs from the compiled output
 * (`node dist/db/init.js`) TypeScript did not copy the .sql file, so we
 * fall back to the source directory. Without the fallback the compiled
 * build cannot migrate a fresh database at all.
 */
function findSchema(): string {
  const candidates = [
    join(here, 'schema.sql'),
    join(here, '..', '..', 'src', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `schema.sql not found - looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

export async function migrate(): Promise<void> {
  const sql = getSql();
  // gen_random_uuid() needs pgcrypto on Postgres < 13; built-in from 13+.
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  const schema = readFileSync(findSchema(), 'utf8');
  await sql.unsafe(schema);
  // Reference data that an older version wrote without Vietnamese diacritics.
  // The journal itself is append-only, but the names of the seeded users
  // and the account labels are not, so they are refreshed here.
  const renamed = await fixLegacyUserNames(sql);
  if (renamed > 0) {
    console.log(`[migrate] renamed ${renamed} legacy user(s) to accented names`);
  }
  const relabelled = await fixLegacyAccountNames(sql);
  if (relabelled > 0) {
    console.log(`[migrate] relabelled ${relabelled} legacy account(s)`);
  }
  console.log('[migrate] schema applied');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed', err);
      process.exit(1);
    });
}
