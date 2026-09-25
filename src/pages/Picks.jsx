import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PickCard from '../components/PickCard.jsx';
import EmailCapture from '../components/EmailCapture.jsx';
import { getBuyerToken } from '../lib/buyerToken.js';
import { getTodaysPicks, checkoutBundle, confirmCheckout, trackSource } from '../lib/api.js';

export default function Picks() {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmError, setConfirmError] = useState(null);
  const [bundleError, setBundleError] = useState(null);
  const [isUnlockingBundle, setIsUnlockingBundle] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const buyerToken = getBuyerToken();

  const loadPicks = () => {
    setLoading(true);
    setError(null);
    getTodaysPicks(buyerToken)
      .then((data) => setPicks(data.picks || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const runConfirm = (sessionId) => {
    setConfirmError(null);
    confirmCheckout(sessionId, buyerToken)
      .then(() => {
        const next = new URLSearchParams(searchParams);
        next.delete('session_id');
        setSearchParams(next, { replace: true });
        loadPicks();
      })
      .catch((err) => {
        setConfirmError(err.message);
      });
  };

  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    const ref = searchParams.get('ref');
    if (ref) {
      trackSource(buyerToken, ref).catch(() => {
        // Non-critical: attribution tracking failing shouldn't block the page.
      });
    }
    if (sessionId) {
      runConfirm(sessionId);
    } else {
      loadPicks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lockedPicks = picks.filter((p) => p.locked);
  const bundleTotalCents = lockedPicks.reduce((sum, p) => sum + Math.round(p.price_cents * 0.8), 0);

  const handleUnlockAll = async () => {
    setBundleError(null);
    setIsUnlockingBundle(true);
    try {
      const { url } = await checkoutBundle(lockedPicks.map((p) => p.id), buyerToken);
      window.location.href = url;
    } catch (err) {
      setBundleError(err.message);
      setIsUnlockingBundle(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-bold text-white sm:text-3xl">Today's NFL Picks</h1>
      <p className="mt-2 text-sm text-neutral-400">
        PickSharp's own analysis, grounded in real market odds — plus verified picks from real accounts on X.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-neutral-500">
        <span>🔓 One free pick every day</span>
        <span>💵 Unlock more from $1.99</span>
        <span>📊 Every pick checked against live odds</span>
      </div>
      <p className="mt-3 text-xs text-neutral-600">
        No account needed to unlock a pick — just tied to this browser.
      </p>

      <EmailCapture buyerToken={buyerToken} />

      {lockedPicks.length >= 2 && (
        <div className="mt-6 rounded-md border border-sharp-700/40 bg-sharp-900/20 p-4 text-sm text-sharp-200">
          <button
            onClick={handleUnlockAll}
            disabled={isUnlockingBundle}
            className="font-semibold text-sharp-400 underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Unlock all {lockedPicks.length} picks for ${(bundleTotalCents / 100).toFixed(2)}
          </button>
        </div>
      )}

      {bundleError && (
        <div className="mt-6 rounded-md border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          <p>We couldn't start checkout: {bundleError}</p>
        </div>
      )}

      {confirmError && searchParams.get('session_id') && (
        <div className="mt-6 rounded-md border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          <p>We couldn't confirm your payment: {confirmError}</p>
          <button
            onClick={() => runConfirm(searchParams.get('session_id'))}
            className="mt-2 font-semibold underline"
          >
            Try again
          </button>
        </div>
      )}

      {loading && <p className="mt-8 text-sm text-neutral-500">Loading picks...</p>}
      {error && <p className="mt-8 text-sm text-red-400">{error}</p>}

      <div className="mt-6 space-y-4">
        {picks.map((pick) => (
          <PickCard key={pick.id} pick={pick} buyerToken={buyerToken} />
        ))}
        {!loading && !error && picks.length === 0 && (
          <p className="text-sm text-neutral-500">No picks yet — check back soon.</p>
        )}
      </div>
    </div>
  );
}
