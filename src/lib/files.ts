import { supabase, supabaseKey, supabaseUrl } from "./supabase";

export const BUCKET = "visiomover-files";
export const QUOTA_BYTES = 524_288_000; // 500 MB, also enforced by a Supabase storage policy
const MB = 1024 * 1024;

export type Category = "image" | "video" | "document";

export type FileRecord = {
  id: string;
  storage_path: string;
  original_name: string;
  category: Category;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

/** Per-file limits. The bucket itself also refuses anything over 50 MB (Supabase free-plan ceiling). */
export const CATEGORY_LIMIT: Record<Category, number> = { image: 20 * MB, video: 50 * MB, document: 50 * MB };
export const CATEGORY_LABEL: Record<Category, string> = { image: "Image", video: "Video", document: "Document" };

type Spec = { category: Category; mime: string; check: (b: Uint8Array) => boolean };

const text = (b: Uint8Array, off: number, s: string) => s.split("").every((c, i) => b[off + i] === c.charCodeAt(0));
const raw = (b: Uint8Array, off: number, v: number[]) => v.every((x, i) => b[off + i] === x);

const jpeg: Spec = { category: "image", mime: "image/jpeg", check: (b) => raw(b, 0, [0xff, 0xd8, 0xff]) };
const zip = (mime: string): Spec => ({ category: "document", mime, check: (b) => raw(b, 0, [0x50, 0x4b, 0x03, 0x04]) });

/** Allowed formats. Magic bytes are checked in the browser for fast feedback; server-side scanning arrives in Stage 7. */
export const SPECS: Record<string, Spec> = {
  jpg: jpeg,
  jpeg,
  png: { category: "image", mime: "image/png", check: (b) => raw(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  webp: { category: "image", mime: "image/webp", check: (b) => text(b, 0, "RIFF") && text(b, 8, "WEBP") },
  mp4: { category: "video", mime: "video/mp4", check: (b) => text(b, 4, "ftyp") },
  mov: { category: "video", mime: "video/quicktime", check: (b) => text(b, 4, "ftyp") || ["moov", "mdat", "free", "wide", "skip"].some((t) => text(b, 4, t)) },
  webm: { category: "video", mime: "video/webm", check: (b) => raw(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
  pdf: { category: "document", mime: "application/pdf", check: (b) => text(b, 0, "%PDF") },
  docx: zip("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  pptx: zip("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
};

export const ACCEPT = Object.keys(SPECS).map((e) => `.${e}`).join(",");
export const ALLOWED_LABEL = "JPG, PNG, WEBP, MP4, MOV, WEBM, PDF, DOCX, PPTX";

export const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < MB) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  if (b < 1024 * MB) return `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
  return `${(b / 1024 / MB).toFixed(1)} GB`;
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Display name only. Stored object names are random UUIDs, never user-controlled. */
export function cleanFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>/\\]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= 255) return cleaned || "file";
  const ext = extOf(cleaned);
  return cleaned.slice(0, 250 - ext.length) + "." + ext;
}

export type Validation = { ok: true; ext: string; spec: Spec } | { ok: false; message: string };

export async function validateFile(file: File): Promise<Validation> {
  const name = cleanFileName(file.name);
  if (file.size === 0) return { ok: false, message: `"${name}" is empty.` };
  const ext = extOf(name);
  const spec = SPECS[ext];
  if (!spec) return { ok: false, message: `"${name}" isn't a supported type. Allowed: ${ALLOWED_LABEL}.` };
  const limit = CATEGORY_LIMIT[spec.category];
  if (file.size > limit) return { ok: false, message: `"${name}" is ${formatBytes(file.size)}. ${CATEGORY_LABEL[spec.category]} files can be up to ${formatBytes(limit)}.` };
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!spec.check(head)) return { ok: false, message: `"${name}" doesn't look like a real .${ext} file, so it was not uploaded.` };
  } catch {
    return { ok: false, message: `"${name}" couldn't be read. Try selecting it again.` };
  }
  return { ok: true, ext, spec };
}

export class UploadCancelled extends Error {
  constructor() { super("Upload cancelled"); }
}

function describeStorageError(status: number, body: string): string {
  let message = "";
  let inner = status;
  try {
    const j = JSON.parse(body) as { message?: string; statusCode?: string | number };
    message = j.message ?? "";
    if (j.statusCode) inner = Number(j.statusCode) || status;
  } catch { /* non-JSON body */ }
  if (inner === 413 || /exceeded the maximum allowed size/i.test(message)) return "The file is larger than the allowed size.";
  if (inner === 401 || /jwt|expired/i.test(message)) return "Your session has ended. Please log in again.";
  if (/mime type|not supported/i.test(message)) return "This file type isn't allowed.";
  if (inner === 403 || /row-level security|violates/i.test(message)) return "Upload not permitted. You may have used all of your 500 MB of storage.";
  if (inner === 409 || /already exists/i.test(message)) return "A file with this stored name already exists. Please try again.";
  if (status >= 500) return "The storage service had a problem. Please try again shortly.";
  return "The upload failed. Please try again.";
}

/** Uploads straight to Supabase Storage with the user's own session token (XHR gives real progress and cancel). */
export async function uploadObject(
  file: File, ext: string, mime: string, userId: string,
  onProgress: (fraction: number) => void, signal: AbortSignal,
): Promise<string> {
  const { data } = await supabase.auth.getSession(); // refreshes the token when needed
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has ended. Please log in again.");
  if (signal.aborted) throw new UploadCancelled();

  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", supabaseKey);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(path) : reject(new Error(describeStorageError(xhr.status, xhr.responseText))));
    xhr.onerror = () => reject(new Error("Can't reach the server. Check your connection and try again."));
    xhr.ontimeout = () => reject(new Error("The upload timed out. Please try again."));
    xhr.onabort = () => reject(new UploadCancelled());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Creates the searchable record. Size and type are re-read from storage by the database, not trusted from here. */
export async function registerFile(path: string, name: string, category: Category, mime: string, size: number): Promise<void> {
  const { error } = await supabase.from("files").insert({ storage_path: path, original_name: name, category, mime_type: mime, size_bytes: size });
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]); // don't leave an unlisted file behind
    throw new Error("The file uploaded but couldn't be saved to your library, so it was removed. Please try again.");
  }
}

