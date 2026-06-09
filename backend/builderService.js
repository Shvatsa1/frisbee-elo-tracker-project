/**
 * builderService — N-team heuristic (SPEC_15 §5).
 *
 * Inputs are pure: an array of roster players, each shaped as
 *
 *   {
 *     player_id: number,
 *     headline_scalar: number,       // from player_skill (or default 1000)
 *     offence_skill?: number,
 *     defence_skill?: number,
 *     attribute?: {
 *       position?: 'handler'|'cutter'|'hybrid',
 *       hand?: 'left'|'right',
 *       style?: 'direct'|'short'|'aerial',
 *       od_preference?: 'offence'|'defence'|'both',
 *     },
 *     rated?: boolean,               // false → un-rated; see §"Edge cases"
 *   }
 *
 * Outputs N teams:
 *
 *   {
 *     teams: [{ team_label: 1, players: [...], total_headline, n_handlers, ... }, ...],
 *     spread: max(total_headline) - min(total_headline),
 *     warnings: ["player X is un-rated; placed with default", ...],
 *   }
 *
 * Algorithm:
 *   1. Snake-draft by headline_scalar desc, alternating direction every
 *      round, for a balanced-sum baseline.
 *   2. Role-aware local swaps: while some team violates a constraint
 *      (min handlers per team, O/D balance), find two players (one each
 *      from the offending pair of teams) with similar headline_scalars
 *      whose swap repairs the mix without inflating the sum-spread above
 *      its current min. Bounded by MAX_SWAP_ITERS.
 *
 * Pure in-memory; expect ms-scale for ≤30 players. Persistence is the
 * route layer's job (`POST /api/build` writes team_build + team_build_player).
 *
 * The `headline_scalar` the builder balances on is itself a BLEND of two
 * things the route combines up-front (see combinedBalanceMetric): the human
 * rating (0–100) and the player's Elo (0–2500, normalised to 0–100). So teams
 * are evened out across both "how good people think they are" and "how results
 * have actually gone", with tunable weights.
 */

const MAX_SWAP_ITERS = 200;

// ---------- helpers ----------

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function teamStats(team) {
  const total_headline = team.reduce((s, p) => s + p.headline_scalar, 0);
  const n_handlers = team.filter(p => p.attribute?.position === 'handler').length;
  const n_offence  = team.filter(p => p.attribute?.od_preference === 'offence').length;
  const n_defence  = team.filter(p => p.attribute?.od_preference === 'defence').length;
  return { total_headline, n_handlers, n_offence, n_defence };
}

function spread(teams) {
  const totals = teams.map(t => teamStats(t).total_headline);
  return Math.max(...totals) - Math.min(...totals);
}

function validate(roster, num_teams, team_size) {
  if (num_teams < 2) throw new Error('num_teams must be >= 2');
  if (team_size < 1) throw new Error('team_size must be >= 1');
  if (roster.length < num_teams) {
    throw new Error(`roster too small: ${roster.length} players for ${num_teams} teams`);
  }
}

// ---------- step 1: snake-draft baseline ----------

export function snakeDraft(roster, num_teams) {
  const sorted = [...roster].sort((a, b) => b.headline_scalar - a.headline_scalar);
  const teams = Array.from({ length: num_teams }, () => []);
  let dir = 1;
  let pos = 0;
  for (const p of sorted) {
    teams[pos].push(p);
    if (dir === 1 && pos === num_teams - 1) {
      dir = -1; // reverse direction (snake) without moving
    } else if (dir === -1 && pos === 0) {
      dir = 1;
    } else {
      pos += dir;
    }
  }
  return teams;
}

// ---------- step 2: role-aware swaps ----------

/**
 * Try to repair role-mix violations by swapping players of similar
 * headline_scalar across teams. Returns the (possibly re-balanced) teams.
 */
