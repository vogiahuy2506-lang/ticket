/**
 * Drops a private schema.
 *
 * The e2e runner can be told to keep its private schema so that a later
 * step can audit the journal it wrote. This script removes it afterwards,
 * so a CI run leaves no trace in the database.
 *
 * The schema name is validated against a strict pattern before it is
 * interpolated into the statement - it comes from a file, so it is not
 * trusted.
 *
 * Usage:
 *   npx tsx apps/api/scripts/drop-schema.ts <schema>
 *   npx tsx apps/api/scripts/drop-schema.ts --file <path>
 */

import { existsSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { loadConfig } from '../src/config.js';

function readSchemaName(): string | undefined {
  const fileIndex = process.argv.indexOf('--file');
  if (fileIndex !== -1) {
    const file = process.argv[fileIndex + 1];
    if (!file || !existsSync(file)) return undefined;
    const name = readFileSync(file, 'utf8').trim();
    return name || undefined;
  }

  const positional = process.argv[2];
  return positional && !positional.startsWith('--') ? positional : undefined;
}

async function main(): Promise<void> {
  const schema = readSchemaName();
  if (!schema) {
    console.log('[drop-schema] no schema given - nothing to do');
    return;
  }

  if (!/^[a-z0-9_]+$/i.test(schema)) {
    throw new Error(`Refusing to drop an unsafe schema name: ${schema}`);
  }

  const sql = postgres(loadConfig().databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    console.log(`[drop-schema] dropped the schema ${schema}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[drop-schema] failed:', err);
  process.exit(1);
});
