// LIVE end-to-end audit of the DEPLOYED app (real Netlify + real Supabase + dedicated TEST accounts).
//   SITE_URL=https://<site>.netlify.app TEST_A_EMAIL=.. TEST_A_PASSWORD=.. TEST_B_EMAIL=.. TEST_B_PASSWORD=..
//   VITE_SUPABASE_URL=.. VITE_SUPABASE_PUBLISHABLE_KEY=.. node tests/live-e2e.mjs      (fixtures: python3 tests/make-fixtures.py)
// Nothing is mocked. Secrets are never printed. Every file it creates is deleted again at the end.
import { mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { launch } from "./lib.mjs";
import { startStatic } from "./static-server.mjs";

const need = (k) => { const v = process.env[k]; if (!v || !v.trim()) { console.error(`Missing env ${k}`); process.exit(2); } return v.trim(); };
let SITE = need("SITE_URL").replace(/\/$/, ""); const SBU = need("VITE_SUPABASE_URL").replace(/\/$/, ""), KEY = need("VITE_SUPABASE_PUBLISHABLE_KEY");
const CRED = { A: [need("TEST_A_EMAIL"), need("TEST_A_PASSWORD")], B: [need("TEST_B_EMAIL"), need("TEST_B_PASSWORD")] };
const ROOT = new URL("..", import.meta.url).pathname, FIX = join(ROOT, "tests/fixtures"), OUT = join(ROOT, "tests/out/live");
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const BUCKET = "visiomover-files";

let total = 0, bad = 0;
const ok = (name, cond, detail = "") => { total++; if (!cond) bad++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`); };
const note = (s) => console.log(`NOTE  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { encoding: "utf8" }));
const pil = (f) => JSON.parse(execFileSync("python3", ["-I", "-c", "import sys,json;from PIL import Image;i=Image.open(sys.argv[1]);i.load();print(json.dumps({'f':i.format,'w':i.size[0],'h':i.size[1]}))", f], { encoding: "utf8" }));
const sb = async (who) => { const c = createClient(SBU, KEY, { auth: { persistSession: false, autoRefreshToken: false } }); const { data, error } = await c.auth.signInWithPassword({ email: CRED[who][0], password: CRED[who][1] }); if (error) { console.error(`API login failed for ${who}: ${error.message}`); process.exit(2); } return { c, id: data.user.id }; };
async function sweep(u) {
  const rows = await u.c.from("files").select("id, storage_path");
  for (const r of rows.data ?? []) { await u.c.storage.from(BUCKET).remove([r.storage_path]); await u.c.from("files").delete().eq("id", r.id); }
  const objs = await u.c.storage.from(BUCKET).list(u.id, { limit: 1000 });
  for (const o of objs.data ?? []) await u.c.storage.from(BUCKET).remove([`${u.id}/${o.name}`]);
}

let local = null;
if (SITE === "local") { local = await startStatic(ROOT, 5301); SITE = local.base; console.log("NOTE  Serving the fresh production build of main locally with the real public/_headers (NOT Netlify). Netlify-specific behaviour is untested in this mode."); }
const A = await sb("A"), B = await sb("B");
await sweep(A); await sweep(B);
const browser = await launch();
const csp = [], pageErrors = [];
async function newPage(viewport, ua, isolated = false) {
  // an isolated (incognito-style) context has its own localStorage, so a second account never inherits the first one's session
  const page = await (isolated ? (await browser.createBrowserContext()).newPage() : browser.newPage());
  if (ua) await page.setUserAgent(ua);
  await page.setViewport(viewport);
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return page;
}
async function uiLogin(page, who) {
  await page.goto(SITE + "/login", { waitUntil: "networkidle0" });
  await page.type("input[type=email]", CRED[who][0]); await page.type("input[type=password]", CRED[who][1]);
  await Promise.all([page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 }), page.click("button[type=submit]")]);
}
async function downloadDir(page, dir) { mkdirSync(dir, { recursive: true }); const c = await page.createCDPSession(); await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir }); }
async function waitFile(dir, tries = 80) { for (let i = 0; i < tries; i++) { const f = readdirSync(dir).filter((x) => !x.endsWith(".crdownload")); if (f.length) return join(dir, f[0]); await sleep(250); } return null; }
const clickText = async (page, sel, text) => { const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t) && !e.disabled), sel, text); const el = h.asElement(); if (!el) throw new Error(`no ${sel} "${text}"`); await el.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await el.click(); };
const typeInto = async (page, el, text) => { await el.focus(); await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await el.type(text); await page.keyboard.press("Enter"); await sleep(100); };
async function uploadViaUi(page, file, name) {
  await page.goto(SITE + "/workspace", { waitUntil: "networkidle0" });
  const input = await page.waitForSelector("input[type=file]");
  await input.uploadFile(file);
  await page.waitForFunction((n) => [...document.querySelectorAll(".frow .f-name")].some((e) => e.textContent === n), { timeout: 90000 }, name);
}

