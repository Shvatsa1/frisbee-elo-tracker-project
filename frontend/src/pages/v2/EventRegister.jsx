/**
 * /v2/e/:share_token — public event page.
 *
 * Auth'd players (X-Session-Id) see "I'm in" / "Withdraw" and their slot
 * status. Anyone else sees the event details with a nudge to tap their
 * personal link.
 */
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Users, Calendar, MapPin, Clock } from 'lucide-react';
import { v2 } from './_api.js';
import { getSessionId } from './_api.js';

export default function EventRegister() {
  const { share_token } = useParams();
  const [ev, setEv] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const hasSession = !!getSessionId();

  async function refresh() {
    try { setEv(await v2.publicEvent(share_token)); }
    catch (e) { setErr(e?.response?.data?.error || e.message); }
  }
  useEffect(() => { refresh(); }, [share_token]);

  async function onRegister() {
    setBusy(true); setErr('');
    try { await v2.registerEvent(share_token); await refresh(); }
    catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  async function onWithdraw() {
    setBusy(true); setErr('');
    try { await v2.withdrawEvent(share_token); await refresh(); }
    catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }

  if (err && !ev) {
    return <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg">{err}</div>;
  }
  if (!ev) return <div className="text-slate-400">Loading...</div>;

  const isIn = ev.me && (ev.me.status === 'main' || ev.me.status === 'waitlist');
  const slotsLeft = Math.max(0, ev.capacity - ev.main_count);

  return (
    <div className="max-w-xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="glass-panel p-6 space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">{ev.title}</h1>
        <div className="text-sm text-slate-300 space-y-1">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            {new Date(ev.event_date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}
            {ev.event_time && <span className="text-slate-400"> · {ev.event_time}</span>}
          </div>
          {ev.location && (
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-slate-400" />{ev.location}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-400" />
            <span>{ev.main_count} / {ev.capacity} in main</span>
            {ev.waitlist_count > 0 && (
              <span className="text-slate-400">· {ev.waitlist_count} waitlist</span>
            )}
          </div>
        </div>
      </div>

      {ev.status !== 'open' && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 px-3 py-2 rounded-lg text-sm">
          Registration is {ev.status}.
        </div>
      )}

      {!hasSession && (
        <div className="bg-slate-800/40 border border-white/10 rounded-lg p-4 text-sm text-slate-300">
          To sign up, tap your personal link from WhatsApp.
        </div>
      )}

      {hasSession && ev.status === 'open' && (
        <div className="glass-panel p-5 space-y-3">
          {isIn && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              ev.me.status === 'main'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                : 'bg-amber-500/10 border border-amber-500/20 text-amber-300'
            }`}>
              {ev.me.status === 'main'
                ? "You're in the main list."
                : `You're on the waitlist — position ${ev.me.position}.`}
              {ev.me.status === 'waitlist' && (
                <div className="text-xs opacity-75 mt-1">
                  You'll be auto-promoted if someone drops out.
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {!isIn && (
              <button
                onClick={onRegister}
                disabled={busy}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {busy ? '…' : (slotsLeft > 0 ? "I'm in" : 'Join waitlist')}
              </button>
            )}
            {isIn && (
              <button
                onClick={onWithdraw}
                disabled={busy}
                className="btn-secondary flex-1 disabled:opacity-50"
              >
                {busy ? '…' : 'Withdraw'}
              </button>
            )}
          </div>
          {err && <div className="text-red-400 text-sm">{err}</div>}
        </div>
      )}

      <div className="flex justify-center text-xs text-slate-500">
        <Link to="/v2/results" className="hover:text-slate-300">← back to results</Link>
      </div>
    </div>
  );
}
