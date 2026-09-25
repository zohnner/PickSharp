import { useState } from 'react';
import { subscribeEmail } from '../lib/api.js';

const STORAGE_KEY = 'sharp_email_subscribed';

function wasSubscribed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberSubscribed() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Private browsing: the form just shows again next visit.
  }
}

export default function EmailCapture({ buyerToken }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState(wasSubscribed() ? 'done' : 'idle');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setStatus('sending');
    try {
      await subscribeEmail(email, buyerToken, 'picks_page');
      rememberSubscribed();
      setStatus('done');
    } catch (err) {
      setError(err.message);
      setStatus('idle');
    }
  };

  if (status === 'done') {
    return (
      <p className="mt-6 rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-400">
        ✅ You're on the list — we'll email you the day's free pick.
      </p>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-6 rounded-md border border-neutral-800 bg-neutral-900 p-4"
    >
      <label htmlFor="email-capture" className="text-sm font-semibold text-white">
        Get the free pick in your inbox
      </label>
      <p className="mt-1 text-xs text-neutral-500">One email on game days. Unsubscribe anytime.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          id="email-capture"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-white placeholder-neutral-600 focus:border-sharp-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={status === 'sending'}
          className="rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-sharp-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'sending' ? 'Joining…' : 'Join free'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </form>
  );
}
