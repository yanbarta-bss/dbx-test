import { type CSSProperties } from 'react';
import type { UsageRow } from '../api';

type TableComponentProps = {
  rows: UsageRow[];
  showCost?: boolean;
};

const num = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

const th: CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid rgba(148,163,184,0.16)',
  color: '#94a3b8',
  fontSize: 12,
  textTransform: 'uppercase',
  textAlign: 'left',
};
const thNum: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.08)' };
const tdNum: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export default function TableComponent({ rows, showCost = false }: TableComponentProps) {
  const colCount = showCost ? 8 : 6;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: showCost ? 860 : 700 }}>
        <thead>
          <tr>
            <th style={th}>User</th>
            <th style={th}>Model</th>
            <th style={thNum}>Requests</th>
            <th style={thNum}>Input tokens</th>
            <th style={thNum}>Output tokens</th>
            <th style={thNum}>Total tokens</th>
            {showCost ? <th style={thNum}>Total DBUs</th> : null}
            {showCost ? <th style={thNum}>Est. cost</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.user + row.model}>
              <td style={td}>{row.user}</td>
              <td style={td}>{row.model}</td>
              <td style={tdNum}>{num.format(row.request_count)}</td>
              <td style={tdNum}>{num.format(row.input_tokens)}</td>
              <td style={tdNum}>{num.format(row.output_tokens)}</td>
              <td style={tdNum}>{num.format(row.total_tokens)}</td>
              {showCost ? <td style={tdNum}>{row.total_dbus.toFixed(2)}</td> : null}
              {showCost ? <td style={tdNum}>{usd.format(row.estimated_cost)}</td> : null}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={colCount} style={{ ...td, textAlign: 'center', color: '#94a3b8' }}>
                No data for this period.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
