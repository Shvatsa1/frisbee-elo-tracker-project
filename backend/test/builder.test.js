/**
 * Chunk 4 sanity test: the N-team builder.
 *
 * Goals:
 *  - Snake-draft baseline keeps headline sums tight (spread < a tolerance).
 *  - Role-aware pass repairs a min-handlers violation when it's solvable.
 *  - Un-rated players carry a visible warning, never silently averaged.
 *  - Builder still works for 2 teams, 3 teams, 4 teams.
 */
import { buildTeams, snakeDraft, combinedBalanceMetric } from '../builderService.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function makeRoster(n, seedOffset = 0) {
  const positions = ['handler', 'cutter', 'cutter', 'hybrid'];
  return Array.from({ length: n }, (_, i) => ({
    player_id: i + 1 + seedOffset,
    headline_scalar: 900 + ((i * 37) % 400),
    attribute: {
      position: positions[i % positions.length],
      od_preference: i % 3 === 0 ? 'offence' : (i % 3 === 1 ? 'defence' : 'both'),
    },
  }));
}

console.log('--- snake-draft baseline ---');
const roster10 = makeRoster(10);
const baseline = snakeDraft(roster10, 2);
const ta = baseline[0].reduce((s, p) => s + p.headline_scalar, 0);
const tb = baseline[1].reduce((s, p) => s + p.headline_scalar, 0);
check('snake: each team has equal headcount',
  baseline[0].length === 5 && baseline[1].length === 5);
check('snake: sum spread < 200 on 10 players',
  Math.abs(ta - tb) < 200, `|A-B|=${Math.abs(ta - tb)}`);

console.log('\n--- buildTeams: 2 teams of 5, no constraints ---');
const r = buildTeams({ roster: roster10, num_teams: 2, team_size: 5 });
check('returns 2 teams', r.teams.length === 2);
check('spread is reasonable', r.spread < 300, `spread=${r.spread}`);
check('no warnings on fully-rated roster', r.warnings.length === 0);

console.log('\n--- buildTeams: 4 teams of 5 ---');
const roster20 = makeRoster(20);
const r4 = buildTeams({ roster: roster20, num_teams: 4, team_size: 5 });
check('returns 4 teams', r4.teams.length === 4);
check('every team has 5 players',
  r4.teams.every(t => t.players.length === 5),
  r4.teams.map(t => t.players.length).join(','));
check('every player appears exactly once',
  new Set(r4.teams.flatMap(t => t.players.map(p => p.player_id))).size === 20);

console.log('\n--- buildTeams: min-handlers constraint ---');
// Set 2 handlers per team requirement on a 12-player roster with 4 handlers
const customRoster = [
  { player_id: 1, headline_scalar: 1300, attribute: { position: 'handler' } },
  { player_id: 2, headline_scalar: 1280, attribute: { position: 'cutter'  } },
  { player_id: 3, headline_scalar: 1260, attribute: { position: 'cutter'  } },
  { player_id: 4, headline_scalar: 1240, attribute: { position: 'handler' } },
  { player_id: 5, headline_scalar: 1220, attribute: { position: 'cutter'  } },
  { player_id: 6, headline_scalar: 1200, attribute: { position: 'cutter'  } },
  { player_id: 7, headline_scalar: 1180, attribute: { position: 'handler' } },
  { player_id: 8, headline_scalar: 1160, attribute: { position: 'cutter'  } },
  { player_id: 9, headline_scalar: 1140, attribute: { position: 'cutter'  } },
  { player_id: 10, headline_scalar: 1120, attribute: { position: 'handler' } },
  { player_id: 11, headline_scalar: 1100, attribute: { position: 'cutter'  } },
  { player_id: 12, headline_scalar: 1080, attribute: { position: 'cutter'  } },
];
const rc = buildTeams({
  roster: customRoster, num_teams: 2, team_size: 6,
  constraints: { min_handlers_per_team: 2, headline_swap_window: 200 },
});
check('every team has ≥2 handlers',
  rc.teams.every(t => t.n_handlers >= 2),
  rc.teams.map(t => `t${t.team_label}=${t.n_handlers}h`).join(','));

console.log('\n--- buildTeams: un-rated warnings ---');
const mixed = [
  ...makeRoster(6),
  { player_id: 99, headline_scalar: 1000, rated: false, attribute: { position: 'cutter' } },
  { player_id: 100, headline_scalar: 1000, rated: false, attribute: { position: 'cutter' } },
];
const rmix = buildTeams({ roster: mixed, num_teams: 2, team_size: 4 });
check('un-rated → warnings emitted', rmix.warnings.length === 2, rmix.warnings.join(' | '));

const rmix2 = buildTeams({
  roster: mixed, num_teams: 2, team_size: 3, excludeUnrated: true,
});
check('excludeUnrated: only 6 players placed',
  rmix2.teams.reduce((s, t) => s + t.players.length, 0) === 6);
check('excludeUnrated emits an exclusion warning',
  rmix2.warnings.some(w => w.startsWith('excluded')));

console.log('\n--- buildTeams: error paths ---');
let threw = false;
try { buildTeams({ roster: makeRoster(3), num_teams: 4, team_size: 1 }); } catch { threw = true; }
check('throws when roster < num_teams', threw);

threw = false;
try { buildTeams({ roster: makeRoster(4), num_teams: 1, team_size: 4 }); } catch { threw = true; }
check('throws on num_teams < 2', threw);

console.log('\n--- combinedBalanceMetric (rating 0–100 + Elo 0–2500) ---');
const approxB = (a, b, t = 1e-6) => Math.abs(a - b) < t;
// 50/50 of rating 60 and Elo 1500 (→60 on 0–100) = 60.
check('50/50 mix of rating 60 + Elo 1500 = 60',
  approxB(combinedBalanceMetric(60, 1500), 60),
  `${combinedBalanceMetric(60, 1500)}`);
// rating-only weighting ignores Elo.
check('wElo=0 → pure rating', approxB(combinedBalanceMetric(70, 2500, { wRating: 1, wElo: 0 }), 70));
// elo-only weighting normalises Elo ÷25.
check('wRating=0 → Elo/25', approxB(combinedBalanceMetric(10, 1000, { wRating: 0, wElo: 1 }), 40));
// missing inputs fall back to mid-scale rating / 1000 Elo.
check('defaults when inputs missing', approxB(combinedBalanceMetric(undefined, undefined), (50 + 40) / 2));

console.log('\n--- summary ---');
const failed = results.filter(r => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('FAILURES:', failed);
  process.exitCode = 1;
}
