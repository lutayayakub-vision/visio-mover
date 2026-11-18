// End-to-end Storage + RLS test over real HTTP. Run from a machine that can reach your Supabase project.
//
//   TEST_A_EMAIL=... TEST_A_PASSWORD=... TEST_B_EMAIL=... TEST_B_PASSWORD=... \
//   VITE_SUPABASE_URL=https://<ref>.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
//   npm run test:storage
//
// Use two dedicated, email-confirmed TEST accounts (never real users). Only the publishable key is used.
// Every file it creates is deleted again before it exits.
import { createClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "node:crypto";

const env = (k) => { const v = process.env[k]; if (!v || !v.trim()) { console.error(`Missing or empty env var ${k} (if this runs in GitHub Actions, the secret exists but has an empty value, so re-create it)`); process.exit(2); } return v; };
const URL_ = env("VITE_SUPABASE_URL").replace(/\/$/, "");
const KEY = env("VITE_SUPABASE_PUBLISHABLE_KEY");
const BUCKET = "visiomover-files";
const mk = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`); };

async function login(prefix) {
  const c = mk();
  const { data, error } = await c.auth.signInWithPassword({ email: env(`${prefix}_EMAIL`), password: env(`${prefix}_PASSWORD`) });
  if (error) { console.error(`Login failed for ${prefix}: ${error.message}`); process.exit(2); }
  return { client: c, id: data.user.id, token: data.session.access_token };
}

// small valid PNG (1x1) with a unique trailing comment so each run's bytes differ
const png = () => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f645400000000049454e44ae426082", "hex"), Buffer.from(randomUUID())]);
const sha = (b) => createHash("sha256").update(b).digest("hex");

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = []; // { owner, client, path, id }

async function uploadAndRegister(u, name = "test-image.png") {
  const bytes = png();
  const path = `${u.id}/${randomUUID()}.png`;
  const up = await u.client.storage.from(BUCKET).upload(path, bytes, { contentType: "image/png", upsert: false });
  if (up.error) return { error: up.error, path, bytes };
  const ins = await u.client.from("files").insert({ storage_path: path, original_name: name, category: "image", mime_type: "image/png", size_bytes: 1 }).select().single();
  if (ins.error) return { error: ins.error, path, bytes };
  created.push({ u, path, id: ins.data.id });
  return { row: ins.data, path, bytes };
}

async function uploadEdited(u, extra, name = "test-image (edited).png") {
  const bytes = png();
  const path = `${u.id}/${randomUUID()}.png`;
  const up = await u.client.storage.from(BUCKET).upload(path, bytes, { contentType: "image/png", upsert: false });
  if (up.error) return { error: up.error, path };
  const ins = await u.client.from("files").insert({ storage_path: path, original_name: name, category: "image", mime_type: "image/png", size_bytes: 1, ...extra }).select().single();
  if (ins.error) { await u.client.storage.from(BUCKET).remove([path]); return { error: ins.error, path }; }
  created.push({ u, path, id: ins.data.id });
  return { row: ins.data, path };
}

async function sweep(u) {
  const rows = await u.client.from("files").select("id, storage_path");
  for (const r of rows.data ?? []) { await u.client.storage.from(BUCKET).remove([r.storage_path]); await u.client.from("files").delete().eq("id", r.id); }
  const objs = await u.client.storage.from(BUCKET).list(u.id, { limit: 1000 });
  for (const o of objs.data ?? []) await u.client.storage.from(BUCKET).remove([`${u.id}/${o.name}`]);
}
const A = await login("TEST_A");
const B = await login("TEST_B");
if (A.id === B.id) { console.error("TEST_A and TEST_B must be different accounts."); process.exit(2); }
await sweep(A); await sweep(B); // dedicated test accounts only: clear leftovers from any earlier interrupted run

try {
  console.log("\n== Upload, metadata, persistence ==");
  const up = await uploadAndRegister(A, "a-private.png");
  check("A uploads a real PNG to own folder", !up.error, up.error?.message);
  check("Metadata row saved; size_bytes came from storage, not client", up.row && up.row.size_bytes === up.bytes.length, `stored=${up.row?.size_bytes} real=${up.bytes.length}`);
  check("Object path is <A user id>/<uuid>.png", up.path?.startsWith(`${A.id}/`));

  const A2 = await login("TEST_A"); // brand-new session = "after refresh / login"
  const list = await A2.client.from("files").select("id, original_name").eq("id", up.row.id);
  check("File is still listed after a fresh login (persistence)", list.data?.length === 1);

  console.log("\n== Authenticated download (owner) ==");
  const signed = await A2.client.storage.from(BUCKET).createSignedUrl(up.path, 60, { download: "a-private.png" });
  check("A gets a signed URL for own file", !!signed.data?.signedUrl, signed.error?.message);
  if (signed.data?.signedUrl) {
    const r = await fetch(signed.data.signedUrl);
    const body = Buffer.from(await r.arrayBuffer());
    check("Signed URL returns the exact uploaded bytes (sha256 match)", r.ok && sha(body) === sha(up.bytes));
  }
  const dl = await A2.client.storage.from(BUCKET).download(up.path);
  check("A downloads via authenticated API", !dl.error && dl.data?.size === up.bytes.length);

  console.log("\n== Cross-account: B attacks A ==");
  const bList = await B.client.from("files").select("id").eq("id", up.row.id);
  check("B cannot read A's metadata row by id", !bList.error && bList.data.length === 0);
  const bAll = await B.client.from("files").select("owner_id");
  check("B's metadata listing contains only B's rows", !bAll.error && bAll.data.every((r) => r.owner_id === B.id));
  const bSign = await B.client.storage.from(BUCKET).createSignedUrl(up.path, 60);
  check("B cannot create a signed URL for A's file", !!bSign.error || !bSign.data?.signedUrl, bSign.error?.message);
  const bDl = await B.client.storage.from(BUCKET).download(up.path);
  check("B cannot download A's file (authenticated API)", !!bDl.error);
  const direct = await fetch(`${URL_}/storage/v1/object/authenticated/${BUCKET}/${up.path}`, { headers: { Authorization: `Bearer ${B.token}`, apikey: KEY } });
  check("Direct REST GET with B's token is refused", !direct.ok, `HTTP ${direct.status}`);
  const bListFolder = await B.client.storage.from(BUCKET).list(A.id);
  check("B listing A's folder returns nothing", !bListFolder.error && (bListFolder.data ?? []).length === 0);
  const bUpIntoA = await B.client.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}.png`, png(), { contentType: "image/png" });
  check("B cannot upload into A's folder", !!bUpIntoA.error, bUpIntoA.error?.message);
  const bDelStore = await B.client.storage.from(BUCKET).remove([up.path]);
  check("B's delete of A's object removes nothing", !bDelStore.error ? (bDelStore.data ?? []).length === 0 : true);
  const bDelRow = await B.client.from("files").delete().eq("id", up.row.id).select();
  check("B's delete of A's metadata row removes nothing", (bDelRow.data ?? []).length === 0);
  const bUpd = await B.client.from("files").update({ original_name: "pwned" }).eq("id", up.row.id).select();
  check("B cannot edit A's metadata", !!bUpd.error || (bUpd.data ?? []).length === 0);
  const stillThere = await A2.client.storage.from(BUCKET).download(up.path);
  check("A's file is intact after B's attacks", !stillThere.error && stillThere.data?.size === up.bytes.length);

  console.log("\n== Anonymous / unauthenticated ==");
  const anon = mk();
  const anonRows = await anon.from("files").select("id");
  check("Anonymous cannot read metadata", !!anonRows.error || (anonRows.data ?? []).length === 0);
  const pub = await fetch(`${URL_}/storage/v1/object/public/${BUCKET}/${up.path}`);
  check("Public URL does not serve the file (bucket is private)", !pub.ok, `HTTP ${pub.status}`);
  const anonUp = await anon.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}.png`, png(), { contentType: "image/png" });
  check("Anonymous cannot upload", !!anonUp.error);

  console.log("\n== Server-side validation ==");
  const badType = await A.client.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}.png`, Buffer.from("not an image"), { contentType: "text/plain" });
  check("Disallowed MIME type (text/plain) is rejected", !!badType.error, badType.error?.message);
  const badName = await A.client.storage.from(BUCKET).upload(`${A.id}/evil.exe`, png(), { contentType: "image/png" });
  check("Non-UUID / disallowed extension name is rejected", !!badName.error, badName.error?.message);
  const ghost = await A.client.from("files").insert({ storage_path: `${A.id}/${randomUUID()}.png`, original_name: "ghost.png", category: "image", mime_type: "image/png", size_bytes: 5 });
  check("Metadata without a stored object is rejected", !!ghost.error, ghost.error?.message);

  console.log("\n== Stage 4: edited copies and lineage ==");
  const params = { format: "webp", quality: 0.8, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } };
  const ed = await uploadEdited(A, { source_file_id: up.row.id, edit_kind: "image", edit_params: params });
  check("A saves an edited copy linked to own original", !ed.error && ed.row?.source_file_id === up.row.id && ed.row?.edit_kind === "image", ed.error?.message);
  // jsonb does not preserve key order, so compare structurally, and read the row back as the owner (not just the insert echo)
  const edBack = await A.client.from("files").select("edit_params, edit_kind, source_file_id").eq("id", ed.row?.id ?? randomUUID()).single();
  check("Processing settings are stored with the copy", !edBack.error && deepEqual(edBack.data.edit_params, params) && deepEqual(ed.row?.edit_params, params), edBack.error?.message);
  const unrelated = await uploadEdited(A, { edit_kind: "image", edit_params: { format: "png", extra: [1, { a: 2 }] } }, "nested.png");
  const unrelatedBack = await A.client.from("files").select("edit_params").eq("id", unrelated.row?.id ?? randomUUID()).single();
  check("Nested settings round-trip exactly (regression: key order must not matter, values must)", !unrelatedBack.error && deepEqual(unrelatedBack.data.edit_params, { extra: [1, { a: 2 }], format: "png" }) && !deepEqual(unrelatedBack.data.edit_params, { format: "png", extra: [1, { a: 3 }] }));
  const orig2 = await A.client.storage.from(BUCKET).download(up.path);
  check("Original is untouched after saving an edited copy", !orig2.error && orig2.data?.size === up.bytes.length);
  const bSeesEdit = await B.client.from("files").select("id, edit_params").eq("id", ed.row?.id ?? randomUUID());
  check("B cannot read A's edited copy or its settings", !bSeesEdit.error && bSeesEdit.data.length === 0);
  const bLink = await uploadEdited(B, { source_file_id: up.row.id, edit_kind: "image", edit_params: {} }, "stolen-link.png");
  check("B cannot create a copy that points at A's original", !!bLink.error, bLink.error?.message);
  const badKind = await uploadEdited(A, { source_file_id: up.row.id, edit_kind: "hack", edit_params: {} });
  check("Unknown edit_kind is rejected", !!badKind.error, badKind.error?.message);
  const noKind = await uploadEdited(A, { source_file_id: up.row.id, edit_params: {} });
  check("A source link without an edit_kind is rejected", !!noKind.error, noKind.error?.message);
  const bigParams = await uploadEdited(A, { source_file_id: up.row.id, edit_kind: "image", edit_params: { pad: "x".repeat(9000) } });
  check("Oversized edit_params (> 8 KB) is rejected", !!bigParams.error, bigParams.error?.message);
  const arrParams = await uploadEdited(A, { edit_kind: "image", edit_params: [1, 2] });
  check("edit_params must be a JSON object", !!arrParams.error, arrParams.error?.message);
  const bUpdEdit = await B.client.from("files").update({ edit_kind: "video" }).eq("id", ed.row?.id ?? randomUUID()).select();
  check("B cannot modify A's edited-copy metadata", !!bUpdEdit.error || (bUpdEdit.data ?? []).length === 0);

  console.log("\n== Secure deletion (owner) ==");
  const del = await A.client.storage.from(BUCKET).remove([up.path]);
  check("A deletes own object", !del.error && (del.data ?? []).length === 1, del.error?.message);
  const delRow = await A.client.from("files").delete().eq("id", up.row.id).select();
  check("A deletes own metadata row", (delRow.data ?? []).length === 1);
  // Cache-independent proofs first: these cannot be answered from a CDN copy.
  const resign = await A.client.storage.from(BUCKET).createSignedUrl(up.path, 60);
  check("Deleted file: a NEW signed URL cannot be created", !!resign.error && !resign.data?.signedUrl, resign.error?.message);
  const fresh = await fetch(`${URL_}/storage/v1/object/authenticated/${BUCKET}/${up.path}?nocache=${randomUUID()}`, { headers: { Authorization: `Bearer ${A.token}`, apikey: KEY, "cache-control": "no-cache" } });
  check("Deleted file: cache-busted authenticated download is refused", !fresh.ok, `HTTP ${fresh.status}`);
  const folder = await A.client.storage.from(BUCKET).list(A.id, { limit: 100 });
  check("Deleted file: no longer present in the storage listing", !folder.error && !(folder.data ?? []).some((o) => `${A.id}/${o.name}` === up.path), folder.error?.message);
  // The plain download and the previously issued signed URL may be served from the CDN until it purges the deleted object.
  // That window must close: poll (up to 120 s) and fail if the deleted bytes are still served after that.
  let goneErr = null, goneAfter = 0, oldUrlDead = !signed.data?.signedUrl, oldAfter = 0;
  for (let t = 0; t <= 120; t += 5) {
    if (!goneErr) { const g = await A.client.storage.from(BUCKET).download(up.path); if (g.error) { goneErr = g.error; goneAfter = t; } }
    if (!oldUrlDead) { const r = await fetch(signed.data.signedUrl); if (!r.ok) { oldUrlDead = true; oldAfter = t; } else await r.arrayBuffer(); }
    if (goneErr && oldUrlDead) break;
    await sleep(5000);
  }
  check("Deleted file can no longer be downloaded", !!goneErr, goneErr ? `refused after ${goneAfter}s` : "still served after 120s");
  check("Previously issued signed URL stops working after deletion", oldUrlDead, oldUrlDead ? `dead after ${oldAfter}s` : "still served after 120s");
  const goneRow = await A.client.from("files").select("id").eq("id", up.row.id);
  check("Deleted file is gone from the listing", goneRow.data?.length === 0);
  const orphan = await A.client.from("files").select("source_file_id, edit_kind").eq("id", ed.row.id).single();
  check("Deleting an original keeps the edited copy (link cleared, not cascaded)", !orphan.error && orphan.data.source_file_id === null && orphan.data.edit_kind === "image", orphan.error?.message);
  for (let i = created.length - 1; i >= 0; i--) if (created[i].id === up.row.id) created.splice(i, 1);
} finally {
  for (const c of created) { await c.u.client.storage.from(BUCKET).remove([c.path]); await c.u.client.from("files").delete().eq("id", c.id); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
