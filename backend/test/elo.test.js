/**
 * Chunk 3 sanity test: eloService still computes K=40/K=20 correctly
 * and the new resultSkillFromMatch() produces the right o/d signals.
 */
import {
  calculateExpectedScore,
  getKFactor,
  processMatch,
  resultSkillFromMatch,
} from '../eloService.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function approx(a, b, eps = 1e-3) { return Math.abs(a - b) < eps; }

console.log('--- core math unchanged ---');
check('K=40 for new player', getKFactor(0) === 40);
check('K=40 still under 15', getKFactor(14) === 40);
check('K=20 at 15 games', getKFactor(15) === 20);
check('expectedScore symmetric', approx(calculateExpectedScore(1000, 1000), 0.5));
check('expectedScore higher Elo wins more', calculateExpectedScore(1400, 1000) > 0.9);

console.log('\n--- processMatch end-to-end ---');
const teamA = [
  { player_id: 1, current_elo: 1000, total_games: 0 },
  { player_id: 2, current_elo: 1000, total_games: 0 },
];
const teamB = [
  { player_id: 3, current_elo: 1000, total_games: 20 },
  { player_id: 4, current_elo: 1000, total_games: 20 },
];
const out = processMatch(teamA, teamB, 'A');
check('team A wins → elo_change > 0', out.updatedTeamA[0].elo_change > 0);
check('team B loses → elo_change < 0', out.updatedTeamB[0].elo_change < 0);
check('team A K=40 produces +20 swing on 50/50', approx(out.updatedTeamA[0].elo_change, 20));
check('team B K=20 produces -10 swing on 50/50', approx(out.updatedTeamB[0].elo_change, -10));

console.log('\n--- resultSkillFromMatch ---');
const neutral = resultSkillFromMatch([
  { player_id: 1, elo_after: 1020, elo_change: 20 },
]);
check('neutral player: off === def === elo_after',
  neutral[0].offence_score === 1020 && neutral[0].defence_score === 1020);

const offHeavy = resultSkillFromMatch([
  { player_id: 2, elo_after: 1020, elo_change: 20, od_preference: 'offence' },
]);
check('offence-pref: offence > defence', offHeavy[0].offence_score > offHeavy[0].defence_score);
check('offence-pref: midpoint preserved',
  approx((offHeavy[0].offence_score + offHeavy[0].defence_score) / 2, 1020));

const defHeavy = resultSkillFromMatch([
  { player_id: 3, elo_after: 1020, elo_change: 20, od_preference: 'defence' },
]);
check('defence-pref: defence > offence', defHeavy[0].defence_score > defHeavy[0].offence_score);

console.log('\n--- summary ---');
const failed = results.filter(r => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('FAILURES:', failed);
  process.exitCode = 1;
}
