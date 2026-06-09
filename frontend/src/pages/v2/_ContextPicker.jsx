/**
 * Shared context picker. Stores selection in localStorage.
 */
import { useEffect, useState } from 'react';
import { v2, getContextId, setContextId } from './_api.js';

export default function ContextPicker({ onChange }) {
  const [contexts, setContexts] = useState([]);
  const [value, setValue] = useState(getContextId() ?? '');

  useEffect(() => {
    v2.listContexts().then(setContexts).catch(() => setContexts([]));
  }, []);

  useEffect(() => {
    setContextId(value);
    onChange?.(value ? parseInt(value, 10) : null);
  }, [value, onChange]);

  return (
    <div className="glass-panel p-3 px-4 flex items-center justify-between text-sm">
      <span className="text-slate-400">Context</span>
      <select
        className="bg-slate-900 border border-white/10 rounded-lg px-3 py-1 text-slate-200 focus:outline-none focus:border-primary"
        value={value}
        onChange={e => setValue(e.target.value)}
      >
        <option value="">— select —</option>
        {contexts.map(c => (
          <option key={c.context_id} value={c.context_id}>
            {c.name} ({c.kind})
          </option>
        ))}
      </select>
    </div>
  );
}
