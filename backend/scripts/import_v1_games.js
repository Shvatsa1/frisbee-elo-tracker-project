/**
 * import_v1_games.js — one-off: import the 6 v1 minis games (2026-06-04) into
 * the v2 DB, recomputing Elo FRESH through v2's own engine.
 *
 * Source: the 6 matches were a round-robin of 4 fixed teams (A/B/C/D). Rosters
 * below were lifted from the v1 DB (frisbee_elo.match_players) and are mapped to
 * v2 by EXACT NAME (every name exists verbatim in the v2 roster for context 1).
 *
 * What it does, per match, in chronological order (so Elo flows match→match):
 *   1. INSERT match (pending) + match_player rows (team A/B).
 *   2. Run the same logic as POST /api/match/:id/confirm — processMatch() off the
 *      current player_statistics_cache Elo (default 1000), write match avg/expected,
 *      match_player elo_before/after/change, skill_input(source='result'), and a
 *      match_confirmation row.
 *   3. await updatePlayerStatsCache() so the NEXT match sees the new Elo.
 *   4. await recomputePlayerSkill() for each participant.
 *
 * Safety:
 *   - Idempotent: refuses to run if context already has matches (use --force).
 *   - --dry-run: resolve names + print the plan, write nothing.
 *   - Take a pg_dump of frisbee_elo_v2 BEFORE running for real (done by the caller).
 *
 * Run inside the backend container:
 *   docker cp import_v1_games.js <backend>:/app/scripts/
 *   docker exec <backend> node scripts/import_v1_games.js --dry-run
 *   docker exec <backend> node scripts/import_v1_games.js
 */
import { pool } from '../db.js';
import { processMatch, resultSkillFromMatch } from '../eloService.js';
import { recomputePlayerSkill } from '../skillService.js';
import { updatePlayerStatsCache, ensurePlayerStatsCacheTable } from '../statsService.js';

const CONTEXT_ID = 1;
const ADMIN_PERSON_ID = 1;       // 'Admin' person row; entered_by / confirmer
const MATCH_DATE = '2026-06-04';
const LOCATION = null;

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// 4 fixed teams (display name → exact v2 player names).
const TEAMS = {
  A: ['Antara', 'Ayush', 'Dr. Partha Patil', 'Harsh Sehgal', 'Karan Arora', 'Pranav Teki', 'Tarishi Jain'],
  B: ['Andre Gama', 'Chinmay', 'Kushal', 'Mayur Parmar', 'Niddhi', 'Prea Jain', 'Vaibhav'],
  C: ['Akhil', 'Anmol Samat', 'Avi', 'Harshit Poddar', 'Plaksha', 'Sanskar', 'Vignesh'],
  D: ['Ahaan C', 'Aryan', 'Divyansh', 'Saad', 'Shrestha', 'Stefan', 'Suryanshu Chauhan', 'Zubin'],
};

// Round-robin, chronological. side A = first team, side B = second.
const MATCHES = [
  { a: 'B', b: 'C', as: 9,  bs: 7 },
  { a: 'A', b: 'D', as: 7,  bs: 8 },
  { a: 'C', b: 'D', as: 6,  bs: 8 },
  { a: 'A', b: 'B', as: 12, bs: 7 },
  { a: 'A', b: 'C', as: 6,  bs: 7 },
  { a: 'B', b: 'D', as: 5,  bs: 11 },
];

