import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Loads the environment for a monorepo workspace.
 *
 * `npm run dev -w @tce/api` runs with cwd = apps/api, so a bare
 * `import 'dotenv/config'` looks for apps/api/.env and finds nothing. The
 * real .env lives at the repo root, so we point dotenv at it explicitly.
 *
 * dotenv never overrides variables that are already set, so real env vars
 * (docker-compose, CI, `PORT=... npm run dev`) always win over the file.
 */
const here = dirname(fileURLToPath(import.meta.url));

// apps/api/src -> apps/api -> apps -> <repo root>
const repoRoot = resolve(here, '..', '..', '..');

const candidates = [
  join(repoRoot, '.env.local'),
  join(repoRoot, '.env'),
  resolve(here, '..', '.env'),
];

for (const file of candidates) {
  if (existsSync(file)) {
    dotenv.config({ path: file });
  }
}
