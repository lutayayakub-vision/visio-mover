// Pure-logic checks for the main-thread cleanup wrapper (limits, region planning, session cap, error types).
import { CleanupError, cleanupLimits, maxCleanups, planRoi, reconstruct } from "../src/lib/inpaintEngine";
import type { DeviceProfile } from "../src/lib/imageEngine";

let pass = 0, fail = 0;
const t = (name: string, cond: boolean, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`); };
const desk = { mobile: false, previewSide: 1600 } as unknown as DeviceProfile;
const mob = { mobile: true, previewSide: 1000 } as unknown as DeviceProfile;
const throws = (f: () => unknown) => { try { f(); return null; } catch (e) { return e as CleanupError; } };

const ld = cleanupLimits(desk), lm = cleanupLimits(mob);
t("desktop limits: 50 MP image, 16 MP region, 1.4 MP synthesis", ld.maxImagePixels === 50e6 && ld.maxRoiPixels === 16e6 && ld.maxWorkPixels === 1.4e6);
t("mobile limits are stricter on every axis", lm.maxImagePixels < ld.maxImagePixels && lm.maxRoiPixels < ld.maxRoiPixels && lm.maxWorkPixels < ld.maxWorkPixels);

// session cap
t("cap is 5 for ordinary photos, 4 for a 12 MP photo on mobile", maxCleanups(1200, 800, desk) === 5 && maxCleanups(4000, 3000, mob) === 4, `${maxCleanups(1200, 800, desk)} / ${maxCleanups(4000, 3000, mob)}`);
t("cap never exceeds 5", maxCleanups(10, 10, desk) === 5 && maxCleanups(10, 10, mob) === 5);
t("cap shrinks for huge images (memory budget) but never below 1", maxCleanups(7000, 7000, desk) === 3 && maxCleanups(5000, 3200, mob) === 3 && maxCleanups(16_000, 3_125, mob) === 1 && maxCleanups(50_000, 1_000, desk) === 3, `${maxCleanups(7000, 7000, desk)} ${maxCleanups(5000, 3200, mob)} ${maxCleanups(16000, 3125, mob)}`);
t("worst-case stored bitmaps stay within budget (desktop ≤ 600 MB, mobile ≤ 192 MB)", [[7000, 7000], [8000, 6000], [5000, 4000], [1200, 800]].every(([w, h]) => maxCleanups(w, h, desk) * w * h * 4 <= 600e6 || maxCleanups(w, h, desk) === 1) && [[4000, 4000], [3000, 2000], [1200, 800]].every(([w, h]) => maxCleanups(w, h, mob) * w * h * 4 <= 192e6 || maxCleanups(w, h, mob) === 1));

// region planning
const roi = planRoi({ x: 100, y: 100, w: 50, h: 50 }, 1000, 800, ld);
t("region is the selection plus margin, inside the image", roi.x >= 0 && roi.y >= 0 && roi.x + roi.w <= 1000 && roi.y + roi.h <= 800 && roi.x < 100 && roi.w > 50, JSON.stringify(roi));
const edge = planRoi({ x: 0, y: 0, w: 30, h: 30 }, 500, 500, ld);
t("region is clipped at the image edge", edge.x === 0 && edge.y === 0 && edge.w <= 500 && edge.h <= 500);
const shrunk = planRoi({ x: 1000, y: 1000, w: 1500, h: 1500 }, 6000, 6000, lm);
t("region shrinks its margin to fit the mobile budget and still contains the selection", shrunk.w * shrunk.h <= lm.maxRoiPixels && shrunk.x <= 1000 && shrunk.x + shrunk.w >= 2500, `${shrunk.w}x${shrunk.h}`);
const big = throws(() => planRoi({ x: 0, y: 0, w: 4000, h: 4000 }, 6000, 6000, lm));
t("a selection too large for the device is refused with code too_large", big instanceof CleanupError && big.code === "too_large", big?.message);

// guard rails in reconstruct() that fire before any work starts
const fake = (w: number, h: number) => ({ width: w, height: h }) as unknown as ImageBitmap;
const run = async (src: ImageBitmap, strokes: any[], opts: any = {}) => { try { await reconstruct(src, strokes, { profile: desk, ...opts }); return null; } catch (e) { return e as CleanupError; } };
const e1 = await run(fake(9000, 9000), [{ erase: false, r: 5, pts: [10, 10] }]);
t("an oversized image is refused (too_large) and the message tells the user what to do", e1?.code === "too_large" && /Resize/.test(e1.message), e1?.message.slice(0, 80));
const e2 = await run(fake(100, 100), [], { });
t("no worker environment -> no_worker, never a fake success", e2?.code === "no_worker", e2?.code);
(globalThis as any).Worker = class {};
const e3 = await run(fake(100, 100), []);
t("empty selection is refused (empty_mask)", e3?.code === "empty_mask", e3?.message);
const ac = new AbortController(); ac.abort();
const e4 = await run(fake(100, 100), [{ erase: false, r: 5, pts: [10, 10] }], { signal: ac.signal });
t("an already-cancelled run stops before doing any work (cancelled)", e4?.code === "cancelled", e4?.code);
const e5 = await run(fake(100, 100), [{ erase: true, r: 5, pts: [10, 10] }]);
t("a selection made only of eraser strokes counts as empty", e5?.code === "empty_mask", e5?.code);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
