import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
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

export default function AdminPanel({ session, loadingSession }) {
  const [form, setForm] = useState(emptyForm);
  const [picks, setPicks] = useState([]);
  const [error, setError] = useState(null);
  const [notAuthorized, setNotAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const loadPicks = async () => {
    try {
      const data = await listAllPicks();
      setPicks(data.picks || []);
      setError(null);
      setNotAuthorized(false);
    } catch (err) {
      if (err.status === 401) {
        setNotAuthorized(true);
      } else {
        setError(err.message);
      }
    } finally {
      setLoadedOnce(true);
    }
  };

  useEffect(() => {
    if (session) loadPicks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await addPick(form);
      setForm(emptyForm);
      await loadPicks();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deletePick(id);
      await loadPicks();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loadingSession || (session && !loadedOnce)) {
    return <div className="mx-auto max-w-sm px-4 py-16 text-sm text-neutral-500">Loading...</div>;
  }

  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  if (notAuthorized) {
    return (
      <div className="mx-auto max-w-sm px-4 py-16">
        <h1 className="text-xl font-bold text-white">Not authorized</h1>
        <p className="mt-2 text-sm text-neutral-500">
          You're logged in as {session.user.email}, but this account isn't an admin.
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-sharp-500 hover:underline">
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold text-white">Admin: Add a Pick</h1>

      <form onSubmit={handleSubmit} className="mt-6 grid gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-5 sm:grid-cols-2">
        <input
          required
          placeholder="Author (@handle)"
          value={form.author}
          onChange={(e) => setForm({ ...form, author: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          required
          placeholder="Pick text (e.g. Kansas City -5.5)"
          value={form.pick_text}
          onChange={(e) => setForm({ ...form, pick_text: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          required
          placeholder="Game (e.g. KC @ BAL)"
          value={form.game}
          onChange={(e) => setForm({ ...form, game: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          required
          placeholder="Game time (e.g. Sept 15 1:00 PM)"
          value={form.game_time}
          onChange={(e) => setForm({ ...form, game_time: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <select
          value={form.pick_type}
          onChange={(e) => setForm({ ...form, pick_type: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
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
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
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
          className="sm:col-span-2 rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-sharp-700 disabled:opacity-60"
        >
          {submitting ? 'Adding...' : 'Add Pick'}
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <h2 className="mt-10 text-lg font-semibold text-white">Current Picks</h2>
      <div className="mt-4 space-y-3">
        {picks.map((pick) => (
          <div key={pick.id} className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900 p-3">
            <div>
              <p className="text-sm font-semibold text-white">
                {pick.author} — {pick.pick_text}
              </p>
              <p className="text-xs text-neutral-500">
                {pick.game} · {pick.game_time} · {pick.pick_type} · {pick.confidence}
              </p>
            </div>
            <button onClick={() => handleDelete(pick.id)} className="text-sm font-medium text-red-400 hover:underline">
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
