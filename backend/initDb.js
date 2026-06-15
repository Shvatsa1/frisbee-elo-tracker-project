/**
 * UltiElo v2 schema bootstrap.
 *
 * Builds the v2 schema (per SPEC_15 §1) idempotently and seeds the
 * minimum needed for the system to be usable on a fresh DB: one admin
 * `person` and a default "Wednesday Minis" `context` with the admin
 * registered as a `context_authority`.
 *
 * Safe to re-run. Will not clobber existing data; will not create
 * duplicate seed rows.
 */
import { pool } from './db.js';

export const createV2SchemaSql = `
-- ============================================================
-- Identity
-- ============================================================
CREATE TABLE IF NOT EXISTS person (
  person_id          SERIAL PRIMARY KEY,
  name               VARCHAR(255) NOT NULL,
  phone              VARCHAR(64)  UNIQUE,
  email              VARCHAR(255) UNIQUE,
  rating_token       VARCHAR(128) UNIQUE,
  -- SPEC_16 §4: single-use / TTL tokens. Plain-HTTP threat mitigation is "a
  -- sniffed token is already spent". token_expires_at = wall-clock TTL;
  -- token_used_at = first redemption (NULL = unspent).
  token_expires_at   TIMESTAMP,
  token_used_at      TIMESTAMP,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Additive guards: person.token_expires_at / token_used_at were added in
-- SPEC_16. Apply on pre-SPEC_16 databases that already have a person table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='person' AND column_name='token_expires_at') THEN
    ALTER TABLE person ADD COLUMN token_expires_at TIMESTAMP;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='person' AND column_name='token_used_at') THEN
    ALTER TABLE person ADD COLUMN token_used_at TIMESTAMP;
  END IF;
  -- Optional profile photo (one per person, shared across contexts). NULL =
  -- show initials placeholder. Populated by the photo-upload flow.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='person' AND column_name='photo_url') THEN
    ALTER TABLE person ADD COLUMN photo_url VARCHAR(512);
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS context (
  context_id    SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  kind          VARCHAR(32)  NOT NULL CHECK (kind IN ('minis','practice','tournament')),
  -- SPEC_16 §4: when TRUE the peer-rating eligibility check drops the
  -- shared-confirmed-match requirement; rater and subject need only be in
  -- the same context. Defaults FALSE; flip deliberately per context.
  open_rating   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (name, kind)
);

-- Additive guard: context.open_rating added in SPEC_16.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='context' AND column_name='open_rating') THEN
    ALTER TABLE context ADD COLUMN open_rating BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS player (
  player_id   SERIAL PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES person(person_id)  ON DELETE CASCADE,
  context_id  INTEGER NOT NULL REFERENCES context(context_id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (person_id, context_id)
);

CREATE TABLE IF NOT EXISTS context_authority (
  context_id  INTEGER NOT NULL REFERENCES context(context_id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES person(person_id)   ON DELETE CASCADE,
  role        VARCHAR(16) NOT NULL CHECK (role IN ('admin','coach')),
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (context_id, person_id)
);

-- ============================================================
-- Role attributes (per-player, per-context)
-- ============================================================
CREATE TABLE IF NOT EXISTS player_attribute (
  player_id      INTEGER PRIMARY KEY REFERENCES player(player_id) ON DELETE CASCADE,
  position       VARCHAR(16) CHECK (position IN ('handler','cutter','hybrid')),
  hand           VARCHAR(8)  CHECK (hand IN ('left','right')),
  style          VARCHAR(16) CHECK (style IN ('direct','short','aerial')),
  od_preference  VARCHAR(16) CHECK (od_preference IN ('offence','defence','both')),
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- SPEC_16 §3: FIFA-style self card. 6 attributes on the shared 0–100 scale
-- (5-tier UI maps to TIER_SCORE = 90/70/50/30/10 in cardService.js). This is
-- the rich self-profile; the route writes a derived self skill_input via
-- cardService.cardToOffenceDefence so the tested blend engine is unchanged.
-- Nullable columns let a player save a partial card (un-set attrs fall back
-- to mid-scale inside the derivation).
CREATE TABLE IF NOT EXISTS player_card (
  player_id   INTEGER PRIMARY KEY REFERENCES player(player_id) ON DELETE CASCADE,
  throwing    FLOAT CHECK (throwing  BETWEEN 0 AND 100),
  cutting     FLOAT CHECK (cutting   BETWEEN 0 AND 100),
  handling    FLOAT CHECK (handling  BETWEEN 0 AND 100),
  defense     FLOAT CHECK (defense   BETWEEN 0 AND 100),
  speed       FLOAT CHECK (speed     BETWEEN 0 AND 100),
  endurance   FLOAT CHECK (endurance BETWEEN 0 AND 100),
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Skill inputs (raw observations) + cached blend
-- ============================================================
CREATE TABLE IF NOT EXISTS skill_input (
  input_id          SERIAL PRIMARY KEY,
  subject_player_id INTEGER NOT NULL REFERENCES player(player_id) ON DELETE CASCADE,
  rater_person_id   INTEGER          REFERENCES person(person_id) ON DELETE SET NULL,
  source            VARCHAR(16) NOT NULL CHECK (source IN ('self','admin','peer','result')),
  offence_score     FLOAT NOT NULL,
  defence_score     FLOAT NOT NULL,
  match_id          INTEGER,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  -- peer rows require rater_person_id; enforced at the route layer with
  -- a shared-confirmed-match eligibility check (see §4).
);

CREATE INDEX IF NOT EXISTS skill_input_subject_idx
  ON skill_input(subject_player_id);
CREATE INDEX IF NOT EXISTS skill_input_subject_source_idx
  ON skill_input(subject_player_id, source);

-- player_skill is the human rating on a 0–100 scale (50 = average), decoupled
-- from Elo. (Elo lives in player_statistics_cache.current_elo, 0–2500.)
CREATE TABLE IF NOT EXISTS player_skill (
  player_id        INTEGER PRIMARY KEY REFERENCES player(player_id) ON DELETE CASCADE,
  offence_skill    FLOAT NOT NULL DEFAULT 50,
  defence_skill    FLOAT NOT NULL DEFAULT 50,
  headline_scalar  FLOAT NOT NULL DEFAULT 50,
  n_peers          INTEGER NOT NULL DEFAULT 0,
  n_results        INTEGER NOT NULL DEFAULT 0,
  weights          JSONB,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Builds (must exist before match so match.build_id can FK)
-- ============================================================
CREATE TABLE IF NOT EXISTS team_build (
  build_id    SERIAL PRIMARY KEY,
  context_id  INTEGER NOT NULL REFERENCES context(context_id) ON DELETE CASCADE,
  created_by  INTEGER NOT NULL REFERENCES person(person_id),
  num_teams   INTEGER NOT NULL CHECK (num_teams >= 2),
  team_size   INTEGER NOT NULL CHECK (team_size >= 1),
  params      JSONB,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS team_build_player (
  build_id    INTEGER NOT NULL REFERENCES team_build(build_id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES player(player_id)    ON DELETE CASCADE,
  team_label  INTEGER NOT NULL,
  PRIMARY KEY (build_id, player_id)
);

-- ============================================================
-- Matches
-- ============================================================
CREATE TABLE IF NOT EXISTS match (
  match_id            SERIAL PRIMARY KEY,
  context_id          INTEGER NOT NULL REFERENCES context(context_id),
  match_date          DATE NOT NULL,
  location            VARCHAR(255),
  team_a_name         VARCHAR(255) NOT NULL DEFAULT 'Team A',
  team_b_name         VARCHAR(255) NOT NULL DEFAULT 'Team B',
  team_a_score        INTEGER NOT NULL,
  team_b_score        INTEGER NOT NULL,
  winning_team        VARCHAR(1) NOT NULL CHECK (winning_team IN ('A','B')),
  team_a_avg_elo      FLOAT,
  team_b_avg_elo      FLOAT,
  expected_win_team_a FLOAT,
  expected_win_team_b FLOAT,
  status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','confirmed','disputed')),
  entered_by          INTEGER NOT NULL REFERENCES person(person_id),
  build_id            INTEGER REFERENCES team_build(build_id) ON DELETE SET NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS match_context_idx ON match(context_id);
CREATE INDEX IF NOT EXISTS match_status_idx  ON match(status);

CREATE TABLE IF NOT EXISTS match_player (
  id          SERIAL PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES match(match_id)   ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES player(player_id) ON DELETE CASCADE,
  team        VARCHAR(1) NOT NULL CHECK (team IN ('A','B')),
  is_captain  BOOLEAN NOT NULL DEFAULT FALSE,
  elo_before  FLOAT,
  elo_after   FLOAT,
  elo_change  FLOAT,
  UNIQUE (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS match_player_player_idx ON match_player(player_id);

CREATE TABLE IF NOT EXISTS match_point (
  id              SERIAL PRIMARY KEY,
  match_id        INTEGER NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  point_no        INTEGER NOT NULL,
  line_type       VARCHAR(1) NOT NULL CHECK (line_type IN ('O','D')),
  scored_by_team  VARCHAR(1) CHECK (scored_by_team IN ('A','B')),
  UNIQUE (match_id, point_no)
);

CREATE TABLE IF NOT EXISTS match_confirmation (
  match_id     INTEGER NOT NULL REFERENCES match(match_id)  ON DELETE CASCADE,
  person_id    INTEGER NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  confirmed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_id, person_id)
);

CREATE TABLE IF NOT EXISTS game_survey (
  survey_id            SERIAL PRIMARY KEY,
  match_id             INTEGER NOT NULL REFERENCES match(match_id)  ON DELETE CASCADE,
  respondent_player_id INTEGER NOT NULL REFERENCES player(player_id) ON DELETE CASCADE,
  balance_felt         INTEGER CHECK (balance_felt BETWEEN 1 AND 5),
  enjoyment            INTEGER CHECK (enjoyment    BETWEEN 1 AND 5),
  effort               INTEGER CHECK (effort       BETWEEN 1 AND 5),
  improve_note         TEXT,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (match_id, respondent_player_id)
);

-- ============================================================
-- Read cache (refreshed by statsService; never written by hand)
-- Belongs to the core schema so public reads on a fresh DB don't
-- 500 before the first cache refresh has run.
-- ============================================================
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

-- ============================================================
-- Event registration (SPEC_17 minimum slice: Soozy replacement)
-- ============================================================
CREATE TABLE IF NOT EXISTS event (
  event_id              SERIAL PRIMARY KEY,
  context_id            INTEGER NOT NULL REFERENCES context(context_id) ON DELETE CASCADE,
  title                 VARCHAR(255) NOT NULL,
  event_date            DATE NOT NULL,
  event_time            VARCHAR(16),
  location              VARCHAR(255),
  capacity              INTEGER NOT NULL DEFAULT 28 CHECK (capacity >= 1),
  status                VARCHAR(16) NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','closed','cancelled')),
  registration_opens_at TIMESTAMP,
  share_token           VARCHAR(128) UNIQUE NOT NULL,
  created_by            INTEGER NOT NULL REFERENCES person(person_id),
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS event_context_idx ON event(context_id);
CREATE INDEX IF NOT EXISTS event_status_idx  ON event(status);

CREATE TABLE IF NOT EXISTS event_registration (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES event(event_id)   ON DELETE CASCADE,
  person_id     INTEGER NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  status        VARCHAR(16) NOT NULL DEFAULT 'main'
                 CHECK (status IN ('main','waitlist','withdrawn')),
  signed_up_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at   TIMESTAMP,
  withdrawn_at  TIMESTAMP,
  UNIQUE (event_id, person_id)
);
CREATE INDEX IF NOT EXISTS event_reg_event_status_idx
  ON event_registration(event_id, status, signed_up_at);
`;

