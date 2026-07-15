import { type CSSProperties, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getMe, type MeResponse } from './api';
import Chat from './components/Chat';
import DashboardPage from './components/DashboardPage';

const appShellStyle: CSSProperties = {
  minHeight: '100vh',
  background: 'linear-gradient(180deg, #020617 0%, #0f172a 100%)',
  color: '#e2e8f0',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
};

const centeredStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px',
  textAlign: 'center',
};

export default function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Failed to load user profile.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={centeredStyle}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>Loading multi-model chat</div>
          <div style={{ color: '#94a3b8' }}>Reading Databricks Apps SSO headers and workspace settings.</div>
        </div>
      </div>
    );
  }

  if (error || !me) {
    return (
      <div style={centeredStyle}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>App startup error</div>
          <div style={{ color: '#fca5a5', maxWidth: 720 }}>{error ?? 'Unable to load the authenticated user.'}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={appShellStyle}>
      <Routes>
        <Route path="/" element={<Chat me={me} />} />
        <Route path="/admin" element={me.isAdmin ? <DashboardPage me={me} /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
