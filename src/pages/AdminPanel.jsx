import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { addPick, deletePick, listAllPicks, verifySlot, getFunnel } from '../lib/api.js';

const PICK_TYPES = ['spread', 'moneyline', 'prop', 'over_under'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];
const TRACKED_AUTHORS = ['@CodyBrownBets', '@SharpFootball', '@jasonrmcintyre', '@DocsSports', '@nflpickspage'];
const SLOTS = ['manual', 'morning', 'midday', 'afternoon', 'evening'];

const emptyForm = {
  author: TRACKED_AUTHORS[0],
  pick_text: '',
  game: '',
  game_time: '',
  game_time_utc: '',
  pick_type: 'spread',
  confidence: 'medium',
  source_tweet_url: '',
  slot: 'manual',
};

export default function AdminPanel({ session, loadingSession }) {
  const [form, setForm] = useState(emptyForm);
  const [picks, setPicks] = useState([]);
  const [error, setError] = useState(null);
  const [notAuthorized, setNotAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [verifySlotChoice, setVerifySlotChoice] = useState(SLOTS[1]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResults, setVerifyResults] = useState(null);
  const [verifyError, setVerifyError] = useState(null);
  const [funnel, setFunnel] = useState(null);

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
    if (session) {
      loadPicks();
      getFunnel()
        .then(setFunnel)
        .catch(() => {
          // Non-critical: the rest of the admin panel still works without it.
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = { ...form };
      if (!payload.source_tweet_url) delete payload.source_tweet_url;
      if (!payload.game_time_utc) delete payload.game_time_utc;
      await addPick(payload);
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

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyError(null);
    setVerifyResults(null);
    try {
      const data = await verifySlot(verifySlotChoice);
      setVerifyResults(data.results || []);
      await loadPicks();
    } catch (err) {
      setVerifyError(err.message);
    } finally {
      setVerifying(false);
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
        <select
          value={form.author}
          onChange={(e) => setForm({ ...form, author: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        >
          {TRACKED_AUTHORS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          placeholder="Source tweet URL (optional)"
          value={form.source_tweet_url}
          onChange={(e) => setForm({ ...form, source_tweet_url: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          required
          placeholder="Pick text (e.g. Kansas City Chiefs -5.5)"
          value={form.pick_text}
          onChange={(e) => setForm({ ...form, pick_text: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          required
          placeholder="Game (exact full team names, e.g. Baltimore Ravens @ Kansas City Chiefs)"
          value={form.game}
          onChange={(e) => setForm({ ...form, game: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          required
          placeholder="Game time (e.g. Sept 21 1:00 PM)"
          value={form.game_time}
          onChange={(e) => setForm({ ...form, game_time: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        <input
          placeholder="Game time UTC (ISO 8601, e.g. 2026-09-21T18:00:00Z) — required for slots/source tweets"
          value={form.game_time_utc}
          onChange={(e) => setForm({ ...form, game_time_utc: e.target.value })}
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
        {!form.source_tweet_url && (
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
        )}
        <select
          value={form.slot}
          onChange={(e) => setForm({ ...form, slot: e.target.value })}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        >
          {SLOTS.map((s) => (
            <option key={s} value={s}>
              {s}
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

      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <span className="text-sm font-semibold text-white">Verify a slot</span>
        <select
          value={verifySlotChoice}
          onChange={(e) => setVerifySlotChoice(e.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        >
          {SLOTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          onClick={handleVerify}
          disabled={verifying}
          className="rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-sharp-700 disabled:opacity-60"
        >
          {verifying ? 'Verifying...' : 'Verify'}
        </button>
        <span className="text-xs text-neutral-500">
          Checks source-tweet picks in this slot against the real tweet — never posts anything.
        </span>
        {verifyError && <p className="w-full text-sm text-red-400">{verifyError}</p>}
        {verifyResults && (
          <ul className="w-full space-y-1 text-sm">
            {verifyResults.length === 0 && <li className="text-neutral-500">No source-tweet picks in this slot.</li>}
            {verifyResults.map((r) => (
              <li key={r.id}>
                Pick {r.id}:{' '}
                <span
                  className={
                    r.status === 'verified' ? 'text-green-400' : r.status === 'deleted' ? 'text-red-400' : 'text-yellow-400'
                  }
                >
                  {r.status === 'verified' ? `✓ verified (${r.confidence})` : r.status === 'deleted' ? '✗ deleted' : '⏳ pending'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {funnel && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <span className="text-sm font-semibold text-white">Today's funnel</span>
          <div className="mt-2 grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-white">{funnel.checkout_started}</p>
              <p className="text-xs text-neutral-500">Checkouts started</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{funnel.checkout_completed}</p>
              <p className="text-xs text-neutral-500">Purchases completed</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{funnel.affiliate_click}</p>
              <p className="text-xs text-neutral-500">Affiliate clicks</p>
            </div>
          </div>
        </div>
      )}

      <h2 className="mt-10 text-lg font-semibold text-white">Current Picks</h2>
      <div className="mt-4 space-y-3">
        {picks.map((pick) => (
          <div key={pick.id} className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900 p-3">
            <div>
              <p className="text-sm font-semibold text-white">
                {pick.author} — {pick.pick_text}
                {pick.source_tweet_id && (
                  <span className={`ml-2 text-xs ${pick.verified ? 'text-green-400' : 'text-yellow-400'}`}>
                    {pick.verified ? '✓ Verified' : '⏳ Pending verification'}
                  </span>
                )}
              </p>
              <p className="text-xs text-neutral-500">
                {pick.game} · {pick.game_time} · {pick.pick_type} · {pick.confidence} · {pick.slot || 'manual'}
                {pick.source_tweet_url && (
                  <>
                    {' · '}
                    <a href={pick.source_tweet_url} target="_blank" rel="noreferrer" className="text-sharp-500 hover:underline">
                      source tweet
                    </a>
                  </>
                )}
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
