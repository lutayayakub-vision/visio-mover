export default function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-live="polite">
      <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="sp-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#6d5dfc" />
          </linearGradient>
        </defs>
        <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,.12)" strokeWidth="3" />
        <path d="M12 3a9 9 0 0 1 9 9" stroke="url(#sp-g)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
