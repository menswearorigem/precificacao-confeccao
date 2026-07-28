export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function NumInput({ value, onChange, step = '0.01', suffix, ...props }) {
  return (
    <div className="numwrap">
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        {...props}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

export function Row({ label, value, strong, big }) {
  return (
    <div className={'row-line' + (strong ? ' strong' : '') + (big ? ' big' : '')}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
