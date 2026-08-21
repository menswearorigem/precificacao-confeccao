import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export default function PasswordField({ id, label, value, onChange, autoComplete, autoFocus, hint }) {
  const [visivel, setVisivel] = useState(false);
  return (
    <div className="login-field">
      <label htmlFor={id} className="login-label">{label}</label>
      <div className="login-control login-control-btn">
        <input
          id={id}
          type={visivel ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          onChange={onChange}
        />
        <button
          type="button"
          className="login-peek"
          aria-label={visivel ? 'Ocultar senha' : 'Mostrar senha'}
          onClick={() => setVisivel((v) => !v)}
        >
          {visivel ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {hint && <span className="login-hint">{hint}</span>}
    </div>
  );
}
