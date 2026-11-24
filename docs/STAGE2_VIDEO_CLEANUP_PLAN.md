# Stage 2 – Video cleanup: implementation plan v2 (PLAN ONLY, awaiting approval)

Branch for this work: `stage2-video-cleanup` (created from `cleanup-stage1-inpainting`, which stays untouched). No code is written until this plan is approved. No merge to `main`, no Netlify deploy, no production-config change at any point.

## 0. Decisions already approved
1. Free, non-AI PatchMatch only. No paid GPU provider, external AI service or API key.
2. Limits: 10 s desktop, 5 s mobile.
3. Reuse `edit_kind = 'cleanup'`; record media type and settings in `edit_params`. **No migration needed** (verified: no constraint ties `edit_kind` to `category`; `video/mp4` + `'cleanup'` is already accepted; `edit_params` ≤ 8 KB).
4. Automatic object tracking, with manual keyframe correction when tracking is inaccurate.
5. Fixed-camera scenes first; limitations with moving cameras, complex motion, occlusion and changing backgrounds are communicated clearly in the UI.
6. Resolution, frame-count, memory and processing-time limits (§3).
7. ~2-second chunks; reliable cancellation.
8. Original preserved byte-for-byte; results saved as new copies linked to the original.
9. Six independently testable milestones with automated tests each (§5).
10. No merge, no deploy, no production changes.

## 1. What it will and will not do (shown to the user in the UI)
| Situation | Behaviour |
|---|---|
| Fixed camera, object fixed or moving over a background that is revealed in other frames | Supported. Best quality (background taken from real frames, no flicker) |
| Fixed camera, object covers background that is never visible | Supported, spatial PatchMatch fill (Stage 1 quality), temporally stabilised |
| Moving camera / pans / zooms | **Detected and warned** ("camera moves; result may flicker or smear"). Spatial-only mode offered; never presented as reliable |
| Fast or complex motion, motion blur, object leaves/re-enters, partial occlusion, lighting changes | Tracker reports low confidence on those frames; they are flagged and need manual keyframes. The run is never silently continued with a bad mask |
| Shot cuts | Detected; processing state resets at the cut |
| Large object hiding unique structure (faces, text) | Poor, same limit as Stage 1 |

## 2. Architecture (reuse, no duplicate editors)
**Reused:** `VideoEditor` (new "Remove object" mode, same pattern as `ImageEditor`), `CleanupStage` (brush, eraser, zoom, pan, undo on a paused frame), `strokes.ts`, `inpaint/core.ts` + worker, `VideoEngine` (ffmpeg.wasm, its `terminate()`, segment concat), `saveEditedCopy`, `CompareSlider`, existing storage/RLS.

**New (all pure/DOM-free where possible, so they are unit-testable in Node):**
- `src/lib/inpaint/temporal.ts` – background-plate (temporal median over frames where the pixel is unmasked), camera-motion check, shot-cut detection, 3-frame smoothing inside the filled region, seam handling.
- `src/lib/track/tracker.ts` – tracker (below).
- `src/lib/videoCleanup.ts` – orchestrator: limits, frame extraction, chunk loop, worker pool, composite, encode, concat, cancel, ETA.
- `src/lib/inpaint/pool.ts` – small worker pool (N workers, terminate-all).
- Core additions (backward compatible; Stage 1 tests must stay green): optional `init` estimate/NNF so frame N starts from frame N-1; optional extra exemplar frames.
- UI: `VideoCleanupStage.tsx` (frame scrubber + mask + track + keyframe timeline) inside the Video Editor.

**Tracker (fixed-camera first):** template matching on a downscaled grayscale ROI. The object's mask (drawn on a frame) defines a template; for each following frame, normalised cross-correlation over a limited search window gives dx,dy (sub-pixel refinement); the mask is translated accordingly (optional uniform scale after the first working version). Per-frame **confidence** = NCC peak, peak-to-second-peak ratio, and a **forward-backward check** (track back and compare). Below threshold → frame flagged "needs review", tracking stops there and waits for a keyframe. A manual keyframe re-anchors the template; tracking continues forward and backward from it; between two keyframes the mask is interpolated. Fixed-camera check: global motion of the area outside the mask (phase correlation); above threshold → camera-move warning.

**Pipeline (per ~2 s chunk, aligned to frames):**
1. ffmpeg.wasm extracts only the working region (crop filter) for the chunk as raw frames, plus the frames needed for the background plate (neighbouring chunk frames within a small window).
2. Tracker output → per-frame mask. Worker pool inpaints frames (plate first, spatial fallback, previous-frame init, fixed seed).
3. Composite: only masked pixels change; every other pixel of the full frame is copied exactly.
4. Encode the chunk with the existing x264 settings; at the end concat chunks with `-c copy` and mux the **original audio untouched** (existing audio path).
5. Chunking bounds ffmpeg's in-memory filesystem; chunk files are deleted as soon as they are concatenated.

