import { type CSSProperties } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { UsageRow } from '../api';

type Metric = 'total_tokens' | 'estimated_cost';

type ChartComponentProps = {
  rows: UsageRow[];
  metric?: Metric;
};

const num = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

const wrapperStyle: CSSProperties = { height: 320, width: '100%' };

export default function ChartComponent({ rows, metric = 'total_tokens' }: ChartComponentProps) {
  const isCost = metric === 'estimated_cost';
  const seriesLabel = isCost ? 'Estimated cost' : 'Total tokens';
  const format = (value: number) => (isCost ? usd.format(value) : num.format(value));

  const aggregated = new Map<string, number>();
  rows.forEach((row) => aggregated.set(row.user, (aggregated.get(row.user) ?? 0) + row[metric]));
  const data = Array.from(aggregated.entries())
    .map(([user, value]) => ({ user, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  return (
    <div style={wrapperStyle}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, left: 12, bottom: 8 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.12)" horizontal={false} />
          <XAxis type="number" tick={{ fill: '#94a3b8' }} axisLine={false} tickLine={false} />
          <YAxis dataKey="user" type="category" width={180} tick={{ fill: '#cbd5e1', fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: 'rgba(148,163,184,0.08)' }}
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 12, color: '#e2e8f0' }}
            formatter={(value: number) => [format(value), seriesLabel]}
          />
          <Bar dataKey="value" fill={isCost ? '#a855f7' : '#38bdf8'} radius={[0, 8, 8, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
