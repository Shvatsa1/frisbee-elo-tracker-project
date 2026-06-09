/**
 * Port v1 players into the v2 schema.
 *
 * v1 had a single flat `players` table:
 *     player_id, player_name, current_elo, total_games, wins, losses
 *
 * v2 splits identity from per-context participation:
 *     person  (the human)
 *       └─ player (person within a context)  ── UNIQUE(person_id, context_id)
 *            ├─ player_statistics_cache   (carries the v1 Elo + W/L history)
 *            └─ player_skill              (offence/defence — LEFT EMPTY here;
 *                                          the Wednesday admin rating fills it)
 *
 * Source data is the read-only CSV pulled from the live VM:
 *     migrations/v1_data/v1_players_<stamp>.csv
 * (never pulled live again — re-run from the CSV, which is append-only ref data)
 *
 * Usage (run from backend/, with DATABASE_URL pointing at your LOCAL pg):
 *     node migrations/port_v1_players.js --csv migrations/v1_data/v1_players_XXXX.csv
 *
 * Flags:
 *     --csv <path>       (required) the v1 players CSV
 *     --context "<name>" target context name   (default: "Wednesday Minis")
 *     --include-test     also import the 8 v1 demo rows (Alice..Heidi).
 *                        Default: those are skipped as obvious seed data.
 *     --dry-run          print what would happen; write nothing.
 *
 * Idempotent: a person is matched by exact name; if that person already has a
 * player row in the target context, the row is updated (stats refreshed), not
 * duplicated. Safe to re-run.
 *
 * Constraint envelope: 52 rows. Trivially fits in RAM; single short
 * transaction; no chunking / resume needed (completes in well under a second).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { applyV2Schema, applyV2Seed } from '../initDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The 8 v1 demo/seed rows — generic placeholder names, not real players.
export const TEST_NAMES = new Set(['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Heidi']);

function parseArgs(argv) {
  const args = { csv: null, context: 'Wednesday Minis', includeTest: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') args.csv = argv[++i];
    else if (a === '--context') args.context = argv[++i];
    else if (a === '--include-test') args.includeTest = true;
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.csv) throw new Error('--csv <path> is required');
  return args;
}

// Minimal CSV reader — the source has no quoted fields with embedded commas
// (names are plain), so a split on the first 6 columns is safe. We still guard
// against a name containing a comma by re-joining the middle columns.
export function readPlayersCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = lines.shift().split(',').map(h => h.trim());
  const expected = ['player_id', 'player_name', 'current_elo', 'total_games', 'wins', 'losses'];
  if (header.join(',') !== expected.join(',')) {
    throw new Error(`unexpected CSV header: ${header.join(',')}`);
  }
  return lines.map(line => {
    const cols = line.split(',');
    // first col = id, last four = numbers; everything between = name.
    const player_id = Number(cols[0]);
    const losses = Number(cols[cols.length - 1]);
    const wins = Number(cols[cols.length - 2]);
    const total_games = Number(cols[cols.length - 3]);
    const current_elo = Number(cols[cols.length - 4]);
    const player_name = cols.slice(1, cols.length - 4).join(',').trim();
    return { player_id, player_name, current_elo, total_games, wins, losses };
  });
}

function winPct(wins, total) {
  return total > 0 ? (wins / total) * 100 : 0;
}

/** Split rows into {kept, skipped} by the test-name filter. */
export function splitRows(rows, includeTest) {
  const kept = rows.filter(r => includeTest || !TEST_NAMES.has(r.player_name));
  const skipped = rows.filter(r => !includeTest && TEST_NAMES.has(r.player_name));
  return { kept, skipped };
}

/**
 * Port the given rows into `contextName` using an open client. Ensures the v2
 * schema + seed exist. Returns {inserted, updated, contextId}. Idempotent:
 * matches person by exact name, upserts the per-context player + stats cache.
 * Caller owns the transaction boundary is NOT assumed — this opens its own.
 */
export async function portPlayers(client, kept, contextName) {
  await applyV2Schema(client);
  await applyV2Seed(client);

  const ctx = (await client.query(
    `SELECT context_id FROM context WHERE name = $1 ORDER BY context_id ASC LIMIT 1`,
    [contextName],
  )).rows[0];
  if (!ctx) throw new Error(`context "${contextName}" not found — run initDb/seed first`);
  const contextId = ctx.context_id;

  let inserted = 0, updated = 0;
  await client.query('BEGIN');
  try {
    for (const r of kept) {
      let person = (await client.query(
        `SELECT person_id FROM person WHERE name = $1 ORDER BY person_id ASC LIMIT 1`,
        [r.player_name],
      )).rows[0];
      if (!person) {
        person = (await client.query(
          `INSERT INTO person (name) VALUES ($1) RETURNING person_id`,
          [r.player_name],
        )).rows[0];
      }

      const existingPlayer = (await client.query(
        `SELECT player_id FROM player WHERE person_id = $1 AND context_id = $2`,
        [person.person_id, contextId],
      )).rows[0];
      let playerId;
      if (existingPlayer) {
        playerId = existingPlayer.player_id;
      } else {
        playerId = (await client.query(
          `INSERT INTO player (person_id, context_id) VALUES ($1, $2) RETURNING player_id`,
          [person.person_id, contextId],
        )).rows[0].player_id;
      }

      const before = (await client.query(
        `SELECT 1 FROM player_statistics_cache WHERE player_id = $1`, [playerId],
      )).rows[0];
      await client.query(
        `INSERT INTO player_statistics_cache
           (player_id, total_games, wins, losses, win_percentage, current_elo)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (player_id) DO UPDATE SET
           total_games = EXCLUDED.total_games,
           wins = EXCLUDED.wins,
           losses = EXCLUDED.losses,
           win_percentage = EXCLUDED.win_percentage,
           current_elo = EXCLUDED.current_elo,
           updated_at = CURRENT_TIMESTAMP`,
        [playerId, r.total_games, r.wins, r.losses, winPct(r.wins, r.total_games), r.current_elo],
      );

      if (existingPlayer && before) updated++; else inserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  return { inserted, updated, contextId };
}

async function main() {
  const args = parseArgs(process.argv);
  const csvPath = path.isAbsolute(args.csv) ? args.csv : path.join(process.cwd(), args.csv);
  const rows = readPlayersCsv(csvPath);

  const { kept, skipped } = splitRows(rows, args.includeTest);

  console.log(`[port] source: ${csvPath}`);
  console.log(`[port] ${rows.length} rows in CSV → ${kept.length} to import, ${skipped.length} skipped as demo data`);
  if (skipped.length) console.log(`[port] skipped (use --include-test to keep): ${skipped.map(r => r.player_name).join(', ')}`);
  if (args.dryRun) {
    console.log('[port] --dry-run: no writes. Would import:');
    kept.forEach(r => console.log(`         ${r.player_name}  elo=${r.current_elo}  ${r.wins}-${r.losses} (${r.total_games}g)`));
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    const { inserted, updated, contextId } = await portPlayers(client, kept, args.context);
    console.log(`[port] target context "${args.context}" → context_id=${contextId}`);
    console.log(`[port] done. ${inserted} new players, ${updated} updated. player_skill left empty for admin rating.`);
  } catch (err) {
    console.error('[port] FAILED, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// Only auto-run when executed directly (not when imported by tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectInvocation) {
  main().catch(e => { console.error(e); process.exit(1); });
}
