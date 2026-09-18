import { Navigate } from 'react-router-dom';

export default function Dashboard({ session }) {
  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-500">Email</p>
        <p className="text-base font-medium text-slate-900">{session.user.email}</p>
      </div>
    </div>
  );
}
