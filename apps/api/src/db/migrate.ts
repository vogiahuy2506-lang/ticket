import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSql } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sql = getSql();
  // gen_random_uuid() needs pgcrypto on Postgres < 13; built-in from 13+.
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  await sql.unsafe(schema);
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
