import FileIcon from "./FileIcon";
import Spinner from "../ui/Spinner";
import { CATEGORY_LABEL, formatBytes, type Category } from "../../lib/files";

export type QItem = {
  id: string;
  file: File;
  name: string;
  category: Category;
  ext: string;
  status: "queued" | "uploading" | "saving" | "done" | "error" | "cancelled";
  progress: number;
  error?: string;
};

const STATUS_TEXT: Record<QItem["status"], string> = {
  queued: "Waiting…",
  uploading: "Uploading",
  saving: "Saving…",
  done: "Uploaded",
  error: "Failed",
  cancelled: "Cancelled",
};

type Props = { items: QItem[]; onCancel: (id: string) => void; onDismiss: (id: string) => void; onClearFinished: () => void };

export default function UploadQueue({ items, onCancel, onDismiss, onClearFinished }: Props) {
  if (items.length === 0) return null;
  const finished = items.filter((i) => ["done", "error", "cancelled"].includes(i.status)).length;

  return (
    <section className="panel card" aria-labelledby="uq-h">
      <div className="panel-head">
        <h2 id="uq-h">Uploads ({items.length})</h2>
        {finished > 0 && <button className="text-btn" onClick={onClearFinished}>Clear finished</button>}
      </div>
      <ul className="queue">
        {items.map((it) => {
          const pct = Math.round(it.progress * 100);
          const active = it.status === "uploading";
          return (
            <li key={it.id} className={`q-item q-${it.status}`}>
              <FileIcon category={it.category} />
              <div className="q-main">
                <div className="q-top">
                  <span className="q-name" title={it.name}>{it.name}</span>
                  <span className="q-meta">{CATEGORY_LABEL[it.category]} · {formatBytes(it.file.size)}</span>
                </div>
                {(active || it.status === "saving" || it.status === "queued") && (
                  <div className="bar" role="progressbar" aria-label={`Uploading ${it.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={active ? pct : it.status === "saving" ? 100 : 0}>
                    <i style={{ width: `${it.status === "queued" ? 0 : it.status === "saving" ? 100 : pct}%` }} />
                  </div>
                )}
                <div className={`q-status s-${it.status}`} aria-live="polite">
                  {it.status === "saving" && <Spinner size={14} />}
                  {active ? `Uploading ${pct}%` : STATUS_TEXT[it.status]}
                  {it.status === "error" && it.error ? ` · ${it.error}` : ""}
                </div>
              </div>
              {(it.status === "queued" || active) ? (
                <button className="icon-btn" onClick={() => onCancel(it.id)} aria-label={`Cancel upload of ${it.name}`} title="Cancel">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              ) : it.status !== "saving" ? (
                <button className="icon-btn" onClick={() => onDismiss(it.id)} aria-label={`Dismiss ${it.name}`} title="Dismiss">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
