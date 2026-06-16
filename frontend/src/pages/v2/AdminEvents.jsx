/**
 * /v2/admin/events — admin-only: create an event, see its roster (main +
 * waitlist + withdrawn), copy the share link, jump to Builder with the
 * registered players pre-filled.
 *
 * Tier-0 (X-Person-Id + X-Admin-Key); requires the admin URL unlock.
 */
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { v2 } from './_api.js';
import ActingAs from './_ActingAs.jsx';
import ContextPicker from './_ContextPicker.jsx';

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); }
  catch { return String(d).slice(0, 10); }
}
function fmtTime(t) {
  if (!t) return '';
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

export default function AdminEvents() {
  const [actor, setActor] = useState(null);
  const [ctxId, setCtxId] = useState(null);
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [roster, setRoster] = useState(null);
  const [draft, setDraft] = useState({ title: '', event_date: '', event_time: '', location: '', capacity: 28 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!ctxId || !actor) return;
    v2.adminEvents(ctxId).then(r => setEvents(r.events || []))
      .catch(e => setErr(e?.response?.data?.error || e.message));
  }, [ctxId, actor]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!selected) { setRoster(null); return; }
    v2.adminRoster(selected.event_id).then(setRoster)
      .catch(e => setErr(e?.response?.data?.error || e.message));
  }, [selected]);

  async function createEvent() {
    if (!actor || !ctxId) { setErr('set "Acting as" and context first'); return; }
    if (!draft.title || !draft.event_date) { setErr('title + date required'); return; }
    setBusy(true); setErr('');
    try {
      const ev = await v2.createEvent({
        context_id: ctxId, title: draft.title, event_date: draft.event_date,
        event_time: draft.event_time || null, location: draft.location || null,
        capacity: Number(draft.capacity) || 28,
      });
      setDraft({ title: '', event_date: '', event_time: '', location: '', capacity: 28 });
      await refresh();
      setSelected(ev);
    } catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }

  async function promote() {
    if (!selected) return;
    setBusy(true);
    try {
      await v2.adminPromote(selected.event_id);
      const r = await v2.adminRoster(selected.event_id);
      setRoster(r);
    } catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }

  const shareUrl = selected ? `${window.location.origin}/v2/e/${selected.share_token}` : '';

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Events</h1>
        <p className="text-slate-400 text-sm">Create the next minis, share the link, see who's in.</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <ActingAs value={actor} onChange={setActor} />
        <ContextPicker value={ctxId} onChange={setCtxId} />
      </div>

      {err && <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm">{err}</div>}

      {/* Create */}
      <div className="glass-panel p-5 space-y-3">
        <h2 className="font-bold">Create event</h2>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Title</span>
            <input className="input-field" value={draft.title}
              onChange={e => setDraft({ ...draft, title: e.target.value })}
              placeholder="e.g. Wednesday Minis" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Date</span>
            <input type="date" className="input-field" value={draft.event_date}
              onChange={e => setDraft({ ...draft, event_date: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Time</span>
            <input className="input-field" value={draft.event_time}
              onChange={e => setDraft({ ...draft, event_time: e.target.value })}
              placeholder="e.g. 7:00 PM" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Location</span>
            <input className="input-field" value={draft.location}
              onChange={e => setDraft({ ...draft, location: e.target.value })}
              placeholder="e.g. Mahim" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Capacity</span>
            <input type="number" min="1" className="input-field" value={draft.capacity}
              onChange={e => setDraft({ ...draft, capacity: e.target.value })} />
          </label>
        </div>
        <button onClick={createEvent} disabled={busy} className="btn-primary disabled:opacity-50">
          {busy ? '…' : 'Create event'}
        </button>
      </div>

      {/* Events list */}
      <div className="glass-panel p-5">
        <h2 className="font-bold mb-3">Upcoming + past</h2>
        {events.length === 0 && <div className="text-slate-400 text-sm">No events yet for this context.</div>}
        <ul className="divide-y divide-white/5">
          {events.map(ev => (
            <li key={ev.event_id} className="py-2 flex justify-between items-center">
              <button onClick={() => setSelected(ev)}
                className={`text-left flex-1 hover:text-primary ${selected?.event_id === ev.event_id ? 'text-primary' : 'text-slate-200'}`}>
                <div className="font-medium">{ev.title}</div>
                <div className="text-xs text-slate-500">
                  {fmtDate(ev.event_date)}{ev.event_time && ` · ${ev.event_time}`} · {ev.status} · cap {ev.capacity}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Selected event roster */}
      {selected && roster && (
        <div className="glass-panel p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-lg">{roster.title}</h2>
              <div className="text-sm text-slate-400">
                {fmtDate(roster.event_date)}{roster.event_time && ` · ${roster.event_time}`}
                {roster.location && ` · ${roster.location}`} · {roster.main.length}/{roster.capacity} in main · {roster.waitlist.length} waitlist
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => navigator.clipboard?.writeText(shareUrl)} className="btn-secondary text-sm">
                Copy share link
              </button>
              <button onClick={promote} disabled={busy} className="btn-secondary text-sm disabled:opacity-50">
                Promote waitlist
              </button>
              <Link
                to={`/v2/builder?event_id=${selected.event_id}`}
                className="px-3 py-1.5 rounded-lg bg-primary text-slate-900 text-sm font-semibold"
              >
                Build teams →
              </Link>
            </div>
          </div>
          <div className="text-xs text-slate-500 break-all">{shareUrl}</div>

          <RosterSection title="Main" rows={roster.main} />
          <RosterSection title="Waitlist" rows={roster.waitlist} />
          <RosterSection title="Withdrawn" rows={roster.withdrawn} muted />
        </div>
      )}
    </div>
  );
}

function RosterSection({ title, rows, muted }) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className={`text-xs uppercase tracking-wider mb-1 ${muted ? 'text-slate-500' : 'text-slate-400'}`}>{title} ({rows.length})</h3>
      <ol className={`space-y-0.5 text-sm ${muted ? 'text-slate-500' : 'text-slate-200'}`}>
        {rows.map((r, i) => (
          <li key={r.id} className="flex justify-between">
            <span>{i + 1}. {r.name}</span>
            <span className="text-xs text-slate-500">{new Date(r.signed_up_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
