import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div>
      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          NFL Picks, <span className="text-sharp-500">Grounded in Real Odds</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-neutral-400">
          PickSharp's own analysis scans live market data to find value on every NFL game day — every pick
          checked against real odds before it's ever posted.
        </p>
        <Link
          to="/auth"
          className="mt-8 inline-block rounded-md bg-gradient-to-b from-[#f3dd8f] via-[#c6971f] to-[#8a6a17] px-6 py-3 text-base font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:from-[#f7e6a8] hover:via-[#d4a72e] hover:to-[#9c7818]"
        >
          Get Free Picks
        </Link>
      </section>

      <section className="bg-neutral-900 py-16">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:grid-cols-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Today's Picks</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Spreads, moneylines, props, and totals from PickSharp's own analysis, generated fresh on every
              NFL game day.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Grounded, Not Guessed</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Every pick is checked against real, live market odds before it's ever posted — no invented
              lines, no games that aren't actually happening.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Bet Instantly</h3>
            <p className="mt-2 text-sm text-neutral-400">
              One-tap links to DraftKings so you can act on a pick the moment you see it.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold text-white">Simple pricing</h2>
        <div className="mx-auto mt-8 max-w-md rounded-lg border-2 border-sharp-600 bg-neutral-900 p-6 text-center">
          <p className="text-3xl font-bold text-white">$1.99 – $4.99</p>
          <p className="mt-1 text-sm text-neutral-500">per pick, priced by confidence</p>
          <ul className="mt-4 space-y-2 text-sm text-neutral-400">
            <li>One free pick every day</li>
            <li>Pay only for the picks you want</li>
            <li>Unlock all of today's picks together at a discount</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
