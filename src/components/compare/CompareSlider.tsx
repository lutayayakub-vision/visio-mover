import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  before: ReactNode;
  after: ReactNode;
  beforeLabel?: string;
  afterLabel?: string;
  /** Gently sweeps the divider until the user interacts. */
  autoDemo?: boolean;
  aspect?: string;
};

export default function CompareSlider({
  before,
  after,
  beforeLabel = "Before",
  afterLabel = "After",
  autoDemo = false,
  aspect = "16 / 10",
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);
  const interacted = useRef(false);

  const setFromClientX = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pct = ((clientX - r.left) / r.width) * 100;
    setPos(Math.min(100, Math.max(0, pct)));
  }, []);

  // Auto demo sweep (stops forever after first interaction, respects reduced motion)
  useEffect(() => {
    if (!autoDemo) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      if (interacted.current) return;
      const t = (now - start) / 1000;
      setPos(50 + Math.sin(t * 0.9) * 32);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoDemo]);

  const onPointerDown = (e: React.PointerEvent) => {
    interacted.current = true;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) setFromClientX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 3;
    if (e.key === "ArrowLeft") { interacted.current = true; setPos((p) => Math.max(0, p - step)); e.preventDefault(); }
    if (e.key === "ArrowRight") { interacted.current = true; setPos((p) => Math.min(100, p + step)); e.preventDefault(); }
    if (e.key === "Home") { interacted.current = true; setPos(0); }
    if (e.key === "End") { interacted.current = true; setPos(100); }
  };

  return (
    <div
      ref={ref}
      className={`compare ${dragging ? "is-dragging" : ""}`}
      style={{ aspectRatio: aspect }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* After sits underneath; Before is clipped on top so dragging right reveals more "before". */}
      <div className="compare-layer">{after}</div>
      <div className="compare-layer" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        {before}
      </div>

      <span className="compare-tag compare-tag-l">{beforeLabel}</span>
      <span className="compare-tag compare-tag-r">{afterLabel}</span>

      <div className="compare-line" style={{ left: `${pos}%` }}>
        <div
          className="compare-handle"
          role="slider"
          tabIndex={0}
          aria-label="Before and after comparison"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          onKeyDown={onKeyDown}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6l-6 6 6 6M15 6l6 6-6 6" />
          </svg>
        </div>
      </div>
    </div>
  );
}
