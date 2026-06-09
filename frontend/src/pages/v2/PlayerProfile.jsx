/**
 * Public player profile.
 *
 * One `person` may have multiple `player` rows (one per context).
 * This page shows skill + history grouped by context.
 *
 * Reads `GET /api/player/:person_id` — no auth.
 */
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { v2 } from './_api.js';

export default function PlayerProfile() {
  const { person_id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    v2.playerProfile(person_id)
      .then(setData)
      .catch(e => setErr(e?.response?.data?.error || e.message));
  }, [person_id]);

  if (err) return <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg">{err}</div>;
  if (!data) return <div className="text-slate-400">Loading...</div>;

  const { person, players, history } = data;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{person.name}</h1>
        <p className="text-slate-400 text-sm">person_id {person.person_id} · joined {new Date(person.created_at).toLocaleDateString()}</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {players.map(p => (
          <div key={p.player_id} className="glass-panel p-5">
            <div className="flex justify-between items-baseline mb-3">
              <h3 className="font-bold">
                <Link to={`/v2/leaderboard?context_id=${p.context_id}`} className="hover:text-primary">
                  {p.context_name}
                </Link>
              </h3>
              <span className="text-xs text-slate-500 uppercase">{p.context_kind}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Headline" value={p.headline_scalar} accent />
              <Stat label="Offence"  value={p.offence_skill} />
              <Stat label="Defence"  value={p.defence_skill} />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center mt-3 text-xs text-slate-400">
              <div>{p.total_games ?? 0} games</div>
              <div>{p.n_peers ?? 0} peer ratings</div>
              <div>{p.n_results ?? 0} match results</div>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-panel p-5">
        <h2 className="text-xl font-bold mb-3">Recent matches</h2>
        {history.length === 0 && <div className="text-slate-400 text-sm">No confirmed matches yet.</div>}
        <ul className="divide-y divide-white/5">
          {history.map(h => (
            <li key={h.match_id} className="py-3 flex justify-between items-center text-sm">
              <div>
                <div className="font-medium text-slate-200">
                  {h.team_a_name} {h.team_a_score} – {h.team_b_score} {h.team_b_name}
                  <span className="ml-2 text-xs text-slate-500">[{h.context_name}]</span>
                  {h.status !== 'confirmed' && (
                    <span className="ml-2 text-xs uppercase text-amber-400">{h.status}</span>
                  )}
                </div>
                <div className="text-xs text-slate-400">
                  {new Date(h.match_date).toLocaleDateString()} · played for Team {h.team}
                  {h.location ? ` · ${h.location}` : ''}
                </div>
              </div>
              <div className="text-right">
                {h.elo_change != null && (
                  <span className={h.elo_change > 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {h.elo_change > 0 ? '↑' : '↓'} {Math.abs(Math.round(h.elo_change))}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div className={`text-2xl font-bold ${accent ? 'text-accent' : 'text-slate-200'}`}>
        {value != null ? Math.round(value) : '—'}
      </div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