try {
  // ═══ 1. Deployment ═══
  const root = await fetch(SITE + "/");
  const csp1 = root.headers.get("content-security-policy") || "";
  ok("Site is up (HTTP 200)", root.ok, `HTTP ${root.status}`);
  ok("CSP header allows WebAssembly and workers (needed by the video engine)", /wasm-unsafe-eval/.test(csp1) && /worker-src/.test(csp1), csp1.slice(0, 80));
  ok("CSP does not allow unsafe-eval / inline scripts", !/script-src[^;]*'unsafe-eval'/.test(csp1) && !/script-src[^;]*'unsafe-inline'/.test(csp1));
  const html = await (await fetch(SITE + "/")).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  ok("Production HTML references built assets", assets.length >= 2, assets.length + " assets");
  const r404 = await fetch(SITE + "/image-editor"); ok("SPA route /image-editor serves the app (redirect rules)", r404.ok);
  // the wasm is lazy-loaded; find its URL from the Studio chunk
  const studioJs = assets.length ? null : null;
  const idx = assets.find((a) => /index-.*\.js$/.test(a));
  let wasmUrl = null;
  if (idx) { const js = await (await fetch(SITE + idx)).text(); const m = js.match(/Studio-[A-Za-z0-9_-]+\.js/); if (m) { const st = await (await fetch(SITE + "/assets/" + m[0])).text(); const w = st.match(/ffmpeg-core-[A-Za-z0-9_-]+\.wasm/); if (w) wasmUrl = "/assets/" + w[0]; } }
  ok("FFmpeg WASM file is deployed", !!wasmUrl, wasmUrl || "not found in Studio chunk");
  if (wasmUrl) {
    const w = await fetch(SITE + wasmUrl, { method: "HEAD" });
    ok("WASM served as application/wasm", /application\/wasm/.test(w.headers.get("content-type") || ""), w.headers.get("content-type"));
    note(`wasm content-length=${w.headers.get("content-length")} content-encoding=${w.headers.get("content-encoding")} cache-control=${w.headers.get("cache-control")}`);
    ok("Hashed assets are cached long-term", /max-age=31536000/.test(w.headers.get("cache-control") || ""), w.headers.get("cache-control"));
  }

  // ═══ 2. Login + upload originals through the real UI ═══
  const page = await newPage({ width: 1280, height: 900 });
  await uiLogin(page, "A");
  ok("A logs in through the UI", !page.url().includes("/login"), new URL(page.url()).pathname);
  await uploadViaUi(page, `${FIX}/photo.jpg`, "photo.jpg");
  ok("Image uploaded through the UI to private storage", true);
  await uploadViaUi(page, `${FIX}/clip.mp4`, "clip.mp4");
  ok("Video uploaded through the UI to private storage", true);
  const orig = await A.c.from("files").select("id, original_name, storage_path, size_bytes").in("original_name", ["photo.jpg", "clip.mp4"]);
  const oImg = orig.data.find((r) => r.original_name === "photo.jpg"), oVid = orig.data.find((r) => r.original_name === "clip.mp4");
  ok("Originals are stored under A's private folder", orig.data.length === 2 && orig.data.every((r) => r.storage_path.startsWith(A.id + "/")));

  // ═══ 3. Image editing on the deployed site ═══
  await page.click("a[aria-label='Edit photo.jpg']");
  await page.waitForSelector("[data-tool='image']:not([hidden]) [data-testid=preview-stage] canvas", { timeout: 40000 });
  ok("Image opens in the editor (signed URL download)", true);
  const dimsText = () => page.$eval("[data-tool=image] [data-testid=out-dims]", (e) => e.textContent);
  await clickText(page, "[data-tool=image] button", "⟳ Rotate right"); await sleep(200);
  ok("Rotate", (await dimsText()).startsWith("800 × 1200"), await dimsText());
  await clickText(page, "[data-tool=image] button", "Crop"); await page.waitForSelector("[data-testid=crop-box]"); await sleep(400);
  await page.$eval("[data-testid=crop-box]", (e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(250);
  const box = await page.$eval("[data-testid=crop-box]", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w, box.y + box.h); await page.mouse.down(); await page.mouse.move(box.x + box.w * 0.75, box.y + box.h * 0.75, { steps: 6 }); await page.mouse.up(); await sleep(250);
  await clickText(page, "[data-tool=image] button", "Apply crop"); await sleep(250);
  const afterCrop = await dimsText(); const cw = parseInt(afterCrop), ch = parseInt(afterCrop.split("×")[1]);
  ok("Crop (draggable handle)", cw < 800 && ch < 1200 && cw > 400, afterCrop);
  const wIn = await page.$("[data-tool=image] .st-size .st-num input"); await wIn.focus(); await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control"); await wIn.type("300"); await page.keyboard.press("Tab"); await sleep(200);
  const sized = await dimsText(); const sw = parseInt(sized), sh = parseInt(sized.split("×")[1]);
  ok("Resize keeps aspect ratio", sw === 300 && Math.abs(sh / sw - ch / cw) < 0.01, sized);
  await page.$eval("#adj-brightness", (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, "25"); e.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.$eval("#adj-contrast", (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, "15"); e.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.$eval("#adj-saturation", (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, "-20"); e.dispatchEvent(new Event("input", { bubbles: true })); });
  await clickText(page, "[data-tool=image] .chip-btn", "WEBP");
  await clickText(page, "[data-tool=image] .chip-btn", "Small");
  await page.screenshot({ path: `${OUT}/image-editor.png`, fullPage: true });
  await page.click("[data-tool=image] [data-testid=process]");
  await page.waitForSelector("[data-tool=image] [data-testid=result] img", { timeout: 60000 });
  ok("Image processed", /300 × \d+ · WEBP/.test(await page.$eval("[data-tool=image] .st-result-meta b", (e) => e.textContent)));
  const dlImg = `${OUT}/dl-image`; await downloadDir(page, dlImg);
  await page.click("[data-tool=image] [data-testid=download]");
  const fImg = await waitFile(dlImg);
  ok("Edited image downloads", !!fImg);
  if (fImg) { const i = pil(fImg); ok("Downloaded image is a valid WEBP at the requested size", i.f === "WEBP" && i.w === 300 && Math.abs(i.h - sh) <= 1, JSON.stringify(i)); ok("Compressed copy is smaller than the original", statSync(fImg).size < statSync(`${FIX}/photo.jpg`).size, `${statSync(`${FIX}/photo.jpg`).size} → ${statSync(fImg).size}`); }
  await page.click("[data-tool=image] [data-testid=save]");
  await page.waitForSelector("[data-tool=image] [data-testid=saved]", { timeout: 40000 });
  ok("Edited image saved to the workspace", true);
  const edImg = await A.c.from("files").select("id, source_file_id, edit_kind, edit_params, storage_path, mime_type, size_bytes").eq("edit_kind", "image");
  ok("Edited image row: private path, lineage to original, settings stored", edImg.data?.length === 1 && edImg.data[0].source_file_id === oImg.id && edImg.data[0].storage_path.startsWith(A.id + "/") && edImg.data[0].mime_type === "image/webp" && edImg.data[0].edit_params && typeof edImg.data[0].edit_params === "object", JSON.stringify(Object.keys(edImg.data?.[0]?.edit_params || {})));
  const o2 = await A.c.from("files").select("size_bytes").eq("id", oImg.id).single();
  ok("Original image row unchanged", o2.data?.size_bytes === oImg.size_bytes);
  const edBytes = await A.c.storage.from(BUCKET).download(edImg.data[0].storage_path);
  ok("Saved edited image downloads from private storage and is a valid WEBP", !edBytes.error && Buffer.from(await edBytes.data.arrayBuffer()).subarray(8, 12).toString() === "WEBP");

  // persistence after refresh
  await page.goto(SITE + "/workspace", { waitUntil: "networkidle0" }); await page.waitForSelector(".frow");
  ok("Edited copy persists after refresh with EDITED tag", (await page.$$eval(".frow", (a) => a.map((x) => x.textContent))).some((t) => t.includes("(edited).webp") && t.includes("EDITED")));

  // ═══ 3b. Object removal on the deployed site (real storage + real database) ═══
  {
    await uploadViaUi(page, `${FIX}/cleanup.png`, "cleanup.png");
    const oCl = (await A.c.from("files").select("id, size_bytes, storage_path").eq("original_name", "cleanup.png").single()).data;
    const origBytes = Buffer.from(await (await A.c.storage.from(BUCKET).download(oCl.storage_path)).data.arrayBuffer());
    await page.click("a[aria-label='Edit cleanup.png']");
    await page.waitForSelector("[data-tool='image']:not([hidden]) [data-testid=preview-stage] canvas", { timeout: 40000 }); await sleep(400);
    await page.$eval("[data-testid=open-cleanup]", (b) => b.click());
    await page.waitForSelector("[data-testid=cleanup-viewport]"); await sleep(300);
    await page.$eval("[data-testid=brush-slider]", (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, "120"); e.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.$eval("[data-testid=cleanup-viewport]", (e) => e.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(100);
    const r = await page.$eval("[data-testid=cleanup-viewport]", (e) => { const q = e.getBoundingClientRect(); return { x: q.x, y: q.y, w: q.width, h: q.height }; });
    await page.mouse.move(r.x + r.w * 0.45, r.y + r.h * 0.5); await page.mouse.down(); await page.mouse.move(r.x + r.w * 0.55, r.y + r.h * 0.5, { steps: 8 }); await page.mouse.up(); await sleep(100);
    await page.$eval("[data-testid=reconstruct]", (b) => b.click());
    await page.waitForSelector("[data-testid=cleanup-candidate]", { timeout: 120000 });
    ok("Live: reconstruction of a stored original produced a preview", true);
    await page.$eval("[data-testid=cleanup-apply]", (b) => b.click()); await sleep(200);
    await clickText(page, "[data-tool=image] .chip-btn", "PNG");
    await page.$eval("[data-testid=process]", (b) => b.click());
    await page.waitForSelector("[data-tool=image] [data-testid=result] img", { timeout: 60000 });
    const dlC = `${OUT}/dl-cleanup`; await downloadDir(page, dlC);
    await page.$eval("[data-testid=download]", (b) => b.click());
    const fC = await waitFile(dlC);
    const red = (f) => JSON.parse(execFileSync("python3", ["-I", "-c", "import sys,json;from PIL import Image;a=Image.open(sys.argv[1]).convert('RGB');p=a.load();print(json.dumps({'f':Image.open(sys.argv[1]).format,'w':a.size[0],'h':a.size[1],'red':sum(1 for y in range(270,331) for x in range(370,431) if p[x,y][0]>200 and p[x,y][1]<80 and p[x,y][2]<80)}))", f], { encoding: "utf8" }));
    const dc = fC ? red(fC) : null;
    ok("Live: downloaded cleaned image is a valid PNG with the object removed", !!dc && dc.f === "PNG" && dc.w === 800 && dc.h === 600 && dc.red < 20, JSON.stringify(dc));
    await page.$eval("[data-testid=save]", (b) => b.click());
    await page.waitForSelector("[data-tool=image] [data-testid=saved]", { timeout: 40000 });
    const cl = await A.c.from("files").select("id, source_file_id, edit_kind, edit_params, storage_path, mime_type").eq("edit_kind", "cleanup");
    ok("Live: cleanup copy row has edit_kind 'cleanup', lineage to the original, private path", cl.data?.length === 1 && cl.data[0].source_file_id === oCl.id && cl.data[0].storage_path.startsWith(A.id + "/") && cl.data[0].mime_type === "image/png", JSON.stringify(cl.error || ""));
    ok("Live: cleanup settings stored (engine, non-AI flag, pass details)", cl.data?.[0]?.edit_params?.cleanup?.engine === "patchmatch-inpaint" && cl.data[0].edit_params.cleanup.ai === false && cl.data[0].edit_params.cleanup.passes?.length === 1 && cl.data[0].edit_params.cleanup.passes[0].maskPixels > 0);
    const o3 = await A.c.from("files").select("size_bytes").eq("id", oCl.id).single();
    const after = Buffer.from(await (await A.c.storage.from(BUCKET).download(oCl.storage_path)).data.arrayBuffer());
    ok("Live: the original file is byte-for-byte unchanged in private storage", o3.data?.size_bytes === oCl.size_bytes && after.equals(origBytes), `${after.length} bytes`);
    const saved = await A.c.storage.from(BUCKET).download(cl.data[0].storage_path);
    ok("Live: saved cleanup copy downloads from private storage and is a valid PNG", !saved.error && Buffer.from(await saved.data.arrayBuffer()).subarray(1, 4).toString() === "PNG");
    const bSees = await B.c.from("files").select("id").eq("id", cl.data[0].id);
    ok("Live: B cannot read A's cleanup copy", !bSees.error && (bSees.data ?? []).length === 0);
    await page.goto(SITE + "/workspace", { waitUntil: "networkidle0" }); await page.waitForSelector(".frow");
  }

  // ═══ 4. Video editing on the deployed site ═══
  await page.click("a[aria-label='Edit clip.mp4']");
  await page.waitForSelector("[data-tool='video']:not([hidden]) [data-testid=source-video]", { timeout: 60000 });
  await page.waitForSelector("[data-tool=video] [data-testid=kept]", { timeout: 20000 });
  ok("Video opens with a preview player", /^0:06\.0 in 1 clip/.test(await page.$eval("[data-tool=video] [data-testid=kept]", (e) => e.textContent)));
  const ti = await page.$$("[data-tool=video] [data-testid=segment] input");
  await typeInto(page, ti[0], "1.0"); await typeInto(page, ti[1], "3.5");
  ok("Trim range set (1.0 s to 3.5 s)", /^0:02\.5 in 1 clip/.test(await page.$eval("[data-tool=video] [data-testid=kept]", (e) => e.textContent)));
  await clickText(page, "[data-tool=video] .chip-btn", "Small"); await page.select("[data-tool=video] select", "360");
  const t0 = Date.now();
  await page.click("[data-tool=video] [data-testid=process]");
  let engineSeen = false;
  await page.waitForFunction(() => !!document.querySelector("[data-tool=video] [data-testid=result-video]") || !!document.querySelector("[data-tool=video] .st-err"), { timeout: 240000 });
  const vErr = await page.$("[data-tool=video] .st-err");
  if (vErr) ok("Video exported on the deployed site", false, await vErr.evaluate((e) => e.textContent));
  else {
    note(`video engine download + export took ${((Date.now() - t0) / 1000).toFixed(1)} s on the runner`);
    ok("Video exported on the deployed site (WASM engine loads under production CSP/MIME)", true);
    const dlV = `${OUT}/dl-video`; await downloadDir(page, dlV);
    await page.click("[data-tool=video] [data-testid=download]");
    const fV = await waitFile(dlV, 120);
    ok("Edited video downloads", !!fV);
    if (fV) {
      const pr = probe(fV), v = pr.streams.find((s) => s.codec_type === "video");
      ok("Downloaded video: valid H.264 MP4, trimmed to 2.5 s, max height 360", v.codec_name === "h264" && Math.abs(parseFloat(pr.format.duration) - 2.5) < 0.2 && v.height <= 360, `${v.codec_name} ${v.width}x${v.height} ${pr.format.duration}s`);
      const dec = spawnSync("ffmpeg", ["-v", "error", "-i", fV, "-f", "null", "-"], { encoding: "utf8" }).stderr.trim();
      ok("Downloaded video decodes with zero errors", dec === "", dec.slice(0, 100));
      ok("Compression produced a smaller file", statSync(fV).size < statSync(`${FIX}/clip.mp4`).size, `${statSync(`${FIX}/clip.mp4`).size} → ${statSync(fV).size}`);
    }
    await page.click("[data-tool=video] [data-testid=save]");
    await page.waitForSelector("[data-tool=video] [data-testid=saved]", { timeout: 60000 });
    const edVid = await A.c.from("files").select("id, source_file_id, edit_kind, storage_path, mime_type").eq("edit_kind", "video");
    ok("Edited video row: private path, lineage to original, kind=video", edVid.data?.length === 1 && edVid.data[0].source_file_id === oVid.id && edVid.data[0].storage_path.startsWith(A.id + "/") && edVid.data[0].mime_type === "video/mp4");
    if (edVid.data?.length) { const b = await A.c.storage.from(BUCKET).download(edVid.data[0].storage_path); const buf = Buffer.from(await b.data.arrayBuffer()); ok("Saved edited video is a real MP4 in private storage", !b.error && buf.subarray(4, 8).toString() === "ftyp", `${buf.length} bytes`); }
  }
  // thumbnail
  await page.$eval("[data-tool=video] [data-testid=source-video]", (v) => { v.currentTime = 3.0; }); await sleep(600);
  const dlT = `${OUT}/dl-thumb`; await downloadDir(page, dlT);
  await page.$eval("[data-tool=video] [data-testid=grab]", (b) => b.scrollIntoView({ block: "center", behavior: "instant" })); await sleep(200);
  await page.click("[data-tool=video] [data-testid=grab]");
  await page.waitForSelector("[data-tool=video] [data-testid=thumb-result] img", { timeout: 30000 });
  await clickText(page, "[data-tool=video] [data-testid=thumb-result] button", "Download JPG");
  const fT = await waitFile(dlT);
  ok("Thumbnail extracted and downloaded as a valid JPEG (640x360)", !!fT && (() => { const i = pil(fT); return i.f === "JPEG" && i.w === 640 && i.h === 360; })());
  await clickText(page, "[data-tool=video] [data-testid=thumb-result] button", "Save to workspace"); await sleep(4000);
  const th = await A.c.from("files").select("source_file_id, edit_kind, category").eq("edit_kind", "thumbnail");
  ok("Thumbnail saved as an image linked to the video", th.data?.length === 1 && th.data[0].category === "image" && th.data[0].source_file_id === oVid.id);

  // ═══ 5. Error handling ═══
  await page.goto(SITE + "/image-editor", { waitUntil: "networkidle0" });
  await (await page.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/fake.png`);
  await page.waitForSelector("[data-tool=image] .empty[role=alert]", { timeout: 20000 });
  ok("Corrupt image: clear error, no crash", (await page.$eval("[data-tool=image] .empty p", (e) => e.textContent)).length > 10, await page.$eval("[data-tool=image] .empty p", (e) => e.textContent));
  await page.click("[data-tool=image] .empty button");
  await (await page.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/huge.jpg`);
  await page.waitForSelector("[data-tool=image] .empty[role=alert]", { timeout: 30000 });
  ok("108-megapixel image refused with a clear message", /large|megapixel|MP/i.test(await page.$eval("[data-tool=image] .empty p", (e) => e.textContent)));
  await page.goto(SITE + "/video-editor", { waitUntil: "networkidle0" });
  await (await page.waitForSelector("[data-tool=video]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/fake.mp4`);
  await page.waitForSelector("[data-tool=video] .empty[role=alert]", { timeout: 30000 });
  ok("Corrupt video: clear error, no crash", true, await page.$eval("[data-tool=video] .empty p", (e) => e.textContent));

  // ═══ 6. User isolation (live) ═══
  const edId = edImg.data[0].id;
  const pb = await newPage({ width: 1280, height: 900 }, undefined, true);
  await uiLogin(pb, "B");
  await pb.goto(SITE + "/workspace", { waitUntil: "networkidle0" });
  await sleep(1500);
  const bNames = await pb.$$eval(".frow .f-name", (a) => a.map((x) => x.textContent));
  ok("B's workspace shows none of A's files", bNames.length === 0, bNames.join(",") || "empty");
  await pb.goto(`${SITE}/image-editor?file=${edId}`, { waitUntil: "networkidle0" });
  await pb.waitForSelector(".st-err[role=alert]", { timeout: 15000 });
  ok("B opening A's file id in the editor gets 'not found'", /wasn't found/i.test(await pb.$eval(".st-err", (e) => e.textContent)) && !(await pb.$("[data-tool=image] canvas")));
  const bApi = await B.c.from("files").select("id").eq("id", edId); ok("B cannot read A's edited-copy row via the API", (bApi.data ?? []).length === 0);
  await pb.close();

  // ═══ 7. Android phone emulation on the deployed site ═══
  const ua = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
  const mob = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, ua, true);
  await uiLogin(mob, "A");
  const overflow = async (label) => { const o = await mob.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth })); ok(`Mobile: no horizontal overflow on ${label}`, o.sw <= o.iw + 1, JSON.stringify(o)); };
  await mob.goto(SITE + "/workspace", { waitUntil: "networkidle0" }); await mob.waitForSelector(".frow"); await overflow("workspace");
  await mob.goto(SITE + "/image-editor", { waitUntil: "networkidle0" });
  await (await mob.waitForSelector("[data-tool=image]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/photo.jpg`);
  await mob.waitForSelector("[data-tool=image] [data-testid=preview-stage] canvas", { timeout: 40000 }); await sleep(500); await overflow("image editor");
  await mob.screenshot({ path: `${OUT}/mobile-image.png`, fullPage: true });
  await mob.click("[data-tool=image] [data-testid=process]"); await mob.waitForSelector("[data-tool=image] [data-testid=result] img", { timeout: 60000 });
  ok("Mobile (Android UA): image processing works", true);
  await mob.goto(SITE + "/video-editor", { waitUntil: "networkidle0" });
  await (await mob.waitForSelector("[data-tool=video]:not([hidden]) input[type=file]")).uploadFile(`${FIX}/clip.mp4`);
  await mob.waitForSelector("[data-tool=video] [data-testid=source-video]", { timeout: 30000 }); await sleep(500); await overflow("video editor");
  await mob.screenshot({ path: `${OUT}/mobile-video.png`, fullPage: true });
  await mob.click("[data-tool=video] [data-testid=process]");
  await mob.waitForFunction(() => !!document.querySelector("[data-tool=video] [data-testid=result-video]") || !!document.querySelector("[data-tool=video] .st-err"), { timeout: 240000 });
  ok("Mobile (Android UA): video export works", !!(await mob.$("[data-tool=video] [data-testid=result-video]")), (await mob.$eval("[data-tool=video] .st-err", (e) => e.textContent).catch(() => "")) || "");
  await mob.close();

  ok("No Content-Security-Policy violations on the deployed site", csp.length === 0, csp.slice(0, 2).join(" | "));
  ok("No uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (e) {
  ok("Audit script ran to completion", false, String(e.message).split("\n")[0]);
} finally {
  await sweep(A); await sweep(B);
  const left = await A.c.from("files").select("id"); note(`cleanup: A has ${left.data?.length ?? "?"} files left`);
  await browser.close(); local?.stop();
}
console.log(`\n${total - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
