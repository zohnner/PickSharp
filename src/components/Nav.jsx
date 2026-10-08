import { useLocation } from 'react-router-dom';
import { NAV, CTA_LABEL } from '../../shared/site.js';

// Same header as the Worker pages (worker/pages.js layout()); both render shared/site.js.
// Plain <a> tags: everything but /record is served by the Worker, so these are full page loads.
// Below 520px it wraps to two rows: logo + CTA, then the links.
export default function Nav() {
  const { pathname } = useLocation();

  return (
    <header className="border-b border-neutral-800 bg-neutral-950">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
        <a href="/" className="flex items-center">
          <img src="/logo-white.png" alt="PickSharp" className="h-8 w-auto sm:h-11" />
        </a>
        <nav
          aria-label="Main"
          className="order-3 flex w-full justify-around min-[520px]:order-none min-[520px]:ml-auto min-[520px]:w-auto min-[520px]:justify-start min-[520px]:gap-6"
        >
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <a
                key={item.key}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`text-sm font-medium ${active ? 'text-sharp-500' : 'text-neutral-400 hover:text-sharp-500'}`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <a
          href="/#signup"
          className="ml-auto whitespace-nowrap rounded-md bg-gradient-to-b from-[#f3dd8f] via-[#c6971f] to-[#8a6a17] px-4 py-2 text-sm font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:from-[#f7e6a8] hover:via-[#d4a72e] hover:to-[#9c7818] min-[520px]:ml-0"
        >
          {CTA_LABEL}
        </a>
      </div>
    </header>
  );
}
