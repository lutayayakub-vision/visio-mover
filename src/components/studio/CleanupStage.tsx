import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rasterMask, type Stroke } from "../../lib/inpaint/strokes";

/** Brush strokes with undo/redo. Strokes are vectors in image pixels, so history is cheap and resolution independent. */
export function useStrokes() {
  const [state, setState] = useState<{ list: Stroke[]; redo: Stroke[] }>({ list: [], redo: [] });
  const add = useCallback((s: Stroke) => setState((p) => ({ list: [...p.list, s], redo: [] })), []);
  const undo = useCallback(() => setState((p) => (p.list.length ? { list: p.list.slice(0, -1), redo: [...p.redo, p.list[p.list.length - 1]] } : p)), []);
  const redo = useCallback(() => setState((p) => (p.redo.length ? { list: [...p.list, p.redo[p.redo.length - 1]], redo: p.redo.slice(0, -1) } : p)), []);
  const clear = useCallback(() => setState({ list: [], redo: [] }), []);
  return { strokes: state.list, canUndo: state.list.length > 0, canRedo: state.redo.length > 0, add, undo, redo, clear };
}
export type StrokesApi = ReturnType<typeof useStrokes>;

type Tool = "brush" | "eraser" | "pan";
type View = { s: number; tx: number; ty: number };
const MAX_ZOOM = 16;

type Props = {
  /** What is drawn under the mask (a preview-resolution copy of the current image). */
  display: ImageBitmap | HTMLCanvasElement;
  imgW: number;
  imgH: number;
  api: StrokesApi;
  disabled?: boolean;
};

