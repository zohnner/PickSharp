import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div>
      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
          Curated NFL Picks, <span className="text-sharp-600">Aggregated in One Place</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600">
          We track the sharpest NFL handicappers on X so you don't have to. See today's picks, track their
          accuracy, and bet with confidence.
        </p>
        <Link
          to="/auth"
          className="mt-8 inline-block rounded-md bg-sharp-600 px-6 py-3 text-base font-semibold text-white hover:bg-sharp-700"
        >
          Get Free Picks
        </Link>
      </section>

      <section className="bg-white py-16">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:grid-cols-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Today's Picks</h3>
            <p className="mt-2 text-sm text-slate-600">
              See spreads, moneylines, props, and totals from top NFL handicappers, updated daily.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Track Accuracy</h3>
            <p className="mt-2 text-sm text-slate-600">
              Every picker's win rate is tracked so you know who's actually hitting.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Bet Instantly</h3>
            <p className="mt-2 text-sm text-slate-600">
              One-tap links to DraftKings so you can act on a pick the moment you see it.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold text-slate-900">Simple pricing</h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            <h3 className="text-lg font-semibold text-slate-900">Free</h3>
            <p className="mt-1 text-3xl font-bold text-slate-900">$0</p>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>Last 7 days of picks</li>
              <li>DraftKings betting links</li>
            </ul>
          </div>
          <div className="rounded-lg border-2 border-sharp-600 bg-white p-6">
            <h3 className="text-lg font-semibold text-slate-900">Premium</h3>
            <p className="mt-1 text-3xl font-bold text-slate-900">
              $14.99<span className="text-base font-normal text-slate-500">/mo</span>
            </p>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>Full pick history</li>
              <li>Advanced filters</li>
              <li>Picker leaderboards</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
