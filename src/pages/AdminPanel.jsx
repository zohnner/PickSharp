import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { addPick, deletePick, listAllPicks, verifySlot, getFunnel, getPipelineStatus, getDiscoveredCandidates, dismissCandidate } from '../lib/api.js';

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

// Derived from game_time_utc rather than trusting a model-provided display
// string -- same "derive it, don't trust free text" reasoning as
// worker/pickGenerator.js's own formatGameTime (a real kickoff time could
// otherwise be echoed correctly in game_time_utc while a separate,
// independently-generated display string drifted from it).
function formatGameTime(isoString) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(isoString));
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('month')} ${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} ET`;
}

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
  const [pipeline, setPipeline] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [spend, setSpend] = useState(null);

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
      getPipelineStatus()
        .then((data) => setPipeline(data.status))
        .catch(() => {
          // Non-critical: the rest of the admin panel still works without it.
        });
      getDiscoveredCandidates()
        .then((data) => {
          setCandidates(data.candidates || []);
          if (typeof data.spent_usd === 'number' && typeof data.ceiling_usd === 'number') {
            setSpend({ spent: data.spent_usd, ceiling: data.ceiling_usd });
          }
        })
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

  const handleUseCandidate = (candidate) => {
    setForm({
      ...emptyForm,
      author: candidate.handle,
      source_tweet_url: candidate.post_url,
      pick_type: candidate.pick_type || emptyForm.pick_type,
      game: candidate.game || '',
      game_time_utc: candidate.game_time_utc || '',
      game_time: candidate.game_time_utc ? formatGameTime(candidate.game_time_utc) : '',
      pick_text: candidate.pick_text || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDismissCandidate = async (id) => {
    try {
      await dismissCandidate(id);
      setCandidates((prev) => prev.filter((c) => c.id !== id));
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

      {(candidates.length > 0 || spend) && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <span className="text-sm font-semibold text-white">Discovered tweet candidates</span>
          {spend && (
            <p className="mt-1 text-xs text-neutral-500">
              xAI discovery budget: ${spend.spent.toFixed(2)} / ${spend.ceiling.toFixed(2)} spent (estimated)
            </p>
          )}
          {candidates.length === 0 && <p className="mt-3 text-sm text-neutral-500">No pending candidates.</p>}
          <div className="mt-3 space-y-2">
            {candidates.map((c) => (
              <div key={c.id} className="rounded-md border border-neutral-800 p-3">
                <p className="text-xs text-neutral-500">{c.handle} · {c.posted_at || 'time unknown'}</p>
                {c.pick_text && (
                  <p className="mt-1 text-sm font-semibold text-white">
                    {c.pick_text}
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      {c.game} · {c.pick_type}
                    </span>
                  </p>
                )}
                <p className="mt-1 text-sm text-neutral-200">{c.post_text}</p>
                <div className="mt-2 flex gap-3">
                  <a href={c.post_url} target="_blank" rel="noreferrer" className="text-xs text-sharp-500 hover:underline">
                    view tweet
                  </a>
                  <button onClick={() => handleUseCandidate(c)} className="text-xs font-medium text-sharp-500 hover:underline">
                    Use this
                  </button>
                  <button onClick={() => handleDismissCandidate(c.id)} className="text-xs font-medium text-red-400 hover:underline">
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {pipeline && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <span className="text-sm font-semibold text-white">Today's pipeline</span>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {pipeline.map((s) => (
              <div key={s.slot} className="rounded-md border border-neutral-800 p-3 text-center">
                <p className="text-xs uppercase text-neutral-500">{s.slot}</p>
                <p className="mt-1 text-sm text-neutral-300">
                  {s.picks_generated > 0 ? `✓ ${s.picks_generated} generated` : '— not yet'}
                </p>
                <p className="text-sm text-neutral-300">{s.posted ? '✓ posted' : '— not posted'}</p>
                {s.metrics && (
                  <p className="mt-1 text-xs text-neutral-500">
                    {s.metrics.views ?? '?'} views · {s.metrics.likes} likes · {s.metrics.retweets} RTs
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {funnel && (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <span className="text-sm font-semibold text-white">Today's funnel</span>
          <div className="mt-2 grid grid-cols-2 gap-4 text-center sm:grid-cols-4">
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
            <div>
              <p className="text-2xl font-bold text-white">{funnel.email_signups_today ?? 0}</p>
              <p className="text-xs text-neutral-500">Email signups ({funnel.email_signups_total ?? 0} total)</p>
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
