/**
 * Builder screen.
 *
 * Pick a context, select roster (signups for today), set `num_teams`
 * + `team_size` + min-handlers constraint, hit `POST /api/build`.
 * Persists a `team_build` and shows the N teams with per-team totals,
 * spread, and any warnings (un-rated players, etc.).
 */
import { useEffect, useState } from 'react';
import { v2 } from './_api.js';
import ActingAs from './_ActingAs.jsx';
import ContextPicker from './_ContextPicker.jsx';

export default function Builder() {
  const [actor, setActor]   = useState(null);
  const [ctxId, setCtxId]   = useState(null);
  const [players, setPlayers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [numTeams, setNumTeams] = useState(2);
  const [teamSize, setTeamSize] = useState(5);
  const [minHandlers, setMinHandlers] = useState(1);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!ctxId) { setPlayers([]); return; }
    v2.leaderboard(ctxId).then(setPlayers);
  }, [ctxId]);

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function build() {
    setErr(''); setResult(null); setBusy(true);
    try {
      const r = await v2.buildTeams({
        context_id: ctxId,
        roster: [...selected],
        num_teams: Number(numTeams),
        team_size: Number(teamSize),
        constraints: { min_handlers_per_team: Number(minHandlers), headline_swap_window: 200 },
      });
      setResult(r);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally { setBusy(false); }
  }

  const enoughSelected = selected.size >= numTeams;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Team Builder</h1>
        <p className="text-slate-400">Generate balanced teams from today's signups.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <ActingAs onChange={setActor} />
        <ContextPicker onChange={setCtxId} />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Roster */}
        <div className="glass-panel p-4 lg:col-span-1 h-[600px] flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-bold">Roster ({selected.size} selected)</h2>
            <button className="text-xs text-slate-400 hover:text-white"
                    onClick={() => setSelected(new Set(players.map(p => p.player_id)))}>
              select all
            </button>
          </div>
          <div className="overflow-y-auto space-y-1">
            {players.map(p => (
              <label key={p.player_id} className={`flex items-center justify-between p-2 rounded cursor-pointer ${selected.has(p.player_id) ? 'bg-primary/20 border border-primary/40' : 'bg-white/5 hover:bg-white/10'}`}>
                <input type="checkbox" className="hidden"
                       checked={selected.has(p.player_id)} onChange={() => toggle(p.player_id)} />
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-slate-400">
                  {p.headline_scalar != null ? Math.round(p.headline_scalar) : '—'}
                </span>
              </label>
            ))}
            {players.length === 0 && <div className="text-slate-400 text-sm p-4">No players in this context.</div>}
          </div>
        </div>

        {/* Settings + results */}
        <div className="lg:col-span-2 space-y-4">
          <div className="glass-panel p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumField label="Number of teams" value={numTeams} onChange={setNumTeams} min={2} max={8} />
            <NumField label="Team size" value={teamSize} onChange={setTeamSize} min={2} max={15} />
            <NumField label="Min handlers / team" value={minHandlers} onChange={setMinHandlers} min={0} max={5} />
            <button onClick={build} disabled={!enoughSelected || !ctxId || !actor || busy}
                    className="btn-primary col-span-2 md:col-span-1 disabled:opacity-50 disabled:cursor-not-allowed">
              {busy ? 'Building…' : 'Build Teams'}
            </button>
          </div>

          {err && <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">{err}</div>}

          {result && (
            <div className="space-y-3">
              <div className="text-sm text-slate-400">
                build_id <span className="text-slate-200 font-mono">{result.build_id}</span>
                {' · '}spread {Math.round(result.spread)}
              </div>
              {result.warnings?.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 px-3 py-2 rounded-lg text-sm">
                  {result.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
              <div className="grid md:grid-cols-2 gap-3">
                {result.teams.map(t => (
                  <div key={t.team_label} className="glass-panel p-4">
                    <div className="flex justify-between items-baseline mb-2">
                      <h3 className="font-bold">Team {t.team_label}</h3>
                      <span className="text-xs text-slate-400">
                        Σ {Math.round(t.total_headline)} · avg {Math.round(t.avg_headline)} · {t.n_handlers}h
                      </span>
                    </div>
                    <ul className="space-y-1 text-sm">
                      {t.players.map(p => (
                        <li key={p.player_id} className="flex justify-between text-slate-300">
                          <span>{p.name}{p.attribute?.position ? ` · ${p.attribute.position}` : ''}</span>
                          <span className="text-slate-500">{Math.round(p.headline_scalar)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, min, max }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block">{label}</label>
      <input type="number" min={min} max={max} value={value}
             onChange={e => onChange(e.target.value)}
             className="input-field" />
    </div>
  );
}
