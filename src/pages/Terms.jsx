export default function Terms() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 text-sm leading-6 text-neutral-400">
      <h1 className="text-2xl font-bold text-white">Terms of Service</h1>
      <p className="mt-2 text-xs text-neutral-600">
        Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
      </p>
      <p className="mt-4 rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-500">
        This is a standard template covering the essentials for a service like PickSharp. It has not been
        reviewed by an attorney — have it reviewed before relying on it as a final, binding legal document.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">1. Who we are</h2>
      <p className="mt-2">
        PickSharp ("PickSharp," "we," "us," or "our") is operated by [Legal Entity Name], based in
        [Jurisdiction]. These Terms of Service ("Terms") govern your access to and use of wepicksharp.com and
        related services (the "Service"). By using the Service, you agree to these Terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">2. What the Service is</h2>
      <p className="mt-2">
        PickSharp publishes sports betting picks for entertainment and informational purposes. Some picks are
        PickSharp's own AI-assisted analysis of publicly available odds data. Others are real picks
        genuinely posted by real, named public accounts on X, reproduced with attribution and a link back to
        the source. We independently verify aggregated picks against the original source before publishing
        them.
      </p>
      <p className="mt-2">
        <strong className="text-neutral-300">Nothing on PickSharp is gambling advice, financial advice, or a
        guarantee of any outcome.</strong> Sports betting results are inherently uncertain. Past performance
        of any pick, model, or account does not predict future results.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">3. Eligibility</h2>
      <p className="mt-2">
        You must be at least 21 years old and located in a jurisdiction where sports betting is legal to use
        any betting-related features of the Service. You are solely responsible for knowing and complying
        with the laws that apply to you.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">4. Accounts and payments</h2>
      <p className="mt-2">
        Creating an account requires a valid email address. You're responsible for keeping your login
        credentials secure. Payments are processed by Stripe; PickSharp does not store your card details.
        Individual picks and bundles are priced as shown at checkout. Because unlocked content is delivered
        instantly and cannot be "returned," <strong className="text-neutral-300">all sales are final</strong> —
        we don't offer refunds except where required by law or at our sole discretion.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">5. Affiliate links</h2>
      <p className="mt-2">
        PickSharp participates in sportsbook affiliate programs. Some links on the Service (including links to
        DraftKings) are affiliate links, and we may earn a commission if you sign up or place a bet through
        them, at no extra cost to you. This does not influence which picks we publish.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">6. AI-assisted content</h2>
      <p className="mt-2">
        Picks attributed to "PickSharp" are generated with the assistance of AI models analyzing real,
        current market odds. They are never attributed to, or presented as coming from, any real individual
        who did not actually post them. AI-assisted analysis has no proven predictive edge over the betting
        market and should be treated the same as any other opinion — not a guarantee.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">7. Acceptable use</h2>
      <p className="mt-2">
        You agree not to misuse the Service — including attempting to circumvent the paywall, scraping
        content at scale, or using the Service in any way that violates applicable law.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">8. Disclaimers and limitation of liability</h2>
      <p className="mt-2">
        The Service is provided "as is" without warranties of any kind. To the fullest extent permitted by
        law, PickSharp is not liable for any losses arising from bets placed based on content from the
        Service, including losses resulting from inaccurate, delayed, or incomplete information.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">9. Changes</h2>
      <p className="mt-2">
        We may update these Terms from time to time. Continued use of the Service after changes take effect
        constitutes acceptance of the revised Terms.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">10. Contact</h2>
      <p className="mt-2">Questions about these Terms: wepicksharp@gmail.com.</p>
    </div>
  );
}
