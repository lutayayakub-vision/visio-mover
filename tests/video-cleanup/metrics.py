#!/usr/bin/env python3
"""Metrics for judging video-cleanup results against exact ground truth. Library + CLI.

Two gate families: evaluate_raw() for pre-encode frames (exact guarantees) and evaluate() for the final MP4 (coarse, per-scenario calibrated codec floors).

  python3 tests/video-cleanup/metrics.py evaluate --scenario static_logo --result out.mp4 [--margin 16]

Every function takes plain numpy arrays (N,H,W,3 uint8 frames; N,H,W bool masks) so pipeline tests can feed either decoded MP4
frames or raw pre-encode frames. Post-encode limits come from calibration.json (see calibrate.py); RAW_FLICKER_MAX is provisional until Milestone 4.
"""
from __future__ import annotations
import argparse, hashlib, json, os, subprocess, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import scenarios as S

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "video-cleanup")
EVAL_DILATE = 2  # px; soft sprite edges (alpha < 0.5) fall just outside the mask and are excluded from "outside" checks


# ───────────────────────── I/O ─────────────────────────
def run(cmd):
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {p.stderr.decode(errors='replace')[:400]}")
    return p.stdout


def probe(path):
    j = json.loads(run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path]))
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    num, den = (int(x) for x in v["r_frame_rate"].split("/"))
    return {
        "w": int(v["width"]), "h": int(v["height"]), "fps": num / den, "frames": int(v["nb_read_frames"]),
        "vcodec": v["codec_name"], "duration": float(j["format"]["duration"]),
        "audio": None if a is None else {"codec": a["codec_name"], "rate": int(a["sample_rate"]), "channels": int(a["channels"]), "duration": float(a.get("duration", 0))},
    }


def decode_frames(path) -> np.ndarray:
    pr = probe(path)
    raw = run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    return np.frombuffer(raw, np.uint8).reshape(-1, pr["h"], pr["w"], 3)


def audio_md5(path):
    out = run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"]).decode().strip()
    return out.split("=", 1)[1] if "=" in out else out


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def reencode_reference(src, dst, crf=23):
    """Re-encode the ORIGINAL with the app's x264 settings, so lossy-codec differences can be separated from real damage."""
    run(["ffmpeg", "-y", "-v", "error", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
         "-x264-params", "threads=1", "-c:a", "copy", "-movflags", "+faststart", dst])
    return dst


def encode_like_app(frames, dst, crf=23, fps=S.FPS):
    """Encode raw frames with exactly the settings reencode_reference uses (video only)."""
    n, h, w, _ = frames.shape
    p = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-x264-params", "threads=1", "-movflags", "+faststart", dst],
                         stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("encode failed")
    return dst


# ───────────────────────── metrics ─────────────────────────
def _sel(a, mask):
    return a[mask] if mask is not None else a.reshape(-1, a.shape[-1])


def mae(a, b, mask=None):
    d = np.abs(_sel(a.astype(np.int16), mask) - _sel(b.astype(np.int16), mask))
    return float(d.mean()) if d.size else 0.0


def psnr(a, b, mask=None):
    d = (_sel(a.astype(np.float64), mask) - _sel(b.astype(np.float64), mask)) ** 2
    m = float(d.mean()) if d.size else 0.0
    return 99.0 if m == 0 else float(10 * np.log10(255.0 ** 2 / m))


def red_count(frames, mask):
    f = frames[mask] if mask is not None else frames.reshape(-1, 3)
    return int(((f[:, 0] > 200) & (f[:, 1] < 80) & (f[:, 2] < 80)).sum())


def object_removal(inp, res, truth, mask, dilate=EVAL_DILATE):
    """How much of the object is gone, measured two ways. residual_ratio: error vs truth inside the region, relative to doing nothing
    (0 = perfect, 1 = nothing changed). red_remaining: fraction of the original red pixels still red (bright scenes only)."""
    m = S.dilate(mask, dilate)
    ei, er = mae(inp, truth, m), mae(res, truth, m)
    r0 = red_count(inp, m)
    return {"mae_input": ei, "mae_result": er, "residual_ratio": er / ei if ei else 0.0,
            "red_remaining": (red_count(res, m) / r0) if r0 else None, "psnr_inside": psnr(res, truth, m)}


