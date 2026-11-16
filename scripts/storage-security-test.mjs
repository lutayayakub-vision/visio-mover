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

const env = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env var ${k}`); process.exit(2); } return v; };
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

const A = await login("TEST_A");
const B = await login("TEST_B");
if (A.id === B.id) { console.error("TEST_A and TEST_B must be different accounts."); process.exit(2); }

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

  console.log("\n== Secure deletion (owner) ==");
  const del = await A.client.storage.from(BUCKET).remove([up.path]);
  check("A deletes own object", !del.error && (del.data ?? []).length === 1, del.error?.message);
  const delRow = await A.client.from("files").delete().eq("id", up.row.id).select();
  check("A deletes own metadata row", (delRow.data ?? []).length === 1);
  const gone = await A.client.storage.from(BUCKET).download(up.path);
  check("Deleted file can no longer be downloaded", !!gone.error);
  const goneRow = await A.client.from("files").select("id").eq("id", up.row.id);
  check("Deleted file is gone from the listing", goneRow.data?.length === 0);
  created.length = 0;
} finally {
  for (const c of created) { await c.u.client.storage.from(BUCKET).remove([c.path]); await c.u.client.from("files").delete().eq("id", c.id); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
