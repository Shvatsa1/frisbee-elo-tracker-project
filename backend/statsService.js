/**
 * statsService — v2 cache refresh.
 *
 * In v1 this cached win%/streak/last_elo_change keyed on the old
 * `players.player_id`. v2 keys everything on the new `player.player_id`
 * (per-context) and reads from `match_player` joined to `match`.
 *
 * The spec marks this as "non-load-bearing, update only what breaks":
 * we keep the same cache table shape but repoint reads. The cache is
 * still useful for the public leaderboard.
 *
 * Per SPEC_15: only **confirmed** matches feed Elo/results — so we filter
 * on `match.status = 'confirmed'` when computing trend/streak.
 */
import { pool } from './db.js';

// Idempotent: ensure the cache table exists at the v2 shape.
const ensureCacheSql = `
CREATE TABLE IF NOT EXISTS player_statistics_cache (
  player_id        INTEGER PRIMARY KEY REFERENCES player(player_id) ON DELETE CASCADE,
  total_games      INTEGER NOT NULL DEFAULT 0,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  win_percentage   FLOAT   NOT NULL DEFAULT 0,
  streak           INTEGER NOT NULL DEFAULT 0,
  last_elo_change  FLOAT   NOT NULL DEFAULT 0,
  current_elo      FLOAT   NOT NULL DEFAULT 1000,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export async function ensurePlayerStatsCacheTable(client = pool) {
  await client.query(ensureCacheSql);
}

/**
 * Recompute (and upsert) the cache row for one or all players within
 * the optional context filter. Pass nothing to refresh every player.
 *
 * Signature kept compatible with v1's `updatePlayerStatsCache(playerId)`.
 */
export async function updatePlayerStatsCache(playerId = null, { context_id = null } = {}) {
  const client = await pool.connect();
  try {
    await ensurePlayerStatsCacheTable(client);

    const params = [];
    const where = ['1=1'];
    if (playerId) { params.push(playerId); where.push(`p.player_id = $${params.length}`); }
    if (context_id) { params.push(context_id); where.push(`p.context_id = $${params.length}`); }

    const players = (await client.query(
      `SELECT p.player_id FROM player p WHERE ${where.join(' AND ')}`,
      params,
    )).rows;

    for (const { player_id } of players) {
      const history = (await client.query(
        `
        SELECT mp.elo_after, mp.elo_change, mp.team, m.winning_team, m.match_date, m.created_at
          FROM match_player mp
          JOIN match m ON mp.match_id = m.match_id
         WHERE mp.player_id = $1
           AND m.status = 'confirmed'
         ORDER BY m.match_date ASC, m.created_at ASC
        `,
        [player_id],
      )).rows;

      const total = history.length;
      let wins = 0, losses = 0, streak = 0, lastEloChange = 0, currentElo = 1000;
      if (total > 0) {
        for (const h of history) {
          const won = h.team === h.winning_team;
          if (won) wins++; else losses++;
        }
        lastEloChange = history[total - 1].elo_change ?? 0;
        currentElo    = history[total - 1].elo_after  ?? 1000;
        // streak: walk backward
        for (let i = total - 1; i >= 0; i--) {
          const h = history[i];
          const won = h.team === h.winning_team;
          if (won && streak >= 0) streak++;
          else if (!won && streak <= 0) streak--;
          else break;
        }
      }

      const winPct = total > 0 ? (wins / total) * 100 : 0;

      await client.query(`
        INSERT INTO player_statistics_cache
          (player_id, total_games, wins, losses, win_percentage, streak,
           last_elo_change, current_elo, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        ON CONFLICT (player_id) DO UPDATE SET
          total_games     = EXCLUDED.total_games,
          wins            = EXCLUDED.wins,
          losses          = EXCLUDED.losses,
          win_percentage  = EXCLUDED.win_percentage,
          streak          = EXCLUDED.streak,
          last_elo_change = EXCLUDED.last_elo_change,
          current_elo     = EXCLUDED.current_elo,
          updated_at      = CURRENT_TIMESTAMP
      `, [player_id, total, wins, losses, winPct, streak, lastEloChange, currentElo]);
    }
  } catch (err) {
    console.error('[statsService] cache refresh failed:', err);
  } finally {
    client.release();
  }
}
