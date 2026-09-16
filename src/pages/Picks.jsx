import { useEffect, useState } from 'react';
import PickCard from '../components/PickCard.jsx';
import SubscriptionModal from '../components/SubscriptionModal.jsx';
import { getTodaysPicks } from '../lib/api.js';

export default function Picks({ session }) {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showUpgrade, setShowUpgrade] = useState(false);

  useEffect(() => {
    getTodaysPicks()
      .then((data) => setPicks(data.picks || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [session]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Today's Picks</h1>
      <p className="mt-1 text-sm text-slate-500">Curated from the sharpest NFL accounts on X.</p>

      {!session && (
        <div className="mt-6 rounded-md border border-sharp-200 bg-sharp-50 p-4 text-sm text-sharp-900">
          <p className="font-medium">Unlock historical picks, advanced filters, and leaderboards.</p>
          <button onClick={() => setShowUpgrade(true)} className="mt-2 font-semibold text-sharp-700 underline">
            Upgrade to Premium
          </button>
        </div>
      )}

      {loading && <p className="mt-8 text-sm text-slate-500">Loading picks...</p>}
      {error && <p className="mt-8 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-4">
        {picks.map((pick) => (
          <PickCard key={pick.id} pick={pick} />
        ))}
        {!loading && !error && picks.length === 0 && (
          <p className="text-sm text-slate-500">No picks yet — check back soon.</p>
        )}
      </div>

      <SubscriptionModal open={showUpgrade} onClose={() => setShowUpgrade(false)} />
    </div>
  );
}