def outside_identity(ref, res, mask, margin=0, dilate=EVAL_DILATE):
    """Pixels outside (dilated mask + margin): how many differ from the reference? Use margin=0 with RAW (pre-encode) frames
    for the exact-copy guarantee; use margin>=16 and psnr_outside for decoded lossy output."""
    out = ~S.dilate(mask, dilate + margin)
    diff = np.abs(ref.astype(np.int16) - res.astype(np.int16)).max(-1)
    bad = (diff > 0) & out
    return {"checked_pixels": int(out.sum()), "differing_pixels": int(bad.sum()),
            "identical_fraction": 1.0 - float(bad.sum()) / max(1, int(out.sum())),
            "max_abs_diff": int(diff[out].max()) if out.any() else 0, "psnr_outside": psnr(ref, res, out)}


def flicker(res, truth, mask, dilate=EVAL_DILATE):
    """Temporal stability inside the region, relative to how the TRUE background changes: mean |(res_t - res_t-1) - (truth_t - truth_t-1)|.
    0 = same temporal behaviour as the real background. A constant colour error scores 0 (stable but wrong), per-frame noise scores high."""
    m = S.dilate(mask, dilate)
    both = m[1:] & m[:-1]
    dr = res[1:].astype(np.int16) - res[:-1].astype(np.int16)
    dt = truth[1:].astype(np.int16) - truth[:-1].astype(np.int16)
    ex = np.abs(dr - dt)[both]
    inst = np.abs(dr)[both]
    return {"excess": float(ex.mean()) if ex.size else 0.0, "temporal_mae_result": float(inst.mean()) if inst.size else 0.0,
            "temporal_mae_truth": float(np.abs(dt)[both].mean()) if ex.size else 0.0, "pixels": int(both.sum())}


def av_parity(src, res, expect_audio_copy=True, dur_tol=0.1):
    a, b = probe(src), probe(res)
    f = []
    if a["frames"] != b["frames"]: f.append(f"frame count {a['frames']} -> {b['frames']}")
    if abs(a["fps"] - b["fps"]) > 1e-3: f.append(f"fps {a['fps']} -> {b['fps']}")
    if (a["w"], a["h"]) != (b["w"], b["h"]): f.append(f"size {a['w']}x{a['h']} -> {b['w']}x{b['h']}")
    if abs(a["duration"] - b["duration"]) > dur_tol: f.append(f"duration {a['duration']:.3f} -> {b['duration']:.3f}")
    if (a["audio"] is None) != (b["audio"] is None): f.append("audio track " + ("lost" if b["audio"] is None else "appeared"))
    elif a["audio"]:
        if a["audio"]["rate"] != b["audio"]["rate"] or a["audio"]["channels"] != b["audio"]["channels"]: f.append("audio format changed")
        if expect_audio_copy:
            if a["audio"]["codec"] != b["audio"]["codec"]: f.append("audio codec changed")
            elif audio_md5(src) != audio_md5(res): f.append("audio data changed")
    return {"ok": not f, "failures": f, "src": a, "res": b}


def track_error(pred, meta):
    """pred: list of [x,y] or None per frame. Error only where the object is visible in the ground truth."""
    errs = []
    for p, c, box in zip(pred, meta["centre"], meta["bbox"]):
        if box is None or p is None or c is None:
            continue
        errs.append(float(np.hypot(p[0] - c[0], p[1] - c[1])))
    e = np.array(errs) if errs else np.zeros(1)
    return {"n": len(errs), "mean": float(e.mean()), "max": float(e.max()), "p95": float(np.percentile(e, 95))}


# ───────────────────────── scenario evaluation ─────────────────────────
CAL_PATH = os.path.join(os.path.dirname(__file__), "calibration.json")
OUTSIDE_PSNR_MARGIN_DB = 3.0
RESIDUAL_MAX = 0.35        # removal: error vs truth inside the region must be <= 35% of doing nothing
RED_REMAINING_MAX = 0.02
# strict gates for RAW (pre-encode) frames: no codec in the loop, so the guarantees are exact
RAW_FLICKER_MAX = 1.5      # PROVISIONAL, recalibrated in Milestone 4 on real pipeline output


