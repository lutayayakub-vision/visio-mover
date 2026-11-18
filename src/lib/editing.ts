/**
 * Supabase glue for the Editing Studio. Everything uses the signed-in user's own session (publishable key only):
 *  - originals are READ through short-lived signed URLs and never modified or overwritten
 *  - edited copies are uploaded as NEW objects under <user id>/<uuid>.<ext> and registered with lineage + settings
 * Row-level security + the files trigger (see supabase/migrations) enforce ownership on the server regardless of this code.
 */
import { supabase } from "./supabase";
import {
  BUCKET, CATEGORY_LIMIT, CATEGORY_LABEL, QUOTA_BYTES, extOf, formatBytes, getUsedBytes, registerFile, uploadObject, cleanFileName,
  type Category, type EditMeta, type FileRecord,
} from "./files";

export class EditingError extends Error {}

/** "holiday.png" -> "holiday (edited).webp". Display name only; the stored object name is a random UUID. */
export function editedName(original: string, ext: string, suffix = "edited"): string {
  const base = cleanFileName(original).replace(/\.[^.]+$/, "") || "file";
  const trimmed = base.length > 200 ? base.slice(0, 200) : base;
  return `${trimmed} (${suffix}).${ext}`;
}

/** Streams an original from private storage into memory with real progress. The signed URL only works for the owner. */
export async function fetchOriginal(rec: FileRecord, onProgress: (f: number) => void, signal: AbortSignal): Promise<File> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rec.storage_path, 120);
  if (error || !data?.signedUrl) throw new EditingError("Couldn't open this file. It may have been deleted, or your session has ended.");
  let res: Response;
  try { res = await fetch(data.signedUrl, { signal }); }
  catch (e) {
    if (signal.aborted) throw new EditingError("Cancelled.");
    throw new EditingError("Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw new EditingError(res.status === 404 ? "This file no longer exists." : "Couldn't download this file. Please try again.");
  const total = Number(res.headers.get("content-length")) || rec.size_bytes;
  if (!res.body) { const b = await res.blob(); onProgress(1); return new File([b], rec.original_name, { type: rec.mime_type }); }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(Math.min(1, got / Math.max(total, 1)));
    }
  } catch {
    if (signal.aborted) throw new EditingError("Cancelled.");
    throw new EditingError("The download was interrupted. Check your connection and try again.");
  }
  onProgress(1);
  return new File(parts as BlobPart[], rec.original_name, { type: rec.mime_type });
}

export type SaveArgs = {
  blob: Blob; ext: string; mime: string; category: Category; originalName: string;
  sourceId: string | null; kind: EditMeta["edit_kind"]; params: Record<string, unknown>; suffix?: string;
  onProgress: (f: number) => void; signal: AbortSignal;
};

/** Checks the same limits the server enforces, so the user gets a clear message before any bytes are sent. */
export async function precheckSave(size: number, category: Category): Promise<void> {
  if (size > CATEGORY_LIMIT[category]) throw new EditingError(`This ${CATEGORY_LABEL[category].toLowerCase()} would be ${formatBytes(size)}, but ${CATEGORY_LABEL[category].toLowerCase()} files can be up to ${formatBytes(CATEGORY_LIMIT[category])}. Lower the quality or size and process again.`);
  const used = await getUsedBytes().catch(() => 0);
  if (used + size > QUOTA_BYTES) throw new EditingError(`Not enough storage. You have ${formatBytes(Math.max(0, QUOTA_BYTES - used))} free and this copy is ${formatBytes(size)}. Delete some files first.`);
}

/** Uploads the processed blob as a NEW file and records where it came from and the exact settings used. */
export async function saveEditedCopy(a: SaveArgs): Promise<{ name: string }> {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) throw new EditingError("Your session has ended. Please log in again.");
  await precheckSave(a.blob.size, a.category);
  const name = editedName(a.originalName, a.ext, a.suffix);
  const file = new File([a.blob], name, { type: a.mime });
  const path = await uploadObject(file, a.ext, a.mime, user.id, a.onProgress, a.signal);
  await registerFile(path, name, a.category, a.mime, file.size, { source_file_id: a.sourceId, edit_kind: a.kind, edit_params: a.params });
  return { name };
}

/** Saves a Blob to the user's device (no server involved). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const isEditable = (rec: FileRecord) =>
  (rec.category === "image" && ["jpg", "jpeg", "png", "webp"].includes(extOf(rec.original_name))) ||
  (rec.category === "video" && ["mp4", "mov", "webm"].includes(extOf(rec.original_name)));
