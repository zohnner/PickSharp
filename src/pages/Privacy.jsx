export default function Privacy() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 text-sm leading-6 text-neutral-400">
      <h1 className="text-2xl font-bold text-white">Privacy Policy</h1>
      <p className="mt-2 text-xs text-neutral-600">
        Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
      </p>
      <p className="mt-4 rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-500">
        This is a standard template covering the essentials for a service like PickSharp. It has not been
        reviewed by an attorney — have it reviewed before relying on it as a final, binding legal document.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">1. What we collect</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong className="text-neutral-300">Account info:</strong> the email address you sign up with,
          handled by our authentication provider, Supabase.
        </li>
        <li>
          <strong className="text-neutral-300">Payment info:</strong> handled entirely by Stripe. We never
          see or store your full card number.
        </li>
        <li>
          <strong className="text-neutral-300">Purchase/unlock records:</strong> which picks you've unlocked,
          tied to a random token stored in your browser (not your identity) so unlocks persist on that
          device.
        </li>
        <li>
          <strong className="text-neutral-300">Basic usage data:</strong> standard web request logs
          (IP address, browser type, pages visited) collected by our hosting provider, Cloudflare.
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-semibold text-white">2. How we use it</h2>
      <p className="mt-2">
        To run the Service: creating your account, processing payments, delivering the picks you've paid
        for, and keeping the site secure and reliable. We do not sell your personal information.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">3. Who we share it with</h2>
      <p className="mt-2">
        Only the service providers that make PickSharp work: Supabase (authentication), Stripe (payments),
        and Cloudflare (hosting and database). Each has its own privacy policy governing how they handle
        data on our behalf. We don't share your information with anyone else except where required by law.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">4. Cookies and local storage</h2>
      <p className="mt-2">
        We use your browser's local storage to remember your unlock token and session — not third-party
        advertising trackers.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">5. Data retention</h2>
      <p className="mt-2">
        We keep account and purchase records for as long as your account is active, and as needed to comply
        with financial recordkeeping obligations.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">6. Your rights</h2>
      <p className="mt-2">
        You can request access to, correction of, or deletion of your account data at any time by contacting
        us at [privacy@wepicksharp.com].
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">7. Children's privacy</h2>
      <p className="mt-2">
        The Service is not directed at, and we do not knowingly collect information from, anyone under 21.
      </p>

      <h2 className="mt-8 text-lg font-semibold text-white">8. Changes</h2>
      <p className="mt-2">We may update this Privacy Policy from time to time; changes take effect when posted here.</p>

      <h2 className="mt-8 text-lg font-semibold text-white">9. Contact</h2>
      <p className="mt-2">Questions about this policy: [privacy@wepicksharp.com].</p>
    </div>
  );
}
