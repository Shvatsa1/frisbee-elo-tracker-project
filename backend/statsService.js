import { pool } from './db.js';

/**
 * Recalculates and caches advanced statistics for a single player.
 * If no playerId is provided, it updates ALL players.
 */
export async function updatePlayerStatsCache(playerId = null) {
  const client = await pool.connect();
  try {
    let playerQuery = 'SELECT player_id FROM players';
    let queryParams = [];
    
    if (playerId) {
      playerQuery += ' WHERE player_id = $1';
      queryParams.push(playerId);
    }
    
    const playersResult = await client.query(playerQuery, queryParams);
    const players = playersResult.rows;

    for (const p of players) {
      const pid = p.player_id;
      
      // Get all matches for this player ordered by date
      const historyResult = await client.query(`
        SELECT mp.*, m.match_date, m.winning_team 
        FROM match_players mp
        JOIN matches m ON mp.match_id = m.match_id
        WHERE mp.player_id = $1
        ORDER BY m.match_date ASC, m.created_at ASC
      `, [pid]);
      
      const history = historyResult.rows;
      
      let streak = 0;
      let wins = 0;
      let total = history.length;
      let lastEloChange = 0;
      
      if (total > 0) {
        lastEloChange = history[total - 1].elo_change;
        // Calculate Streak (from most recent backward)
        for (let i = history.length - 1; i >= 0; i--) {
          const match = history[i];
          const won = match.team === match.winning_team;
          
          if (won && streak >= 0) {
            streak++;
          } else if (!won && streak <= 0) {
            streak--;
          } else {
            break;
          }
        }
        
        // Calculate Wins
        wins = history.filter(m => m.team === m.winning_team).length;
      }
      
      const winPercentage = total > 0 ? (wins / total) * 100 : 0;
      
      // Upsert into cache
      await client.query(`
        INSERT INTO player_statistics_cache (player_id, win_percentage, streak, last_elo_change, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (player_id) DO UPDATE 
        SET win_percentage = EXCLUDED.win_percentage,
            streak = EXCLUDED.streak,
            last_elo_change = EXCLUDED.last_elo_change,
            updated_at = CURRENT_TIMESTAMP
      `, [pid, winPercentage, streak, lastEloChange]);
    }
  } catch (err) {
    console.error('Error updating player stats cache:', err);
  } finally {
    client.release();
  }
}
