import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import cors from '@fastify/cors';
import { getSql } from './db/client.js';
import { loadConfig } from './config.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(formbody);

  // Some endpoints (e.g. "complete event", "recheck") are POSTs without a
  // body. Fastify rejects an empty body when the content-type is JSON, so we
  // treat an empty payload as `{}`.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (typeof body === 'string' && body.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, {});
      }
    },
  );

  const sql = getSql();
  app.decorate('sql', sql);
  app.decorate('config', config);

  app.get('/health', async () => {
    const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
    return {
      status: 'ok',
      db: rows[0]?.ok === 1,
      provider: config.mockGateway ? 'mock' : 'vnpay',
    };
  });

  await registerRoutes(app);

  return app;
}
