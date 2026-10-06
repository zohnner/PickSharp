import { Link } from 'react-router-dom';
import EmailCapture from '../components/EmailCapture.jsx';

export default function Landing() {
  return (
    <div>
      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          Find bets priced <span className="text-sharp-500">better than the market</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-neutral-400">
          Every game day, PickSharp compares 9 US sportsbooks against Pinnacle's no-vig fair price and flags the
          bets a book is selling for more than they're worth. Every flagged bet is tracked against the closing
          line in public, misses included.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {/* /odds is served by the Worker, not the SPA router, so it needs a full page load. */}
          <a
            href="/odds"
            className="inline-block rounded-md bg-gradient-to-b from-[#f3dd8f] via-[#c6971f] to-[#8a6a17] px-6 py-3 text-base font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:from-[#f7e6a8] hover:via-[#d4a72e] hover:to-[#9c7818]"
          >
            See today's odds
          </a>
          <Link
            to="/record"
            className="inline-block rounded-md border border-neutral-700 px-6 py-3 text-base font-semibold text-white hover:border-sharp-500"
          >
            View the record
          </Link>
        </div>
        <div id="signup" className="mx-auto max-w-xl text-left">
          <EmailCapture source="landing" />
        </div>
      </section>

      <section className="bg-neutral-900 py-16">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:grid-cols-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Math, not opinions</h3>
            <p className="mt-2 text-sm text-neutral-400">
              We remove the bookmaker's margin from Pinnacle's line to get a fair price, then compare it with each
              US book. An edge is a price above fair, not a prediction about who wins.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Proof, not promises</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Beating the closing line is the standard test of whether a bet was good. Our{' '}
              <Link to="/record" className="text-sharp-500 hover:underline">
                public record
              </Link>{' '}
              shows the closing line value of every edge we log.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Free tools</h3>
            <p className="mt-2 text-sm text-neutral-400">
              Check any bet yourself with the{' '}
              <a href="/tools/no-vig-calculator" className="text-sharp-500 hover:underline">
                no-vig calculator
              </a>{' '}
              and the{' '}
              <a href="/tools/ev-calculator" className="text-sharp-500 hover:underline">
                EV calculator
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold text-white">Free during the public trial</h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-neutral-400">
          Every edge we find goes out free by email while we build the record. A paid plan comes only after the
          record clears a public bar: 100 qualifying edges with a known closing line, averaging +1% closing line
          value or better. Trial subscribers get a founding-member price.
        </p>
      </section>
    </div>
  );
}
