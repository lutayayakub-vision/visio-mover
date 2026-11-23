#!/usr/bin/env python3
"""Measure the codec floor for each scenario with REFERENCE cleaners, and write calibration.json.

Reference cleaners (all encoded exactly like the app encodes, crf 23 veryfast):
  perfect : the lossless truth                       -> floor of 'outside' PSNR (codec propagation, noise, motion)
  bias    : truth + 20 levels inside the object      -> a stable-but-imperfect fill: the best flicker an imperfect cleaner can show through the codec
evaluate() then gates a real cleaner against these per-scenario numbers (outside PSNR >= perfect - 3 dB, flicker <= 2*bias + 0.5).
Re-run after changing ffmpeg/x264 versions or scenarios:   python3 tests/video-cleanup/calibrate.py [scenario]
"""
import json, os, subprocess, sys, tempfile, shutil
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import scenarios as S, metrics as M

def main(only=None):
    path = os.path.join(os.path.dirname(__file__), "calibration.json")
    tmp = tempfile.mkdtemp(); out = json.load(open(path))["scenarios"] if only and os.path.exists(path) else {}
    for n in ([only] if only else S.names()):
        inp, truth, mask = S.render_all(n); dm = S.dilate(mask, M.EVAL_DILATE)
        res = {}
        for name, frames in (("perfect", truth), ("bias", np.where(dm[..., None], np.clip(truth.astype(int) + S.get(n).bias_level, 0, 255), truth).astype(np.uint8))):
            p = os.path.join(tmp, f"{n}-{name}.mp4"); M.encode_like_app(frames, p)
            e = M.evaluate(n, p, calibrating=True)
            res[name] = {"outside_psnr": e["outside_vs_reencoded_original"]["psnr_outside"], "flicker": e["flicker"]["excess"], "residual": e["removal"]["residual_ratio"], "truth_motion": e["flicker"]["temporal_mae_truth"]}
        out[n] = {"perfect_outside_psnr": round(res["perfect"]["outside_psnr"], 2), "bias_flicker": round(res["bias"]["flicker"], 3),
                  "bias_residual": round(res["bias"]["residual"], 3), "truth_motion": round(res["perfect"]["truth_motion"], 3)}
        print(n, out[n], flush=True)
    ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    json.dump({"ffmpeg": ver, "crf": 23, "rules": "outside_psnr >= perfect_outside_psnr - 3 ; flicker <= 2*bias_flicker + 0.5 (bias fill = truth + bias_level inside the object)", "scenarios": out},
              open(path, "w"), indent=1)
    shutil.rmtree(tmp)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
