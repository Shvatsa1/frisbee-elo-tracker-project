/**
 * eloService — UltiElo result-Elo math (preserved from v1).
 *
 * In v2 this is no longer the headline rating; the headline is the blend in
 * `skillService.js`. Elo here lives on as the *result* signal: every
 * confirmed match produces an `elo_after`/`elo_change` per participating
 * `match_player`, and a `source='result'` row is written into
 * `skill_input` via `resultSkillFromMatch()`.
 *
 * The core math (calculateExpectedScore, getKFactor, processMatch) is
 * unchanged from v1 — same K-factor curve (40 < 15 games, else 20).
 */

/**
 * Calculates the expected win probability for a team.
 * @param {number} teamElo - Average Elo of the team.
 * @param {number} opponentElo - Average Elo of the opponent team.
 * @returns {number} Expected probability of winning (0 to 1).
 */
export function calculateExpectedScore(teamElo, opponentElo) {
  return 1 / (1 + Math.pow(10, (opponentElo - teamElo) / 400));
}

/**
 * Gets the K-factor based on the player's total games.
 * @param {number} totalGames - Number of rated games played by the player before this match.
 * @returns {number} K-factor (40 for < 15 games, 20 for >= 15 games)
 */
export function getKFactor(totalGames) {
  return totalGames < 15 ? 40 : 20;
}

/**
 * Calculates Elo updates for players in a match.
 * @param {Array} teamAPlayers - Array of player objects { player_id, current_elo, total_games }
 * @param {Array} teamBPlayers - Array of player objects { player_id, current_elo, total_games }
 * @param {string} winningTeam - 'A' or 'B'
 * @returns {Object} { updatedTeamA, updatedTeamB } with elo_after and elo_change attached to each player
 */
export function processMatch(teamAPlayers, teamBPlayers, winningTeam) {
  // 1. Calculate average Elo for both teams
  const avgEloA = teamAPlayers.reduce((sum, p) => sum + p.current_elo, 0) / teamAPlayers.length;
  const avgEloB = teamBPlayers.reduce((sum, p) => sum + p.current_elo, 0) / teamBPlayers.length;

  // 2. Calculate expected scores
  const expectedA = calculateExpectedScore(avgEloA, avgEloB);
  const expectedB = calculateExpectedScore(avgEloB, avgEloA);

  // 3. Actual scores
  const actualA = winningTeam === 'A' ? 1 : 0;
  const actualB = winningTeam === 'B' ? 1 : 0;

  // 4. Update ratings
  const updatedTeamA = teamAPlayers.map(p => {
    const k = getKFactor(p.total_games);
    const eloChange = k * (actualA - expectedA);
    return {
      ...p,
      elo_before: p.current_elo,
      elo_after: p.current_elo + eloChange,
      elo_change: eloChange
    };
  });

  const updatedTeamB = teamBPlayers.map(p => {
    const k = getKFactor(p.total_games);
    const eloChange = k * (actualB - expectedB);
    return {
      ...p,
      elo_before: p.current_elo,
      elo_after: p.current_elo + eloChange,
      elo_change: eloChange
    };
  });

  return { 
    updatedTeamA, 
    updatedTeamB,
    teamAAvgElo: avgEloA,
    teamBAvgElo: avgEloB,
    expectedWinA: expectedA,
    expectedWinB: expectedB
  };
}

// ----------------------------------------------------------------------
// v2 addition: map an Elo outcome into one skill_input(source='result')
// row per participating player. Offence/defence-neutral by default — the
// minis result has no per-line split — but if the player has an
// `od_preference` of 'offence' or 'defence', the result is biased toward
// that side. See SPEC_15 §3.
// ----------------------------------------------------------------------

// How much each player's result skill diverges from their post-match
// elo_after, biased by od_preference. Symmetric: offence-preference
// raises the offence side, lowers the defence side, by the same amount.
const OD_BIAS = 25;

/**
 * Compute the per-player offence/defence "result" signal given the
 * processMatch output for one team. Pure function; no DB I/O.
 *
 * @param {Array} updatedTeam - rows from processMatch().updatedTeamA/B,
 *   each augmented (or not) with `od_preference`.
 * @returns {Array<{player_id, offence_score, defence_score, elo_after, elo_change}>}
 */
export function resultSkillFromMatch(updatedTeam) {
  return updatedTeam.map(p => {
    const base = p.elo_after;
    let off = base;
    let def = base;
    if (p.od_preference === 'offence') {
      off = base + OD_BIAS;
      def = base - OD_BIAS;
    } else if (p.od_preference === 'defence') {
      off = base - OD_BIAS;
      def = base + OD_BIAS;
    }
    return {
      player_id: p.player_id,
      offence_score: off,
      defence_score: def,
      elo_after: p.elo_after,
      elo_change: p.elo_change,
    };
  });
}

