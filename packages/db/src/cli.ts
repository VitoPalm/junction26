import { createPool } from './pool.ts';
import { migrate } from './migrate.ts';

const [command] = process.argv.slice(2);

if (command !== 'migrate') {
  console.error('usage: cli.ts migrate   (reads MIGRATION_DATABASE_URL or DATABASE_URL)');
  process.exit(2);
}

// Prefer a direct URL for migrations when the app URL goes through PgBouncer.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

const pool = createPool(url, { max: 1, applicationName: 'junction26-migrate' });
try {
  const result = await migrate(pool);
  console.log(JSON.stringify({ msg: 'migrations complete', ...result }));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
