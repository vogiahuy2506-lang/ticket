import { buildServer } from './server.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = await buildServer();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    {
      provider: config.mockGateway ? 'mock' : 'vnpay',
      publicBaseUrl: config.publicBaseUrl,
    },
    'api started',
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
