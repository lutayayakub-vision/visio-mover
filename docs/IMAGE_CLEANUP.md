# Image cleanup (object removal), Stage 1

Lives inside the existing **Image Editor** (`/image-editor`): *Remove objects → Select area to remove*.

## What it is (and is not)
- **Real inpainting, not AI.** The engine is a classical **multi-scale PatchMatch exemplar-based inpainting** algorithm (the family behind "content-aware fill"). It rebuilds the selected area by copying and blending patches from the rest of the same image. It is **not a neural network** and is not described as AI anywhere in the product.
- It is strong on textures, skies, walls, grass, water, stripes and repeated patterns, and on small/medium objects over simple backgrounds. It is weaker where a large region hides unique structure (faces, text, complex objects) because it can only reuse what is visible elsewhere in the image.
- It never silently falls back to blur or flat fill. If reconstruction is impossible it fails with a message and changes nothing.

## How it works
1. Brush/eraser strokes are stored as vectors in image pixels (undo/redo = drop/restore strokes) and rasterised only when needed.
2. A region of interest (selection bounds + margin) is cut from the full-resolution image and sent to a Web Worker.
3. Image pyramid (max 9 levels) → coarsest hole filled by diffusion → per level, 4–7 EM iterations of PatchMatch (propagation + random search, 7×7 patches, source patches must lie fully outside the hole) and similarity-weighted voting → upsample → seam-correction pass (screened diffusion of the boundary colour offset).
4. Only selected pixels are pasted back (opaque). Every other pixel keeps the source's exact bytes (verified bit-for-bit in tests).
5. The result is shown as a candidate with a before/after slider. **Apply** commits it to the editor session, **Discard** drops it. The original file is never modified; saving creates a new file.

Deterministic: fixed PRNG seed (1337), so the same selection gives the same result.

## Limits
| | Desktop | Mobile |
|---|---|---|
| Max image | 50 MP | 16 MP |
| Max region processed | 16 MP | 5 MP |
| Max synthesis resolution | 1.4 MP | 0.5 MP |

Very large selections are synthesised at reduced resolution and upsampled (seams are still corrected at full resolution). Selecting more than 70 % of the image, or leaving fewer than ~20 usable source patches, fails with a clear message. Up to 5 applied cleanups per editing session. Supported formats: PNG, JPEG, WebP (corrupt/unsupported/oversized files are rejected by the existing image loader). Transparent pixels inside a selection are filled opaque.

## Privacy, cost, dependencies
- **Runs entirely in the browser.** The image is not uploaded to any service for cleanup. No API keys, no env vars, no model download, no cost.
- No new runtime dependencies. `tsx` was added as a **dev-only** dependency to run the Node unit tests. No new licence obligations (the GPL note in the video docs applies to the video engine only).
- Supabase: saving uses the existing private bucket and `files` table. Migration `supabase/migrations/20261122_cleanup_edit_kind.sql` allows `edit_kind = 'cleanup'`. The row stores `source_file_id` (lineage) and `edit_params` (engine, version, `ai:false`, per-pass strokes/mask size/region/iterations/timing). RLS is unchanged.
- Intended for cleaning up content you own or are authorised to modify, not for removing third-party copyright or attribution marks.

## Optional upgrade path (not implemented)
A neural inpainting model (e.g. LaMa exported to ONNX, ~200 MB, run with onnxruntime-web/WebGPU) would handle large structural regions better. Trade-offs: large first download, slower on weak devices, model licence review, or, if hosted, a paid GPU service plus uploading user images (privacy disclosure required). Not enabled; nothing here depends on it.

## Tests
- `npm run test:inpaint` – 47 core checks (mask, brush sizes, undo/redo, success, outside-pixels identical, failures, cancel, determinism).
- `node tests/ui-e2e.test.mjs` (after `npm run build`) – production build in headless Chrome: brush, eraser, size, undo/redo, zoom, reconstruct, compare, apply/discard, export validity (PIL), saved lineage, failure message, 390 px mobile layout with touch painting. Supabase is a mock there.
- `scripts/storage-security-test.mjs` (GitHub Actions `storage-security-test.yml`) – real Supabase: cleanup lineage, cross-account isolation, limits.
- `tests/sql/cleanup-rules.sql` – rolled-back DB rules test (run in the Supabase SQL editor).
