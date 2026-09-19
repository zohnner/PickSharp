import { Navigate } from 'react-router-dom';

export default function Dashboard({ session }) {
  if (!session) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <p className="text-sm text-neutral-500">Email</p>
        <p className="text-base font-medium text-white">{session.user.email}</p>
      </div>
    </div>
  );
}
