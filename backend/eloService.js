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
