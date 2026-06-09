/**
 * Persistent LOCAL Postgres for v2 development — never the live VM.
 *
 * Uses the same embedded-postgres binary the tests use, but with a stable data
 * dir (backend/.localdb) so data survives across runs. Two ways to use it:
 *
 *   import { startLocalDb, stopLocalDb, LOCALDB_URL } from './local_db.js';
 *     — programmatic (seed_local.js calls these).
 *
 *   node scripts/local_db.js
 *     — CLI: boots PG and KEEPS IT RUNNING (Ctrl-C to stop). Run the API in a
 *       second terminal with DATABASE_URL=<printed url> npm start.
 *
 * Port 55433 (tests use 55432) so a test run and a dev DB can coexist.
 */
import EmbeddedPostgres from 'embedded-postgres';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, '..', '.localdb');
export const PORT = 55433;
export const USER = 'postgres';
export const PASSWORD = 'localpw';
export const DB_NAME = 'frisbee_elo';
export const LOCALDB_URL = `postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`;

let pg_instance = null;

function alreadyInitialised() {
  return fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
}

export async function startLocalDb() {
  if (pg_instance) return { connectionString: LOCALDB_URL };
  const fresh = !alreadyInitialised();

  pg_instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onLog: () => {},
    onError: (e) => console.error('[localdb]', e),
  });

  if (fresh) await pg_instance.initialise();
  await pg_instance.start();
  if (fresh) {
    await pg_instance.createDatabase(DB_NAME);
  }

  process.env.DATABASE_URL = LOCALDB_URL;
  return { connectionString: LOCALDB_URL };
}

export async function stopLocalDb() {
  if (pg_instance) {
    await pg_instance.stop();
    pg_instance = null;
  }
}

// CLI mode: boot and stay up until interrupted.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectInvocation) {
  startLocalDb().then(() => {
    console.log(`[localdb] up at ${LOCALDB_URL}`);
    console.log('[localdb] keeping Postgres running — Ctrl-C to stop.');
    console.log('[localdb] in another terminal:');
    console.log(`            $env:DATABASE_URL="${LOCALDB_URL}"; npm start`);
    const shutdown = async () => {
      console.log('\n[localdb] stopping...');
      await stopLocalDb();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(e => { console.error('[localdb] FAILED:', e); process.exit(1); });
}
