import { useState } from 'react';
import { checkoutPick, affiliateGoUrl } from '../lib/api.js';

const TYPE_LABELS = {
  spread: 'Spread',
  moneyline: 'Moneyline',
  prop: 'Prop',
  over_under: 'Over/Under',
};

const CONFIDENCE_STYLES = {
  high: 'bg-green-900/40 text-green-300',
  medium: 'bg-amber-900/40 text-amber-300',
  low: 'bg-neutral-800 text-neutral-400',
};

export default function PickCard({ pick, buyerToken }) {
  const winRate = pick.win_rate;
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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sharp-900/40 text-sm font-semibold text-sharp-300">
            {pick.author.replace('@', '').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-white">{pick.author}</p>
            <p className="text-xs text-neutral-500">{winRate != null ? `${winRate}% win rate` : 'Building track record'}</p>
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
          <span className="rounded bg-sharp-900/30 px-2 py-0.5 text-xs font-semibold uppercase text-sharp-400">
            {TYPE_LABELS[pick.pick_type] || pick.pick_type}
          </span>
        </div>

        {pick.locked ? (
          <p className="mt-2 text-lg font-bold text-neutral-600 blur-sm select-none">Locked pick</p>
        ) : (
          <p className="mt-2 text-lg font-bold text-white">{pick.pick_text}</p>
        )}
        <p className="mt-1 text-sm text-neutral-500">
          {pick.game} · {pick.game_time}
        </p>
      </div>

      {pick.game_started ? (
        <p className="mt-4 inline-flex items-center justify-center rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-500">
          Game started
        </p>
      ) : pick.locked ? (
        <button
          onClick={handleUnlock}
          disabled={isUnlocking}
          className="mt-4 inline-flex items-center justify-center rounded-md bg-gradient-to-b from-[#f3dd8f] via-[#c6971f] to-[#8a6a17] px-4 py-2 text-sm font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:from-[#f7e6a8] hover:via-[#d4a72e] hover:to-[#9c7818] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Unlock for ${(pick.price_cents / 100).toFixed(2)}
        </button>
      ) : (
        <a
          href={affiliateGoUrl(pick.id, buyerToken)}
          target="_blank"
          rel="noopener noreferrer sponsored"
          className="mt-4 inline-flex items-center justify-center rounded-md bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-white"
        >
          Bet on DraftKings
        </a>
      )}
    </div>
  );
}
