/**
 * Results — the player landing view ("Last Week"). Shows recent confirmed
 * matches for the player's context (auto-resolved from the session, or the
 * sole context if there's only one), newest first, with per-team rosters and
 * the winner highlighted. Public read (GET /api/matches).
 *
 * Landing design borrows V1's visual language (hero + stat cards + polished
 * scoreboards) but draws every figure from v2 endpoints — the V1 Dashboard
 * component itself hits dead v1 routes, so only the styling is shared.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, UserPlus, Users, CalendarDays, Activity, Shield, ArrowRight } from 'lucide-react';
import { v2, getContextId, getSessionId } from './_api.js';

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return String(d).slice(0, 10); }
}

function StatCard({ icon: Icon, value, label, accent }) {
  return (
    <div className={`bg-[#0B1120]/80 backdrop-blur-md border rounded-xl p-4 flex flex-col items-center justify-center text-center ${
      accent ? 'border-primary/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]' : 'border-white/10'
    }`}>
      <Icon className={`w-5 h-5 mb-2 ${accent ? 'text-primary' : 'text-indigo-400'}`} />
      <div className="text-3xl font-black text-white tabular-nums">{value}</div>
      <div className={`text-[10px] font-bold uppercase tracking-widest mt-1 ${accent ? 'text-primary' : 'text-slate-400'}`}>{label}</div>
    </div>
  );
}

function TeamColumn({ name, score, players, won }) {
  return (
    <div className={`flex-1 rounded-xl p-4 transition ${won ? 'bg-accent/10 border border-accent/30 shadow-[0_0_15px_rgba(245,158,11,0.08)]' : 'bg-white/5 border border-white/5'}`}>
      <div className="flex items-center justify-between">
        <span className={`font-bold tracking-tight ${won ? 'text-accent' : 'text-slate-200'}`}>{name}</span>
        <span className={`text-3xl font-black tabular-nums ${won ? 'text-accent' : 'text-slate-400'}`}>{score}</span>
      </div>
      {won && <span className="inline-block mt-1 text-[9px] font-bold uppercase tracking-widest text-accent bg-accent/10 px-2 py-0.5 rounded">Won</span>}
      <ul className="mt-3 space-y-0.5 text-xs text-slate-400">
        {players.map(p => (
          <li key={p.person_id}>
            <Link to={`/v2/profile/${p.person_id}`} className="hover:text-primary transition-colors">{p.name}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Results() {
  const [ctxId, setCtxId] = useState(getContextId());
  const [selDate, setSelDate] = useState(null);   // null = latest session
  const [data, setData] = useState(null);
  const [openEvent, setOpenEvent] = useState(null);
  const [playerCount, setPlayerCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const loggedIn = !!getSessionId();

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
    v2.matches(ctxId, selDate)
      .then(setData)
      .catch(e => setErr(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [ctxId, selDate]);

  // The "up next" banner and player count don't depend on the chosen week.
  useEffect(() => {
    if (!ctxId) return;
    v2.openEvent(ctxId).then(r => setOpenEvent(r.event)).catch(() => setOpenEvent(null));
    v2.leaderboard(ctxId).then(rows => setPlayerCount(rows.length)).catch(() => setPlayerCount(null));
  }, [ctxId]);

  const matches = data?.matches ?? [];
  const weeks = data?.weeks ?? [];
  const selected = data?.selected_date ?? null;
  const isLatest = selected && weeks.length > 0 && selected === weeks[0].date;
  const totalGames = weeks.reduce((s, w) => s + (w.n || 0), 0);

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-6xl mx-auto">

      {/* HERO — V1's signature gradient banner, v2 data */}
      <div className="glass-panel relative overflow-hidden p-8 md:p-10">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1598024220557-93ba2a488e02?auto=format&fit=crop&q=80')] bg-cover bg-center opacity-10 mix-blend-overlay" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#131C31] via-[#131C31]/80 to-transparent" />

        <div className="relative z-10">
          <h1 className="text-5xl md:text-6xl font-black tracking-tight leading-none uppercase">
            Mumbai's Ultimate<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-600 italic">Rankings</span>
          </h1>
          <p className="text-slate-400 font-medium tracking-wide mt-2">Track. Compete. Improve. Repeat.</p>

          <div className="flex flex-wrap gap-3 mt-6">
            <Link to="/v2/leaderboard" className="btn-primary flex items-center"><Trophy className="w-4 h-4 mr-2" /> View Leaderboard</Link>
            {loggedIn
              ? <Link to="/v2/me" className="btn-secondary flex items-center"><Shield className="w-4 h-4 mr-2" /> My Card</Link>
              : <Link to="/v2/join" className="btn-secondary flex items-center"><UserPlus className="w-4 h-4 mr-2" /> Join In</Link>}
          </div>

          <div className="grid grid-cols-3 gap-4 mt-8 max-w-md">
            <StatCard icon={Users} value={playerCount ?? '—'} label="Players" />
            <StatCard icon={CalendarDays} value={weeks.length || '—'} label="Sessions" />
            <StatCard icon={Activity} value={totalGames || '—'} label="Games" accent />
          </div>
        </div>
      </div>

      {/* Up next */}
      {openEvent && (
        <Link
          to={`/v2/e/${openEvent.share_token}`}
          className="block glass-panel p-5 border border-accent/30 bg-accent/5 hover:bg-accent/10 transition"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-accent font-semibold">Up next</div>
              <div className="text-lg font-bold mt-0.5">{openEvent.title}</div>
              <div className="text-sm text-slate-400">
                {fmtDate(openEvent.event_date)}
                {openEvent.event_time && ` · ${openEvent.event_time}`}
                {openEvent.location && ` · ${openEvent.location}`}
              </div>
            </div>
            <span className="shrink-0 px-3 py-1.5 rounded-lg bg-accent text-slate-900 text-sm font-semibold flex items-center">Sign up <ArrowRight className="w-4 h-4 ml-1" /></span>
          </div>
        </Link>
      )}

      {/* Results header + week selector */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-black tracking-widest uppercase text-slate-300 flex items-center">
            <CalendarDays className="w-4 h-4 mr-2 text-primary" /> {isLatest ? 'Last Week' : 'Results'}
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            {selected
              ? `${isLatest ? 'Most recent session' : 'Session'} — ${fmtDate(selected)}`
              : 'Recent results'}
          </p>
        </div>
        {weeks.length > 1 && (
          <label className="text-sm text-slate-400">
            <span className="mr-2">Week</span>
            <select
              value={selected ?? ''}
              onChange={e => setSelDate(e.target.value)}
              className="input-field py-1.5 px-2 text-sm w-auto inline-block"
            >
              {weeks.map(w => (
                <option key={w.date} value={w.date}>{fmtDate(w.date)} ({w.n})</option>
              ))}
            </select>
          </label>
        )}
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
