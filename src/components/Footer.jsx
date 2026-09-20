import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="border-t border-neutral-800 bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-neutral-500">
        <p className="mb-2">
          PickSharp picks are AI-assisted analysis of real market data, plus real picks verified from public
          accounts on X, for entertainment and informational purposes only. We do not guarantee outcomes.
          Betting involves risk — never wager more than you can afford to lose.
        </p>
        <p>
          Gambling problem? Call{' '}
          <a href="tel:1-800-522-4700" className="underline hover:text-sharp-500">
            1-800-GAMBLER
          </a>
          . Must be 21+ and located in a jurisdiction where sports betting is legal.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-4 text-neutral-600">
          <span>© {new Date().getFullYear()} PickSharp. All rights reserved.</span>
          <Link to="/terms" className="underline hover:text-sharp-500">
            Terms of Service
          </Link>
          <Link to="/privacy" className="underline hover:text-sharp-500">
            Privacy Policy
          </Link>
        </p>
      </div>
    </footer>
  );
}