export type ListQuery = { search: string; category: Category | "all"; sort: "newest" | "oldest" | "name" | "largest"; from: number; to: number };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listFiles(q: ListQuery): Promise<{ rows: FileRecord[]; total: number }> {
  let query = supabase
    .from("files")
    .select("id, storage_path, original_name, category, mime_type, size_bytes, created_at", { count: "exact" });
  if (q.category !== "all") query = query.eq("category", q.category);
  const term = q.search.trim();
  if (term) query = query.ilike("original_name", `%${escapeLike(term)}%`);
  const order = { newest: ["created_at", false], oldest: ["created_at", true], name: ["original_name", true], largest: ["size_bytes", false] } as const;
  const [col, asc] = order[q.sort];
  const { data, error, count } = await query.order(col, { ascending: asc }).order("id").range(q.from, q.to);
  if (error) throw new Error("Couldn't load your files.");
  return { rows: (data ?? []) as FileRecord[], total: count ?? 0 };
}

export async function getUsedBytes(): Promise<number> {
  const { data, error } = await supabase.rpc("storage_used_bytes");
  if (error) throw new Error("Couldn't read your storage usage.");
  return Number(data ?? 0);
}

/** Short-lived (60 s) link created only for the signed-in owner; the bucket stays private. */
export async function downloadFile(rec: FileRecord): Promise<void> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rec.storage_path, 60, { download: rec.original_name });
  if (error || !data?.signedUrl) throw new Error("Couldn't start the download. Please try again.");
  const a = document.createElement("a");
  a.href = data.signedUrl;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function deleteFile(rec: FileRecord): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([rec.storage_path]);
  if (error) throw new Error("Couldn't delete the file. Please try again.");
  const { error: dbErr } = await supabase.from("files").delete().eq("id", rec.id);
  if (dbErr) throw new Error("The file was removed, but its entry couldn't be cleared. Refresh and try again.");
}
