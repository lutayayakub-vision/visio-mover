import { Link } from "react-router-dom";

export default function Logo() {
  return (
    <Link to="/" className="logo" aria-label="VISIOMOVER home">
      <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#6d5dfc" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="#11173a" stroke="rgba(255,255,255,.12)" />
        <path d="M7 9l9 15 9-15" fill="none" stroke="url(#logo-g)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="logo-word">VISIO<b>MOVER</b></span>
    </Link>
  );
}
