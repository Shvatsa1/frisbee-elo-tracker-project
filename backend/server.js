import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import { processMatch, calculateExpectedScore, getKFactor } from './eloService.js';
import { updatePlayerStatsCache } from './statsService.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_fallback_key';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

const app = express();
app.use(cors());
app.use(express.json());

// --- Auth ---
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

// --- Dashboard Stats ---
app.get('/api/dashboard', async (req, res) => {
  try {
    const playersCount = await pool.query('SELECT COUNT(*) FROM players');
    const matchesCount = await pool.query('SELECT COUNT(*) FROM matches');
    const topPlayers = await pool.query(`
      SELECT p.*, c.streak, c.win_percentage, c.last_elo_change
      FROM players p
      LEFT JOIN player_statistics_cache c ON p.player_id = c.player_id
      ORDER BY p.current_elo DESC LIMIT 10
    `);
    const latestMatches = await pool.query(`
      SELECT m.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'player_id', p.player_id, 
                   'player_name', p.player_name, 
                   'team', mp.team
                 )
               ) FILTER (WHERE p.player_id IS NOT NULL), '[]'
             ) as players
      FROM matches m
      LEFT JOIN match_players mp ON m.match_id = mp.match_id
      LEFT JOIN players p ON mp.player_id = p.player_id
      GROUP BY m.match_id
      ORDER BY m.match_date DESC, m.created_at DESC LIMIT 5
    `);
    const insights = await pool.query(`
      SELECT p.player_name, c.streak, c.win_percentage, p.total_games
      FROM player_statistics_cache c 
      JOIN players p ON p.player_id = c.player_id 
      ORDER BY c.streak DESC LIMIT 1
    `);
    
    // Pulse Aggregations
    const pulseMostActiveDay = await pool.query(`
      SELECT TO_CHAR(match_date, 'Day') as day_name, COUNT(*) as matches 
      FROM matches 
      GROUP BY day_name 
      ORDER BY matches DESC LIMIT 1
    `);
    
    const pulseMostPlayedVenue = await pool.query(`
      SELECT location, COUNT(*) as matches 
      FROM matches 
      WHERE location IS NOT NULL AND location != '' 
      GROUP BY location 
      ORDER BY matches DESC LIMIT 1
    `);
    
    const pulseAvgTeamElo = await pool.query(`
      SELECT AVG((team_a_avg_elo + team_b_avg_elo) / 2) as avg_elo 
      FROM matches
    `);

    res.json({
      totalPlayers: parseInt(playersCount.rows[0].count),
      totalMatches: parseInt(matchesCount.rows[0].count),
      topPlayers: topPlayers.rows,
      latestMatches: latestMatches.rows,
      insights: insights.rows[0],
      pulse: {
        mostActiveDay: pulseMostActiveDay.rows[0] || null,
        mostPlayedVenue: pulseMostPlayedVenue.rows[0] || null,
        avgTeamElo: pulseAvgTeamElo.rows[0]?.avg_elo || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Trending & Activity ---
app.get('/api/dashboard/trending', async (req, res) => {
  try {
    const topPlayers = await pool.query('SELECT player_id, player_name FROM players ORDER BY current_elo DESC LIMIT 5');
    
    const result = [];
    for (const p of topPlayers.rows) {
      const history = await pool.query(`
        SELECT m.match_date, mp.elo_after 
        FROM match_players mp
        JOIN matches m ON m.match_id = mp.match_id
        WHERE mp.player_id = $1
        ORDER BY m.match_date DESC, m.created_at DESC
        LIMIT 10
      `, [p.player_id]);
      
      result.push({
        player_id: p.player_id,
        player_name: p.player_name,
        history: history.rows.reverse()
      });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/activity', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM activity_feed ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Players ---
app.get('/api/players', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, c.streak, c.win_percentage, c.last_elo_change
      FROM players p
      LEFT JOIN player_statistics_cache c ON p.player_id = c.player_id
      ORDER BY p.current_elo DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/players/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const playerResult = await pool.query('SELECT * FROM players WHERE player_id = $1', [id]);
    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    
    const historyResult = await pool.query(`
      SELECT 
        m.match_id, mp.team as player_team, mp.elo_before, mp.elo_after, mp.elo_change,
        m.match_date, m.location, m.team_a_score, m.team_b_score, m.winning_team,
        m.team_a_name, m.team_b_name,
        COALESCE(
          json_agg(
            json_build_object(
              'player_id', p.player_id, 
              'player_name', p.player_name, 
              'team', mp_all.team
            )
          ) FILTER (WHERE p.player_id IS NOT NULL), '[]'
        ) as players
      FROM match_players mp
      JOIN matches m ON mp.match_id = m.match_id
      LEFT JOIN match_players mp_all ON m.match_id = mp_all.match_id
      LEFT JOIN players p ON mp_all.player_id = p.player_id
      WHERE mp.player_id = $1
      GROUP BY m.match_id, mp.team, mp.elo_before, mp.elo_after, mp.elo_change, m.created_at
      ORDER BY m.match_date DESC, m.created_at DESC
    `, [id]);
    
    const bestAllyResult = await pool.query(`
      SELECT p.player_name, count(*) as wins
      FROM match_players mp1
      JOIN match_players mp2 ON mp1.match_id = mp2.match_id AND mp1.team = mp2.team AND mp1.player_id != mp2.player_id
      JOIN matches m ON mp1.match_id = m.match_id
      JOIN players p ON mp2.player_id = p.player_id
      WHERE mp1.player_id = $1 AND m.winning_team = mp1.team
      GROUP BY p.player_name
      ORDER BY wins DESC
      LIMIT 1
    `, [id]);
    
    const nemesisResult = await pool.query(`
      SELECT p.player_name, count(*) as losses
      FROM match_players mp1
      JOIN match_players mp2 ON mp1.match_id = mp2.match_id AND mp1.team != mp2.team
      JOIN matches m ON mp1.match_id = m.match_id
      JOIN players p ON mp2.player_id = p.player_id
      WHERE mp1.player_id = $1 AND m.winning_team != mp1.team AND m.winning_team != 'Draw'
      GROUP BY p.player_name
      ORDER BY losses DESC
      LIMIT 1
    `, [id]);
    
    res.json({
      player: playerResult.rows[0],
      history: historyResult.rows,
      bestAlly: bestAllyResult.rows[0] || null,
      nemesis: nemesisResult.rows[0] || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/players', authMiddleware, async (req, res) => {
  const { player_name } = req.body;
  if (!player_name) return res.status(400).json({ error: 'player_name is required' });
  try {
    const result = await pool.query(
      'INSERT INTO players (player_name) VALUES ($1) RETURNING *',
      [player_name]
    );
    const newPlayer = result.rows[0];
    await pool.query(
      `INSERT INTO activity_feed (event_type, player_id, description, meta_data) VALUES ($1, $2, $3, $4)`,
      ['NEW_PLAYER', newPlayer.player_id, `New player ${newPlayer.player_name} joined Mumbai Ultimate!`, JSON.stringify({})]
    );
    res.status(201).json(newPlayer);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Player name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Matches ---
app.get('/api/matches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'player_id', p.player_id, 
                   'player_name', p.player_name, 
                   'team', mp.team
                 )
               ) FILTER (WHERE p.player_id IS NOT NULL), '[]'
             ) as players
      FROM matches m
      LEFT JOIN match_players mp ON m.match_id = mp.match_id
      LEFT JOIN players p ON mp.player_id = p.player_id
      GROUP BY m.match_id
      ORDER BY m.match_date DESC, m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/matches', authMiddleware, async (req, res) => {
  const { match_date, location, team_a_score, team_b_score, team_a_players, team_b_players, team_a_name, team_b_name } = req.body;
  
  if (!match_date || team_a_score == null || team_b_score == null || !team_a_players || !team_b_players) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const winning_team = team_a_score > team_b_score ? 'A' : (team_b_score > team_a_score ? 'B' : 'Draw');
  if (winning_team === 'Draw') {
    return res.status(400).json({ error: 'Draws are not supported in this MVP' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Fetch current players data
    const playerIds = [...team_a_players, ...team_b_players];
    const playersResult = await client.query(`SELECT * FROM players WHERE player_id = ANY($1)`, [playerIds]);
    const playersMap = new Map(playersResult.rows.map(p => [p.player_id, p]));
    
    // Construct team arrays
    const teamA = team_a_players.map(id => playersMap.get(id));
    const teamB = team_b_players.map(id => playersMap.get(id));
    
    if (teamA.includes(undefined) || teamB.includes(undefined)) {
      throw new Error('One or more players not found');
    }
    
    // Calculate Elo
    const { updatedTeamA, updatedTeamB, teamAAvgElo, teamBAvgElo, expectedWinA, expectedWinB } = processMatch(teamA, teamB, winning_team);
    
    // Insert match
    const matchResult = await client.query(
      `INSERT INTO matches 
        (match_date, location, team_a_score, team_b_score, winning_team, expected_win_team_a, expected_win_team_b, team_a_avg_elo, team_b_avg_elo, team_a_name, team_b_name) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING match_id`,
      [match_date, location, team_a_score, team_b_score, winning_team, expectedWinA, expectedWinB, teamAAvgElo, teamBAvgElo, team_a_name || 'Team A', team_b_name || 'Team B']
    );
    const matchId = matchResult.rows[0].match_id;
    
    // Insert match_players and update players
    const allUpdates = [
      ...updatedTeamA.map(p => ({ ...p, team: 'A', isWinner: winning_team === 'A' })),
      ...updatedTeamB.map(p => ({ ...p, team: 'B', isWinner: winning_team === 'B' }))
    ];
    
    for (const update of allUpdates) {
      // Insert into match_players
      await client.query(
        'INSERT INTO match_players (match_id, player_id, team, elo_before, elo_after, elo_change) VALUES ($1, $2, $3, $4, $5, $6)',
        [matchId, update.player_id, update.team, update.elo_before, update.elo_after, update.elo_change]
      );
      
      // Update players table
      await client.query(
        `UPDATE players 
         SET current_elo = $1, 
             total_games = total_games + 1, 
             wins = wins + $2, 
             losses = losses + $3 
         WHERE player_id = $4`,
        [update.elo_after, update.isWinner ? 1 : 0, update.isWinner ? 0 : 1, update.player_id]
      );
    }
    
    await client.query('COMMIT');
    
    // Add activity feed entries (outside transaction)
    try {
      const winningTeamName = winning_team === 'A' ? (team_a_name || 'Team A') : (team_b_name || 'Team B');
      const eloSwing = Math.round(winning_team === 'A' ? Math.abs(updatedTeamA[0]?.elo_change || 0) : Math.abs(updatedTeamB[0]?.elo_change || 0));
      
      const teamAWon = winning_team === 'A';
      const teamBWon = winning_team === 'B';
      const isTeamAUpset = teamAWon && expectedWinA < 0.35;
      const isTeamBUpset = teamBWon && expectedWinB < 0.35;
      
      if (isTeamAUpset || isTeamBUpset) {
        await pool.query(
          `INSERT INTO activity_feed (event_type, match_id, description, meta_data) VALUES ($1, $2, $3, $4)`,
          ['UPSET', matchId, `Massive Upset! ${winningTeamName} defeated the favorites.`, JSON.stringify({ elo_swing: eloSwing })]
        );
      } else {
        await pool.query(
          `INSERT INTO activity_feed (event_type, match_id, description, meta_data) VALUES ($1, $2, $3, $4)`,
          ['MATCH_LOGGED', matchId, `${winningTeamName} won a match!`, JSON.stringify({ elo_swing: eloSwing })]
        );
      }
    } catch (activityErr) {
      console.error('Failed to log activity feed:', activityErr);
    }
    
    // Asynchronously update cache in the background
    updatePlayerStatsCache().catch(console.error);
    
    res.status(201).json({ success: true, matchId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

// --- Admin Match Editing ---
app.put('/api/admin/matches/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { team_a_score, team_b_score, team_a_players, team_b_players } = req.body;
  
  if (team_a_score == null || team_b_score == null || !team_a_players || !team_b_players) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const winning_team = team_a_score > team_b_score ? 'A' : (team_b_score > team_a_score ? 'B' : 'Draw');
  if (winning_team === 'Draw') {
    return res.status(400).json({ error: 'Draws are not supported in this MVP' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Update match scores and winner
    await client.query(
      `UPDATE matches SET team_a_score = $1, team_b_score = $2, winning_team = $3 WHERE match_id = $4`,
      [team_a_score, team_b_score, winning_team, id]
    );

    // Delete old match players
    await client.query('DELETE FROM match_players WHERE match_id = $1', [id]);

    // Insert new match players (elo_before/after will be overwritten by the recalculate engine)
    for (const pId of team_a_players) {
      await client.query(
        'INSERT INTO match_players (match_id, player_id, team, elo_before, elo_after, elo_change) VALUES ($1, $2, $3, 0, 0, 0)',
        [id, pId, 'A']
      );
    }
    for (const pId of team_b_players) {
      await client.query(
        'INSERT INTO match_players (match_id, player_id, team, elo_before, elo_after, elo_change) VALUES ($1, $2, $3, 0, 0, 0)',
        [id, pId, 'B']
      );
    }

    // Log the manual edit in the activity feed
    await client.query(
      `INSERT INTO activity_feed (event_type, match_id, description, meta_data) VALUES ($1, $2, $3, $4)`,
      ['ADMIN_EDIT', id, `Match #${id} was edited by an admin. Elo recalculation required.`, JSON.stringify({})]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

// --- Admin / Recalculation Engine ---
app.post('/api/admin/recalculate', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Reset all players to baseline
    await client.query('UPDATE players SET current_elo = 1000, total_games = 0, wins = 0, losses = 0');
    
    // 2. Fetch all matches chronologically
    const matchesResult = await client.query('SELECT * FROM matches ORDER BY match_date ASC, created_at ASC');
    const matches = matchesResult.rows;
    
    // 3. Replay each match
    for (const match of matches) {
      // Get roster for this match
      const rosterResult = await client.query('SELECT player_id, team FROM match_players WHERE match_id = $1', [match.match_id]);
      
      const teamAIds = rosterResult.rows.filter(r => r.team === 'A').map(r => r.player_id);
      const teamBIds = rosterResult.rows.filter(r => r.team === 'B').map(r => r.player_id);
      
      const allPlayerIds = [...teamAIds, ...teamBIds];
      if (allPlayerIds.length === 0) continue;
      
      const playersResult = await client.query('SELECT * FROM players WHERE player_id = ANY($1)', [allPlayerIds]);
      const playersMap = new Map(playersResult.rows.map(p => [p.player_id, p]));
      
      const teamA = teamAIds.map(id => playersMap.get(id));
      const teamB = teamBIds.map(id => playersMap.get(id));
      
      // Calculate new Elo
      const { updatedTeamA, updatedTeamB, teamAAvgElo, teamBAvgElo, expectedWinA, expectedWinB } = processMatch(teamA, teamB, match.winning_team);
      
      // Update matches table with new snapshots
      await client.query(`
        UPDATE matches 
        SET expected_win_team_a = $1, expected_win_team_b = $2, team_a_avg_elo = $3, team_b_avg_elo = $4
        WHERE match_id = $5
      `, [expectedWinA, expectedWinB, teamAAvgElo, teamBAvgElo, match.match_id]);
      
      // Update match_players and players
      const allUpdates = [
        ...updatedTeamA.map(p => ({ ...p, team: 'A', isWinner: match.winning_team === 'A' })),
        ...updatedTeamB.map(p => ({ ...p, team: 'B', isWinner: match.winning_team === 'B' }))
      ];
      
      for (const update of allUpdates) {
        await client.query(`
          UPDATE match_players 
          SET elo_before = $1, elo_after = $2, elo_change = $3
          WHERE match_id = $4 AND player_id = $5
        `, [update.elo_before, update.elo_after, update.elo_change, match.match_id, update.player_id]);
        
        await client.query(`
          UPDATE players 
          SET current_elo = $1, total_games = total_games + 1, wins = wins + $2, losses = losses + $3
          WHERE player_id = $4
        `, [update.elo_after, update.isWinner ? 1 : 0, update.isWinner ? 0 : 1, update.player_id]);
      }
    }

    await client.query('COMMIT');
    
    // Update cache for all players
    updatePlayerStatsCache().catch(console.error);
    
    res.json({ success: true, message: 'Recalculation complete' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
