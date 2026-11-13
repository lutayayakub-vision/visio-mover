import { useId } from "react";

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email";
  error?: string;
  autoComplete?: string;
  disabled?: boolean;
  maxLength?: number;
};

export default function TextField({ label, value, onChange, type = "text", error, autoComplete, disabled, maxLength }: Props) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={`input-wrap ${error ? "invalid" : ""}`}>
        <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete}
          disabled={disabled} maxLength={maxLength} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} />
      </div>
      {error && <p className="field-error" id={`${id}-err`} role="alert">{error}</p>}
    </div>
  );
}
