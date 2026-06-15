/**
 * Results — the player landing view ("Last Week"). Shows recent confirmed
 * matches for the player's context (auto-resolved from the session, or the
 * sole context if there's only one), newest first, with per-team rosters and
 * the winner highlighted. Public read (GET /api/matches).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { v2, getContextId } from './_api.js';

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return String(d).slice(0, 10); }
}

function TeamColumn({ name, score, players, won }) {
  return (
    <div className={`flex-1 rounded-xl p-3 ${won ? 'bg-accent/10 border border-accent/30' : 'bg-white/5 border border-white/5'}`}>
      <div className="flex items-baseline justify-between">
        <span className={`font-semibold ${won ? 'text-accent' : 'text-slate-200'}`}>{name}</span>
        <span className={`text-2xl font-bold tabular-nums ${won ? 'text-accent' : 'text-slate-300'}`}>{score}</span>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-slate-400">
        {players.map(p => (
          <li key={p.person_id}>
            <Link to={`/v2/profile/${p.person_id}`} className="hover:text-primary">{p.name}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Results() {
  const [ctxId, setCtxId] = useState(getContextId());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // Auto-resolve context: stored session context, else the only context.
  useEffect(() => {
    if (ctxId) return;
    v2.listContexts()
      .then(cs => { if (cs.length) setCtxId(cs[0].context_id); else setLoading(false); })
      .catch(() => setLoading(false));
  }, [ctxId]);

  useEffect(() => {
    if (!ctxId) return;
    setLoading(true); setErr('');
    v2.matches(ctxId)
      .then(setData)
      .catch(e => setErr(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [ctxId]);

  const matches = data?.matches ?? [];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Last Week</h1>
        <p className="text-slate-400">
          {data?.latest_date ? `Most recent session — ${fmtDate(data.latest_date)}` : 'Recent results'}
        </p>
      </div>

      {err && <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">{err}</div>}
      {loading && <div className="text-slate-400">Loading…</div>}

      {!loading && matches.length === 0 && (
        <div className="glass-panel p-8 text-center space-y-3">
          <p className="text-slate-300 font-medium">No games recorded yet.</p>
          <p className="text-slate-400 text-sm">
            While you’re here — rate yourself and your teammates so the team-builder has data.
          </p>
          <div className="flex justify-center gap-3 pt-1">
            <Link to="/v2/me" className="px-4 py-2 rounded-lg bg-primary/15 text-primary text-sm font-medium hover:bg-primary/25">Rate Yourself</Link>
            <Link to="/v2/me/rate" className="px-4 py-2 rounded-lg bg-white/5 text-slate-200 text-sm font-medium hover:bg-white/10">Rate Teammates</Link>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {matches.map(m => {
          const aWon = m.winning_team === 'A';
          return (
            <div key={m.match_id} className="glass-panel p-4">
              <div className="flex items-center justify-between mb-3 text-xs text-slate-500">
                <span>{fmtDate(m.match_date)}</span>
                {m.location && <span>{m.location}</span>}
              </div>
              <div className="flex items-stretch gap-3">
                <TeamColumn name={m.team_a_name} score={m.team_a_score} players={m.team_a_players} won={aWon} />
                <div className="flex items-center text-slate-500 text-sm font-medium">vs</div>
                <TeamColumn name={m.team_b_name} score={m.team_b_score} players={m.team_b_players} won={!aWon} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
