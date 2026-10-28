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
  // The dev tools indicator ("N" in the corner) is a Next.js development
  // aid. It shows up in the storefront during review and looks like a
  // leftover from a template, so it is turned off. It only ever appears
  // in `next dev` anyway - a production build has no indicator at all.
  devIndicators: false,
  env: {
    // The storefront talks to the API over HTTP. On the host that is the
    // published port from .env; inside compose the web container uses
    // http://api:3001, which docker-compose.yml sets explicitly.
    API_BASE_URL: process.env.API_BASE_URL ?? 'http://localhost:3101',
  },
};

export default nextConfig;