**Metadata** (`edit_params`, ≤ 8 KB, compact): `{kind:"cleanup", cleanup:{media:"video", engine:"patchmatch-inpaint", version, ai:false, tracking:{method, keyframes, flaggedFrames, minConfidence}, range, fps, frames, region, chunkSeconds, camera:"fixed"|"warned", limitationsShown:[...], ms}}`. Full masks are not stored.

## 3. Resource limits (initial; confirmed by real measurements during M4)
| | Desktop | Mobile |
|---|---|---|
| Input file (existing) | 50 MB | 30 MB |
| Processed duration | ≤ 10 s | ≤ 5 s |
| Frame rate | ≤ 30 fps (higher: refused with advice to trim/convert) | ≤ 30 fps |
| Frame count | ≤ 300 | ≤ 150 |
| Source frame size | ≤ 1920×1080 | ≤ 1280×720 |
| Working region | ≤ 2 MP | ≤ 0.5 MP |
| Chunk | ~2 s (≤ 60 frames) | ~2 s (≤ 60 frames) |
| Raw frames held per chunk | ≤ ~120 MB | ≤ ~40 MB |
| Workers | `min(4, hardwareConcurrency − 1)` | 1–2 |
| Keyframes | ≤ 8 manual (+ automatic tracking) | ≤ 8 |
| Output | must fit the 50 MB bucket cap; checked before saving | same |
| Time | ETA measured on the first frames; **refuse before starting** if projected > 10 min (desktop) / 6 min (mobile); stop and offer options if real time exceeds 2× the projection | same |
Anything over a limit is refused up front with a specific message (trim first, smaller region, lower resolution) – never started and abandoned.

