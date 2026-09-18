import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PickCard from '../components/PickCard.jsx';
import { getBuyerToken } from '../lib/buyerToken.js';
import { getTodaysPicks, checkoutBundle, confirmCheckout } from '../lib/api.js';

export default function Picks() {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const buyerToken = getBuyerToken();

  const loadPicks = () => {
    setLoading(true);
    getTodaysPicks(buyerToken)
      .then((data) => setPicks(data.picks || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    if (sessionId) {
      confirmCheckout(sessionId, buyerToken)
        .catch((err) => setError(err.message))
        .finally(() => {
          setSearchParams({}, { replace: true });
          loadPicks();
        });
    } else {
      loadPicks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lockedPicks = picks.filter((p) => p.locked);
  const bundleTotalCents = lockedPicks.reduce((sum, p) => sum + Math.round(p.price_cents * 0.8), 0);

  const handleUnlockAll = async () => {
    try {
      const { url } = await checkoutBundle(lockedPicks.map((p) => p.id), buyerToken);
      window.location.href = url;
    } catch (err) {
      window.alert(err.message);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Today's Picks</h1>
      <p className="mt-1 text-sm text-slate-500">Curated from the sharpest NFL accounts on X.</p>
      <p className="mt-1 text-xs text-slate-400">
        Unlocks are tied to this browser — they won't follow you to another device.
      </p>

      {lockedPicks.length >= 2 && (
        <div className="mt-6 rounded-md border border-sharp-200 bg-sharp-50 p-4 text-sm text-sharp-900">
          <button onClick={handleUnlockAll} className="font-semibold text-sharp-700 underline">
            Unlock all {lockedPicks.length} picks for ${(bundleTotalCents / 100).toFixed(2)}
          </button>
        </div>
      )}

      {loading && <p className="mt-8 text-sm text-slate-500">Loading picks...</p>}
      {error && <p className="mt-8 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-4">
        {picks.map((pick) => (
          <PickCard key={pick.id} pick={pick} buyerToken={buyerToken} />
        ))}
        {!loading && !error && picks.length === 0 && (
          <p className="text-sm text-slate-500">No picks yet — check back soon.</p>
        )}
      </div>
    </div>
  );
}
