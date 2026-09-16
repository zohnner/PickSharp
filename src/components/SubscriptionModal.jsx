export default function SubscriptionModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-xl font-bold text-slate-900">Upgrade to PickSharp Premium</h2>
        <p className="mt-2 text-sm text-slate-600">
          Unlock historical picks, advanced filters, and picker leaderboards for $14.99/mo.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-slate-700">
          <li>✓ Full pick history, not just the last 7 days</li>
          <li>✓ Filter by picker, confidence, and bet type</li>
          <li>✓ Picker accuracy leaderboards</li>
        </ul>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Not now
          </button>
          <button
            disabled
            title="Stripe checkout coming soon"
            className="flex-1 cursor-not-allowed rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-white opacity-70"
          >
            Upgrade — $14.99/mo
          </button>
        </div>
      </div>
    </div>
  );
}