## 4. Cancellation and safety
- One `AbortController`: terminates every pool worker and the ffmpeg instance (`VideoEngine.terminate()`), deletes MEMFS files, discards partial chunks. Target: UI back to idle within ~2 s; a new run works afterwards.
- No partial result is ever shown or saved. Failure/cancel → clear message, original untouched.
- The original `File`/stored object is only read (copied into ffmpeg's memory). Tests compare SHA-256 before/after (local file and live storage object).
- Same private bucket, same RLS/grants/triggers; no new endpoints, env vars, secrets or CSP changes; no upload for processing.

## 5. Six milestones and test strategy
Each milestone is committed to `stage2-video-cleanup`, must be fully green (previous suites included: Stage 1 47/47 + 15/15, image, video, UI e2e 87/87) and ends with a short report of exact results. I stop for your go/no-go after **M3** (tracking viability is the biggest quality risk) and whenever a gate fails; otherwise I continue to the next milestone and report. Tell me if you want a stop after every milestone instead.

| M | Deliverable | Automated tests / acceptance gate |
|---|---|---|
| **1. Test assets + metrics harness** | ffmpeg-generated clips with known ground truth: (a) static logo over moving background, (b) object moving over static background, (c) camera pan (limitation case), (d) shot cut, (e) occlusion/exit-reenter, (f) low-light noise; with and without audio. Python/Node metrics: object-gone, outside-mask pixel identity, flicker (temporal difference of the filled area vs ground-truth background), PSNR, audio/fps/duration/frame-count parity | Harness self-tests against ground truth (e.g. a perfect result scores perfect, a naive blur scores worse). Deterministic generation |
| **2. Temporal core (pure)** | `temporal.ts` + core `init`/exemplar hooks | Unit tests: plate median exact when background visible; previous-frame init is deterministic and reduces flicker vs independent fill; shot-cut reset; camera-motion detector true/false cases; smoothing never touches pixels outside the mask. Stage 1 tests unchanged and green |
| **3. Tracker (pure)** | template tracker, confidence, forward-backward check, keyframe interpolation/re-anchoring | Unit/synthetic tests: translation accuracy (sub-pixel error threshold), noise robustness, drift over 150 frames, **occlusion and exit are flagged, not tracked through**, keyframe re-anchoring recovers, interpolation correct, speed budget. **Gate: report accuracy numbers; your go/no-go before continuing** |
| **4. Pipeline** | `videoCleanup.ts`, pool, chunked ffmpeg.wasm flow, limits, ETA, cancel | Headless-Chrome tests with real ffmpeg.wasm on M1 clips: object removed; **pixels outside the mask identical before encode**; fps/duration/frame count unchanged; audio stream preserved; flicker ≤ threshold; every limit refused with the right message; **cancel mid-chunk frees all workers/ffmpeg, original unchanged, a new run succeeds**; simulated OOM and corrupt input; measured time/memory recorded to confirm or adjust §3 |
| **5. UI in the Video Editor** | mask on a paused frame, Track, low-confidence timeline with manual keyframes, 2-second preview, progress/ETA/Cancel, before/after, Apply/Discard, clear limitation messages | Production-build e2e (real `_headers`, mock Supabase): draw mask, track, fix a flagged frame, preview, apply, export validity (ffprobe), limits/errors, camera-move warning, cancel, **390 px mobile layout with touch**, existing editors not regressed |
| **6. Save, lineage, live checks, docs** | save as `edit_kind='cleanup'`, `media:"video"`, lineage + compact settings; docs; homepage text only for what is tested | Mock e2e + GitHub-Actions live run with real Supabase (same pattern as Stage 1): copy row/lineage/private path, cross-account isolation, oversize/invalid kind, **original byte-identical (SHA-256) in storage**, valid MP4 downloads. Final report in the required 7-point format |

Not testable here and stated as such in reports: real-phone speed/thermal behaviour, Netlify-specific behaviour (deploys stay off), user-perceived quality beyond the metrics.

## 6. Risks
- Tracker drift or failure on blur/occlusion → mitigated by confidence flags + manual keyframes; the gate after M3 decides whether to proceed.
- ffmpeg.wasm memory/time on phones → chunking, low limits, early refusal.
- x264 re-encode is lossy: "pixels outside the mask unchanged" is proven before encoding; after encoding we compare against an equally re-encoded original and say so.
- Moving-camera footage will not be good; the UI says so.

## 7. Out of scope
Neural inpainting, server processing, audio cleanup, clips over the limits, automatic object detection (the user marks the object), any production deployment or `main` change.

## M2 implementation note (as built)
`src/lib/inpaint/temporal.ts`: global-translation motion per frame pair (masked areas ignored; "still" preferred when it explains the picture as well as the best shift), rigid-motion check (64×64 block agreement), shot cuts by block-mean mismatch, per-shot cumulative motion, motion-compensated per-pixel median plate (nearest frames first), coverage policy (default: refuse with `insufficient_background`; opt-in `spatial` → status `degraded`), Stage 1 PatchMatch fallback seeded from the previous frame (`init` hook in `core.ts`), exact outside-copy verified before returning. Integer-pixel global translation only; zoom/rotation/parallax are detected as unreliable, not compensated. Results: `tests/video-cleanup/last-m2-result.txt`. Run: `npm run test:vc-temporal`.

## M3 implementation note (as built)
`src/lib/track/tracker.ts`: masked NCC template matching against the keyframe picture (colour-aware agreement check with robust brightness fit and noise-adaptive tolerance), sub-pixel refinement, forward-backward checks (previous frame and keyframe), statuses `keyframe/tracked/interpolated/reentry/uncertain/lost/absent`, re-entry search over the whole frame, manual keyframes with bidirectional tracking and straight-line interpolation (max 30 frames), camera-movement warning, `resolveMasks()` refuses while any frame needs review. Fixed (keyframe) template, no appearance adaptation: scale/rotation/shape change is flagged, not followed. Results: `tests/video-cleanup/last-m3-result.txt`, `last-m3-bench.json`. Run: `npm run test:vc-tracker`.

---

## Milestone 4 as-built note (pipeline)

**Delivered:** `src/lib/videoCleanup.ts` (pipeline), `src/lib/inpaint/pool.ts` (worker pool), `src/lib/inpaint/temporalWorker.ts` (tracking and reconstruction in workers), additive `VideoEngine` methods (`useInput/exec/writeBytes/readBytes/removeFile`), `range` option in `temporal.ts`, `tests/video-cleanup-pipeline.test.mjs` (`npm run test:vc-pipeline`).

**Deviations from §3, decided for honesty/safety:**
- Region limit is `min(2 MP, rawBudget / (frames × 3))`: tracking needs the whole range's region frames in memory (desktop 240 MB, mobile 72 MB), so long clips need a smaller working area (refused with the exact maximum).
- Output is the cleaned range only (not spliced into the full video). Keyframe frame numbers count from the range start.
- Chunks are ~2 s with ≤15 context frames; a chunk is retried once with ≤45 context frames when background is insufficient or when seam pixels were filled spatially, if memory allows. Spatial-fallback seeding resets at chunk boundaries.
- A fresh ffmpeg.wasm instance is started per job (wasm memory only grows; a reused instance failed later jobs in the suite).
- Time model refuses > 10 min (desktop) / 6 min (mobile) projected, and a running job is stopped as `too_slow` if projected > 2× estimate and above a floor. Constants calibrated on this sandbox; real-device speed is NOT yet measured.

**Bug found by the M4 tests:** reading the video in pieces with `-ss` half a frame before the target made ffmpeg duplicate a frame at the start of later pieces, putting the cleaned patch one frame late on moving footage (static_logo flicker excess 7.3 vs limit 6.1). Fixed with `-vsync 0` (excess now 1.9).

**Not covered:** HDR / non-4:2:0 / non-8-bit (refused), variable-frame-rate sources beyond the frame-count check, real phones.
