import { pool } from './db.js';

const createTablesQuery = `
CREATE TABLE IF NOT EXISTS players (
    player_id SERIAL PRIMARY KEY,
    player_name VARCHAR(255) UNIQUE NOT NULL,
    current_elo FLOAT DEFAULT 1000,
    total_games INT DEFAULT 0,
    wins INT DEFAULT 0,
    losses INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS matches (
    match_id SERIAL PRIMARY KEY,
    match_date DATE NOT NULL,
    location VARCHAR(255),
    team_a_score INT NOT NULL,
    team_b_score INT NOT NULL,
    winning_team VARCHAR(1) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS match_players (
    id SERIAL PRIMARY KEY,
    match_id INT REFERENCES matches(match_id) ON DELETE CASCADE,
    player_id INT REFERENCES players(player_id) ON DELETE CASCADE,
    team VARCHAR(1) NOT NULL,
    elo_before FLOAT NOT NULL,
    elo_after FLOAT NOT NULL,
    elo_change FLOAT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

const seedDataQuery = `
INSERT INTO players (player_name, current_elo, total_games, wins, losses) 
VALUES 
  ('Alice', 1200, 16, 10, 6),
  ('Bob', 980, 5, 2, 3),
  ('Charlie', 1050, 10, 5, 5),
  ('David', 1000, 0, 0, 0),
  ('Eve', 1100, 20, 12, 8),
  ('Frank', 950, 8, 3, 5),
  ('Grace', 1300, 30, 20, 10),
  ('Heidi', 1000, 0, 0, 0)
ON CONFLICT (player_name) DO NOTHING;
`;

async function initDb() {
  try {
    console.log('Initializing database schema...');
    await pool.query(createTablesQuery);
    console.log('Tables created successfully.');
    
    console.log('Seeding initial data...');
    await pool.query(seedDataQuery);
    console.log('Seed data inserted successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    pool.end();
  }
}

initDb();
