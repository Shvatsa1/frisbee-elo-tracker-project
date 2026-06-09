/**
 * Tier-0 "Acting As" picker.
 *
 * Sits at the top of every admin-write page. Stores the chosen
 * person_id in localStorage so the API client can attach it as
 * X-Person-Id. Replaceable with a capability-link login flow when
 * Tier-1 lands.
 */
import { useEffect, useState } from 'react';
import { getActorId, setActorId } from './_api.js';

export default function ActingAs({ onChange }) {
  const [value, setValue] = useState(getActorId() ?? '');

  useEffect(() => {
    setActorId(value);
    onChange?.(value ? parseInt(value, 10) : null);
  }, [value, onChange]);

  return (
    <div className="glass-panel p-3 px-4 flex items-center justify-between text-sm">
      <span className="text-slate-400">
        Acting as <span className="text-slate-200 font-medium">person_id</span>
      </span>
      <input
        type="number"
        placeholder="e.g. 1 (Admin)"
        className="bg-slate-900 border border-white/10 rounded-lg px-3 py-1 w-32 text-right text-slate-200 focus:outline-none focus:border-primary"
        value={value}
        onChange={e => setValue(e.target.value)}
      />
    </div>
  );
}