async function main() {
  await ensurePlayerStatsCacheTable(pool);

  // Resolve every name → v2 player_id for this context. Fail loudly on any miss.
  const roster = (await pool.query(
    `SELECT pl.player_id, pr.name
       FROM player pl JOIN person pr ON pr.person_id = pl.person_id
      WHERE pl.context_id = $1`, [CONTEXT_ID],
  )).rows;
  const byName = new Map(roster.map(r => [r.name, r.player_id]));
  const resolve = (name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`UNRESOLVED NAME: "${name}" — not in v2 roster for context ${CONTEXT_ID}`);
    return id;
  };

  // Pre-resolve all teams (surfaces any name miss before touching the DB).
  const teamIds = {};
  for (const [k, names] of Object.entries(TEAMS)) teamIds[k] = names.map(n => [n, resolve(n)]);

  console.log(`\n=== Name resolution (context ${CONTEXT_ID}) ===`);
  for (const [k, pairs] of Object.entries(teamIds)) {
    console.log(`Team ${k} (${pairs.length}): ` + pairs.map(([n, id]) => `${n}#${id}`).join(', '));
  }

  console.log(`\n=== Matches to import (${MATCHES.length}) ===`);
  for (let i = 0; i < MATCHES.length; i++) {
    const m = MATCHES[i];
    const win = m.as > m.bs ? 'A' : 'B';
    console.log(`  ${i + 1}. Team ${m.a} vs Team ${m.b}  ${m.as}-${m.bs}  → winner side ${win} (Team ${win === 'A' ? m.a : m.b})  [${TEAMS[m.a].length}v${TEAMS[m.b].length}]`);
  }

  // Idempotency guard.
  const existing = (await pool.query(
    `SELECT count(*)::int AS n FROM match WHERE context_id = $1`, [CONTEXT_ID])).rows[0].n;
  if (existing > 0 && !FORCE) {
    console.error(`\nREFUSING: context ${CONTEXT_ID} already has ${existing} match(es). Re-running would double-count Elo. Use --force only if you know what you're doing.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] All ${Object.values(TEAMS).flat().length} names resolved, ${MATCHES.length} matches planned. No writes performed.`);
    await pool.end?.();
    return;
  }

  // ---- Real import: one match at a time, in order ----
  for (let i = 0; i < MATCHES.length; i++) {
    const m = MATCHES[i];
    const winning_team = m.as > m.bs ? 'A' : 'B';
    const aIds = TEAMS[m.a].map(resolve);
    const bIds = TEAMS[m.b].map(resolve);

    const client = await pool.connect();
    let matchId;
    try {
      await client.query('BEGIN');
      const match = (await client.query(`
        INSERT INTO match
          (context_id, match_date, location, team_a_name, team_b_name,
           team_a_score, team_b_score, winning_team, status, entered_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
        RETURNING *`,
        [CONTEXT_ID, MATCH_DATE, LOCATION, `Team ${m.a}`, `Team ${m.b}`,
         m.as, m.bs, winning_team, ADMIN_PERSON_ID])).rows[0];
      matchId = match.match_id;

      for (const pid of aIds) {
        await client.query(`INSERT INTO match_player (match_id, player_id, team) VALUES ($1,$2,'A')`, [matchId, pid]);
      }
      for (const pid of bIds) {
        await client.query(`INSERT INTO match_player (match_id, player_id, team) VALUES ($1,$2,'B')`, [matchId, pid]);
      }

      // --- mirror /api/match/:id/confirm ---
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
          team_a_avg_elo=$1, team_b_avg_elo=$2,
          expected_win_team_a=$3, expected_win_team_b=$4
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
        INSERT INTO match_confirmation (match_id, person_id) VALUES ($1,$2)
        ON CONFLICT DO NOTHING`, [matchId, ADMIN_PERSON_ID]);

      await client.query('COMMIT');

      // Propagate Elo to the cache BEFORE the next match, and reblend skills.
      await updatePlayerStatsCache(null, { context_id: CONTEXT_ID });
      for (const s of all) await recomputePlayerSkill(s.player_id, pool);

      console.log(`✓ match ${i + 1} (id ${matchId}): Team ${m.a} ${m.as}-${m.bs} Team ${m.b} | avgElo A=${teamAAvgElo.toFixed(0)} B=${teamBAvgElo.toFixed(0)} | winner ${winning_team}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`✗ match ${i + 1} FAILED:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`\n=== Done. Imported ${MATCHES.length} matches into context ${CONTEXT_ID}. ===`);
  await pool.end?.();
}

main().catch(err => { console.error('\nIMPORT ABORTED:', err.message); process.exit(1); });
