import { useEffect, useState } from 'react';
import { addPick, deletePick, listAllPicks } from '../lib/api.js';

const PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

const emptyForm = {
  author: '',
  pick_text: '',
  game: '',
  game_time: '',
  pick_type: 'spread',
  confidence: 'medium',
};

export default function AdminPanel() {
  const [adminSecret, setAdminSecret] = useState(() => sessionStorage.getItem('sharp_admin_secret') || '');
  const [form, setForm] = useState(emptyForm);
  const [picks, setPicks] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const loadPicks = async (secret) => {
    try {
      const data = await listAllPicks(secret);
      setPicks(data.picks || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (adminSecret) loadPicks(adminSecret);
  }, [adminSecret]);

  const handleUnlock = (e) => {
    e.preventDefault();
    sessionStorage.setItem('sharp_admin_secret', adminSecret);
    loadPicks(adminSecret);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await addPick(form, adminSecret);
      setForm(emptyForm);
      await loadPicks(adminSecret);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deletePick(id, adminSecret);
      await loadPicks(adminSecret);
    } catch (err) {
      setError(err.message);
    }
  };

  if (!picks.length && !error) {
    return (
      <div className="mx-auto max-w-sm px-4 py-16">
        <h1 className="text-xl font-bold text-slate-900">Admin unlock</h1>
        <form onSubmit={handleUnlock} className="mt-4 space-y-3">
          <input
            type="password"
            placeholder="Admin secret"
            value={adminSecret}
            onChange={(e) => setAdminSecret(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button className="w-full rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-slate-900">
            Continue
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Admin: Add a Pick</h1>

      <form onSubmit={handleSubmit} className="mt-6 grid gap-3 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-2">
        <input
          required
          placeholder="Author (@handle)"
          value={form.author}
          onChange={(e) => setForm({ ...form, author: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          required
          placeholder="Pick text (e.g. Kansas City -5.5)"
          value={form.pick_text}
          onChange={(e) => setForm({ ...form, pick_text: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          required
          placeholder="Game (e.g. KC @ BAL)"
          value={form.game}
          onChange={(e) => setForm({ ...form, game: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          required
          placeholder="Game time (e.g. Sept 15 1:00 PM)"
          value={form.game_time}
          onChange={(e) => setForm({ ...form, game_time: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <select
          value={form.pick_type}
          onChange={(e) => setForm({ ...form, pick_type: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          {PICK_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={form.confidence}
          onChange={(e) => setForm({ ...form, confidence: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          {CONFIDENCE_LEVELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="sm:col-span-2 rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-sharp-700 disabled:opacity-60"
        >
          {submitting ? 'Adding...' : 'Add Pick'}
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <h2 className="mt-10 text-lg font-semibold text-slate-900">Current Picks</h2>
      <div className="mt-4 space-y-3">
        {picks.map((pick) => (
          <div key={pick.id} className="flex items-center justify-between rounded-md border border-slate-200 bg-white p-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {pick.author} — {pick.pick_text}
              </p>
              <p className="text-xs text-slate-500">
                {pick.game} · {pick.game_time} · {pick.pick_type} · {pick.confidence}
              </p>
            </div>
            <button onClick={() => handleDelete(pick.id)} className="text-sm font-medium text-red-600 hover:underline">
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
