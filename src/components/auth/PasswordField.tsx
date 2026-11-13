import { useId, useState } from "react";
import { checkPassword } from "../../auth/validation";

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  autoComplete: "new-password" | "current-password";
  showStrength?: boolean;
  disabled?: boolean;
};

export default function PasswordField({ label, value, onChange, error, autoComplete, showStrength, disabled }: Props) {
  const id = useId();
  const [show, setShow] = useState(false);
  const check = showStrength ? checkPassword(value) : null;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={`input-wrap ${error ? "invalid" : ""}`}>
        <input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          maxLength={128}
          spellCheck={false}
        />
        <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {show ? <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6-.4.8-1.1 1.8-2.1 2.8M6.5 7.5C4.5 8.9 3.2 10.8 2.5 12c1 2 4.5 6 9.5 6 1.5 0 2.8-.4 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" /> : <><path d="M2.5 12C3.5 10 7 6 12 6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z" /><circle cx="12" cy="12" r="3" /></>}
          </svg>
        </button>
      </div>
      {error && <p className="field-error" id={`${id}-err`} role="alert">{error}</p>}
      {check && value.length > 0 && (
        <div className="strength" aria-live="polite">
          <div className="strength-bars" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <i key={i} className={i < check.score ? `on s${check.score}` : ""} />)}
          </div>
          <span className={`strength-label s${check.score}`}>{check.label}</span>
          <ul className="rules">
            {check.rules.map((r) => <li key={r.label} className={r.ok ? "ok" : ""}>{r.ok ? "✓" : "○"} {r.label}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