// Admin is the only person we seed; we identify it by a fixed rating_token
// sentinel so the seed is idempotent without polluting `name` with a unique
// constraint (two real humans named "Sai" must be allowed).
const ADMIN_SENTINEL_TOKEN = 'system:bootstrap-admin';

const seedSql = `
INSERT INTO person (name, rating_token)
  SELECT 'Admin', '${ADMIN_SENTINEL_TOKEN}'
  WHERE NOT EXISTS (SELECT 1 FROM person WHERE rating_token = '${ADMIN_SENTINEL_TOKEN}');

INSERT INTO context (name, kind)
  VALUES ('Wednesday Minis', 'minis')
  ON CONFLICT (name, kind) DO NOTHING;

INSERT INTO context_authority (context_id, person_id, role)
  SELECT c.context_id, p.person_id, 'admin'
  FROM context c, person p
  WHERE c.name = 'Wednesday Minis' AND c.kind = 'minis'
    AND p.rating_token = '${ADMIN_SENTINEL_TOKEN}'
  ON CONFLICT DO NOTHING;
`;

export async function applyV2Schema(client) {
  await client.query(createV2SchemaSql);
}

export async function applyV2Seed(client) {
  await client.query(seedSql);
}

async function initDb() {
  const client = await pool.connect();
  try {
    console.log('[initDb] applying v2 schema...');
    await applyV2Schema(client);
    console.log('[initDb] seeding minimum admin + default context...');
    await applyV2Seed(client);
    console.log('[initDb] done.');
  } catch (err) {
    console.error('[initDb] failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// Only auto-run when executed directly (not when imported by harness/tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectInvocation) {
  initDb();
}
