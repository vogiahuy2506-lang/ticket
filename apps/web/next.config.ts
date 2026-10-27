import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { NextConfig } from 'next';

/**
 * Loads the environment for the storefront.
 *
 * `npm run dev -w @tce/web` runs with cwd = apps/web, so Next.js only picks
 * up apps/web/.env* and misses the root .env where the API URL lives. We
 * point dotenv at the repo root explicitly.
 *
 * Precedence matches Next.js: .env.local > .env, and real environment
 * variables always win over both (dotenv never overrides an existing value).
 *
 * This lives inline (not in a separate module) because Next.js compiles
 * next.config.ts to CommonJS, where a `require('./env')` of a .ts file fails.
 */
const here = dirname(fileURLToPath(import.meta.url));

// apps/web -> <repo root>
const repoRoot = resolve(here, '..', '..');

const envFiles = [
  join(repoRoot, '.env.local'),
  join(repoRoot, '.env'),
  resolve(here, '.env.local'),
  resolve(here, '.env'),
];

for (const file of envFiles) {
  if (existsSync(file)) {
    dotenv.config({ path: file });
  }
}

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    API_BASE_URL: process.env.API_BASE_URL ?? 'http://localhost:3111',
  },
};

export default nextConfig;
