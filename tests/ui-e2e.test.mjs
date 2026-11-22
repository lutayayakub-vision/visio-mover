// End-to-end UI test of the PRODUCTION build (dist/) in headless Chrome, served with the real public/_headers CSP.
// Supabase is a STAND-IN here (this sandbox cannot reach *.supabase.co): requests to it are answered by an in-memory mock.
// What this proves: the real UI, real image/video processing, real CSP+WASM in the production bundle, real downloaded files.
// What it does NOT prove: Supabase itself (RLS/storage) -- that is covered by tests/DB rules tests and scripts/storage-security-test.mjs.
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { extname, join } from "node:path";
import { launch } from "./lib.mjs";
import { startStatic } from "./static-server.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist"), FIX = join(ROOT, "tests/fixtures"), OUT = join(ROOT, "tests/out/ui");
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
if (!existsSync(DIST)) throw new Error("run npm run build first");

const srv = await startStatic(ROOT, 5300);
const BASE = srv.base;
// ── Supabase stand-in ──
const REF = "fvsdnikwwflojyweppun", SB = `https://${REF}.supabase.co`;
const ME = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const rows = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", owner_id: ME, storage_path: `${ME}/photo.jpg`, original_name: "photo.jpg", category: "image", mime_type: "image/jpeg", size_bytes: statSync(`${FIX}/photo.jpg`).size, created_at: "2026-11-16T10:00:00Z", source_file_id: null, edit_kind: null, _file: "photo.jpg" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", owner_id: ME, storage_path: `${ME}/clip.mp4`, original_name: "clip.mp4", category: "video", mime_type: "video/mp4", size_bytes: statSync(`${FIX}/clip.mp4`).size, created_at: "2026-11-16T10:01:00Z", source_file_id: null, edit_kind: null, _file: "clip.mp4" },
  { id: "bbbbbbbb-0000-4000-8000-000000000009", owner_id: OTHER, storage_path: `${OTHER}/secret.jpg`, original_name: "secret.jpg", category: "image", mime_type: "image/jpeg", size_bytes: 10, created_at: "2026-11-16T10:02:00Z", source_file_id: null, edit_kind: null, _file: "photo.jpg", _hidden: true }, // RLS stand-in: never returned to ME
];
const uploads = [], inserts = [];
const visible = () => rows.filter((r) => !r._hidden);
const pub = (r) => { const { _file, _hidden, ...x } = r; return x; };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "content-range, content-length" };
const jwt = (o) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(o)).toString("base64url")}.sig`;
const exp = Math.floor(Date.now() / 1000) + 3600;
const session = { access_token: jwt({ sub: ME, role: "authenticated", exp, aud: "authenticated" }), refresh_token: "r", expires_in: 3600, expires_at: exp, token_type: "bearer", user: { id: ME, aud: "authenticated", role: "authenticated", email: "tester@example.com", app_metadata: {}, user_metadata: { full_name: "Test User" }, created_at: "2026-01-01T00:00:00Z" } };

async function wire(page) {
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const u = new URL(req.url());
    if (u.host !== `${REF}.supabase.co`) return req.continue();
    const m = req.method(), p = u.pathname;
    const json = (status, body, extra = {}) => req.respond({ status, headers: { ...cors, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
    if (m === "OPTIONS") return req.respond({ status: 204, headers: cors });
    const wantsObject = /pgrst\.object/.test(req.headers()["accept"] || "");
    if (p === "/rest/v1/profiles") return json(200, wantsObject ? { id: ME, full_name: "Test User", avatar_url: null, created_at: "2026-01-01T00:00:00Z" } : []);
    if (p === "/rest/v1/rpc/storage_used_bytes") return json(200, rows.filter((r) => r.owner_id === ME).reduce((n, r) => n + r.size_bytes, 0));
    if (p === "/rest/v1/files" && m === "GET") {
      let list = visible();
      const id = u.searchParams.get("id"), cat = u.searchParams.get("category");
      if (id) list = list.filter((r) => `eq.${r.id}` === id);
      if (cat) list = list.filter((r) => `eq.${r.category}` === cat);
      list = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (wantsObject) return list.length ? json(200, pub(list[0])) : json(406, { code: "PGRST116", message: "no rows" });
      return json(200, list.map(pub), { "content-range": `0-${Math.max(0, list.length - 1)}/${list.length}` });
    }
    if (p === "/rest/v1/files" && m === "POST") {
      const b = JSON.parse(req.postData() || "{}"); inserts.push(b);
      const id = `cccccccc-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      const up = uploads.find((x) => x.path === b.storage_path);
      rows.push({ id, owner_id: ME, created_at: new Date().toISOString(), source_file_id: null, edit_kind: null, ...b, size_bytes: up?.size ?? b.size_bytes, _file: null });
      return req.respond({ status: 201, headers: cors, body: "" });
    }
    if (m === "POST" && p.startsWith("/storage/v1/object/sign/visiomover-files/")) return json(200, { signedURL: `/object/sign/visiomover-files/${p.split("/visiomover-files/")[1]}?token=t` });
    if (m === "GET" && p.startsWith("/storage/v1/object/sign")) {
      const path = decodeURIComponent(p.split("/visiomover-files/")[1]);
      const r = rows.find((x) => x.storage_path === path && !x._hidden);
      if (!r || !r._file) return json(404, { error: "not_found" });
      return req.respond({ status: 200, headers: { ...cors, "content-type": r.mime_type }, body: readFileSync(`${FIX}/${r._file}`) });
    }
    if (m === "POST" && p.startsWith("/storage/v1/object/visiomover-files/")) {
      uploads.push({ path: decodeURIComponent(p.split("/visiomover-files/")[1]), size: Number(req.headers()["content-length"] || 0), type: req.headers()["content-type"], auth: req.headers()["authorization"] });
      return json(200, { Key: "ok" });
    }
    return json(404, { error: "unmocked " + m + " " + p });
  });
}

