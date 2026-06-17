/**
 * parse_v1_dump.js — extract the 18 v1 minis games from a pg_dump (.sql) of the
 * refreshed v1 DB into a self-describing JSON, BEFORE any transform/import.
 *
 * Follows the data-preservation rule: the dump is the expensive-to-reproduce raw
 * artifact; we persist a normalised, append-only snapshot of it so the import can
 * be re-derived without re-querying v1.
 *
 * Usage:
 *   node scripts/parse_v1_dump.js <path-to-dump.sql> [out.json]
 * Default out: migrations/v1_data/v1_games_18.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dumpPath = process.argv[2];
if (!dumpPath) { console.error('usage: node scripts/parse_v1_dump.js <dump.sql> [out.json]'); process.exit(1); }
const outPath = process.argv[3] || path.join(__dirname, '..', 'migrations', 'v1_data', 'v1_games_18.json');

const sql = fs.readFileSync(dumpPath, 'utf8');
const lines = sql.split(/\r?\n/);

// Generic COPY-block reader: returns array of tab-split rows for the table whose
// COPY statement contains `marker`.
function readCopy(marker) {
  const rows = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (line.startsWith('COPY ') && line.includes(marker)) inBlock = true;
      continue;
    }
    if (line === '\\.') break;
    rows.push(line.split('\t'));
  }
  return rows;
}

// players: (player_id, player_name, current_elo, total_games, wins, losses, created_at)
const players = {};
for (const r of readCopy('public.players ')) {
  players[parseInt(r[0], 10)] = r[1];
}

// matches: (match_id, match_date, location, team_a_score, team_b_score, winning_team, ...names)
const matchMeta = {};
for (const r of readCopy('public.matches ')) {
  const id = parseInt(r[0], 10);
  matchMeta[id] = {
    match_id: id,
    date: r[1],
    location: r[2] === '\\N' ? null : r[2],
    a_score: parseInt(r[3], 10),
    b_score: parseInt(r[4], 10),
    winner: r[5],                       // 'A' | 'B'
    team_a_name: r[r.length - 2] === '\\N' ? null : r[r.length - 2],
    team_b_name: r[r.length - 1] === '\\N' ? null : r[r.length - 1],
    teamA: [],
    teamB: [],
  };
}

// match_players: (id, match_id, player_id, team, ...elo)
for (const r of readCopy('public.match_players ')) {
  const matchId = parseInt(r[1], 10);
  const playerId = parseInt(r[2], 10);
  const team = r[3];
  const m = matchMeta[matchId];
  if (!m) continue;
  (team === 'A' ? m.teamA : m.teamB).push(playerId);
}

// Chronological order: by date, then by match_id within a date (entry order).
const matches = Object.values(matchMeta).sort((a, b) =>
  a.date === b.date ? a.match_id - b.match_id : a.date.localeCompare(b.date),
);

const out = {
  _meta: {
    source_dump: path.basename(dumpPath),
    extracted_at: new Date().toISOString(),
    note: 'Normalised snapshot of refreshed v1 frisbee_elo DB. player ids/names are V1 ids. Append-only reference data.',
    n_players: Object.keys(players).length,
    n_matches: matches.length,
  },
  players,
  matches,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`Wrote ${outPath}`);
console.log(`  players: ${out._meta.n_players}  matches: ${matches.length}`);
for (const m of matches) {
  console.log(`  m${m.match_id} ${m.date} ${m.team_a_name} ${m.a_score}-${m.b_score} ${m.team_b_name} (win ${m.winner}) [${m.teamA.length}v${m.teamB.length}]`);
}
