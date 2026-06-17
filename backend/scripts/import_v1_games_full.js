/**
 * import_v1_games_full.js — full chronological (re)import of ALL v1 minis games
 * into the v2 DB, recomputing Elo FRESH through v2's own engine.
 *
 * WHY a full re-import (not an append): the refreshed v1 data spans 3 dates and
 * the 2026-05-20 session is EARLIER than the 6 games already in v2. Correct Elo
 * must flow oldest-first, so the existing v2 results are wiped and all games are
 * replayed in date order. Admin / self / peer skill ratings are PRESERVED — only
 * 'result'-source skill rows + match data + the stats cache are reset.
 *
 * Source of truth: backend/migrations/v1_data/v1_games_18.json (produced by
 * parse_v1_dump.js from the refreshed v1 pg_dump). v1 player ids are mapped to v2
 * by name; spelling variants below; unmatched names create a new person+player.
 *
 * Safety:
 *   --dry-run : resolve names, print the mapping + plan, write NOTHING.
 *   --wipe    : required to actually delete existing results + import (guard).
 *   Take a pg_dump of frisbee_elo_v2 BEFORE running for real (caller's job).
 *
 * Run inside the backend container:
 *   docker cp scripts/import_v1_games_full.js <backend>:/app/scripts/
 *   docker cp migrations/v1_data/v1_games_18.json <backend>:/app/migrations/v1_data/
 *   docker exec <backend> node scripts/import_v1_games_full.js --dry-run
 *   docker exec <backend> node scripts/import_v1_games_full.js --wipe
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { processMatch, resultSkillFromMatch } from '../eloService.js';
import { recomputePlayerSkill } from '../skillService.js';
import { updatePlayerStatsCache, ensurePlayerStatsCacheTable } from '../statsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTEXT_ID = 1;
const ADMIN_PERSON_ID = 1;
const DRY_RUN = process.argv.includes('--dry-run');
const DO_WIPE = process.argv.includes('--wipe');
const DATA_PATH = path.join(__dirname, '..', 'migrations', 'v1_data', 'v1_games_18.json');

// V1 name -> V2 name: confident same-person spelling variants.
const NAME_VARIANTS = {
  'Harsh Sahgal': 'Harsh Sehgal',
  'Divyansh Joshi': 'Divyansh',
  'Harshit': 'Harshit Poddar',
  'Ahaan': 'Ahaan C',
};
// User-confirmed (2026-06-17): these are NEW people, NOT the similarly-named v2
// players (Mann != Maan, Aviral != Avi). The strings differ so they'd be treated
// as new anyway; listed here as the explicit decision record.
const CONFIRMED_NEW = new Set(['Mann', 'Aviral']);

function targetName(v1Name) { return NAME_VARIANTS[v1Name] || v1Name; }

async function main() {
  await ensurePlayerStatsCacheTable(pool);

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const { players: v1Players, matches } = data;
  console.log(`Loaded ${Object.keys(v1Players).length} v1 players, ${matches.length} matches from ${path.basename(DATA_PATH)}`);

  // Which v1 player ids actually appear in matches.
  const usedV1Ids = new Set();
  for (const m of matches) { m.teamA.forEach(id => usedV1Ids.add(id)); m.teamB.forEach(id => usedV1Ids.add(id)); }

  // Current v2 roster: name -> player_id.
  const rosterRows = (await pool.query(
    `SELECT pl.player_id, pr.name
       FROM player pl JOIN person pr ON pr.person_id = pl.person_id
      WHERE pl.context_id = $1`, [CONTEXT_ID])).rows;
  const v2ByName = new Map(rosterRows.map(r => [r.name, r.player_id]));

  // Resolve each used v1 id -> v2 player id, collecting new players to create.
  const v1ToV2 = new Map();      // v1 player_id -> v2 player_id (filled after creation)
  const matched = [];            // {v1Id, v1Name, v2Name, v2Id}
  const toCreate = [];           // {v1Id, v1Name}
  for (const v1Id of [...usedV1Ids].sort((a, b) => a - b)) {
    const v1Name = v1Players[v1Id];
    const tName = targetName(v1Name);
    const v2Id = v2ByName.get(tName);
    if (v2Id) matched.push({ v1Id, v1Name, v2Name: tName, v2Id });
    else toCreate.push({ v1Id, v1Name });
  }

  console.log(`\n=== Name resolution (context ${CONTEXT_ID}) ===`);
  console.log(`Matched to existing v2 players: ${matched.length}`);
  for (const r of matched) {
    const tag = r.v1Name === r.v2Name ? '' : `  (variant of "${r.v1Name}")`;
    console.log(`  v1#${r.v1Id} ${r.v2Name} -> v2#${r.v2Id}${tag}`);
  }
  console.log(`\nNEW players to create (${toCreate.length}):`);
  for (const r of toCreate) {
    const flag = CONFIRMED_NEW.has(r.v1Name) ? '  [confirmed-new, similar name exists in v2]' : '';
    console.log(`  v1#${r.v1Id} ${r.v1Name}${flag}`);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Would create ${toCreate.length} players and replay ${matches.length} matches. No writes.`);
    await pool.end?.();
    return;
  }
  if (!DO_WIPE) {
    console.error(`\nREFUSING: this import wipes existing results in context ${CONTEXT_ID} and replays all games.\nRe-run with --wipe once the dry-run looks correct (and after a pg_dump backup).`);
    process.exit(1);
  }

  // ---- Create new players (person + player) ----
  for (const r of toCreate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const person = (await client.query(
        `INSERT INTO person (name) VALUES ($1) RETURNING person_id`, [r.v1Name])).rows[0];
      const player = (await client.query(
        `INSERT INTO player (person_id, context_id) VALUES ($1, $2) RETURNING player_id`,
        [person.person_id, CONTEXT_ID])).rows[0];
      await client.query('COMMIT');
      r.v2Id = player.player_id;
      console.log(`+ created ${r.v1Name}: person#${person.person_id} player#${player.player_id}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`failed to create player "${r.v1Name}": ${err.message}`);
    } finally { client.release(); }
  }

  // Build the full v1->v2 id map.
  for (const r of [...matched, ...toCreate]) v1ToV2.set(r.v1Id, r.v2Id);
  const resolve = (v1Id) => {
    const id = v1ToV2.get(v1Id);
    if (!id) throw new Error(`UNRESOLVED v1 player id ${v1Id} (${v1Players[v1Id]})`);
    return id;
  };

  // ---- Wipe existing results for this context (preserve human skill ratings) ----
  {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ctxPlayers = `(SELECT player_id FROM player WHERE context_id = ${CONTEXT_ID})`;
      const r1 = await client.query(
        `DELETE FROM skill_input WHERE source = 'result' AND subject_player_id IN ${ctxPlayers}`);
      const r2 = await client.query(
        `DELETE FROM player_statistics_cache WHERE player_id IN ${ctxPlayers}`);
      // match delete cascades to match_player + match_confirmation.
      const r3 = await client.query(`DELETE FROM match WHERE context_id = $1`, [CONTEXT_ID]);
      await client.query('COMMIT');
      console.log(`\nWiped: ${r3.rowCount} matches, ${r1.rowCount} result skill rows, ${r2.rowCount} stats-cache rows (admin/self/peer ratings preserved).`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`wipe failed: ${err.message}`);
    } finally { client.release(); }
  }

  // ---- Replay all matches in chronological order ----
  console.log(`\n=== Replaying ${matches.length} matches ===`);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const winning_team = m.winner;                 // 'A' | 'B'
    const aIds = m.teamA.map(resolve);
    const bIds = m.teamB.map(resolve);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const match = (await client.query(`
        INSERT INTO match
          (context_id, match_date, location, team_a_name, team_b_name,
           team_a_score, team_b_score, winning_team, status, entered_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
        RETURNING match_id`,
        [CONTEXT_ID, m.date, m.location, m.team_a_name, m.team_b_name,
         m.a_score, m.b_score, winning_team, ADMIN_PERSON_ID])).rows[0];
      const matchId = match.match_id;

      for (const pid of aIds) await client.query(`INSERT INTO match_player (match_id, player_id, team) VALUES ($1,$2,'A')`, [matchId, pid]);
      for (const pid of bIds) await client.query(`INSERT INTO match_player (match_id, player_id, team) VALUES ($1,$2,'B')`, [matchId, pid]);

      // mirror POST /api/match/:id/confirm
      const teamRows = (await client.query(`
        SELECT mp.player_id, mp.team,
               COALESCE(psc.current_elo, 1000) AS current_elo,
               COALESCE(psc.total_games, 0)    AS total_games,
               pa.od_preference
          FROM match_player mp
          LEFT JOIN player_statistics_cache psc ON psc.player_id = mp.player_id
          LEFT JOIN player_attribute pa         ON pa.player_id = mp.player_id
         WHERE mp.match_id = $1`, [matchId])).rows;
      const teamA = teamRows.filter(r => r.team === 'A').map(r => ({ ...r, current_elo: parseFloat(r.current_elo) }));
      const teamB = teamRows.filter(r => r.team === 'B').map(r => ({ ...r, current_elo: parseFloat(r.current_elo) }));

      const { updatedTeamA, updatedTeamB, teamAAvgElo, teamBAvgElo, expectedWinA, expectedWinB } =
        processMatch(teamA, teamB, winning_team);

      await client.query(`
        UPDATE match SET status='confirmed',
          team_a_avg_elo=$1, team_b_avg_elo=$2, expected_win_team_a=$3, expected_win_team_b=$4
        WHERE match_id=$5`,
        [teamAAvgElo, teamBAvgElo, expectedWinA, expectedWinB, matchId]);

      const allUpdates = [
        ...updatedTeamA.map(p => ({ ...p, team: 'A' })),
        ...updatedTeamB.map(p => ({ ...p, team: 'B' })),
      ];
      for (const upd of allUpdates) {
        await client.query(`
          UPDATE match_player SET elo_before=$1, elo_after=$2, elo_change=$3
           WHERE match_id=$4 AND player_id=$5`,
          [upd.elo_before, upd.elo_after, upd.elo_change, matchId, upd.player_id]);
      }

      const all = [...resultSkillFromMatch(updatedTeamA), ...resultSkillFromMatch(updatedTeamB)];
      for (const s of all) {
        await client.query(`
          INSERT INTO skill_input (subject_player_id, source, offence_score, defence_score, match_id)
          VALUES ($1,'result',$2,$3,$4)`,
          [s.player_id, s.offence_score, s.defence_score, matchId]);
      }
      await client.query(`
        INSERT INTO match_confirmation (match_id, person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [matchId, ADMIN_PERSON_ID]);

      await client.query('COMMIT');

      await updatePlayerStatsCache(null, { context_id: CONTEXT_ID });
      for (const s of all) await recomputePlayerSkill(s.player_id, pool);

      console.log(`✓ m${m.match_id} (v2 id ${matchId}) ${m.date} ${m.team_a_name} ${m.a_score}-${m.b_score} ${m.team_b_name} | avgElo A=${teamAAvgElo.toFixed(0)} B=${teamBAvgElo.toFixed(0)} | win ${winning_team}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`✗ m${m.match_id} FAILED:`, err.message);
      throw err;
    } finally { client.release(); }
  }

  console.log(`\n=== Done. Imported ${matches.length} matches; created ${toCreate.length} new players. ===`);
  await pool.end?.();
}

main().catch(err => { console.error('\nIMPORT ABORTED:', err.message); process.exit(1); });
