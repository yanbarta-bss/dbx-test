import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { getUsage, type MeResponse, type UsageResponse } from '../api';
import UsageChart from './UsageChart';
import UsageTable from './UsageTable';

type AdminDashboardProps = {
  me: MeResponse;
};

const pageStyle: CSSProperties = {
  minHeight: '100vh',
  padding: 28,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

const cardStyle: CSSProperties = {
  borderRadius: 20,
  border: '1px solid rgba(148, 163, 184, 0.14)',
  background: 'rgba(15, 23, 42, 0.8)',
  boxShadow: '0 20px 40px rgba(2, 6, 23, 0.24)',
  padding: 20,
};

const ranges = [7, 30, 90];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(value);
}

export default function AdminDashboard({ me }: AdminDashboardProps) {
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getUsage(days)
      .then(setUsage)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Failed to load usage metrics.'))
      .finally(() => setLoading(false));
  }, [days]);

  const totals = useMemo(() => {
    const rows = usage?.rows ?? [];
    return rows.reduce(
      (accumulator, row) => ({
        requests: accumulator.requests + row.request_count,
        dbus: accumulator.dbus + row.total_dbus,
        cost: accumulator.cost + row.estimated_cost,
      }),
      { requests: 0, dbus: 0, cost: 0 },
    );
  }, [usage]);

  return (
    <div style={pageStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#38bdf8' }}>Admin dashboard</div>
          <h1 style={{ margin: '10px 0 8px', fontSize: 34 }}>Model usage and cost</h1>
          <div style={{ color: '#94a3b8', maxWidth: 880 }}>
            View model serving DBUs attributed to AI Gateway records in billing system tables. Signed in as {me.name}.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link
            to="/"
            style={{
              textDecoration: 'none',
              color: '#e2e8f0',
              borderRadius: 12,
              border: '1px solid rgba(148, 163, 184, 0.2)',
              padding: '10px 14px',
            }}
          >
            Back to chat
          </Link>
          <div style={{ display: 'flex', gap: 8 }}>
            {ranges.map((range) => (
              <button
                key={range}
                onClick={() => setDays(range)}
                style={{
                  border: range === days ? '1px solid rgba(56, 189, 248, 0.55)' : '1px solid rgba(148, 163, 184, 0.18)',
                  background: range === days ? 'rgba(37, 99, 235, 0.22)' : 'rgba(15, 23, 42, 0.72)',
                  color: '#e2e8f0',
                  borderRadius: 12,
                  padding: '10px 14px',
                  cursor: 'pointer',
                }}
              >
                Last {range} days
              </button>
            ))}
          </div>
        </div>
      </header>

      {usage?.message ? (
        <div style={{ ...cardStyle, color: '#fcd34d', background: 'rgba(120, 53, 15, 0.24)' }}>{usage.message}</div>
      ) : null}

      {error ? <div style={{ ...cardStyle, color: '#fecaca', background: 'rgba(127, 29, 29, 0.35)' }}>{error}</div> : null}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <div style={cardStyle}>
          <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>Requests</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 10 }}>{totals.requests}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>Total DBUs</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 10 }}>{totals.dbus.toFixed(4)}</div>
        </div>
        <div style={cardStyle}>
          <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>Estimated Cost</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 10 }}>{formatCurrency(totals.cost)}</div>
        </div>
      </section>

      <section style={{ ...cardStyle, minHeight: 380 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Top users by cost</div>
        {loading ? <div style={{ color: '#94a3b8' }}>Loading usage chart…</div> : <UsageChart rows={usage?.rows ?? []} />}
      </section>

      <section style={cardStyle}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>User and model breakdown</div>
        {loading ? <div style={{ color: '#94a3b8' }}>Loading usage table…</div> : <UsageTable rows={usage?.rows ?? []} />}
      </section>
    </div>
  );
}
