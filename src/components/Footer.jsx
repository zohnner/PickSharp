export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-500">
        <p className="mb-2">
          PickSharp aggregates publicly posted picks for entertainment and informational purposes only.
          We do not guarantee outcomes. Betting involves risk — never wager more than you can afford to lose.
        </p>
        <p>
          Gambling problem? Call{' '}
          <a href="tel:1-800-522-4700" className="underline hover:text-sharp-600">
            1-800-GAMBLER
          </a>
          . Must be 21+ and located in a jurisdiction where sports betting is legal.
        </p>
        <p className="mt-4 text-slate-400">© {new Date().getFullYear()} PickSharp. All rights reserved.</p>
      </div>
    </footer>
  );
}
