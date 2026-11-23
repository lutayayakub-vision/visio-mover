#!/usr/bin/env python3
"""Generate the Stage 2 synthetic clips.

  python3 tests/video-cleanup/gen.py                 -> tests/fixtures/video-cleanup/<scenario>/{input.mp4,meta.json}
  python3 tests/video-cleanup/gen.py --only static_logo
  python3 tests/video-cleanup/gen.py --export-truth static_logo --out DIR   (lossless truth/mask PNG sequences for debugging)

Truth frames and masks are NOT stored: they are re-rendered from (scenario, frame) on demand, so fixtures stay small and cannot drift.
"""
import argparse, json, os, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import scenarios as S

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "tests", "fixtures", "video-cleanup")
X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-x264-params", "threads=1:bframes=0", "-g", "30", "-movflags", "+faststart"]


def encode(frames_iter, w, h, fps, out_path, audio_freq=None, n_frames=None):
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
    if audio_freq:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency={audio_freq}:sample_rate=44100:duration={n_frames / fps}"]
    cmd += X264
    if audio_freq:
        cmd += ["-c:a", "aac", "-b:a", "96k", "-ac", "2", "-shortest"]
    cmd += [out_path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames_iter:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit("ffmpeg failed")


def build(name, out_root=OUT):
    sc = S.get(name)
    d = os.path.join(out_root, name)
    os.makedirs(d, exist_ok=True)
    inp, truth, mask = S.render_all(name)
    idx = S.names().index(name)
    encode(inp, S.W, S.H, S.FPS, os.path.join(d, "input.mp4"), audio_freq=(300 + 60 * idx) if sc.audio else None, n_frames=sc.frames)
    centres, boxes, areas = [], [], []
    for t in range(sc.frames):
        c = sc.centre(t)
        centres.append([round(float(c[0]), 3), round(float(c[1]), 3)] if c else None)
        ys, xs = np.nonzero(mask[t])
        areas.append(int(mask[t].sum()))
        boxes.append([int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None)
    meta = {
        "name": name, "w": S.W, "h": S.H, "fps": S.FPS, "frames": sc.frames, "audio": sc.audio,
        "audio_freq": (300 + 60 * idx) if sc.audio else None,
        "camera_motion": sc.camera_motion, "bg_velocity": list(sc.bg_velocity), "cuts": list(sc.cuts),
        "noise_sigma": sc.noise_sigma(), "notes": sc.notes,
        "centre": centres, "bbox": boxes, "mask_area": areas,
        "reveal": S.reveal_stats(sc, mask),
        "static_plate_valid": (not sc.camera_motion) and sc.bg_velocity == (0, 0),
        "sha256_raw_input": S.sha(inp), "sha256_raw_truth": S.sha(truth), "sha256_raw_mask": S.sha(mask),
    }
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    return d, meta


def export_truth(name, out):
    from PIL import Image
    inp, truth, mask = S.render_all(name)
    os.makedirs(out, exist_ok=True)
    for t in range(len(inp)):
        Image.fromarray(truth[t]).save(os.path.join(out, f"truth_{t:04d}.png"))
        Image.fromarray(inp[t]).save(os.path.join(out, f"input_{t:04d}.png"))
        Image.fromarray((mask[t] * 255).astype(np.uint8)).save(os.path.join(out, f"mask_{t:04d}.png"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only"); ap.add_argument("--export-truth"); ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    if a.export_truth:
        export_truth(a.export_truth, a.out); print("exported", a.export_truth, "->", a.out); sys.exit(0)
    for n in ([a.only] if a.only else S.names()):
        d, m = build(n, a.out)
        print(f"{n}: {m['frames']} frames, audio={m['audio']}, reveal static={m['reveal']['static']:.2f} motion={m['reveal']['motion_compensated']:.2f} -> {d}")