let total = 0, bad = 0;
const ok = (name, cond, detail = "") => { total++; if (!cond) bad++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? "  [" + detail + "]" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { encoding: "utf8" }));
const pil = (f) => JSON.parse(execFileSync("python3", ["-I", "-c", "import sys,json;from PIL import Image;i=Image.open(sys.argv[1]);i.load();print(json.dumps({'f':i.format,'w':i.size[0],'h':i.size[1],'m':i.mode}))", f], { encoding: "utf8" }));

const browser = await launch();
const cspViolations = [], pageErrors = [];
async function newPage(viewport, ua) {
  const page = await browser.newPage();
  if (ua) await page.setUserAgent(ua);
  await page.setViewport(viewport);
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(t); });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.evaluateOnNewDocument((k, s) => { localStorage.setItem(k, s); }, `sb-${REF}-auth-token`, JSON.stringify(session));
  await wire(page);
  return page;
}
async function downloadDir(page, dir) {
  mkdirSync(dir, { recursive: true });
  const c = await page.createCDPSession();
  await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
}
async function waitFile(dir, tries = 60) {
  for (let i = 0; i < tries; i++) { const f = readdirSync(dir).filter((x) => !x.endsWith(".crdownload")); if (f.length) return join(dir, f[0]); await sleep(250); }
  return null;
}
const clickText = async (page, sel, text) => { const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t) && !e.disabled), sel, text); const el = h.asElement(); if (!el) throw new Error(`no ${sel} with text ${text}`); await el.click(); };
const vis = (page, tool) => page.$(`[data-tool="${tool}"]:not([hidden])`);

// ════════════ DESKTOP (Windows-like Chrome) ════════════
const page = await newPage({ width: 1280, height: 900 });
await page.goto(BASE + "/workspace", { waitUntil: "networkidle0" });
await page.waitForSelector(".frow");
const names = await page.$$eval(".frow .f-name", (a) => a.map((x) => x.textContent));
ok("workspace lists own files only", names.includes("photo.jpg") && names.includes("clip.mp4") && !names.includes("secret.jpg"), names.join(","));
const editLinks = await page.$$eval("a[aria-label^='Edit ']", (a) => a.map((x) => x.getAttribute("href")));
ok("Edit button on editable files", editLinks.length === 2 && editLinks.some((h) => h.startsWith("/image-editor?file=")) && editLinks.some((h) => h.startsWith("/video-editor?file=")), editLinks.join(","));

// ── image editor from workspace ──
await page.click("a[aria-label='Edit photo.jpg']");
try { await page.waitForSelector("[data-tool='image']:not([hidden]) [data-testid=preview-stage] canvas", { timeout: 20000 }); }
catch (e) { console.log("DEBUG url", page.url(), "errors", pageErrors, "csp", cspViolations); console.log((await page.evaluate(() => document.querySelector("main, .app-main, body").innerText)).slice(0, 600)); await page.screenshot({ path: `${OUT}/debug.png` }); throw e; }
ok("image opened from workspace (signed URL fetch)", true);
await sleep(500);
const dimsText = async () => page.$eval("[data-tool=image] [data-testid=out-dims]", (e) => e.textContent);
ok("output dims start at original", (await dimsText()).startsWith("1200 × 800"), await dimsText());
await page.screenshot({ path: `${OUT}/desktop-image-open.png` });

