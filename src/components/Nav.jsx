import { Link, NavLink } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';

export default function Nav({ session }) {
  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const linkClass = ({ isActive }) =>
    `text-sm font-medium ${isActive ? 'text-sharp-500' : 'text-neutral-400 hover:text-sharp-500'}`;

  return (
    <header className="border-b border-neutral-800 bg-neutral-950">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Link to="/" className="flex items-center">
          <img src="/logo-white.png" alt="PickSharp" className="h-9 w-auto" />
        </Link>
        <nav className="flex items-center gap-6">
          <NavLink to="/picks" className={linkClass}>
            Picks
          </NavLink>
          {session ? (
            <>
              <NavLink to="/dashboard" className={linkClass}>
                Dashboard
              </NavLink>
              <button
                onClick={handleLogout}
                className="text-sm font-medium text-neutral-400 hover:text-sharp-500"
              >
                Log out
              </button>
            </>
          ) : (
            <Link
              to="/auth"
              className="rounded-md bg-gradient-to-b from-[#f3dd8f] via-[#c6971f] to-[#8a6a17] px-4 py-2 text-sm font-semibold text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:from-[#f7e6a8] hover:via-[#d4a72e] hover:to-[#9c7818]"
            >
              Get Free Picks
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
