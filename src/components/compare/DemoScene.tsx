/**
 * Original illustration used for the landing-page demo.
 * "marked" adds a sample overlay mark so the slider has something to remove.
 * This is a marketing illustration, not real output from the processing engine.
 */
export default function DemoScene({ marked }: { marked: boolean }) {
  return (
    <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice" className="scene" role="img"
      aria-label={marked ? "Illustration with unwanted marks" : "Same illustration, cleaned"}>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b1b6b" />
          <stop offset="0.55" stopColor="#c0457f" />
          <stop offset="1" stopColor="#ffb774" />
        </linearGradient>
        <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c2a6b" />
          <stop offset="1" stopColor="#0a1030" />
        </linearGradient>
        <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff3c4" />
          <stop offset="1" stopColor="#ffb774" />
        </radialGradient>
      </defs>
      <rect width="800" height="500" fill="url(#sky)" />
      <circle cx="520" cy="270" r="70" fill="url(#sun)" />
      {/* mountains */}
      <path d="M0 330 L120 220 L220 300 L330 190 L460 310 L560 240 L700 320 L800 260 L800 340 L0 340Z" fill="#251a5c" opacity="0.92" />
      <path d="M0 350 L90 290 L200 340 L320 280 L430 345 L560 295 L690 350 L800 310 L800 360 L0 360Z" fill="#170f45" />
      {/* sea */}
      <rect y="340" width="800" height="160" fill="url(#sea)" />
      <path d="M440 345 h160 M455 362 h130 M470 380 h100 M485 398 h70" stroke="#ffd6a0" strokeWidth="4" strokeLinecap="round" opacity="0.55" />
      {/* birds */}
      <path d="M120 120 q10 -12 20 0 q10 -12 20 0" fill="none" stroke="#f5f7ff" strokeWidth="2.5" opacity="0.8" />
      <path d="M200 160 q8 -10 16 0 q8 -10 16 0" fill="none" stroke="#f5f7ff" strokeWidth="2.5" opacity="0.7" />

      {marked && (
        <g className="scene-marks">
          {/* diagonal repeated sample text mark */}
          <g transform="rotate(-24 400 250)" fill="#ffffff" opacity="0.42" fontFamily="Sora, sans-serif" fontWeight="700" fontSize="46">
            <text x="120" y="190">SAMPLE MARK</text>
            <text x="330" y="300">SAMPLE MARK</text>
            <text x="30" y="360">SAMPLE MARK</text>
          </g>
          {/* corner stamp */}
          <g opacity="0.65">
            <rect x="590" y="415" width="190" height="62" rx="10" fill="#0a0e27" />
            <text x="685" y="455" textAnchor="middle" fill="#fff" fontFamily="Sora, sans-serif" fontWeight="700" fontSize="24">© STAMP</text>
          </g>
          {/* stray dust spots */}
          <circle cx="250" cy="110" r="9" fill="#d9d9e8" opacity="0.7" />
          <circle cx="680" cy="140" r="6" fill="#d9d9e8" opacity="0.7" />
        </g>
      )}
    </svg>
  );
}