export default function CleanupStage({ display, imgW, imgH, api, disabled }: Props) {
  const { strokes, add } = api;
  const [tool, setTool] = useState<Tool>("brush");
  const maxDia = Math.max(60, Math.round(Math.min(imgW, imgH) * 0.3));
  const [dia, setDia] = useState(() => Math.max(8, Math.round(Math.min(imgW, imgH) * 0.04)));
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState<Stroke | null>(null);

  const vp = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d: number; cx: number; cy: number; view: View } | null>(null);
  const panning = useRef<{ x: number; y: number; view: View } | null>(null);
  const drawing = useRef<Stroke | null>(null);
  const spaceDown = useRef(false);

  const dw = display.width, dh = display.height;
  const k = dw / imgW; // image px -> preview px

  useEffect(() => {
    const c = baseRef.current; if (!c) return;
    c.width = dw; c.height = dh; c.getContext("2d")!.drawImage(display, 0, 0);
  }, [display, dw, dh]);

  // mask overlay: red where selected
  const all = useMemo(() => (live ? [...strokes, live] : strokes), [strokes, live]);
  useEffect(() => {
    const c = maskRef.current; if (!c) return;
    c.width = dw; c.height = dh;
    const ctx = c.getContext("2d")!;
    if (!all.length) { ctx.clearRect(0, 0, dw, dh); return; }
    const m = rasterMask(all, { x: 0, y: 0, w: dw, h: dh }, k);
    const img = ctx.createImageData(dw, dh);
    for (let i = 0; i < m.length; i++) if (m[i]) { const o = i * 4; img.data[o] = 255; img.data[o + 1] = 40; img.data[o + 2] = 70; img.data[o + 3] = 140; }
    ctx.putImageData(img, 0, 0);
  }, [all, dw, dh, k]);

  const clampView = useCallback((v: View): View => {
    const el = vp.current; if (!el) return v;
    const { width, height } = el.getBoundingClientRect();
    const s = Math.min(MAX_ZOOM, Math.max(1, v.s));
    return { s, tx: Math.min(0, Math.max(width - width * s, v.tx)), ty: Math.min(0, Math.max(height - height * s, v.ty)) };
  }, []);
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => { const s = Math.min(MAX_ZOOM, Math.max(1, v.s * factor)); const f = s / v.s; return clampView({ s, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f }); });
  }, [clampView]);
  const zoomCentre = (f: number) => { const r = vp.current?.getBoundingClientRect(); if (r) zoomAt(f, r.width / 2, r.height / 2); };

  useEffect(() => {
    const el = vp.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.code === "Space" && (e.target as HTMLElement)?.tagName !== "INPUT") { spaceDown.current = true; if (e.target === document.body) e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") spaceDown.current = false; };
    window.addEventListener("keydown", dn); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, []);

  const toImage = (cx: number, cy: number) => {
    const r = vp.current!.getBoundingClientRect();
    const x = ((cx - r.left - view.tx) / view.s / r.width) * imgW;
    const y = ((cy - r.top - view.ty) / view.s / r.height) * imgH;
    return [Math.min(imgW, Math.max(0, x)), Math.min(imgH, Math.max(0, y))] as const;
  };

  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) { // second finger: cancel any stroke, switch to pinch/pan
      drawing.current = null; setLive(null);
      const [a, b] = [...pointers.current.values()];
      const r = vp.current!.getBoundingClientRect();
      gesture.current = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, view };
      return;
    }
    if (tool === "pan" || spaceDown.current || e.button === 1) { panning.current = { x: e.clientX, y: e.clientY, view }; return; }
    const [x, y] = toImage(e.clientX, e.clientY);
    drawing.current = { erase: tool === "eraser", r: dia / 2, pts: [x, y] };
    setLive({ ...drawing.current });
  };
  const move = (e: React.PointerEvent) => {
    const r = vp.current!.getBoundingClientRect();
    if (e.pointerType === "mouse" || e.pointerType === "pen") setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      const s = Math.min(MAX_ZOOM, Math.max(1, g.view.s * (d / (g.d || 1))));
      const f = s / g.view.s;
      setView(clampView({ s, tx: cx - (g.cx - g.view.tx) * f, ty: cy - (g.cy - g.view.ty) * f }));
      return;
    }
    if (panning.current) {
      const p = panning.current;
      setView(clampView({ s: p.view.s, tx: p.view.tx + e.clientX - p.x, ty: p.view.ty + e.clientY - p.y }));
      return;
    }
    const cur = drawing.current;
    if (cur) {
      const [x, y] = toImage(e.clientX, e.clientY);
      const n = cur.pts.length;
      if (Math.hypot(x - cur.pts[n - 2], y - cur.pts[n - 1]) >= Math.max(0.5, cur.r / 6)) { cur.pts.push(x, y); setLive({ ...cur, pts: cur.pts.slice() }); }
    }
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    panning.current = null;
    const cur = drawing.current;
    if (cur && pointers.current.size === 0) { drawing.current = null; setLive(null); add({ ...cur, pts: cur.pts.slice() }); }
  };

  const screenDia = (dia / imgW) * (vp.current?.getBoundingClientRect().width ?? 0) * view.s;

  return (
    <div className="cl-stage">
      <div className="cl-tools" role="toolbar" aria-label="Selection tools">
        <div className="chips" role="group" aria-label="Tool">
          {([["brush", "Brush"], ["eraser", "Eraser"], ["pan", "Pan"]] as const).map(([id, l]) => (
            <button key={id} className={`chip-btn ${tool === id ? "on" : ""}`} aria-pressed={tool === id} onClick={() => setTool(id)} disabled={disabled} data-testid={`tool-${id}`}>{l}</button>
          ))}
        </div>
        <label className="cl-size">
          <span>Size <b data-testid="brush-size">{dia}</b> px</span>
          <input type="range" min={2} max={maxDia} value={Math.min(dia, maxDia)} onChange={(e) => setDia(Number(e.target.value))} disabled={disabled} aria-label="Brush size" data-testid="brush-slider" />
        </label>
        <div className="st-group" role="group" aria-label="Selection history">
          <button className="btn btn-ghost btn-sm" onClick={api.undo} disabled={!api.canUndo || disabled} data-testid="sel-undo"><span>Undo stroke</span></button>
          <button className="btn btn-ghost btn-sm" onClick={api.redo} disabled={!api.canRedo || disabled} data-testid="sel-redo"><span>Redo stroke</span></button>
          <button className="btn btn-ghost btn-sm" onClick={api.clear} disabled={!strokes.length || disabled} data-testid="sel-clear"><span>Clear</span></button>
        </div>
        <div className="st-group" role="group" aria-label="Zoom">
          <button className="btn btn-ghost btn-sm" onClick={() => zoomCentre(1 / 1.5)} aria-label="Zoom out"><span>−</span></button>
          <span className="st-muted cl-zoom" aria-live="polite" data-testid="zoom">{Math.round(view.s * 100)}%</span>
          <button className="btn btn-ghost btn-sm" onClick={() => zoomCentre(1.5)} aria-label="Zoom in"><span>+</span></button>
          <button className="btn btn-ghost btn-sm" onClick={() => setView({ s: 1, tx: 0, ty: 0 })}><span>Fit</span></button>
        </div>
      </div>

      <div className="cl-fit" style={{ width: `min(100%, ${(64 * (imgW / imgH)).toFixed(2)}vh)` }}>
        <div ref={vp} className={`cl-viewport ${tool === "pan" ? "is-pan" : ""}`} style={{ aspectRatio: `${imgW} / ${imgH}` }} data-testid="cleanup-viewport"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setCursor(null)}>
          <div className="cl-inner" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
            <canvas ref={baseRef} className="cl-layer" aria-label="Image to clean up" />
            <canvas ref={maskRef} className="cl-layer cl-mask" aria-label="Selected area" data-testid="mask-canvas" />
          </div>
          {cursor && tool !== "pan" && !disabled && <span className={`cl-cursor ${tool === "eraser" ? "is-erase" : ""}`} style={{ width: screenDia, height: screenDia, left: cursor.x, top: cursor.y }} />}
        </div>
      </div>
      <p className="st-muted cl-hint">Paint over what you want removed. Scroll or pinch to zoom, drag with Pan (or hold Space) to move around.</p>
    </div>
  );
}
