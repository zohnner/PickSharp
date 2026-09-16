import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { getCurrentUser } from '../lib/api.js';
import SubscriptionModal from '../components/SubscriptionModal.jsx';

export default function Dashboard({ session }) {
  const [profile, setProfile] = useState(null);
  const [showUpgrade, setShowUpgrade] = useState(false);

  useEffect(() => {
    if (session) {
      getCurrentUser()
        .then((data) => setProfile(data.user))
        .catch(() => setProfile(null));
    }
  }, [session]);

  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-500">Email</p>
        <p className="text-base font-medium text-slate-900">{session.user.email}</p>

        <p className="mt-4 text-sm text-slate-500">Subscription status</p>
        <p className="text-base font-medium text-slate-900">
          {profile?.is_premium ? 'Premium' : 'Free'}
        </p>

        {!profile?.is_premium && (
          <button
            onClick={() => setShowUpgrade(true)}
            className="mt-6 rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sharp-700"
          >
            Upgrade to Premium
          </button>
        )}
      </div>

      <SubscriptionModal open={showUpgrade} onClose={() => setShowUpgrade(false)} />
    </div>
  );
}
