import { FOOTER } from '../../shared/site.js';

// Same footer as the Worker pages (worker/pages.js layout()); both render shared/site.js.
export default function Footer() {
  return (
    <footer className="mt-8 border-t border-neutral-800 bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-neutral-500">
        <p className="mb-2">{FOOTER.disclaimer}</p>
        <p className="mb-2">
          Gambling problem? Call{' '}
          <a href={`tel:${FOOTER.helpline.tel}`} className="underline hover:text-sharp-500">
            {FOOTER.helpline.label}
          </a>
          . {FOOTER.eligibility}
        </p>
        <p className="mt-4 flex flex-wrap gap-x-4 text-neutral-600">
          <span>© {new Date().getFullYear()} PickSharp. All rights reserved.</span>
          {FOOTER.links.map((link) => (
            <a key={link.href} href={link.href} className="underline hover:text-sharp-500">
              {link.label}
            </a>
          ))}
        </p>
      </div>
    </footer>
  );
}
