import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { getUsage, type MeResponse, type UsageResponse, type UsageRow } from '../api';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type DashboardPageProps = {
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

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

function InlineChart({ rows }: { rows: UsageRow[] }) {
  const m = new Map<string, number>();
  rows.forEach((r) => m.set(r.user, (m.get(r.user) ?? 0) + r.estimated_cost));
  const data = Array.from(m.entries()).map(([user, cost]) => ({ user, cost: Number(cost.toFixed(4)) })).sort((a, b) => b.cost - a.cost).slice(0, 10);
  return (
    <div style={{ height: 320, width: '100%' }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, left: 12, bottom: 8 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.12)" horizontal={false} />
          <XAxis type="number" tick={{ fill: '#94a3b8' }} axisLine={false} tickLine={false} />
          <YAxis dataKey="user" type="category" width={180} tick={{ fill: '#cbd5e1', fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }} contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 12, color: '#e2e8f0' }} formatter={(v: number) => [`${v.toFixed(4)}`, 'Cost']} />
          <Bar dataKey="cost" fill="#38bdf8" radius={[0, 8, 8, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function InlineTable({ rows }: { rows: UsageRow[] }) {
  const th: CSSProperties = { padding: '12px 16px', borderBottom: '1px solid rgba(148,163,184,0.16)', color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', textAlign: 'left' };
  const td: CSSProperties = { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.08)' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
        <thead><tr><th style={th}>User</th><th style={th}>Model</th><th style={th}>Requests</th><th style={th}>DBUs</th><th style={th}>Cost</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user + r.model}><td style={td}>{r.user}</td><td style={td}>{r.model}</td><td style={td}>{r.request_count}</td><td style={td}>{r.total_dbus.toFixed(4)}</td><td style={td}>{fmt.format(r.estimated_cost)}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: '#94a3b8' }}>No data for this period.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardPage({ me }: DashboardPageProps) {
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getUsage(days)
      .then(setUsage)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load usage.'))
      .finally(() => setLoading(false));
  }, [days]);

  const totals = useMemo(() => {
    const rows = usage?.rows ?? [];
    return rows.reduce(
      (acc, row) => ({
        requests: acc.requests + row.request_count,
        dbus: acc.dbus + row.total_dbus,
        cost: acc.cost + row.estimated_cost,
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
            Real DBUs from <code>system.billing.usage</code> attributed to AI Gateway. Signed in as {me.name}.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link to="/" style={{ textDecoration: 'none', color: '#e2e8f0', borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.2)', padding: '10px 14px' }}>
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
                Last {range}d
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
        {[
          { label: 'Requests', value: String(totals.requests) },
          { label: 'Total DBUs', value: totals.dbus.toFixed(4) },
          { label: 'Estimated Cost', value: formatCurrency(totals.cost) },
        ].map(({ label, value }) => (
          <div key={label} style={cardStyle}>
            <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 32, fontWeight: 700, marginTop: 10 }}>{value}</div>
          </div>
        ))}
      </section>

      <section style={{ ...cardStyle, minHeight: 380 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Top users by cost</div>
        {loading ? <div style={{ color: '#94a3b8' }}>Loading...</div> : <InlineChart rows={usage?.rows ?? []} />}
      </section>

      <section style={cardStyle}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>User and model breakdown</div>
        {loading ? <div style={{ color: '#94a3b8' }}>Loading...</div> : <InlineTable rows={usage?.rows ?? []} />}
      </section>
    </div>
  );
}
