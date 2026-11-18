import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../components/ui/Toast";
import Spinner from "../../components/ui/Spinner";
import FileIcon from "../../components/workspace/FileIcon";
import ConfirmDialog from "../../components/workspace/ConfirmDialog";
import { isEditable } from "../../lib/editing";
import UploadQueue, { type QItem } from "../../components/workspace/UploadQueue";
import {
  ACCEPT, ALLOWED_LABEL, CATEGORY_LABEL, QUOTA_BYTES, SPECS,
  deleteFile, downloadFile, formatBytes, formatDate, getUsedBytes, listFiles, registerFile,
  UploadCancelled, uploadObject, validateFile, cleanFileName, extOf,
  type Category, type FileRecord, type ListQuery,
} from "../../lib/files";

const PAGE = 12;
const MAX_PARALLEL = 2;
const MAX_PER_BATCH = 20;

const FILTERS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "All" }, { id: "image", label: "Images" }, { id: "video", label: "Videos" }, { id: "document", label: "Documents" },
];

export default function Workspace() {
  const { user } = useAuth();
  const toast = useToast();
  const userId = user!.id; // route is protected, so a user always exists here

  // ----- upload queue -----
  const [queue, setQueue] = useState<QItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const started = useRef(new Set<string>());
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ----- usage -----
  const [used, setUsed] = useState<number | null>(null);

  // ----- list -----
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [sort, setSort] = useState<ListQuery["sort"]>("newest");
  const [rows, setRows] = useState<FileRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const reqId = useRef(0);

  // ----- row actions -----
  const [downloading, setDownloading] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<FileRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const patch = useCallback((id: string, p: Partial<QItem>) => setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...p } : i))), []);

  useEffect(() => { const t = setTimeout(() => setSearch(searchText), 300); return () => clearTimeout(t); }, [searchText]);

  // load first page whenever filters change or something was uploaded/deleted
  useEffect(() => {
    const id = ++reqId.current;
    setListError(null);
    setLoading(true);
    listFiles({ search, category, sort, from: 0, to: PAGE - 1 })
      .then(({ rows: r, total: t }) => { if (id === reqId.current) { setRows(r); setTotal(t); } })
      .catch((e: Error) => { if (id === reqId.current) setListError(e.message); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [search, category, sort, refreshKey]);

  useEffect(() => { getUsedBytes().then(setUsed).catch(() => setUsed(null)); }, [refreshKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const { rows: r, total: t } = await listFiles({ search, category, sort, from: rows.length, to: rows.length + PAGE - 1 });
      setRows((prev) => [...prev, ...r.filter((x) => !prev.some((p) => p.id === x.id))]);
      setTotal(t);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Couldn't load more files.");
    } finally { setLoadingMore(false); }
  };

  // ----- upload scheduler -----
  const runItem = useCallback(async (item: QItem) => {
    const ctrl = new AbortController();
    controllers.current.set(item.id, ctrl);
    patch(item.id, { status: "uploading", progress: 0 });
    try {
      const spec = SPECS[item.ext];
      const path = await uploadObject(item.file, item.ext, spec.mime, userId, (p) => patch(item.id, { progress: p }), ctrl.signal);
      patch(item.id, { status: "saving", progress: 1 });
      await registerFile(path, item.name, item.category, spec.mime, item.file.size);
      patch(item.id, { status: "done" });
      toast("success", `Uploaded ${item.name}`);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      if (e instanceof UploadCancelled) patch(item.id, { status: "cancelled" });
      else patch(item.id, { status: "error", error: e instanceof Error ? e.message : "Upload failed." });
    } finally {
      controllers.current.delete(item.id);
    }
  }, [patch, toast, userId]);

  useEffect(() => {
    let slots = MAX_PARALLEL - queue.filter((i) => i.status === "uploading" || i.status === "saving").length;
    for (const item of queue) {
      if (slots <= 0) break;
      if (item.status === "queued" && !started.current.has(item.id)) {
        started.current.add(item.id);
        slots--;
        void runItem(item);
      }
    }
  }, [queue, runItem]);

  // cancel everything in flight if the page is left
  useEffect(() => {
    const map = controllers.current;
    return () => map.forEach((c) => c.abort());
  }, []);

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const files = Array.from(list);
    if (!files.length) return;
    if (files.length > MAX_PER_BATCH) toast("info", `Only the first ${MAX_PER_BATCH} files were added. Upload the rest in another batch.`);
    const batch = files.slice(0, MAX_PER_BATCH);

    const pending = queue.filter((i) => ["queued", "uploading", "saving"].includes(i.status)).reduce((n, i) => n + i.file.size, 0);
    let budget = QUOTA_BYTES - (used ?? 0) - pending;

    const items: QItem[] = [];
    for (const file of batch) {
      const name = cleanFileName(file.name);
      const v = await validateFile(file);
      const base = { id: crypto.randomUUID(), file, name, progress: 0 };
      if (!v.ok) {
        items.push({ ...base, category: SPECS[extOf(name)]?.category ?? "document", ext: extOf(name), status: "error", error: v.message });
      } else if (file.size > budget) {
        items.push({ ...base, category: v.spec.category, ext: v.ext, status: "error", error: `Not enough storage left. You have ${formatBytes(Math.max(0, budget))} free.` });
      } else {
        budget -= file.size;
        items.push({ ...base, category: v.spec.category, ext: v.ext, status: "queued" });
      }
    }
    setQueue((q) => [...items, ...q]);
  }, [queue, toast, used]);

  const cancel = (id: string) => {
    const c = controllers.current.get(id);
    if (c) c.abort();
    else { started.current.add(id); patch(id, { status: "cancelled" }); } // still waiting in line
  };
  const dismiss = (id: string) => setQueue((q) => q.filter((i) => i.id !== id));
  const clearFinished = () => setQueue((q) => q.filter((i) => !["done", "error", "cancelled"].includes(i.status)));

  // ----- row actions -----
  const download = async (rec: FileRecord) => {
    setDownloading(rec.id);
    try { await downloadFile(rec); toast("success", `Download started: ${rec.original_name}`); }
    catch (e) { toast("error", e instanceof Error ? e.message : "Download failed."); }
    finally { setDownloading(null); }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await deleteFile(toDelete);
      toast("success", `Deleted ${toDelete.original_name}`);
      setToDelete(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Delete failed.");
    } finally { setDeleting(false); }
  };

  // ----- drag and drop -----
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); dragDepth.current = 0; setOver(false); void addFiles(e.dataTransfer.files); };

  const pct = used === null ? 0 : Math.min(100, (used / QUOTA_BYTES) * 100);
  const hasFilter = search.trim() !== "" || category !== "all";
  const noFilesAtAll = !loading && !listError && total === 0 && !hasFilter;

  return (
    <>
      <div className="page-head">
        <h1>Upload <span className="gradient-text">Workspace</span></h1>
        <p>Your files are private to your account. Upload, find, download and delete them here.</p>
      </div>

      <section className="panel card">
        <div
          className={`dropzone ws-drop ${over ? "over" : ""}`}
          onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setOver(true); }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setOver(false); }}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
          role="button" tabIndex={0}
          aria-label="Choose files to upload or drag them here"
        >
          <div className="dz-icon">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
          </div>
          <p className="dz-title">{over ? "Release to upload" : "Drag files here"}</p>
          <p className="dz-sub">or <span className="link">browse your device</span></p>
          <div className="dz-types"><span className="dz-limit">{ALLOWED_LABEL} · images up to 20 MB, video and documents up to 50 MB</span></div>
          <input ref={input} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
        </div>

        <div className="usage" aria-live="polite">
          <div className="usage-top">
            <span>Storage used</span>
            <b>{used === null ? "—" : `${formatBytes(used)} of ${formatBytes(QUOTA_BYTES)}`}</b>
          </div>
          <div className={`bar ${pct > 90 ? "warn" : ""}`} role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><i style={{ width: `${pct}%` }} /></div>
        </div>
      </section>

      <UploadQueue items={queue} onCancel={cancel} onDismiss={dismiss} onClearFinished={clearFinished} />

      <section className="panel card" aria-labelledby="yf-h">
        <div className="panel-head">
          <h2 id="yf-h">Your files{!loading && !listError ? ` (${total})` : ""}</h2>
        </div>

        <div className="toolbar">
          <div className="search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search by file name" aria-label="Search files by name" maxLength={100} />
          </div>
          <div className="chips" role="group" aria-label="Filter by type">
            {FILTERS.map((f) => (
              <button key={f.id} className={`chip-btn ${category === f.id ? "on" : ""}`} aria-pressed={category === f.id} onClick={() => setCategory(f.id)}>{f.label}</button>
            ))}
          </div>
          <label className="sort">
            <span className="sr-only">Sort files</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as ListQuery["sort"])}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A to Z</option>
              <option value="largest">Largest first</option>
            </select>
          </label>
        </div>

        {loading && rows.length === 0 && (
          <ul className="files" aria-busy="true" aria-label="Loading files">
            {[0, 1, 2].map((i) => <li key={i} className="frow skeleton"><span className="sk sk-ico" /><span className="sk sk-line" /><span className="sk sk-short" /></li>)}
          </ul>
        )}

        {listError && (
          <div className="empty" role="alert">
            <h3>{listError}</h3>
            <p>Check your connection and try again.</p>
            <button className="btn btn-ghost btn-md" onClick={() => setRefreshKey((k) => k + 1)}><span>Retry</span></button>
          </div>
        )}

        {noFilesAtAll && (
          <div className="empty">
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            <h3>No files yet</h3>
            <p>Drag a file into the box above, or choose one from your device.</p>
            <button className="btn btn-primary btn-md" onClick={() => input.current?.click()}><span>Upload your first file</span></button>
          </div>
        )}

        {!loading && !listError && total === 0 && hasFilter && (
          <div className="empty">
            <h3>No matching files</h3>
            <p>Try a different search or filter.</p>
            <button className="btn btn-ghost btn-md" onClick={() => { setSearchText(""); setCategory("all"); }}><span>Clear search and filters</span></button>
          </div>
        )}

        {rows.length > 0 && !listError && (
          <ul className="files">
            {rows.map((f) => (
              <li key={f.id} className="frow">
                <FileIcon category={f.category} />
                <div className="f-main">
                  <span className="f-name" title={f.original_name}>{f.original_name}</span>
                  <span className="f-meta">
                    <span className={`tag tag-${f.category}`}>{extOf(f.original_name).toUpperCase() || CATEGORY_LABEL[f.category]}</span>{f.edit_kind && <span className="tag">EDITED</span>}
                    <span>{formatBytes(f.size_bytes)}</span>
                    <span>Uploaded {formatDate(f.created_at)}</span>
                  </span>
                </div>
                <div className="f-actions">
                  {isEditable(f) && <Link className="btn btn-ghost btn-sm" to={`/${f.category}-editor?file=${f.id}`} aria-label={`Edit ${f.original_name}`}><span>Edit</span></Link>}
                  <button className="btn btn-ghost btn-sm" onClick={() => download(f)} disabled={downloading === f.id} aria-label={`Download ${f.original_name}`}>
                    <span>{downloading === f.id ? <Spinner size={14} /> : "Download"}</span>
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => setToDelete(f)} aria-label={`Delete ${f.original_name}`}><span>Delete</span></button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {rows.length > 0 && rows.length < total && !listError && (
          <div className="more">
            <button className="btn btn-ghost btn-md" onClick={loadMore} disabled={loadingMore}>
              <span>{loadingMore ? <><Spinner size={16} /> Loading…</> : `Load more (${total - rows.length} left)`}</span>
            </button>
          </div>
        )}
      </section>

      {toDelete && (
        <ConfirmDialog
          title="Delete this file?"
          body={`"${toDelete.original_name}" will be permanently removed from your storage. This can't be undone.`}
          confirmLabel="Delete file"
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
    </>
  );
}
