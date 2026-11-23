#!/usr/bin/env python3
"""Milestone 1 gate: proves the clips and the metrics themselves are trustworthy BEFORE any cleanup code exists.
Run: python3 tests/video-cleanup/selftest.py     (needs ffmpeg/ffprobe, numpy, Pillow)   Exit code 1 if any check fails."""
import json, os, shutil, subprocess, sys, tempfile, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import scenarios as S, metrics as M, gen

total = bad = 0
def check(name, cond, detail=""):
    global total, bad
    total += 1; bad += (not cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'  [' + str(detail) + ']' if detail != '' else ''}", flush=True)

def ff(*args):
    M.run(["ffmpeg", "-y", "-v", "error", *args])

t_start = time.time()
tmp = tempfile.mkdtemp(prefix="vc-selftest-")
try:
    # ───── 1. generation, determinism, container facts ─────
    print("== 1. clips: generation and determinism ==")
    meta = {}
    for n in S.names():
        d, m = gen.build(n)
        meta[n] = m
    for n in S.names():
        m = meta[n]; p = M.probe(os.path.join(gen.OUT, n, "input.mp4"))
        check(f"{n}: MP4 is {m['w']}x{m['h']} @ {m['fps']} fps, {m['frames']} frames, h264", (p["w"], p["h"], p["fps"], p["frames"], p["vcodec"]) == (m["w"], m["h"], m["fps"], m["frames"], "h264"), f"{p['w']}x{p['h']} {p['fps']} {p['frames']}f")
        check(f"{n}: audio track {'present (aac)' if m['audio'] else 'absent'} as declared", (p["audio"] is not None) == m["audio"] and (not m["audio"] or p["audio"]["codec"] == "aac"))
    check("scenario set covers static overlay, moving object, camera pan, shot cut, occlusion, low-light noise, long track, with and without audio",
          set(S.names()) == {"static_logo", "moving_object", "camera_pan", "shot_cut", "occlusion", "lowlight_noise", "long_track"} and any(not m["audio"] for m in meta.values()) and any(m["audio"] for m in meta.values()))
    for n in S.names():
        i1, t1, m1 = S.render_all(n); i2, t2, m2 = S.render_all(n)
        check(f"{n}: rendering twice gives bit-identical input/truth/mask frames", S.sha(i1) == S.sha(i2) and S.sha(t1) == S.sha(t2) and S.sha(m1) == S.sha(m2) and S.sha(i1) == meta[n]["sha256_raw_input"])
    d2 = os.path.join(tmp, "regen"); gen.build("static_logo", d2)
    a1 = M.decode_frames(os.path.join(gen.OUT, "static_logo", "input.mp4")); a2 = M.decode_frames(os.path.join(d2, "static_logo", "input.mp4"))
    check("regenerating a clip gives identical decoded frames (encode is deterministic)", S.sha(a1) == S.sha(a2))
    check("regenerated audio is identical too", M.audio_md5(os.path.join(gen.OUT, "static_logo", "input.mp4")) == M.audio_md5(os.path.join(d2, "static_logo", "input.mp4")))

    # ───── 2. ground truth is internally consistent ─────
    print("== 2. ground truth consistency ==")
    R = {n: S.render_all(n) for n in S.names()}
    for n in S.names():
        inp, truth, mask = R[n]
        dm = S.dilate(mask, M.EVAL_DILATE)
        diff = np.abs(inp.astype(np.int16) - truth.astype(np.int16)).max(-1)
        check(f"{n}: input equals truth everywhere outside the (dilated) object mask", int(((diff > 0) & ~dm).sum()) == 0, f"{int(((diff > 0) & ~dm).sum())} stray px")
        has = mask.reshape(len(mask), -1).any(1)
        inside_changed = (diff > 0)[mask].mean() if mask.any() else 0
        check(f"{n}: object visibly differs from the true background inside the mask (>=95% of px)", inside_changed >= 0.95, f"{inside_changed:.3f}")
        if n != "lowlight_noise":
            check(f"{n}: the clean truth contains no red (red == object, unambiguous)", M.red_count(truth, None) == 0)
            check(f"{n}: the input does contain the red object", M.red_count(inp, mask) > 0 if has.any() else False)
    check("static_logo: logo mask identical in every frame (fixed overlay)", len({m.tobytes() for m in R['static_logo'][2]}) == 1)
    check("static_logo: scene really scrolls 3 px/frame (truth[t+1] == truth[t] shifted)", all(np.array_equal(R['static_logo'][1][t + 1][:, :-3], R['static_logo'][1][t][:, 3:]) for t in range(0, 89, 7)))
    check("camera_pan: whole frame pans (2,1) px/frame exactly (limitation case is a true global motion)", all(np.array_equal(R['camera_pan'][1][t + 1][:-1, :-2], R['camera_pan'][1][t][1:, 2:]) for t in range(0, 89, 7)))
    tr = R["shot_cut"][1]
    d_cut = np.abs(tr[45].astype(int) - tr[44].astype(int)).mean(); d_norm = np.abs(tr[30].astype(int) - tr[29].astype(int)).mean()
    check("shot_cut: truth jumps hard at frame 45 and is static elsewhere", d_cut > 20 and d_norm == 0, f"cut {d_cut:.1f}, normal {d_norm:.1f}")
    ar = meta["occlusion"]["mask_area"]
    check("occlusion: object is fully hidden/out of frame in some frames, partly hidden in others, fully visible in others",
          ar.count(0) >= 10 and any(0 < a < 0.7 * max(ar) for a in ar) and max(ar) > 2500, f"hidden {ar.count(0)} frames, max area {max(ar)}")
    trn = R["lowlight_noise"][1]
    check("lowlight_noise: real temporal noise (truth changes frame to frame by ~sigma) and dark scene", 6 < np.abs(trn[11].astype(int) - trn[10].astype(int)).mean() < 14 and trn.mean() < 60, f"{np.abs(trn[11].astype(int) - trn[10].astype(int)).mean():.1f} / mean {trn.mean():.0f}")
    lt = np.array(meta["long_track"]["centre"]); step = np.hypot(*np.diff(lt, axis=0).T)
    check("long_track: 150 frames, smooth sub-pixel motion (not integer steps), speed 1-9 px/frame", meta["long_track"]["frames"] == 150 and 1 < step.mean() < 9 and not np.allclose(lt, np.round(lt)), f"mean step {step.mean():.2f}")
    rv = {n: meta[n]["reveal"] for n in S.names()}
    check("reveal: moving object over static background uncovers the background elsewhere (>=95%)", rv["moving_object"]["static"] >= 0.95, rv["moving_object"]["static"])
    check("reveal: FIXED overlay on a scrolling scene is NEVER revealed at the same screen pixel (static plate = 0)...", rv["static_logo"]["static"] == 0.0, rv["static_logo"]["static"])
    check("reveal: ...but IS revealed when the scene motion is followed (motion-compensated >= 95%)", rv["static_logo"]["motion_compensated"] >= 0.95, rv["static_logo"]["motion_compensated"])
    check("reveal: camera pan with a world-fixed object is never revealed even when motion-compensated (<=20%)", rv["camera_pan"]["motion_compensated"] <= 0.2, rv["camera_pan"]["motion_compensated"])
    check("meta: static-plate validity flag only true for truly static scenes", [n for n in S.names() if meta[n]["static_plate_valid"]] == ["moving_object", "shot_cut", "occlusion", "lowlight_noise", "long_track"])

    # ───── 3. metrics behave correctly on known results ─────
    print("== 3. metrics validated on results with known quality ==")
    inp, truth, mask = R["moving_object"]
    perfect = M.object_removal(inp, truth, truth, mask)
    check("perfect result (= truth): residual 0, no red left, PSNR inside 99", perfect["residual_ratio"] == 0 and perfect["red_remaining"] == 0 and perfect["psnr_inside"] == 99.0)
    nothing = M.object_removal(inp, inp, truth, mask)
    check("do-nothing result: residual 1.0 and all red still present", abs(nothing["residual_ratio"] - 1) < 1e-9 and nothing["red_remaining"] == 1.0)
    flat = truth.copy(); flat[S.dilate(mask, M.EVAL_DILATE)] = 128
    fl = M.object_removal(inp, flat, truth, mask)
    check("flat-grey fill: red is gone but residual error is clearly worse than perfect (metrics separate 'removed' from 'good')", fl["red_remaining"] == 0 and 0.05 < fl["residual_ratio"] < 1.0, f"residual {fl['residual_ratio']:.2f}")
    check("ranking: perfect < flat fill < do nothing", perfect["residual_ratio"] < fl["residual_ratio"] < nothing["residual_ratio"])
    bias = truth.copy(); bias[S.dilate(mask, M.EVAL_DILATE)] = np.clip(bias[S.dilate(mask, M.EVAL_DILATE)].astype(int) + 20, 0, 255).astype(np.uint8)
    noisy = truth.copy(); dm = S.dilate(mask, M.EVAL_DILATE)
    for t in range(len(noisy)):
        n = S.rng(5, t).integers(-25, 26, noisy[t].shape).astype(int)
        noisy[t][dm[t]] = np.clip(noisy[t][dm[t]].astype(int) + n[dm[t]], 0, 255).astype(np.uint8)
    fb, fn, f0 = M.flicker(bias, truth, mask), M.flicker(noisy, truth, mask), M.flicker(truth, truth, mask)
    check("flicker metric: truth scores exactly 0", f0["excess"] == 0.0)
    check("flicker metric: a constant colour error (stable but wrong) scores ~0 flicker", fb["excess"] < 0.05, f"{fb['excess']:.3f}")
    check("flicker metric: per-frame random error scores high (>=5x the constant-error case and >5 levels)", fn["excess"] > 5 and fn["excess"] > 5 * max(fb["excess"], 0.01), f"{fn['excess']:.2f}")
    check("...while the same constant error still shows up in the removal metric (wrong but stable)", M.object_removal(inp, bias, truth, mask)["residual_ratio"] > 0.1)
    tam = truth.copy(); out = ~S.dilate(mask, 6)
    ys, xs = np.nonzero(out[10]); pts = list(zip(ys[:7], xs[:7]))
    for (y, x) in pts: tam[10, y, x, 0] = (int(tam[10, y, x, 0]) + 9) % 256
    oi = M.outside_identity(truth, tam, mask)
    check("outside-identity: untouched result is 100% identical outside the mask", M.outside_identity(truth, truth, mask)["differing_pixels"] == 0 and M.outside_identity(truth, truth, mask)["identical_fraction"] == 1.0)
    check("outside-identity: exactly 7 tampered pixels are detected, with the right max difference", oi["differing_pixels"] == 7 and oi["max_abs_diff"] == 9 and oi["identical_fraction"] < 1.0, f"{oi['differing_pixels']} px, max {oi['max_abs_diff']}")
    ins = truth.copy(); ins[S.dilate(mask, 0)] = 0
    check("outside-identity: changes INSIDE the mask are not counted as outside damage", M.outside_identity(truth, ins, mask)["differing_pixels"] == 0)
    check("track_error: perfect centres give 0; a (3,4) offset gives exactly 5; hidden frames are skipped",
          M.track_error([c for c in meta["occlusion"]["centre"]], meta["occlusion"])["max"] == 0
          and abs(M.track_error([[c[0] + 3, c[1] + 4] for c in meta["long_track"]["centre"]], meta["long_track"])["mean"] - 5) < 1e-6
          and M.track_error(meta["occlusion"]["centre"], meta["occlusion"])["n"] == sum(1 for b in meta["occlusion"]["bbox"] if b), "")
    check("track_error: a tracker that drifts 0.1 px/frame is measured as ~7.5 px mean over 150 frames",
          abs(M.track_error([[c[0] + 0.1 * t, c[1]] for t, c in enumerate(meta["long_track"]["centre"])], meta["long_track"])["mean"] - 7.45) < 0.1)

    # ───── 4. audio/video parity tools ─────
    print("== 4. audio/video parity and file-integrity tools ==")
    src = os.path.join(gen.OUT, "static_logo", "input.mp4")
    check("parity: a file compared with itself passes", M.av_parity(src, src)["ok"])
    p1 = os.path.join(tmp, "trim.mp4"); ff("-i", src, "-t", "2", "-c", "copy", p1)
    r = M.av_parity(src, p1); check("parity: a trimmed copy is flagged (frames + duration)", not r["ok"] and any("frame count" in f for f in r["failures"]) and any("duration" in f for f in r["failures"]), r["failures"])
    p2 = os.path.join(tmp, "fps.mp4"); ff("-i", src, "-r", "15", "-c:v", "libx264", "-c:a", "copy", p2)
    r = M.av_parity(src, p2); check("parity: changed frame rate is flagged", any("fps" in f for f in r["failures"]), r["failures"])
    p3 = os.path.join(tmp, "noaudio.mp4"); ff("-i", src, "-an", "-c:v", "copy", p3)
    r = M.av_parity(src, p3); check("parity: dropped audio track is flagged", any("audio track lost" in f for f in r["failures"]), r["failures"])
    p4 = os.path.join(tmp, "audio-reenc.mp4"); ff("-i", src, "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", p4)
    r = M.av_parity(src, p4); check("parity: re-encoded audio is flagged as changed data", any("audio data changed" in f for f in r["failures"]), r["failures"])
    p5 = os.path.join(tmp, "copyaudio.mp4"); ff("-i", src, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", p5)
    r = M.av_parity(src, p5); check("parity: video re-encoded but audio copied untouched PASSES (audio bit-identical, frames/fps/size equal)", r["ok"], r["failures"])
    p6 = os.path.join(tmp, "small.mp4"); ff("-i", src, "-vf", "scale=320:180", "-c:v", "libx264", "-c:a", "copy", p6)
    r = M.av_parity(src, p6); check("parity: changed resolution is flagged", any("size" in f for f in r["failures"]), r["failures"])
    nsrc = os.path.join(gen.OUT, "moving_object", "input.mp4")
    check("parity: a silent clip compared with itself passes (no phantom audio)", M.av_parity(nsrc, nsrc)["ok"])
    cp = os.path.join(tmp, "copy.mp4"); shutil.copyfile(src, cp)
    check("sha256: identical copy has the same digest", M.sha256_file(src) == M.sha256_file(cp))
    with open(cp, "r+b") as f: f.seek(5000); b = f.read(1); f.seek(5000); f.write(bytes([b[0] ^ 1]))
    check("sha256: a single flipped bit changes the digest (byte-for-byte original check is sensitive)", M.sha256_file(src) != M.sha256_file(cp))

    # ───── 5. strict gates on RAW (pre-encode) frames: exact guarantees ─────
    print("== 5. raw-frame gates (what Milestone 4 will use before encoding) ==")
    for n in ["moving_object", "static_logo", "lowlight_noise"]:
        inp, truth, mask = R[n]; dm = S.dilate(mask, M.EVAL_DILATE)
        ok_ = M.evaluate_raw(n, truth)
        check(f"{n}: raw gate passes a perfect cleaner (residual 0, outside exact, flicker 0)", all(ok_["pass"].values()) and ok_["flicker"]["excess"] == 0, ok_["pass"])
        bias_f = np.where(dm[..., None], np.clip(truth.astype(int) + S.get(n).bias_level, 0, 255), truth).astype(np.uint8)
        e = M.evaluate_raw(n, bias_f)
        check(f"{n}: raw gate passes a stable-but-imperfect fill (truth + bias_level) with exactly 0 flicker", all(e["pass"].values()) and e["flicker"]["excess"] == 0, e["pass"])
        noisy_f = truth.copy()
        for t in range(len(noisy_f)):
            nn = S.rng(6, t).integers(-30, 31, noisy_f[t].shape).astype(int)
            noisy_f[t][dm[t]] = np.clip(noisy_f[t][dm[t]].astype(int) + nn[dm[t]], 0, 255).astype(np.uint8)
        e = M.evaluate_raw(n, noisy_f)
        check(f"{n}: raw gate FAILS per-frame random fill on stability only (outside still exact)", not e["pass"]["stable"] and e["pass"]["outside_exact"], f"flicker {e['flicker']['excess']:.1f}")
        one = truth.copy(); y, x = np.argwhere(~S.dilate(mask[5], 6))[0]; one[5, y, x, 1] ^= 1
        e = M.evaluate_raw(n, one)
        check(f"{n}: raw gate FAILS when a single pixel outside the object differs by 1 level", not e["pass"]["outside_exact"] and e["outside"]["differing_pixels"] == 1, e["outside"]["differing_pixels"])
        e = M.evaluate_raw(n, inp)
        check(f"{n}: raw gate FAILS a do-nothing result (object still there)", not e["pass"]["removed"] and not (e["pass"]["red_gone"] and n != "lowlight_noise"))
        e = M.evaluate_raw(n, truth[:-3])
        check(f"{n}: raw gate FAILS a result with missing frames", not e["pass"]["all_frames"])

    # ───── 6. the whole evaluate() path on the final MP4, with a lossy codec in the loop ─────
    print("== 6. end-to-end evaluate() on MP4 output (codec in the loop, per-scenario calibrated limits) ==")
    cal = M.load_calibration()
    check("calibration.json exists, covers every scenario and records the ffmpeg build it was measured with", set(cal["scenarios"]) == set(S.names()) and "ffmpeg" in cal, cal["ffmpeg"][:40])
    def make_result(n, frames, name):
        """a cleaner's output: frames encoded the way the app encodes (crf 23), original audio copied"""
        sc = meta[n]; mp = os.path.join(tmp, f"{n}-{name}-v.mp4"); M.encode_like_app(frames, mp)
        out = os.path.join(tmp, f"{n}-{name}.mp4")
        ff("-i", mp, "-i", os.path.join(gen.OUT, n, "input.mp4"), "-map", "0:v:0", *(["-map", "1:a:0"] if sc["audio"] else []), "-c", "copy", out)
        return out
    for n in ["moving_object", "static_logo", "lowlight_noise"]:
        inp, truth, mask = R[n]; dm = S.dilate(mask, M.EVAL_DILATE); c = cal["scenarios"][n]
        e = M.evaluate(n, make_result(n, truth, "perfect"))
        num = {k: round(v, 2) for k, v in {"outside_psnr": e["outside_vs_reencoded_original"]["psnr_outside"], "limit_psnr": e["limits"]["outside_psnr_min"], "flicker": e["flicker"]["excess"], "limit_flicker": e["limits"]["flicker_max"], "residual": e["removal"]["residual_ratio"]}.items()}
        check(f"{n}: a perfect cleaner (truth, app-style encode, audio copied) passes every post-encode gate", all(e["pass"].values()), json.dumps(num))
        check(f"{n}: calibration.json still matches this machine's ffmpeg (outside PSNR within 0.2 dB)", abs(e["outside_vs_reencoded_original"]["psnr_outside"] - c["perfect_outside_psnr"]) < 0.2, f"{e['outside_vs_reencoded_original']['psnr_outside']:.2f} vs {c['perfect_outside_psnr']}")
        bias_f = np.where(dm[..., None], np.clip(truth.astype(int) + S.get(n).bias_level, 0, 255), truth).astype(np.uint8)
        e_b = M.evaluate(n, make_result(n, bias_f, "bias"))
        check(f"{n}: a stable-but-imperfect fill passes (and its flicker matches the calibrated figure within 0.3)", all(e_b["pass"].values()) and abs(e_b["flicker"]["excess"] - c["bias_flicker"]) < 0.3, f"{e_b['flicker']['excess']:.2f} vs {c['bias_flicker']}")
        noisy_f = truth.copy()
        for t in range(len(noisy_f)):
            nn = S.rng(6, t).integers(-30, 31, noisy_f[t].shape).astype(int)
            noisy_f[t][dm[t]] = np.clip(noisy_f[t][dm[t]].astype(int) + nn[dm[t]], 0, 255).astype(np.uint8)
        e_n = M.evaluate(n, make_result(n, noisy_f, "noisy"))
        check(f"{n}: a fill that re-randomises every frame FAILS the stability gate even through the codec", not e_n["pass"]["stable"], f"flicker {e_n['flicker']['excess']:.2f} > limit {e_n['limits']['flicker_max']:.2f}")
        region = (np.arange(S.H)[None, :, None, None] >= 200) & (np.arange(S.H)[None, :, None, None] < 260) & (np.arange(S.W)[None, None, :, None] >= 10) & (np.arange(S.W)[None, None, :, None] < 90) & ~dm[..., None]
        e_d = M.evaluate(n, make_result(n, np.where(region, 0, truth).astype(np.uint8), "damage"))
        check(f"{n}: a cleaner that blacks out pixels OUTSIDE the object FAILS the outside-damage gate", not e_d["pass"]["outside_ok"], f"outside PSNR {e_d['outside_vs_reencoded_original']['psnr_outside']:.1f} < {e_d['limits']['outside_psnr_min']:.1f}")
        bad_out = os.path.join(tmp, f"{n}-nothing.mp4"); shutil.copyfile(os.path.join(gen.OUT, n, "input.mp4"), bad_out)
        e2 = M.evaluate(n, bad_out)
        check(f"{n}: an unchanged clip FAILS the removal gate (cannot be fooled)", not e2["pass"]["removed"], f"residual {e2['removal']['residual_ratio']:.2f}")
    nsa = make_result("static_logo", R["static_logo"][1], "noaudio-check"); na = os.path.join(tmp, "stripped.mp4"); ff("-i", nsa, "-an", "-c:v", "copy", na)
    check("post-encode gate FAILS a cleaner that drops the audio track", not M.evaluate("static_logo", na)["pass"]["av_ok"])
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{total - bad}/{total} passed  ({time.time() - t_start:.0f}s)")
sys.exit(1 if bad else 0)
