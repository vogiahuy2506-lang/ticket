import { migrate } from './migrate.js';
import { seed } from './seed.js';

async function main() {
  await migrate();
  await seed();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  });
