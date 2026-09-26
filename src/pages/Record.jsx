import { useEffect, useState } from 'react';
import { getRecord } from '../lib/api.js';

const SPORT_LABELS = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'NCAAF', basketball_nba: 'NBA' };

const GRADE_STYLES = {
  win: 'bg-green-900/40 text-green-300',
  loss: 'bg-red-900/40 text-red-300',
  push: 'bg-neutral-800 text-neutral-300',
  pending: 'bg-neutral-800 text-neutral-500',
  void: 'bg-neutral-800 text-neutral-500',
};

const pct = (x, digits = 1) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
const units = (x) => `${x > 0 ? '+' : ''}${x.toFixed(2)}u`;
const odds = (o) => (o == null ? '—' : o > 0 ? `+${o}` : `${o}`);
const date = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-neutral-500">{sub}</p>}
    </div>
  );
}

export default function Record() {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    getRecord().then(setRecord).catch((err) => setError(err.message));
  }, []);

  const bar = record?.publishBar ?? 0.02;
  const summary = record && (showAll ? record.summary.all : record.summary.bar);
  const segments = record?.summary.segments?.[showAll ? 'all' : 'bar'];
  const edges = record ? record.edges.filter((e) => showAll || e.ev >= bar) : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-bold text-white sm:text-3xl">Our Record</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Every edge we've found, graded after the game. Nothing removed, nothing cherry-picked.
      </p>
      <p className="mt-2 text-xs text-neutral-500">
        An edge is a sportsbook price better than the fair price implied by Pinnacle's sharp market.
        CLV (closing line value) shows whether our price beat the fair price at kickoff — the fastest
        honest signal of whether the edges are real. Results assume one unit per bet at the price we logged.
      </p>

      <div className="mt-6 inline-flex rounded-md border border-neutral-800 p-0.5 text-sm">
        {[
          [false, `${Math.round(bar * 100)}%+ edges`],
          [true, 'Everything logged'],
        ].map(([value, label]) => (
          <button
            key={label}
            onClick={() => setShowAll(value)}
            className={`rounded px-3 py-1.5 font-medium ${showAll === value ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="mt-8 text-sm text-red-400">{error}</p>}
      {!record && !error && <p className="mt-8 text-sm text-neutral-500">Loading record...</p>}

      {summary && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Record"
            value={`${summary.wins}-${summary.losses}${summary.pushes ? `-${summary.pushes}` : ''}`}
            sub={summary.pending ? `${summary.pending} awaiting result` : `${summary.edges} edges`}
          />
          <Stat label="Units" value={units(summary.units)} />
          <Stat label="ROI" value={pct(summary.roi)} />
          <Stat
            label="Avg CLV"
            value={pct(summary.clv.avg, 2)}
            sub={summary.clv.count ? `${pct(summary.clv.positiveShare, 0).replace('+', '')} beat the close` : 'no closes yet'}
          />
        </div>
      )}

      {segments && summary.edges > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
                <th className="p-3 font-medium">By bet type</th>
                <th className="p-3 font-medium">Record</th>
                <th className="p-3 font-medium">Units</th>
                <th className="p-3 font-medium">Avg CLV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {segments.map((s) => (
                <tr key={s.key} className="text-neutral-300">
                  <td className="p-3">{s.label}</td>
                  <td className="p-3">{s.edges ? `${s.wins}-${s.losses}${s.pushes ? `-${s.pushes}` : ''}` : '—'}</td>
                  <td className="p-3">{s.edges ? units(s.units) : '—'}</td>
                  <td className="p-3">
                    {pct(s.clv.avg, 2)}
                    {s.clv.count ? <span className="text-neutral-500"> ({s.clv.count})</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-neutral-800 p-3 text-xs text-neutral-500">
            Big underdogs are where fair prices are hardest to pin down, so we report them separately — a lucky
            run on longshots shouldn't be mistaken for an edge.
          </p>
        </div>
      )}

      {record && edges.length === 0 && (
        <p className="mt-8 text-sm text-neutral-500">
          No edges on the record yet. Edges appear here once their game kicks off, and get graded the
          morning after.
        </p>
      )}

      <div className="mt-6 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {edges.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
            <div className="min-w-0 flex-1 basis-60">
              <p className="font-semibold text-white">{e.selection}</p>
              <p className="text-xs text-neutral-500 sm:truncate">
                {SPORT_LABELS[e.sport] || e.sport} · {e.game} · {date(e.commence_time)}
                {e.score && ` · Final ${e.score}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-nowrap text-xs text-neutral-400">
              <span title="Odds when found">
                {odds(e.odds)} <span className="text-neutral-600">@ {e.book}</span>
              </span>
              <span title="Edge when found">Edge {pct(e.ev)}</span>
              <span title="Closing line value">CLV {pct(e.clv)}</span>
              <span className={`w-16 rounded px-2 py-0.5 text-center font-semibold capitalize ${GRADE_STYLES[e.grade]}`}>
                {e.grade}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
