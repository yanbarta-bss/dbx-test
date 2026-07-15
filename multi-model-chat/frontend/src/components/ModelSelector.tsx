import type { ModelInfo } from '../api';

type ModelSelectorProps = {
  models: ModelInfo[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

export default function ModelSelector({ models, value, disabled, onChange }: ModelSelectorProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
      <span style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Model
      </span>
      <select
        value={value}
        disabled={disabled || models.length === 0}
        onChange={(event) => onChange(event.target.value)}
        style={{
          borderRadius: 12,
          border: '1px solid rgba(148, 163, 184, 0.25)',
          background: '#0f172a',
          color: '#e2e8f0',
          padding: '10px 12px',
          fontSize: 14,
          outline: 'none',
        }}
      >
        {models.length === 0 ? <option value="">No models available</option> : null}
        {models.map((model) => (
          <option key={model.name} value={model.name}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}