export function roleAwareRebalance(teams, constraints) {
  const minHandlers = constraints.min_handlers_per_team ?? 0;
  const odTolerance = constraints.od_tolerance ?? 999; // how unequal O/D can be
  const headlineSwapWindow = constraints.headline_swap_window ?? 75;

  const violations = () => {
    const out = [];
    teams.forEach((t, idx) => {
      const s = teamStats(t);
      if (s.n_handlers < minHandlers) out.push({ team: idx, kind: 'handlers_low', s });
      if (Math.abs(s.n_offence - s.n_defence) > odTolerance) {
        out.push({ team: idx, kind: 'od_imbalance', s });
      }
    });
    return out;
  };

  let bestSpread = spread(teams);

  for (let iter = 0; iter < MAX_SWAP_ITERS; iter++) {
    const v = violations();
    if (v.length === 0) return teams;

    const offending = v[0];

    let swapped = false;
    for (let other = 0; other < teams.length && !swapped; other++) {
      if (other === offending.team) continue;

      const tA = teams[offending.team];
      const tB = teams[other];
      const tBStats = teamStats(tB);

      for (let i = 0; i < tA.length && !swapped; i++) {
        for (let j = 0; j < tB.length && !swapped; j++) {
          const a = tA[i];
          const b = tB[j];

          // Only consider swaps of players with similar headline so we
          // don't trash the sum-spread.
          if (Math.abs(a.headline_scalar - b.headline_scalar) > headlineSwapWindow) continue;

          // Hypothetical: would the swap reduce the offending violation?
          let helps = false;
          if (offending.kind === 'handlers_low') {
            helps = b.attribute?.position === 'handler'
                 && a.attribute?.position !== 'handler'
                 && tBStats.n_handlers - 1 >= minHandlers;
          } else if (offending.kind === 'od_imbalance') {
            // tA needs to gain whichever side is short on it.
            const aS = teamStats(tA);
            const tANeedsOff = aS.n_offence < aS.n_defence;
            helps = (tANeedsOff
              ? b.attribute?.od_preference === 'offence' && a.attribute?.od_preference === 'defence'
              : b.attribute?.od_preference === 'defence' && a.attribute?.od_preference === 'offence');
          }
          if (!helps) continue;

          // Perform swap, accept only if spread does not get worse.
          tA[i] = b;
          tB[j] = a;
          const newSpread = spread(teams);
          if (newSpread <= bestSpread + headlineSwapWindow) {
            bestSpread = Math.min(bestSpread, newSpread);
            swapped = true;
          } else {
            // revert
            tA[i] = a;
            tB[j] = b;
          }
        }
      }
    }

    if (!swapped) break; // no helpful swap exists; stop
  }
  return teams;
}

// ---------- main entry ----------

export function buildTeams({
  roster,
  num_teams,
  team_size,
  constraints = {},
  excludeUnrated = false,
}) {
  validate(roster, num_teams, team_size);

  const warnings = [];
  let pool = roster;

  // un-rated handling — spec §"Edge cases": never silently average
  const unrated = pool.filter(p => p.rated === false);
  if (excludeUnrated && unrated.length > 0) {
    pool = pool.filter(p => p.rated !== false);
    warnings.push(`excluded ${unrated.length} un-rated player(s): ${unrated.map(p => p.player_id).join(', ')}`);
    if (pool.length < num_teams) {
      throw new Error('not enough rated players to fill all teams');
    }
  } else {
    for (const u of unrated) {
      warnings.push(`player_id ${u.player_id} is un-rated; placed with default headline ${u.headline_scalar}`);
    }
  }

  const baseline = snakeDraft(pool, num_teams);
  const balanced = roleAwareRebalance(baseline, constraints);

  const out = balanced.map((players, idx) => {
    const s = teamStats(players);
    return {
      team_label: idx + 1,
      players,
      total_headline: s.total_headline,
      avg_headline: players.length > 0 ? s.total_headline / players.length : 0,
      n_handlers: s.n_handlers,
      n_offence: s.n_offence,
      n_defence: s.n_defence,
    };
  });

  return {
    teams: out,
    spread: spread(balanced),
    warnings,
  };
}

// ----------------------------------------------------------------------
// Balance metric: combine the human rating (0–100) with Elo (0–2500).
// Elo is normalised to 0–100 (÷25) so the two live on the same scale, then
// weighted. Default 50/50. Early on (few/no games) callers can lean on rating
// by raising wRating. Returns a single 0–100-ish number to balance teams on.
// ----------------------------------------------------------------------
export const ELO_TO_RATING = 1 / 25;   // 0–2500 Elo → 0–100
export const DEFAULT_W_RATING = 0.5;
export const DEFAULT_W_ELO = 0.5;

export function combinedBalanceMetric(
  rating, elo, { wRating = DEFAULT_W_RATING, wElo = DEFAULT_W_ELO } = {},
) {
  const r = Number.isFinite(rating) ? rating : 50;          // mid-scale default
  const e = (Number.isFinite(elo) ? elo : 1000) * ELO_TO_RATING;
  const wSum = wRating + wElo;
  if (wSum <= 0) return r;
  return (wRating * r + wElo * e) / wSum;
}

// Re-export the seed-able shuffle for any caller that wants jittered
// draft order (e.g. to break ties deterministically across runs).
export const _internals = { shuffleInPlace };
