import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Nav from './components/Nav.jsx';
import Footer from './components/Footer.jsx';
import Record from './pages/Record.jsx';
import Auth from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AdminPanel from './pages/AdminPanel.jsx';
import Terms from './pages/Terms.jsx';
import Privacy from './pages/Privacy.jsx';
import { supabase } from './lib/supabase.js';

// AI picks were retired 2026-10-05. Old /picks links (X bio, past emails) land on the odds
// pages instead, which the Worker serves, so this has to be a full page load.
function OddsRedirect() {
  useEffect(() => {
    window.location.replace('/odds');
  }, []);
  return null;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Routes>
          <Route path="/picks" element={<OddsRedirect />} />
          <Route path="/record" element={<Record />} />
          <Route path="/auth" element={<Auth loadingSession={loadingSession} session={session} />} />
          <Route path="/dashboard" element={<Dashboard session={session} />} />
          <Route path="/admin" element={<AdminPanel session={session} loadingSession={loadingSession} />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