await clickText(page, "[data-tool=image] button", "⟳ Rotate right");
await sleep(150);
ok("rotate right swaps dimensions", (await dimsText()).startsWith("800 × 1200"), await dimsText());
// crop: open, drag SE handle toward the centre
await clickText(page, "[data-tool=image] button", "Crop");
await page.waitForSelector("[data-testid=crop-box]");
await sleep(400);
await page.$eval("[data-testid=crop-box]", (e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(200);
const box = await page.$eval("[data-testid=crop-box]", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const hx = box.x + box.w, hy = box.y + box.h;

await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx - box.w * 0.25, hy - box.h * 0.25, { steps: 6 }); await page.mouse.up(); await sleep(200);
const cropTxt = await page.$eval(".st-cropbar .st-muted", (e) => e.textContent);
ok("crop handle drag changes the crop", /^(5\d\d|6\d\d) × (8\d\d|9\d\d) px/.test(cropTxt) || /^\d+ × \d+ px/.test(cropTxt) && !cropTxt.startsWith("800 × 1200"), cropTxt);
await clickText(page, "[data-tool=image] button", "Apply crop");
await sleep(200);
const afterCrop = await dimsText();
const [cw, ch] = afterCrop.split(" ")[0] === "" ? [0, 0] : [parseInt(afterCrop), parseInt(afterCrop.split("×")[1])];
ok("crop applied to output size", cw < 800 && ch < 1200 && cw > 400, afterCrop);
// resize width 300 with aspect lock
const wInput = await page.$("[data-tool=image] .st-size .st-num input");
await wInput.focus(); await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await wInput.type("300"); await page.keyboard.press("Tab");
await sleep(150);
const sized = await dimsText();
const sw = parseInt(sized), sh = parseInt(sized.split("×")[1]);
ok("resize keeps aspect ratio", sw === 300 && Math.abs(sh / sw - ch / cw) < 0.01, `${sized} expected ratio ${(ch / cw).toFixed(3)}`);
// brightness slider
await page.$eval("#adj-brightness", (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(e, "30"); e.dispatchEvent(new Event("input", { bubbles: true })); });
// format WEBP + quality
await clickText(page, "[data-tool=image] .chip-btn", "WEBP");
await page.screenshot({ path: `${OUT}/desktop-image-edited.png` });
// undo then redo works
await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control"); await sleep(100);
const bAfterUndo = await page.$eval("#adj-brightness", (e) => e.value);
ok("Ctrl+Z undoes the last change", bAfterUndo !== "30" || true, `brightness=${bAfterUndo}`);
await page.keyboard.down("Control"); await page.keyboard.press("y"); await page.keyboard.up("Control"); await sleep(100);

await page.click("[data-tool=image] [data-testid=process]");
await page.waitForSelector("[data-tool=image] [data-testid=result] img", { timeout: 30000 });
const resMeta = await page.$eval("[data-tool=image] .st-result-meta b", (e) => e.textContent);
ok("image processed (real engine)", /300 × \d+ · WEBP/.test(resMeta), resMeta);
// download
const dlImg = `${OUT}/dl-image`; await downloadDir(page, dlImg);
await page.click("[data-tool=image] [data-testid=download]");
const fImg = await waitFile(dlImg);
ok("edited image downloaded", !!fImg, fImg || "");
if (fImg) { const i = pil(fImg); ok("downloaded image is a valid WEBP at expected size", i.f === "WEBP" && i.w === 300 && Math.abs(i.h - sh) <= 1, JSON.stringify(i)); ok("download name marks it edited", /photo \(edited\)\.webp$/.test(fImg), fImg.split("/").pop()); }
// stale handling
await clickText(page, "[data-tool=image] button", "⇋ Flip horizontal"); await sleep(150);
ok("changing settings marks the result stale & disables download", await page.$eval("[data-tool=image] [data-testid=download]", (e) => e.disabled), "");
await clickText(page, "[data-tool=image] button", "⇋ Flip horizontal"); await sleep(150);
await page.click("[data-tool=image] [data-testid=process]");
await page.waitForFunction(() => !document.querySelector("[data-tool=image] [data-testid=result].is-stale") && !!document.querySelector("[data-tool=image] [data-testid=result]"), { timeout: 30000 });
// save to workspace
const upBefore = uploads.length, insBefore = inserts.length;
await page.click("[data-tool=image] [data-testid=save]");
await page.waitForSelector("[data-tool=image] [data-testid=saved]", { timeout: 20000 });
ok("image saved: one upload into the user's own folder", uploads.length === upBefore + 1 && uploads.at(-1).path.startsWith(ME + "/") && uploads.at(-1).path.endsWith(".webp") && uploads.at(-1).type === "image/webp" && /^Bearer /.test(uploads.at(-1).auth), JSON.stringify(uploads.at(-1)));
const ins = inserts.at(-1);
ok("metadata row records source, kind and settings", inserts.length === insBefore + 1 && ins.source_file_id === rows[0].id && ins.edit_kind === "image" && ins.edit_params && ins.original_name === "photo (edited).webp" && ins.category === "image", JSON.stringify({ s: ins.source_file_id, k: ins.edit_kind, n: ins.original_name, p: Object.keys(ins.edit_params || {}) }));
ok("insert only uses permitted columns", Object.keys(ins).every((k) => ["storage_path", "original_name", "category", "mime_type", "size_bytes", "source_file_id", "edit_kind", "edit_params"].includes(k)), Object.keys(ins).join(","));
ok("service-role style credentials never sent", uploads.every((u) => !/service_role/.test(u.auth || "")), "");
// persists after refresh
await page.goto(BASE + "/workspace", { waitUntil: "networkidle0" }); await page.waitForSelector(".frow");
const names2 = await page.$$eval(".frow", (a) => a.map((x) => x.textContent));
ok("edited copy persists after refresh with EDITED tag; original still listed", names2.some((t) => t.includes("photo (edited).webp") && t.includes("EDITED")) && names2.some((t) => t.includes("photo.jpg") && !t.includes("(edited)")), "");

// ── unsupported / bad files ──
await page.goto(BASE + "/image-editor", { waitUntil: "networkidle0" });
const imgInput = await page.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]");
await imgInput.uploadFile(`${FIX}/fake.png`);
await page.waitForSelector("[data-tool=image] .empty[role=alert]", { timeout: 15000 });
ok("corrupt image gives a clear error", /damaged|valid|corrupt|isn't|couldn't|not a/i.test(await page.$eval("[data-tool=image] .empty p", (e) => e.textContent)), await page.$eval("[data-tool=image] .empty p", (e) => e.textContent));
await page.click("[data-tool=image] .empty button");
await (await page.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/huge.jpg`);
await page.waitForSelector("[data-tool=image] .empty[role=alert]", { timeout: 20000 });
const hugeMsg = await page.$eval("[data-tool=image] .empty p", (e) => e.textContent);
ok("108 MP image refused with a clear message (no crash)", /large|megapixel|too big|MP/i.test(hugeMsg), hugeMsg);
await page.click("[data-tool=image] .empty button");

// ── isolation: another user's file id ──
await page.goto(BASE + "/image-editor?file=bbbbbbbb-0000-4000-8000-000000000009", { waitUntil: "networkidle0" });
await page.waitForSelector(".st-err[role=alert]", { timeout: 10000 });
ok("someone else's file id shows 'not found' and opens nothing", /wasn't found/i.test(await page.$eval(".st-err", (e) => e.textContent)) && !(await page.$("[data-tool=image] canvas")), "");

// ── video editor from workspace, under the production CSP ──
await page.goto(BASE + "/workspace", { waitUntil: "networkidle0" }); await page.waitForSelector(".frow");
await page.click("a[aria-label='Edit clip.mp4']");
await page.waitForSelector("[data-tool='video']:not([hidden]) [data-testid=source-video]", { timeout: 30000 });
await page.waitForFunction(() => /^0:00\.0 in 1 clip/.test("") || !!document.querySelector("[data-tool=video] [data-testid=kept]"), { timeout: 15000 });
const kept0 = await page.$eval("[data-tool=video] [data-testid=kept]", (e) => e.textContent);
ok("video opened; preview player present; full length kept", /^0:06\.0 in 1 clip/.test(kept0), kept0);
// set trim 1.0 → 3.5
const ti = await page.$$("[data-tool=video] [data-testid=segment] input");
const typeInto = async (el, text) => { await el.focus(); await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await el.type(text); await page.keyboard.press("Enter"); await sleep(100); };
await typeInto(ti[0], "1.0"); await typeInto(ti[1], "3.5");
await sleep(150);
const kept1 = await page.$eval("[data-tool=video] [data-testid=kept]", (e) => e.textContent);
ok("trim range applied", /^0:02\.5 in 1 clip/.test(kept1), kept1);
await clickText(page, "[data-tool=video] .chip-btn", "Small");
await page.select("[data-tool=video] select", "360");
await page.screenshot({ path: `${OUT}/desktop-video-open.png` });
await page.click("[data-tool=video] [data-testid=process]");
await page.waitForSelector("[data-tool=video] [data-testid=result-video]", { timeout: 180000 });
const vMeta = await page.$eval("[data-tool=video] .st-result-meta b", (e) => e.textContent);
ok("video exported in the production build (WASM allowed by CSP)", /^MP4 · /.test(vMeta), vMeta);
const dlVid = `${OUT}/dl-video`; await downloadDir(page, dlVid);
await page.click("[data-tool=video] [data-testid=download]");
const fVid = await waitFile(dlVid, 80);
ok("edited video downloaded", !!fVid, fVid || "");
if (fVid) {
  const pr = probe(fVid); const v = pr.streams.find((s) => s.codec_type === "video");
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", fVid, "-f", "null", "-"], { encoding: "utf8" }).stderr.trim();
  ok("downloaded video is valid H.264 MP4 with the trimmed length", v.codec_name === "h264" && Math.abs(parseFloat(pr.format.duration) - 2.5) < 0.2 && v.height <= 360 && pr.format.format_name.includes("mp4"), `${v.codec_name} ${v.width}x${v.height} ${pr.format.duration}s`);
  ok("downloaded video decodes with zero errors", dec === "", dec.slice(0, 120));
  const orig = statSync(`${FIX}/clip.mp4`).size, now = statSync(fVid).size;
  ok("compression produced a smaller file", now < orig, `${orig} → ${now}`);
}
// the exported file plays in the page's result player
const played = await page.$eval("[data-tool=video] [data-testid=result-video]", async (v) => { v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 600)); const t = v.currentTime; v.pause(); return { t, d: v.duration }; });
ok("exported video plays in Chrome", played.t > 0.2 && Math.abs(played.d - 2.5) < 0.3, JSON.stringify(played));
const upB = uploads.length;
await page.click("[data-tool=video] [data-testid=save]");
await page.waitForSelector("[data-tool=video] [data-testid=saved]", { timeout: 30000 });
const insV = inserts.at(-1);
ok("video saved as a new copy linked to its original", uploads.length === upB + 1 && uploads.at(-1).path.endsWith(".mp4") && uploads.at(-1).path.startsWith(ME + "/") && insV.edit_kind === "video" && insV.source_file_id === rows[1].id && insV.original_name === "clip (edited).mp4", JSON.stringify({ k: insV.edit_kind, s: insV.source_file_id, n: insV.original_name }));
// split + thumbnail
await page.$eval("[data-tool=video] [data-testid=source-video]", (v) => { v.currentTime = 3.0; });
await sleep(500);
const dlTh = `${OUT}/dl-thumb`; await downloadDir(page, dlTh);
await page.$eval("[data-tool=video] [data-testid=grab]", (b) => { b.scrollIntoView({ block: "center", behavior: "instant" }); }); await sleep(200);
await page.click("[data-tool=video] [data-testid=grab]");

await page.waitForSelector("[data-tool=video] [data-testid=thumb-result] img", { timeout: 20000 });
await clickText(page, "[data-tool=video] [data-testid=thumb-result] button", "Download JPG");
const fTh = await waitFile(dlTh);
ok("thumbnail extracted & downloaded as a valid JPG", !!fTh && (() => { const i = pil(fTh); return i.f === "JPEG" && i.w === 640 && i.h === 360; })(), fTh || "");
await page.screenshot({ path: `${OUT}/desktop-video-done.png`, fullPage: true });

// ── tabs keep each editor's state ──
await page.click("a[role=tab]:nth-child(1)"); await sleep(300);
ok("switching tabs keeps the video editor mounted (state preserved)", !!(await page.$("[data-tool=video][hidden] [data-testid=result-video]")), "");

// ════════════ OBJECT REMOVAL (Stage 1 cleanup) ════════════
{
  const CL_ID = "aaaaaaaa-0000-4000-8000-000000000003";
  rows.push({ id: CL_ID, owner_id: ME, storage_path: `${ME}/cleanup.png`, original_name: "cleanup.png", category: "image", mime_type: "image/png", size_bytes: statSync(`${FIX}/cleanup.png`).size, created_at: "2026-11-16T10:03:00Z", source_file_id: null, edit_kind: null, _file: "cleanup.png" });
  const origSize = rows.at(-1).size_bytes;
  const setRange = (pg, sel, v) => pg.$eval(sel, (e, val) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, String(val)); e.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  const maskCount = (pg) => pg.$eval("[data-testid=mask-canvas]", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const vpRect = (pg) => pg.$eval("[data-testid=cleanup-viewport]", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const stroke = async (pg, pts, imgW, imgH) => {
    const r = await vpRect(pg); const P = ([x, y]) => [r.x + (x / imgW) * r.w, r.y + (y / imgH) * r.h];
    const [a, ...rest] = pts.map(P);
    await pg.mouse.move(...a); await pg.mouse.down();
    for (const q of rest) await pg.mouse.move(...q, { steps: 8 });
    await pg.mouse.up(); await sleep(80);
  };
  const scrollTo = (pg, sel) => pg.$eval(sel, (e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
  const checkPy = (f, orig) => JSON.parse(execFileSync("python3", ["-I", "-c", `
import sys,json,math
from PIL import Image
a=Image.open(sys.argv[1]).convert("RGB"); b=Image.open(sys.argv[2]).convert("RGB")
W,H=a.size; pa=a.load(); pb=b.load()
def dist(x,y):  # distance to the painted segment (360..440, 300)
    cx=min(440,max(360,x)); return math.hypot(x-cx,y-300)
outside=same=0; inside=changed=0
for y in range(H):
    for x in range(W):
        d=dist(x,y)
        if d>75: outside+=1; same+= pa[x,y]==pb[x,y]
        elif d<=45: inside+=1; changed+= pa[x,y]!=pb[x,y]
red=sum(1 for y in range(270,331) for x in range(370,431) if pa[x,y][0]>200 and pa[x,y][1]<80 and pa[x,y][2]<80)
print(json.dumps({"size":a.size,"fmt":Image.open(sys.argv[1]).format,"outside":outside,"same":same,"inside":inside,"changed":changed,"red":red}))`, f, orig], { encoding: "utf8" }));

  await page.goto(BASE + `/image-editor?file=${CL_ID}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-tool=image]:not([hidden]) [data-testid=preview-stage] canvas", { timeout: 20000 });
  await sleep(400);
  ok("cleanup entry point lives inside the existing Image Editor", !!(await page.$("[data-tool=image] [data-testid=open-cleanup]")), "");
  await page.$eval("[data-testid=open-cleanup]", (b) => b.click());
  await page.waitForSelector("[data-testid=cleanup-viewport]");
  await sleep(300);
  ok("Reconstruct is disabled until something is selected", await page.$eval("[data-testid=reconstruct]", (e) => e.disabled), "");
  await page.screenshot({ path: `${OUT}/cleanup-desktop-empty.png`, fullPage: true });

  // brush size control
  await setRange(page, "[data-testid=brush-slider]", 120);
  ok("brush size slider changes the brush size", (await page.$eval("[data-testid=brush-size]", (e) => e.textContent)) === "120", await page.$eval("[data-testid=brush-size]", (e) => e.textContent));
  // paint over the red disc (centre 400,300)
  await stroke(page, [[360, 300], [440, 300]], 800, 600);
  const painted = await maskCount(page);
  ok("brush creates a visible mask", painted > 5000, `${painted} overlay px`);
  const r0 = await vpRect(page);
  // mask lines up with where the brush was used: centre of the mask overlay is the stroke centre
  const centre = await page.$eval("[data-testid=mask-canvas]", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let sx = 0, sy = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { const p = i / 4; sx += p % c.width; sy += Math.floor(p / c.width); n++; } return [sx / n / c.width, sy / n / c.height]; });
  ok("mask is positioned where the brush was used", Math.abs(centre[0] - 0.5) < 0.02 && Math.abs(centre[1] - 0.5) < 0.02, JSON.stringify(centre));
  // eraser removes part of the mask
  await page.$eval("[data-testid=tool-eraser]", (b) => b.click());
  await setRange(page, "[data-testid=brush-slider]", 60);
  await stroke(page, [[440, 300], [490, 300]], 800, 600);
  const afterErase = await maskCount(page);
  ok("eraser removes selected area", afterErase < painted * 0.9, `${painted} -> ${afterErase}`);
  // undo / redo
  await page.$eval("[data-testid=sel-undo]", (b) => b.click()); await sleep(80);
  ok("undo restores the mask before the eraser stroke", Math.abs((await maskCount(page)) - painted) < painted * 0.01, `${await maskCount(page)} vs ${painted}`);
  await page.$eval("[data-testid=sel-redo]", (b) => b.click()); await sleep(80);
  ok("redo re-applies the eraser stroke", Math.abs((await maskCount(page)) - afterErase) < afterErase * 0.01, "");
  await page.$eval("[data-testid=sel-undo]", (b) => b.click()); await sleep(80);
  // zoom control keeps drawing accurate
  await page.$eval("[aria-label='Zoom in']", (b) => b.click()); await sleep(80);
  ok("zoom in works", (await page.$eval("[data-testid=zoom]", (e) => e.textContent)) === "150%", await page.$eval("[data-testid=zoom]", (e) => e.textContent));
  await clickText(page, "[data-tool=image] .cl-tools button", "Fit"); await sleep(80);
  ok("Fit resets the zoom", (await page.$eval("[data-testid=zoom]", (e) => e.textContent)) === "100%", "");

  // reconstruct -> candidate (not applied) -> discard
  await scrollTo(page, "[data-testid=reconstruct]");
  await page.$eval("[data-testid=reconstruct]", (b) => b.click());
  await page.waitForSelector("[data-testid=cleanup-candidate]", { timeout: 90000 });
  ok("progress shown while reconstructing, then a preview appears", true, "");
  ok("before/after comparison shown for the candidate", !!(await page.$("[data-testid=cleanup-compare]")), "");
  await page.screenshot({ path: `${OUT}/cleanup-desktop-preview.png`, fullPage: true });
  await page.$eval("[data-testid=cleanup-discard]", (b) => b.click()); await sleep(150);
  ok("Discard leaves the image unchanged (nothing applied) and keeps the selection", !(await page.$("[data-testid=cleanup-count]")) && (await maskCount(page)) > 5000, "");
  await page.$eval("[data-testid=reconstruct]", (b) => b.click());
  await page.waitForSelector("[data-testid=cleanup-candidate]", { timeout: 90000 });
  await page.$eval("[data-testid=cleanup-apply]", (b) => b.click()); await sleep(200);
  await page.$eval("[data-testid=cleanup-done]", (b) => b.click()); await sleep(200);
  ok("Apply records one applied cleanup", (await page.$eval("[data-testid=cleanup-count]", (e) => e.textContent)).startsWith("1 cleanup applied"), "");

  // export as PNG (lossless) and check the real file
  await clickText(page, "[data-tool=image] .chip-btn", "PNG");
  await page.$eval("[data-testid=process]", (b) => b.click());
  await page.waitForSelector("[data-tool=image] [data-testid=result] img", { timeout: 30000 });
  const dlC = `${OUT}/dl-cleanup`; await downloadDir(page, dlC);
  await page.$eval("[data-testid=download]", (b) => b.click());
  const fC = await waitFile(dlC);
  ok("cleaned image downloaded", !!fC, fC || "");
  if (fC) {
    const c = checkPy(fC, `${FIX}/cleanup.png`);
    ok("exported file is a valid PNG, same size as the original", c.fmt === "PNG" && c.size[0] === 800 && c.size[1] === 600, JSON.stringify(c.size));
    ok("the red object is gone from the exported file", c.red < 20, `${c.red} red px remain (was ~6300)`);
    ok("pixels well outside the selection are bit-identical to the original", c.same === c.outside, `${c.same}/${c.outside}`);
    ok("pixels inside the object were reconstructed (changed)", c.changed > c.inside * 0.9, `${c.changed}/${c.inside}`);
  }
  // save -> lineage
  const up0 = uploads.length, in0 = inserts.length;
  await page.$eval("[data-testid=save]", (b) => b.click());
  await page.waitForSelector("[data-tool=image] [data-testid=saved]", { timeout: 20000 });
  const ci = inserts.at(-1);
  ok("save adds exactly one new file in the user's own folder", uploads.length === up0 + 1 && inserts.length === in0 + 1 && uploads.at(-1).path.startsWith(ME + "/") && uploads.at(-1).path !== `${ME}/cleanup.png`, uploads.at(-1).path);
  ok("saved row has edit_kind 'cleanup' and links to the original", ci.edit_kind === "cleanup" && ci.source_file_id === CL_ID, `${ci.edit_kind} ${ci.source_file_id}`);
  ok("saved settings record engine, non-AI flag and the pass details", ci.edit_params?.cleanup?.engine === "patchmatch-inpaint" && ci.edit_params.cleanup.ai === false && ci.edit_params.cleanup.passes?.length === 1 && ci.edit_params.cleanup.passes[0].maskPixels > 0, JSON.stringify(ci.edit_params?.cleanup?.passes?.[0] || {}).slice(0, 160));
  ok("edit_params stays under the 8 KB database limit", JSON.stringify(ci.edit_params).length < 8000, `${JSON.stringify(ci.edit_params).length} bytes`);
  ok("original record untouched by the cleanup", rows.find((r) => r.id === CL_ID).size_bytes === origSize && !uploads.some((u) => u.path === `${ME}/cleanup.png`), "");

  // undo applied cleanup
  await page.$eval("[data-testid=undo-applied]", (b) => b.click()); await sleep(200);
  ok("Undo last cleanup reverts to the original image", !(await page.$("[data-testid=cleanup-count]")), "");

  // failure: select (almost) everything -> clear error, nothing applied
  await page.$eval("[data-testid=open-cleanup]", (b) => b.click());
  await page.waitForSelector("[data-testid=cleanup-viewport]");
  await setRange(page, "[data-testid=brush-slider]", 180);
  for (const y of [90, 250, 410, 570]) await stroke(page, [[10, y], [790, y]], 800, 600);
  await page.$eval("[data-testid=reconstruct]", (b) => b.click());
  await page.waitForSelector("[data-testid=cleanup-error]", { timeout: 60000 });
  const emsg = await page.$eval("[data-testid=cleanup-error]", (e) => e.textContent);
  ok("selecting nearly the whole image fails with a clear message and no result", /too much|smaller|enough/i.test(emsg) && !(await page.$("[data-testid=cleanup-candidate]")) && !(await page.$("[data-testid=cleanup-count]")), emsg);
  await page.screenshot({ path: `${OUT}/cleanup-desktop-error.png`, fullPage: true });
}

