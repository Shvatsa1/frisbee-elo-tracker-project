/**
 * Public per-context leaderboard.
 *
 * Reads from `GET /api/leaderboard?context_id=...` (no auth).
 * Sorted by `headline_scalar desc` on the server; offence/defence
 * shown alongside Elo for transparency.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { v2 } from './_api.js';
import ContextPicker from './_ContextPicker.jsx';

export default function Leaderboard() {
  const [ctxId, setCtxId] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!ctxId) { setRows([]); return; }
    setLoading(true); setErr('');
    v2.leaderboard(ctxId)
      .then(setRows)
      .catch(e => setErr(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [ctxId]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
          <p className="text-slate-400">
            Blended skill (admin + peer + result), per context. Public.
          </p>
        </div>
        <div className="w-full md:w-72">
          <ContextPicker onChange={setCtxId} />
        </div>
      </div>

      {err && <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">{err}</div>}
      {loading && <div className="text-slate-400">Loading...</div>}

      {!ctxId && !loading && (
        <div className="glass-panel p-8 text-center text-slate-400">Pick a context to see its leaderboard.</div>
      )}

      {ctxId && !loading && (
        <div className="glass-panel overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-white/5 border-b border-white/10 text-sm text-slate-400">
                <th className="p-4 font-medium">Rank</th>
                <th className="p-4 font-medium">Player</th>
                <th className="p-4 font-medium text-right">Headline</th>
                <th className="p-4 font-medium text-right">Offence</th>
                <th className="p-4 font-medium text-right">Defence</th>
                <th className="p-4 font-medium text-right">Games</th>
                <th className="p-4 font-medium text-right">Peers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r, i) => (
                <tr key={r.player_id} className="hover:bg-white/5">
                  <td className="p-4 text-slate-400">{i + 1}</td>
                  <td className="p-4">
                    <Link to={`/v2/profile/${r.person_id}`} className="font-medium hover:text-primary">
                      {r.name}
                    </Link>
                  </td>
                  <td className="p-4 text-right font-bold text-accent">
                    {r.headline_scalar != null ? Math.round(r.headline_scalar) : '—'}
                  </td>
                  <td className="p-4 text-right text-slate-300">
                    {r.offence_skill != null ? Math.round(r.offence_skill) : '—'}
                  </td>
                  <td className="p-4 text-right text-slate-300">
                    {r.defence_skill != null ? Math.round(r.defence_skill) : '—'}
                  </td>
                  <td className="p-4 text-right text-slate-400">
                    {r.n_results ?? 0}
                  </td>
                  <td className="p-4 text-right text-slate-400">
                    {r.n_peers ?? 0}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">
                  No players in this context yet.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