def load_calibration():
    if not os.path.exists(CAL_PATH):
        raise RuntimeError("calibration.json missing: run tests/video-cleanup/calibrate.py (post-encode gates need per-scenario codec floors)")
    return json.load(open(CAL_PATH))


def evaluate(scenario, result_path, margin=16, crf=23, calibrating=False):
    """crf must be the CRF the pipeline used for the result. Two codec-matched references are built from it:
      - the ORIGINAL re-encoded with the same settings  -> "outside the mask" damage is measured against this
      - the lossless TRUTH re-encoded with the same settings -> flicker is measured against this, so codec noise on moving
        content (which any cleaner suffers) is not blamed on the algorithm. Removal is measured against the lossless truth."""
    meta = json.load(open(os.path.join(FIXTURES, scenario, "meta.json")))
    src = os.path.join(FIXTURES, scenario, "input.mp4")
    inp_raw, truth, mask = S.render_all(scenario)
    res = decode_frames(result_path)
    ref_path = reencode_reference(src, result_path + ".ref.mp4", crf)
    ref = decode_frames(ref_path)
    os.remove(ref_path)
    tref_path = encode_like_app(truth, result_path + ".truth.mp4", crf)
    truth_ref = decode_frames(tref_path)
    os.remove(tref_path)
    n = min(len(res), len(inp_raw))
    out = {"scenario": scenario, "frames_compared": n,
           "removal": object_removal(inp_raw[:n], res[:n], truth[:n], mask[:n]),
           "outside_vs_reencoded_original": outside_identity(ref[:n], res[:n], mask[:n], margin=margin),
           "flicker": flicker(res[:n], truth_ref[:n], mask[:n]),
           "flicker_vs_lossless_truth": flicker(res[:n], truth[:n], mask[:n]),
           "av": av_parity(src, result_path, expect_audio_copy=meta["audio"])}
    if calibrating:
        return out
    cal = load_calibration()["scenarios"][scenario]
    out["limits"] = {"residual_max": RESIDUAL_MAX, "red_remaining_max": RED_REMAINING_MAX,
                     "outside_psnr_min": cal["perfect_outside_psnr"] - OUTSIDE_PSNR_MARGIN_DB, "flicker_max": 2 * cal["bias_flicker"] + 0.5}
    L = out["limits"]
    out["pass"] = {
        "removed": out["removal"]["residual_ratio"] <= L["residual_max"],
        "red_gone": out["removal"]["red_remaining"] is None or out["removal"]["red_remaining"] <= L["red_remaining_max"],
        "outside_ok": out["outside_vs_reencoded_original"]["psnr_outside"] >= L["outside_psnr_min"],
        "stable": out["flicker"]["excess"] <= L["flicker_max"], "av_ok": out["av"]["ok"]}
    return out


def evaluate_raw(scenario, result_frames):
    """Strict gate for the pipeline's RAW composited frames (before encoding): exact outside-copy, removal, flicker."""
    inp, truth, mask = S.render_all(scenario)
    n = min(len(inp), len(result_frames)); r = result_frames[:n]
    out = {"scenario": scenario, "frames": n, "removal": object_removal(inp[:n], r, truth[:n], mask[:n]),
           "outside": outside_identity(inp[:n], r, mask[:n]), "flicker": flicker(r, truth[:n], mask[:n])}
    out["pass"] = {"all_frames": n == len(inp), "removed": out["removal"]["residual_ratio"] <= RESIDUAL_MAX,
                   "red_gone": out["removal"]["red_remaining"] is None or out["removal"]["red_remaining"] <= RED_REMAINING_MAX,
                   "outside_exact": out["outside"]["differing_pixels"] == 0, "stable": out["flicker"]["excess"] <= RAW_FLICKER_MAX}
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("evaluate"); e.add_argument("--scenario", required=True); e.add_argument("--result", required=True); e.add_argument("--margin", type=int, default=16); e.add_argument("--crf", type=int, default=23)
    a = ap.parse_args()
    print(json.dumps(evaluate(a.scenario, a.result, a.margin, a.crf), indent=1, default=str))
