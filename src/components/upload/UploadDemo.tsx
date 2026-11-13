import { useCallback, useEffect, useRef, useState } from "react";
import Reveal from "../ui/Reveal";

type Category = "image" | "video" | "document";

const CATS: Record<Category, { label: string; exts: string[]; mimes: string[]; maxMB: number; hint: string }> = {
  image: { label: "Images", exts: ["jpg", "jpeg", "png", "webp"], mimes: ["image/jpeg", "image/png", "image/webp"], maxMB: 20, hint: "JPG, JPEG, PNG, WEBP" },
  video: { label: "Videos", exts: ["mp4", "mov", "webm"], mimes: ["video/mp4", "video/quicktime", "video/webm"], maxMB: 200, hint: "MP4, MOV, WEBM" },
  document: {
    label: "Documents",
    exts: ["pdf", "docx", "pptx"],
    mimes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    maxMB: 50,
    hint: "PDF, DOCX, PPTX",
  },
};

type Item = { id: string; file: File; url: string | null; cat: Category };
type Notice = { kind: "error" | "info"; text: string } | null;

const ICONS: Record<Category, string> = {
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1 1 0 1 0 0 .01",
  video: "M3 6h12v12H3zM15 10l6-3v10l-6-3",
  document: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6",
};

const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ext = (n: string) => n.split(".").pop()?.toLowerCase() ?? "";

function Icon({ cat, size = 28 }: { cat: Category; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[cat]} />
    </svg>
  );
}

export default function UploadDemo() {
  const [cat, setCat] = useState<Category>("image");
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<Set<string>>(new Set());

  // release browser memory on unmount
  useEffect(() => {
    const set = urls.current;
    return () => set.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const cfg = CATS[cat];
      const accepted: Item[] = [];
      const problems: string[] = [];
      Array.from(list).forEach((file) => {
        const e = ext(file.name);
        // Extension AND browser-reported type must agree. (Real content verification happens server-side in a later stage.)
        const typeOk = file.type === "" || cfg.mimes.includes(file.type);
        if (!cfg.exts.includes(e) || !typeOk) {
          problems.push(`"${file.name}" is not a supported ${cfg.label.toLowerCase()} file.`);
        } else if (file.size > cfg.maxMB * 1024 * 1024) {
          problems.push(`"${file.name}" is over the ${cfg.maxMB} MB demo limit.`);
        } else if (file.size === 0) {
          problems.push(`"${file.name}" is empty.`);
        } else {
          let url: string | null = null;
          if (cat !== "document") {
            url = URL.createObjectURL(file);
            urls.current.add(url);
          }
          accepted.push({ id: `${file.name}-${file.size}-${crypto.randomUUID()}`, file, url, cat });
        }
      });
      if (accepted.length) setItems((prev) => [...accepted, ...prev].slice(0, 6));
      setNotice(problems.length ? { kind: "error", text: problems.join(" ") } : null);
    },
    [cat]
  );

  const remove = (id: string) =>
    setItems((prev) => {
      const gone = prev.find((i) => i.id === id);
      if (gone?.url) { URL.revokeObjectURL(gone.url); urls.current.delete(gone.url); }
      return prev.filter((i) => i.id !== id);
    });

  const clearAll = () => {
    items.forEach((i) => i.url && URL.revokeObjectURL(i.url));
    urls.current.clear();
    setItems([]);
    setNotice(null);
  };

  const cfg = CATS[cat];

  return (
    <section id="upload" className="section">
      <div className="container">
        <Reveal>
          <div className="section-head">
            <span className="eyebrow">Try the interface</span>
            <h2>Choose a file and see how the workspace will feel</h2>
            <p>Pick a category, then drop a file in. This is an interface demonstration only.</p>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className="upload card">
            <div className="demo-banner" role="note">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
              <span><b>Frontend demo.</b> Files stay in your browser for preview. Nothing is uploaded, stored or processed.</span>
            </div>

            <div className="tabs" role="tablist" aria-label="File category">
              {(Object.keys(CATS) as Category[]).map((c) => (
                <button key={c} role="tab" aria-selected={cat === c} className={`tab ${cat === c ? "active" : ""}`}
                  onClick={() => { setCat(c); setNotice(null); }}>
                  <Icon cat={c} size={20} /> {CATS[c].label}
                </button>
              ))}
            </div>

            <div
              className={`dropzone ${over ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
              role="button"
              tabIndex={0}
              aria-label={`Choose ${cfg.label.toLowerCase()} or drag them here`}
            >
              <div className="dz-icon"><Icon cat={cat} size={34} /></div>
              <p className="dz-title">{over ? "Release to add" : `Drag ${cfg.label.toLowerCase()} here`}</p>
              <p className="dz-sub">or <span className="link">browse your device</span></p>
              <div className="dz-types">
                {cfg.exts.map((x) => <span key={x} className="chip">{x.toUpperCase()}</span>)}
                <span className="dz-limit">up to {cfg.maxMB} MB</span>
              </div>
              <input
                ref={input}
                type="file"
                hidden
                multiple
                accept={cfg.exts.map((x) => `.${x}`).join(",")}
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
              />
            </div>

            <div aria-live="polite">
              {notice && <p className={`notice ${notice.kind}`}>{notice.text}</p>}
            </div>

            {items.length > 0 && (
              <div className="previews">
                <div className="previews-head">
                  <h3>Selected files ({items.length})</h3>
                  <button className="text-btn" onClick={clearAll}>Clear all</button>
                </div>
                <ul>
                  {items.map((it) => (
                    <li key={it.id} className="preview">
                      <div className="preview-media">
                        {it.cat === "image" && it.url && <img src={it.url} alt={`Preview of ${it.file.name}`} />}
                        {it.cat === "video" && it.url && <video src={it.url} muted playsInline controls preload="metadata" aria-label={`Preview of ${it.file.name}`} />}
                        {it.cat === "document" && (
                          <div className="doc-tile"><Icon cat="document" size={34} /><b>{ext(it.file.name).toUpperCase()}</b></div>
                        )}
                      </div>
                      <div className="preview-meta">
                        <span className="preview-name" title={it.file.name}>{it.file.name}</span>
                        <span className="preview-sub">{fmtSize(it.file.size)} · <span className="badge proto">Preview only</span></span>
                      </div>
                      <button className="icon-btn" onClick={() => remove(it.id)} aria-label={`Remove ${it.file.name}`}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="demo-foot">Editing, processing and download arrive in later stages. No result is generated here.</p>
              </div>
            )}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
