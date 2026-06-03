import { pool } from './db.js';

async function migrate() {
  console.log('Running migrations...');
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Ensure core tables exist (if this is run on a fresh instance)
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        player_id SERIAL PRIMARY KEY,
        player_name VARCHAR(255) UNIQUE NOT NULL,
        current_elo FLOAT DEFAULT 1000,
        total_games INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id SERIAL PRIMARY KEY,
        match_date DATE NOT NULL,
        location VARCHAR(255),
        team_a_score INTEGER NOT NULL,
        team_b_score INTEGER NOT NULL,
        winning_team VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS match_players (
        id SERIAL PRIMARY KEY,
        match_id INTEGER REFERENCES matches(match_id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(player_id) ON DELETE CASCADE,
        team VARCHAR(10) NOT NULL,
        elo_before FLOAT NOT NULL,
        elo_after FLOAT NOT NULL,
        elo_change FLOAT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Phase 1 Schema Upgrades
    console.log('Adding new columns to matches...');
    const matchColumns = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='matches'
    `);
    const cols = matchColumns.rows.map(r => r.column_name);
    
    if (!cols.includes('expected_win_team_a')) {
      await client.query(`ALTER TABLE matches ADD COLUMN expected_win_team_a FLOAT DEFAULT NULL`);
    }
    if (!cols.includes('expected_win_team_b')) {
      await client.query(`ALTER TABLE matches ADD COLUMN expected_win_team_b FLOAT DEFAULT NULL`);
    }
    if (!cols.includes('team_a_avg_elo')) {
      await client.query(`ALTER TABLE matches ADD COLUMN team_a_avg_elo FLOAT DEFAULT NULL`);
    }
    if (!cols.includes('team_b_avg_elo')) {
      await client.query(`ALTER TABLE matches ADD COLUMN team_b_avg_elo FLOAT DEFAULT NULL`);
    }
    if (!cols.includes('team_a_name')) {
      await client.query(`ALTER TABLE matches ADD COLUMN team_a_name VARCHAR(255) DEFAULT NULL`);
    }
    if (!cols.includes('team_b_name')) {
      await client.query(`ALTER TABLE matches ADD COLUMN team_b_name VARCHAR(255) DEFAULT NULL`);
    }

    console.log('Creating player_statistics_cache...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_statistics_cache (
        player_id INTEGER PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
        win_percentage FLOAT DEFAULT 0,
        streak INTEGER DEFAULT 0,
        clutch_score FLOAT DEFAULT 0,
        consistency_score FLOAT DEFAULT 0,
        activity_score FLOAT DEFAULT 0,
        last_elo_change FLOAT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Ensure column exists if table already existed
    const cacheCols = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='player_statistics_cache'
    `);
    if (!cacheCols.rows.map(r => r.column_name).includes('last_elo_change')) {
      await client.query(`ALTER TABLE player_statistics_cache ADD COLUMN last_elo_change FLOAT DEFAULT 0`);
    }

    console.log('Creating activity_feed...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_feed (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        player_id INTEGER REFERENCES players(player_id) ON DELETE SET NULL,
        match_id INTEGER REFERENCES matches(match_id) ON DELETE SET NULL,
        description TEXT NOT NULL,
        meta_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query('COMMIT');
    console.log('Migrations completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
    process.exit();
  }
}

migrate();
