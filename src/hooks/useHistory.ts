import { useCallback, useRef, useState } from "react";

/**
 * Undo/redo for editor state. Rapid changes with the same `key` (e.g. dragging a slider) are merged into ONE undo step.
 */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState({ past: [] as T[], present: initial, future: [] as T[] });
  const last = useRef<{ key: string; at: number } | null>(null);
  const base = useRef(initial);

  const set = useCallback((next: T | ((cur: T) => T), key?: string) => {
    setState((s) => {
      const value = typeof next === "function" ? (next as (c: T) => T)(s.present) : next;
      if (Object.is(value, s.present)) return s;
      const now = Date.now();
      const merge = !!key && last.current?.key === key && now - last.current.at < 800 && s.past.length > 0;
      last.current = key ? { key, at: now } : null;
      return merge ? { past: s.past, present: value, future: [] } : { past: [...s.past.slice(-49), s.present], present: value, future: [] };
    });
  }, []);

  const undo = useCallback(() => { last.current = null; setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)); }, []);
  const redo = useCallback(() => { last.current = null; setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)); }, []);
  /** Back to the starting state; the reset itself can be undone. */
  const reset = useCallback(() => { last.current = null; setState((s) => (Object.is(s.present, base.current) ? s : { past: [...s.past, s.present], present: base.current, future: [] })); }, []);
  /** Start over with a brand-new baseline (e.g. a new file was opened). */
  const restart = useCallback((value: T) => { last.current = null; base.current = value; setState({ past: [], present: value, future: [] }); }, []);

  return { value: state.present, set, undo, redo, reset, restart, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
