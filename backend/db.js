/**
 * Shared pg Pool, lazily constructed on first access.
 *
 * In v1 the pool was eagerly created at module-load. In v2 we keep it
 * lazy so tests can boot embedded-postgres and set `DATABASE_URL`
 * *after* importing modules that ultimately reach for `pool`. Production
 * behaviour is unchanged: the first request triggers pool creation, the
 * env var is already set from `.env` / docker-compose at that point.
 */
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let _pool = null;

function makePool() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  p.on('error', (err) => {
    console.error('[db] unexpected error on idle client', err);
  });
  return p;
}

// Proxy that defers construction until any property of the pool is touched.
export const pool = new Proxy({}, {
  get(_target, prop) {
    if (!_pool) _pool = makePool();
    const value = _pool[prop];
    return typeof value === 'function' ? value.bind(_pool) : value;
  },
});

// Test-only: drop the pool so the next call rebuilds against a new
// DATABASE_URL. Used between sanity-test runs.
export function _resetPoolForTests() {
  if (_pool) {
    const old = _pool;
    _pool = null;
    return old.end();
  }
  return Promise.resolve();
}
