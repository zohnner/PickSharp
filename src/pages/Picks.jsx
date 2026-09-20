import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PickCard from '../components/PickCard.jsx';
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
      <h1 className="text-2xl font-bold text-white">Today's Picks</h1>
      <p className="mt-1 text-sm text-neutral-500">
        PickSharp's own AI-assisted analysis, grounded in real market odds — plus verified picks from real
        accounts on X, with a link back to the source.
      </p>
      <p className="mt-1 text-xs text-neutral-600">
        Unlocks are tied to this browser — they won't follow you to another device.
      </p>

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
