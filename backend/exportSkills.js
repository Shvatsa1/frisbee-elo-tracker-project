/**
 * Skills export — players as rows, skills as columns.
 *
 * Produces the admin-facing spreadsheet of a context's roster:
 * one row per player, columns for the blended offence/defence skill,
 * the headline scalar, rating provenance (n_peers / n_results), and the
 * result-Elo carried from match history.
 *
 * Used by:
 *   - GET /api/export/skills?context_id=  (server.js) — streams .xlsx
 *   - scripts/export_skills.js            — writes an .xlsx file locally
 *
 * The query is the same shape as /api/leaderboard so the spreadsheet always
 * matches what the app shows. player_skill is LEFT JOINed: a freshly-ported
 * player who hasn't been admin-rated yet shows blank skill columns (not 1000),
 * which is the honest signal that they still need rating.
 */
import ExcelJS from 'exceljs';

const ROSTER_SQL = `
  SELECT
    pr.name                AS name,
    ps.offence_skill       AS offence_skill,
    ps.defence_skill       AS defence_skill,
    ps.headline_scalar     AS headline_scalar,
    ps.n_peers             AS n_peers,
    ps.n_results           AS n_results,
    psc.current_elo        AS current_elo,
    psc.total_games        AS total_games,
    psc.wins               AS wins,
    psc.losses             AS losses,
    psc.win_percentage     AS win_percentage
  FROM player pl
  JOIN person pr                        ON pr.person_id = pl.person_id
  LEFT JOIN player_skill ps             ON ps.player_id = pl.player_id
  LEFT JOIN player_statistics_cache psc ON psc.player_id = pl.player_id
  WHERE pl.context_id = $1
  ORDER BY ps.headline_scalar DESC NULLS LAST, pr.name ASC
`;

/** Fetch the roster rows for a context. */
export async function fetchRoster(contextId, db) {
  const { rows } = await db.query(ROSTER_SQL, [contextId]);
  return rows;
}

const COLUMNS = [
  { header: 'Player',        key: 'name',           width: 24 },
  { header: 'Offence',       key: 'offence_skill',  width: 12 },
  { header: 'Defence',       key: 'defence_skill',  width: 12 },
  { header: 'Headline',      key: 'headline_scalar', width: 12 },
  { header: 'Result Elo',    key: 'current_elo',    width: 12 },
  { header: 'Games',         key: 'total_games',    width: 9 },
  { header: 'Wins',          key: 'wins',           width: 8 },
  { header: 'Losses',        key: 'losses',         width: 8 },
  { header: 'Win %',         key: 'win_percentage', width: 9 },
  { header: '# Peer ratings', key: 'n_peers',       width: 14 },
  { header: '# Results',     key: 'n_results',      width: 11 },
];

const NUM_FMT = { round1: '0.0', whole: '0', pct: '0.0' };

/**
 * Build an ExcelJS workbook for a context's roster.
 * @param {number} contextId
 * @param {{query: Function}} db   pool or client
 * @param {string} [contextName]   used for the sheet title; optional
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildSkillsWorkbook(contextId, db, contextName) {
  const rows = await fetchRoster(contextId, db);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'UltiElo';
  wb.created = new Date();
  const sheetName = (contextName || `Context ${contextId}`).slice(0, 31); // Excel 31-char sheet cap
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = COLUMNS;

  // Header styling.
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };

  for (const r of rows) {
    ws.addRow({
      name: r.name,
      offence_skill: r.offence_skill == null ? null : Number(r.offence_skill),
      defence_skill: r.defence_skill == null ? null : Number(r.defence_skill),
      headline_scalar: r.headline_scalar == null ? null : Number(r.headline_scalar),
      current_elo: r.current_elo == null ? null : Number(r.current_elo),
      total_games: r.total_games ?? null,
      wins: r.wins ?? null,
      losses: r.losses ?? null,
      win_percentage: r.win_percentage == null ? null : Number(r.win_percentage),
      n_peers: r.n_peers ?? 0,
      n_results: r.n_results ?? 0,
    });
  }

  // Number formats per column.
  ['offence_skill', 'defence_skill', 'headline_scalar', 'current_elo'].forEach(key => {
    ws.getColumn(key).numFmt = NUM_FMT.round1;
  });
  ws.getColumn('win_percentage').numFmt = NUM_FMT.pct;

  // AutoFilter across the header.
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  return wb;
}
