import { Link, NavLink } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';

export default function Nav({ session }) {
  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const linkClass = ({ isActive }) =>
    `text-sm font-medium ${isActive ? 'text-sharp-600' : 'text-slate-600 hover:text-sharp-600'}`;

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Link to="/" className="text-xl font-bold text-slate-900">
          Pick<span className="text-sharp-600">Sharp</span>
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
                className="text-sm font-medium text-slate-600 hover:text-sharp-600"
              >
                Log out
              </button>
            </>
          ) : (
            <Link
              to="/auth"
              className="rounded-md bg-sharp-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sharp-700"
            >
              Get Free Picks
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
