import { useEffect, useRef } from "react";
import Spinner from "../ui/Spinner";

type Props = { title: string; body: string; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void };

export default function ConfirmDialog({ title, body, confirmLabel, busy, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-back" role="presentation" onClick={() => !busy && onCancel()}>
      <div className="modal card" role="alertdialog" aria-modal="true" aria-labelledby="cd-title" aria-describedby="cd-body" onClick={(e) => e.stopPropagation()}>
        <h3 id="cd-title">{title}</h3>
        <p id="cd-body">{body}</p>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn btn-ghost btn-md" onClick={onCancel} disabled={busy}><span>Cancel</span></button>
          <button className="btn btn-danger btn-md" onClick={onConfirm} disabled={busy}>
            <span>{busy ? <><Spinner size={16} /> Deleting…</> : confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
