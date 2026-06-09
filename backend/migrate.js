/**
 * UltiElo v2 idempotent migration.
 *
 * In v1 this file applied additive ALTER TABLEs to a long-lived schema.
 * v2 is a rewrite; this script simply calls the same v2-schema and v2-seed
 * SQL as `initDb.js` (everything is `CREATE TABLE IF NOT EXISTS` /
 * `ON CONFLICT DO NOTHING`), so it's safe to run repeatedly on an
 * already-migrated database without changing data.
 *
 * Additive guards for any future v2.x columns/tables go below the
 * core-schema apply step.
 */
import { pool } from './db.js';
import { applyV2Schema, applyV2Seed } from './initDb.js';

async function migrate() {
  console.log('[migrate] connecting...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('[migrate] applying v2 schema (idempotent)...');
    await applyV2Schema(client);

    console.log('[migrate] applying v2 seed (idempotent)...');
    await applyV2Seed(client);

    // ----- Additive v2.x guards (add new columns/tables below) -----
    // Example pattern (left commented for future use):
    //
    //   const cols = (await client.query(`
    //     SELECT column_name FROM information_schema.columns
    //     WHERE table_name='player_skill'
    //   `)).rows.map(r => r.column_name);
    //   if (!cols.includes('confidence')) {
    //     await client.query(`ALTER TABLE player_skill ADD COLUMN confidence FLOAT`);
    //   }

    await client.query('COMMIT');
    console.log('[migrate] done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
