# Stage 2 – Video cleanup: implementation plan (PLAN ONLY, no code written)

Status: proposal for approval. Nothing here is built. Builds on Stage 1 (image cleanup) and the existing Video Editor.

## 1. Goal and honest scope
Remove an unwanted object from a short clip the user owns or may modify (a logo/watermark they own, a stray person, a sensor spot), inside the existing **Video Editor**, on the user's device, saving a **new** edited copy and never touching the original.

What a non-AI, on-device engine can and cannot do:
| Case | Achievable? | Approach |
|---|---|---|
| Object fixed on screen (overlay, logo, dust spot), background moving | Good | **2a** reveal background from other frames, spatial fill as fallback |
| Moving object, static camera | Good | **2a/2b** background plate from frames where the object is elsewhere |
| Moving object, moving camera, complex scene | Weak / flickery | needs neural video inpainting (see §9). Not promised in 2a/2b |
| Large object hiding unique structure (faces, text) | Poor | same limit as Stage 1 |

## 2. What we measured (to size the work)
Stage 1 core, single thread, Node (browser worker is similar to ~2× slower): ROI 320×240 → 0.16 s/frame; 480×360 → 0.23 s; 640×360 → 0.35 s; 960×540 → 0.67 s; 1280×720 → 1.1 s.
So a 10 s clip at 30 fps (300 frames) with a 640×360 region ≈ 105 s on one thread; ≈ 30–50 s with a 4-worker pool. Limits below are derived from this. Existing video limits stay: 50 MB desktop / 30 MB phone input, 50 MB bucket cap on output.

## 3. Architecture (reuse, do not duplicate)
- **Reuse** `VideoEditor` (new "Remove object" mode, same pattern as Stage 1 in `ImageEditor`), `CleanupStage` (brush/eraser/zoom/pan/undo on a paused frame), `strokes.ts`, `inpaint/core.ts`, `VideoEngine` (ffmpeg.wasm), `saveEditedCopy`, `CompareSlider`.
- **New** `src/lib/videoCleanup.ts` (orchestrator), `src/lib/inpaint/temporal.ts` (pure, DOM-free, unit-testable), worker pool wrapper reusing `inpaint/worker.ts` with a new message type.
- **Pipeline per chunk (≈2 s, keyframe-aligned):** ffmpeg.wasm `crop` filter extracts only the working region as raw/PNG frames → worker pool → composite onto the full frame (non-masked pixels copied exactly) → x264 encode of the chunk (existing encode settings) → at the end concat chunks with `-c copy` (the existing multi-segment path) and mux the original audio untouched (`-c:a copy` when compatible, existing AAC path otherwise). Chunking keeps ffmpeg's in-memory filesystem bounded (a 300-frame 640×360 RGBA ROI would otherwise be ~280 MB).
- Core changes (backward compatible, Stage 1 tests must stay green): optional `init` estimate / NNF so frame N starts from frame N-1's solution; optional extra exemplar frames as source; export NNF.

## 4. Temporal consistency (the hard part)
1. **Background-plate (2a):** for each masked pixel, take the temporal median over nearby frames where that pixel is *not* masked and the scene is static (static-camera check via frame-difference outside the mask). Free of flicker and exact when the background is visible in some frame.
2. **Spatial fallback:** pixels never revealed are synthesised by the Stage 1 PatchMatch, **initialised from the previous frame's result** (NNF propagation), same seed, so the fill is stable rather than re-invented every frame.
3. **Smoothing:** weighted 3-frame blend inside the filled region only, disabled across detected shot cuts (histogram jump) where state resets.
4. **Seam:** reuse the Stage 1 seam correction per frame.
5. Static-camera check fails → warn the user ("camera moves; result may flicker") and offer spatial-only mode. Never silently pretend it worked.

## 5. Masks
- **2a:** one mask (strokes drawn on a paused frame), applied to a chosen time range (default: whole kept clip). Fixed screen position.
- **2b:** up to 8 **keyframes**; the mask shape/position is linearly interpolated between them (strokes stored as vectors, as in Stage 1). User scrubs, adjusts, previews.
- **2c (optional, decision needed):** tracking-assisted propagation (template/optical-flow tracker) to reduce manual keyframes. Higher risk; only after 2a/2b pass.

