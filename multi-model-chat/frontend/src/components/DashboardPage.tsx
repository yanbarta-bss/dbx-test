import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { getUsage, type MeResponse, type UsageResponse } from '../api';
import ChartComponent from './ChartComponent';
import TableComponent from './TableComponent';

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

const num = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

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
        totalTokens: acc.totalTokens + row.total_tokens,
        totalDbus: acc.totalDbus + row.total_dbus,
        estimatedCost: acc.estimatedCost + row.estimated_cost,
      }),
      { requests: 0, totalTokens: 0, totalDbus: 0, estimatedCost: 0 },
    );
  }, [usage]);

  const evalSummary = usage?.eval_summary ?? null;

  return (
    <div style={pageStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#38bdf8' }}>Admin dashboard</div>
          <h1 style={{ margin: '10px 0 8px', fontSize: 34 }}>Model usage &amp; governance</h1>
          <div style={{ color: '#94a3b8', maxWidth: 880, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>
              Real token usage from <code>system.serving.endpoint_usage</code>. Signed in as {me.name}.
            </span>
            {usage ? (
              <span
                title={`DBU price ${usd.format(usage.dbu_price)}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  borderRadius: 999,
                  padding: '4px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: usage.governed_by_gateway ? '#bbf7d0' : '#fcd34d',
                  background: usage.governed_by_gateway ? 'rgba(22, 101, 52, 0.35)' : 'rgba(120, 53, 15, 0.3)',
                  border: `1px solid ${usage.governed_by_gateway ? 'rgba(74, 222, 128, 0.4)' : 'rgba(252, 211, 77, 0.35)'}`,
                }}
              >
                {usage.governed_by_gateway ? '● Governed by AI Gateway' : '○ AI Gateway not detected'}
                <span style={{ opacity: 0.7 }}>· DBU {usd.format(usage.dbu_price)}</span>
              </span>
            ) : null}
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
          { label: 'Requests', value: num.format(totals.requests) },
          { label: 'Total tokens', value: num.format(totals.totalTokens) },
          { label: 'Total DBUs (est.)', value: totals.totalDbus.toFixed(2) },
          { label: 'Estimated cost', value: usd.format(totals.estimatedCost) },
        ].map(({ label, value }) => (
          <div key={label} style={cardStyle}>
            <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 32, fontWeight: 700, marginTop: 10 }}>{value}</div>
          </div>
        ))}
      </section>

      {evalSummary ? (
        <section style={cardStyle}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Quality (MLflow eval)</div>
          <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>
            LLM-as-judge scores over {evalSummary.sample_count} recent {evalSummary.sample_count === 1 ? 'answer' : 'answers'}.
          </div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            {[
              { label: 'Relevance', value: evalSummary.avg_relevance },
              { label: 'Safety', value: evalSummary.avg_safety },
              { label: 'Groundedness', value: evalSummary.avg_groundedness },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>{label}</div>
                <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6, color: '#a5b4fc' }}>{value.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <div style={{ ...cardStyle, minHeight: 380 }}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Top users by tokens</div>
          {loading ? <div style={{ color: '#94a3b8' }}>Loading...</div> : <ChartComponent rows={usage?.rows ?? []} metric="total_tokens" />}
        </div>
        <div style={{ ...cardStyle, minHeight: 380 }}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Top users by cost</div>
          {loading ? <div style={{ color: '#94a3b8' }}>Loading...</div> : <ChartComponent rows={usage?.rows ?? []} metric="estimated_cost" />}
        </div>
      </section>

      <section style={cardStyle}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>User and model breakdown</div>
        {loading ? <div style={{ color: '#94a3b8' }}>Loading...</div> : <TableComponent rows={usage?.rows ?? []} showCost />}
      </section>
    </div>
  );
}
