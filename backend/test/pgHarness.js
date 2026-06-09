/**
 * Embedded-Postgres harness for v2 sanity tests.
 *
 * Boots a real Postgres 18 instance (via @embedded-postgres/windows-x64) and
 * exposes a `pg` Pool on a fresh `frisbee_elo_test` database. Sets
 * `process.env.DATABASE_URL` so the regular `db.js` pool — when imported AFTER
 * harness start — points here.
 *
 * Windows-hardening (why each run is isolated):
 *   The serial runner (`run-all.js`) spawns each suite as its own child
 *   process. If every suite reused the same port + data dir, a previous
 *   postgres.exe that hadn't fully released its shared-memory block / data dir
 *   would make the next boot fail with "pre-existing shared memory block is
 *   still in use" or an EBUSY rmdir. So each harness instance picks a **free
 *   ephemeral port** and a **unique data dir** (`.pgdata-<pid>-<rand>`), and
 *   teardown removes it with retries. Stale dirs from crashed runs are swept on
 *   startup (safe because suites run serially, never in parallel).
 *
 * Lifecycle: tests call `startHarness()` once, then `await stopHarness()`.
 */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { rm } from 'fs/promises';
import { _resetPoolForTests } from '../db.js';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_PREFIX = '.pgdata';
const USER = 'postgres';
const PASSWORD = 'testpw';
const DB_NAME = 'frisbee_elo_test';

let pg_instance = null;
let pool = null;
let dataDir = null;   // the unique dir this instance created
let port = null;

// Find a free TCP port by binding to :0 and reading it back.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Remove a directory, retrying through the brief EBUSY window Windows leaves
// after a postgres.exe exits. Never throws — cleanup is best-effort.
async function rmRetry(dir, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (i === tries - 1) return;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

// Best-effort sweep of leftover .pgdata-* dirs from earlier crashed runs.
// Safe because suites run serially — no other harness dir is live right now.
async function sweepStale(keepDir) {
  let entries;
  try { entries = fs.readdirSync(__dirname); } catch { return; }
  await Promise.all(entries
    .filter(name => name.startsWith(`${DATA_PREFIX}-`) && path.join(__dirname, name) !== keepDir)
    .map(name => rmRetry(path.join(__dirname, name))));
}

export async function startHarness({ fresh = true } = {}) {
  if (pg_instance) {
    throw new Error('pgHarness already started');
  }

  port = await getFreePort();
  dataDir = path.join(__dirname, `${DATA_PREFIX}-${process.pid}-${Date.now()}`);
  await sweepStale(dataDir);
  if (fresh) await rmRetry(dataDir);

  pg_instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent: false,
    onLog: () => {},
    onError: (e) => console.error('[pg]', e),
  });

  await pg_instance.initialise();
  await pg_instance.start();

  await pg_instance.createDatabase(DB_NAME);

  const connectionString = `postgres://${USER}:${PASSWORD}@localhost:${port}/${DB_NAME}`;
  process.env.DATABASE_URL = connectionString;

  pool = new Pool({ connectionString });
  return { pool, connectionString };
}

export async function stopHarness() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  // Drain the shared db.js pool too, so embedded PG doesn't terminate
  // idle clients out from under it (which spews harmless ECONNRESETs).
  await _resetPoolForTests().catch(() => {});
  if (pg_instance) {
    await pg_instance.stop().catch(() => {});
    pg_instance = null;
  }
  if (dataDir) {
    await rmRetry(dataDir);
    dataDir = null;
  }
  port = null;
}

export function getPool() {
  if (!pool) throw new Error('pgHarness not started');
  return pool;
}