## 6. UI (inside the existing Video Editor)
"Remove object" card → scrub to a frame → brush/eraser/size/zoom/pan/undo (reuse `CleanupStage`) → choose range → **Preview 2 s** (≈15–20 frames, same pipeline, before/after) → **Reconstruct whole clip** with progress, frame counter, ETA, **Cancel** (terminate workers, free MEMFS) → result player with before/after → **Apply / Discard** → existing export/save/download. Clear errors for every failure; desktop and 390 px layouts.

## 7. Limits (initial, to be confirmed by device testing)
| | Desktop | Mobile |
|---|---|---|
| Clip length processed | ≤ 10 s | ≤ 5 s |
| Frame rate processed | ≤ 30 fps (higher is re-timed to 30 only with user consent, otherwise refused) | ≤ 30 fps |
| Working region | ≤ 2 MP | ≤ 0.5 MP |
| Workers | `min(4, hardwareConcurrency−1)` | 1–2 |
| Output | must fit the 50 MB bucket cap, checked before save | same |
Longer clips: user trims first (existing trim tool) and cleans the kept part.

## 8. Supabase, security, privacy, licensing
- **No new migration needed:** reuse `edit_kind = 'cleanup'` (already allowed) with `edit_params.cleanup.media = "video"`, category `video`, `source_file_id` = original. RLS, grants, triggers, bucket unchanged. If we prefer a distinct kind (`'video_cleanup'`) it is one CHECK-widening migration like Stage 1; user approval first.
- `edit_params` stays ≤ 8 KB: store a summary (keyframe count, simplified region, range, frames, engine/version, timings), not full masks.
- Everything on-device: no upload, no server, no API keys, no new env vars, no service-role use. CSP already allows workers/wasm.
- Licence: no new dependencies; the existing ffmpeg.wasm core is GPL (libx264) – unchanged, documented in the video docs. Feature is for content the user owns or is authorised to modify.

## 9. Decision gates for you
1. **Accept the non-AI scope** (§1 table), or authorise a neural option later (e.g. a ProPainter-class model). That needs a GPU provider (cost to be quoted, not assumed), an API key you supply, a privacy disclosure because the video leaves the device, and your explicit approval. Not planned for Stage 2.
2. **Clip limits** in §7 (10 s / 5 s).
3. **Distinct `edit_kind` or reuse `'cleanup'`** (§8).
4. **Include tracking (2c)** or stop at keyframes (2b).

## 10. Milestones and acceptance gates
| M | Deliverable | Gate (tests actually run) |
|---|---|---|
| 0 | Synthetic test videos (ffmpeg-generated: static logo over moving background; moving object over static background; camera pan; shot cut; with audio) + metrics tooling (object-gone, outside-pixels, flicker, audio) | metrics validated against ground truth |
| 1 | `temporal.ts` + core `init`/exemplar hooks, unit tests | Stage 1 47/47 + 15/15 still pass; new unit tests: plate median exactness, NNF reuse determinism, shot-cut reset |
| 2 | Orchestrator + chunked ffmpeg pipeline + worker pool, headless | object removed in test videos; **pixels outside the mask identical before encode**; fps/duration/frame count unchanged; audio stream preserved; flicker metric ≤ agreed threshold; cancel frees workers and memory; failure leaves original untouched |
| 3 | UI (mode, keyframes, 2 s preview, progress/ETA, cancel, compare, apply) | desktop + 390 px e2e with real production build |
| 4 | Save/lineage/isolation, limits and error cases (oversize, corrupt, OOM simulation, too-long clip) | mock e2e + live Supabase run (same pattern as Stage 1) with original byte-identical |
| 5 | Docs, honest homepage text (only what is tested), completion report | all suites green, exact results reported |

Rough effort: M0–M2 are the risky part (temporal quality, memory); M3–M5 mirror Stage 1.

## 11. Risks
- Flicker/ghosting on moving-camera footage (mitigated by detection + honest warning, not hidden).
- ffmpeg.wasm memory/time on phones (mitigated by chunking, low limits, early refusal).
- x264 re-encode is lossy: "pixels outside the mask unchanged" holds before encoding; after encoding we measure against an equally re-encoded original and say so.
- Real-device speed unknown until tested.

## 12. Out of scope for Stage 2
Neural inpainting, server processing, audio cleanup, clips > limits, automatic object detection, any change to production deployment or `main`.
