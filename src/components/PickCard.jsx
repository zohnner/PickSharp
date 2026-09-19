import { useState } from 'react';
import { checkoutPick } from '../lib/api.js';

const TYPE_LABELS = {
  spread: 'Spread',
  moneyline: 'Moneyline',
  prop: 'Prop',
  over_under: 'Over/Under',
};

const CONFIDENCE_STYLES = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-slate-100 text-slate-600',
};

const DK_LINK = 'https://ak.draftkings.com';

export default function PickCard({ pick, buyerToken }) {
  const winRate = pick.win_rate ?? 55;
  const [isUnlocking, setIsUnlocking] = useState(false);

  const handleUnlock = async () => {
    setIsUnlocking(true);
    try {
      const { url } = await checkoutPick(pick.id, buyerToken);
      window.location.href = url;
    } catch (err) {
      setIsUnlocking(false);
      window.alert(err.message);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sharp-100 text-sm font-semibold text-sharp-700">
            {pick.author.replace('@', '').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-slate-900">{pick.author}</p>
            <p className="text-xs text-slate-500">{winRate}% win rate</p>
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${CONFIDENCE_STYLES[pick.confidence] || CONFIDENCE_STYLES.medium}`}
        >
          {pick.confidence} confidence
        </span>
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sharp-50 px-2 py-0.5 text-xs font-semibold uppercase text-sharp-700">
            {TYPE_LABELS[pick.pick_type] || pick.pick_type}
          </span>
        </div>

        {pick.locked ? (
          <p className="mt-2 text-lg font-bold text-slate-400 blur-sm select-none">Locked pick</p>
        ) : (
          <p className="mt-2 text-lg font-bold text-slate-900">{pick.pick_text}</p>
        )}
        <p className="mt-1 text-sm text-slate-500">
          {pick.game} · {pick.game_time}
        </p>
      </div>

      {pick.game_started ? (
        <p className="mt-4 inline-flex items-center justify-center rounded-md bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-500">
          Game started
        </p>
      ) : pick.locked ? (
        <button
          onClick={handleUnlock}
          disabled={isUnlocking}
          className="mt-4 inline-flex items-center justify-center rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-sharp-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Unlock for ${(pick.price_cents / 100).toFixed(2)}
        </button>
      ) : (
        <a
          href={pick.affiliate_link || DK_LINK}
          target="_blank"
          rel="noopener noreferrer sponsored"
          className="mt-4 inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Bet on DraftKings
        </a>
      )}
    </div>
  );
}