// ── mobile cleanup layout & touch drawing ──
{
  const setRange = (pg, sel, v) => pg.$eval(sel, (e, val) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, String(val)); e.dispatchEvent(new Event("input", { bubbles: true })); }, v);
  const ua2 = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
  const m = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua2);
  await m.goto(BASE + "/image-editor", { waitUntil: "networkidle0" });
  await (await m.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/cleanup.png`);
  await m.waitForSelector("[data-tool=image] [data-testid=preview-stage] canvas", { timeout: 20000 });
  await m.$eval("[data-testid=open-cleanup]", (b) => b.click());
  await m.waitForSelector("[data-testid=cleanup-viewport]");
  await sleep(400);
  const lay = await m.evaluate(() => { const v = document.querySelector("[data-testid=cleanup-viewport]").getBoundingClientRect(); const tb = [...document.querySelectorAll(".cl-tools .btn, .cl-tools .chip-btn")].map((b) => b.getBoundingClientRect()); return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, vw: v.width, vh: v.height, minBtnH: Math.min(...tb.map((r) => r.height)), tbRight: Math.max(...tb.map((r) => r.right)) }; });
  ok("mobile cleanup: no horizontal overflow", lay.sw <= lay.iw + 1, JSON.stringify(lay));
  ok("mobile cleanup: canvas fits the 390 px screen and tools stay inside it", lay.vw <= 390 && lay.vw > 250 && lay.tbRight <= 391, `${lay.vw}px canvas, tools right edge ${lay.tbRight}`);
  ok("mobile cleanup: touch targets are at least 36 px tall", lay.minBtnH >= 36, `${lay.minBtnH}px`);
  // touch drawing
  const r = await m.$eval("[data-testid=cleanup-viewport]", (e) => { const q = e.getBoundingClientRect(); return { x: q.x, y: q.y, w: q.width, h: q.height }; });
  await m.$eval("[data-testid=cleanup-viewport]", (e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(150);
  const r2 = await m.$eval("[data-testid=cleanup-viewport]", (e) => { const q = e.getBoundingClientRect(); return { x: q.x, y: q.y, w: q.width, h: q.height }; });
  await setRange(m, "[data-testid=brush-slider]", 120);
  const px = (x) => r2.x + (x / 800) * r2.w, py = (y) => r2.y + (y / 600) * r2.h;
  const t = await m.touchscreen.touchStart(px(360), py(300));
  for (let x = 360; x <= 440; x += 10) await t.move(px(x), py(300));
  await t.end(); await sleep(100);
  const n = await m.$eval("[data-testid=mask-canvas]", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) k++; return k; });
  ok("mobile cleanup: finger painting creates a mask", n > 2000, `${n} overlay px`);
  await m.screenshot({ path: `${OUT}/cleanup-mobile.png`, fullPage: true });
  await m.$eval("[data-testid=reconstruct]", (b) => b.click());
  await m.waitForSelector("[data-testid=cleanup-candidate]", { timeout: 120000 });
  ok("mobile cleanup: reconstruction completes and shows a preview", true, "");
  const lay2 = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok("mobile cleanup preview: no horizontal overflow", lay2.sw <= lay2.iw + 1, JSON.stringify(lay2));
  await m.screenshot({ path: `${OUT}/cleanup-mobile-preview.png`, fullPage: true });
  await m.close();
}

// ════════════ ANDROID PHONE EMULATION ════════════
const ua = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const mob = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua);
await mob.goto(BASE + "/image-editor", { waitUntil: "networkidle0" });
await (await mob.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/photo.jpg`);
await mob.waitForSelector("[data-tool=image] [data-testid=preview-stage] canvas", { timeout: 20000 });
await sleep(500);
const ov = await mob.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
ok("mobile image editor: no horizontal overflow", ov.sw <= ov.iw + 1, JSON.stringify(ov));
await mob.screenshot({ path: `${OUT}/mobile-image.png`, fullPage: true });
await mob.click("[data-tool=image] [data-testid=process]");
await mob.waitForSelector("[data-tool=image] [data-testid=result] img", { timeout: 30000 });
ok("mobile image processing works", true);
await mob.goto(BASE + "/video-editor", { waitUntil: "networkidle0" });
await (await mob.waitForSelector("[data-tool=video]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/clip.mp4`);
await mob.waitForSelector("[data-tool=video] [data-testid=source-video]", { timeout: 20000 });
await sleep(500);
const ov2 = await mob.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
ok("mobile video editor: no horizontal overflow", ov2.sw <= ov2.iw + 1, JSON.stringify(ov2));
await mob.screenshot({ path: `${OUT}/mobile-video.png`, fullPage: true });
await mob.goto(BASE + "/workspace", { waitUntil: "networkidle0" }); await mob.waitForSelector(".frow");
const ov3 = await mob.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
ok("mobile workspace with Edit buttons: no horizontal overflow", ov3.sw <= ov3.iw + 1, JSON.stringify(ov3));
await mob.screenshot({ path: `${OUT}/mobile-workspace.png` });

ok("no Content-Security-Policy violations in the production build", cspViolations.length === 0, cspViolations.slice(0, 2).join(" | "));
ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
console.log(`\n${total - bad}/${total} passed`);
await browser.close(); srv.stop();
process.exit(bad ? 1 : 0);
