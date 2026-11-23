# Stage 2 video-cleanup test harness (Milestone 1)

Synthetic clips with exact ground truth + metrics, so later milestones are judged by numbers, not by eye.

| File | Purpose |
|---|---|
| `scenarios.py` | 7 deterministic scenarios (static logo on scrolling scene, moving object, camera pan, shot cut, occlusion/exit/re-entry, low-light noise, 150-frame long track). `render(t)` returns input, truth (no object) and mask. |
| `gen.py` | writes `tests/fixtures/video-cleanup/<scenario>/{input.mp4,meta.json}` (H.264 + AAC, 640×360 @ 30 fps). Truth/mask are re-rendered on demand (`--export-truth` dumps PNGs). |
| `metrics.py` | object removal, outside-mask identity, flicker vs true background dynamics, A/V parity (frames, fps, size, duration, audio bit-identity), SHA-256, tracker error. `evaluate_raw()` = strict gates for pre-encode frames; `evaluate()` = gates for the final MP4 using per-scenario codec floors. |
| `calibrate.py` / `calibration.json` | measured codec floors (re-run if ffmpeg/x264 changes) |
| `selftest.py` | the Milestone 1 gate: validates clips and metrics before any cleanup code exists |

Run: `npm run test:vc-harness` (needs ffmpeg, ffprobe, numpy, Pillow; ≈4 min).
