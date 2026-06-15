/**
 * PlayerCard — FIFA-style visual card for a player in one context.
 *
 * Shows: photo (or initials), name, position, the headline RATING (0–100,
 * human-judgement blend) and ELO (match results), plus the six self-rated
 * attributes as bars. Attributes are null until the player fills their card,
 * so they degrade to "—". Pure presentational; data comes from
 * GET /api/player/:person_id.
 */

const ATTRS = [
  { key: 'throwing',  abbr: 'THR' },
  { key: 'cutting',   abbr: 'CUT' },
  { key: 'handling',  abbr: 'HAN' },
  { key: 'defense',   abbr: 'DEF' },
  { key: 'speed',     abbr: 'SPD' },
  { key: 'endurance', abbr: 'END' },
];

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map(s => s[0]?.toUpperCase() ?? '').join('');
}

function ratingColor(v) {
  if (v == null) return 'text-slate-400';
  if (v >= 80) return 'text-emerald-400';
  if (v >= 60) return 'text-accent';
  if (v >= 40) return 'text-amber-400';
  return 'text-slate-300';
}

function AttrBar({ abbr, value }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 text-xs font-mono text-slate-400">{abbr}</span>
      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-7 text-right text-xs tabular-nums text-slate-300">
        {value == null ? '—' : Math.round(value)}
      </span>
    </div>
  );
}

/**
 * @param {string} name
 * @param {string|null} photoUrl
 * @param {object} player  one row from GET /api/player → players[]
 * @param {object} [options]  { showElo, showRating, showAttrs } — display config
 */
export default function PlayerCard({ name, photoUrl, player, options = {} }) {
  const { showElo = true, showRating = true, showAttrs = true } = options;
  const rating = player?.headline_scalar;
  const elo = player?.current_elo;
  const hasAnyAttr = ATTRS.some(a => player?.[a.key] != null);

  return (
    <div className="relative rounded-2xl p-5 bg-gradient-to-br from-surface to-slate-900/60 border border-white/10 shadow-xl overflow-hidden">
      {/* Rating badge — top-left, FIFA style */}
      {showRating && (
        <div className="absolute top-4 left-4 text-center leading-none">
          <div className={`text-4xl font-extrabold ${ratingColor(rating)}`}>
            {rating != null ? Math.round(rating) : '—'}
          </div>
          <div className="text-[10px] tracking-widest text-slate-500 mt-0.5">RATING</div>
          {player?.position && (
            <div className="text-xs font-semibold text-slate-300 uppercase mt-1">{player.position.slice(0, 3)}</div>
          )}
        </div>
      )}

      {/* Photo / initials — top-right */}
      <div className="flex justify-end">
        <div className="w-20 h-20 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center overflow-hidden">
          {photoUrl
            ? <img src={photoUrl} alt={name} className="w-full h-full object-cover" />
            : <span className="text-2xl font-bold text-slate-400">{initials(name)}</span>}
        </div>
      </div>

      {/* Name + context */}
      <div className="mt-3">
        <h3 className="text-lg font-bold leading-tight">{name}</h3>
        <p className="text-xs text-slate-500">
          {player?.context_name}
          {player?.style ? ` · ${player.style}` : ''}
          {player?.hand ? ` · ${player.hand} hand` : ''}
        </p>
      </div>

      {/* Rating + Elo headline row */}
      <div className="grid grid-cols-2 gap-2 mt-4">
        {showRating && (
          <div className="rounded-lg bg-white/5 px-3 py-2">
            <div className="text-[10px] text-slate-500">OFF / DEF</div>
            <div className="text-sm font-semibold text-slate-200">
              {player?.offence_skill != null ? Math.round(player.offence_skill) : '—'}
              <span className="text-slate-500"> / </span>
              {player?.defence_skill != null ? Math.round(player.defence_skill) : '—'}
            </div>
          </div>
        )}
        {showElo && (
          <div className="rounded-lg bg-white/5 px-3 py-2">
            <div className="text-[10px] text-slate-500">ELO</div>
            <div className="text-sm font-semibold text-slate-200">
              {elo != null ? Math.round(elo) : '—'}
              {player?.total_games != null && (
                <span className="text-xs text-slate-500 font-normal"> · {player.total_games}g</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Six attributes */}
      {showAttrs && (
        <div className="mt-4 space-y-1.5">
          {ATTRS.map(a => <AttrBar key={a.key} abbr={a.abbr} value={player?.[a.key]} />)}
          {!hasAnyAttr && (
            <p className="text-[11px] text-slate-500 pt-1">Attributes appear once this player fills their card.</p>
          )}
        </div>
      )}

      {/* W/L footer */}
      {(player?.wins != null || player?.losses != null) && (
        <div className="mt-4 pt-3 border-t border-white/5 flex justify-between text-xs text-slate-400">
          <span>{player.wins ?? 0}W · {player.losses ?? 0}L</span>
          <span>{player.n_peers ?? 0} peer ratings</span>
        </div>
      )}
    </div>
  );
}
