"""Deterministic synthetic clips with exact ground truth for the Stage 2 video-cleanup work.

Every scenario can render, for any frame t:
    inp   - what the user's video shows (background + unwanted object [+ foreground occluder] [+ noise])
    truth - what the video would show WITHOUT the object (same noise realisation, same occluder)
    mask  - where the object is visible (alpha > 0.5, after occlusion)
so metrics never depend on eyeballing. Frames are generated from (scenario, t) only: no stored state, no wall-clock.
"""
from __future__ import annotations
import hashlib
from functools import lru_cache
import numpy as np

W, H, FPS = 640, 360, 30
RED_RGB = np.array([228, 28, 38], np.float32)


def rng(*key):
    return np.random.default_rng(list(key))


# ───────────────────────── textures (no pure red anywhere, so "red" always means "the object") ─────────────────────────
def texture_bricks(seed: int, w: int, h: int) -> np.ndarray:
    r = rng(seed, 1)
    bw, bh = 40, 18
    ys, xs = np.mgrid[0:h, 0:w]
    row = ys // bh
    off = (row % 2) * (bw // 2)
    col = (xs + off) // bw
    mortar = ((ys % bh) < 3) | (((xs + off) % bw) < 3)
    tone = r.normal(0, 14, (h // bh + 2, w // bw + 3, 3)).astype(np.float32)
    img = np.array([112, 122, 138], np.float32) + tone[row, col]
    img[mortar] = (188, 190, 192)
    img += r.normal(0, 3, (h, w, 3)).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.float32)


def texture_waves(seed: int, w: int, h: int) -> np.ndarray:
    r = rng(seed, 2)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.stack([
        70 + 60 * ys / h + 18 * np.sin(xs * 0.045 + ys * 0.03),
        120 + 50 * ys / h + 22 * np.sin(xs * 0.03 - ys * 0.05 + 1),
        170 - 30 * ys / h + 16 * np.sin(xs * 0.06 + ys * 0.02 + 2)], -1)
    for _ in range(40):  # low-contrast blobs give real structure to track against / copy from
        cx, cy, rx, ry = r.uniform(0, w), r.uniform(0, h), r.uniform(8, 40), r.uniform(8, 30)
        col = np.array([r.uniform(20, 120), r.uniform(90, 190), r.uniform(100, 200)], np.float32)
        m = ((xs - cx) / rx) ** 2 + ((ys - cy) / ry) ** 2 < 1
        img[m] = 0.6 * img[m] + 0.4 * col
    img += r.normal(0, 3, (h, w, 3)).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.float32)


# ───────────────────────── sprites: return (y0, y1, x0, x1, alpha[h,w], rgb[h,w,3]) in a local window ─────────────────────────
def _win(cx, cy, rx, ry):
    x0, x1 = int(np.floor(cx - rx)), int(np.ceil(cx + rx)) + 1
    y0, y1 = int(np.floor(cy - ry)), int(np.ceil(cy + ry)) + 1
    x0c, x1c, y0c, y1c = max(0, x0), min(W, x1), max(0, y0), min(H, y1)
    if x1c <= x0c or y1c <= y0c:
        return None
    ys, xs = np.mgrid[y0c:y1c, x0c:x1c].astype(np.float32)
    return y0c, y1c, x0c, x1c, ys, xs


def sprite_disc(cx, cy, R, dim=1.0):
    w = _win(cx, cy, R + 2, R + 2)
    if w is None:
        return None
    y0, y1, x0, x1, ys, xs = w
    d = np.hypot(xs - cx, ys - cy)
    a = np.clip(R + 0.5 - d, 0, 1)
    t = d / R
    rgb = np.broadcast_to(RED_RGB, d.shape + (3,)).copy() * (1 - 0.25 * t)[..., None]
    ring = np.abs(t - 0.6) < 0.08
    rgb[ring] = (250, 250, 250)
    dot = np.hypot(xs - (cx + 0.3 * R), ys - (cy - 0.2 * R)) < 0.15 * R
    rgb[dot] = (60, 10, 15)
    return y0, y1, x0, x1, a, rgb * dim


def sprite_logo(cx, cy, hw, hh):
    w = _win(cx, cy, hw + 2, hh + 2)
    if w is None:
        return None
    y0, y1, x0, x1, ys, xs = w
    dx, dy = np.abs(xs - cx), np.abs(ys - cy)
    r = 10.0
    qx, qy = dx - (hw - r), dy - (hh - r)
    sdf = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
    a = np.clip(0.5 - sdf, 0, 1)
    rgb = np.broadcast_to(np.array([232, 32, 40], np.float32), dx.shape + (3,)).copy()
    u, v = (xs - cx) / hw, (ys - cy) / hh
    x_lines = (np.abs(np.abs(u) - np.abs(v)) < 0.09) & (np.abs(u) < 0.8) & (np.abs(v) < 0.7)
    border = (sdf > -4)
    rgb[x_lines | border] = (250, 250, 250)
    return y0, y1, x0, x1, a, rgb


def paste(frame, sp):
    """alpha-composite a sprite onto frame (float HxWx3). Returns the sprite's alpha on the full frame."""
    full = np.zeros((H, W), np.float32)
    if sp is None:
        return full
    y0, y1, x0, x1, a, rgb = sp
    frame[y0:y1, x0:x1] = frame[y0:y1, x0:x1] * (1 - a[..., None]) + rgb * a[..., None]
    full[y0:y1, x0:x1] = a
    return full


# ───────────────────────── scenarios ─────────────────────────
class Scenario:
    name = ""
    frames = 90
    audio = True
    camera_motion = False
    bg_velocity = (0, 0)       # background content velocity in px/frame (integer)
    cuts: list = []
    R = 36
    seed = 1
    notes = ""
    bias_level = 20            # size of the "stable but imperfect" reference fill (levels); scaled down for dark scenes

    # subclass API
    def bg(self, t) -> np.ndarray: ...
    def object_sprite(self, t): ...
    def occluder(self):  # (x0, x1, rgb[H, x1-x0, 3]) or None
        return None
    def noise_sigma(self):
        return 0.0
    def centre(self, t):  # object centre in screen px (may be off-screen)
        return None

    # common rendering
    def render(self, t):
        bg = self.bg(t).copy()
        truth = bg.copy()
        inp = bg.copy()
        a_obj = paste(inp, self.object_sprite(t))
        occ = self.occluder()
        a_occ = np.zeros((H, W), np.float32)
        if occ is not None:
            x0, x1, rgb = occ
            truth[:, x0:x1] = rgb
            inp[:, x0:x1] = rgb
            a_occ[:, x0:x1] = 1
        sig = self.noise_sigma()
        if sig:
            n = rng(self.seed, 99, t).normal(0, sig, (H, W, 3)).astype(np.float32)
            truth, inp = truth + n, inp + n
        q = lambda f: np.clip(np.rint(f), 0, 255).astype(np.uint8)
        mask = (a_obj * (1 - a_occ)) > 0.5
        return q(inp), q(truth), mask


def _canvas(kind, seed, w, h):
    return texture_bricks(seed, w, h) if kind == "bricks" else texture_waves(seed, w, h)


class StaticLogo(Scenario):
    name, frames, seed, bg_velocity = "static_logo", 90, 11, (3, 0)
    notes = "Fixed camera; the scene scrolls 3 px/frame; an opaque logo is fixed on screen (watermark case)."
    def __init__(self):
        self.canvas = _canvas("bricks", self.seed, W + 3 * self.frames + 8, H)
    def bg(self, t):
        ox = 3 * t
        return self.canvas[:, ox:ox + W]
    def object_sprite(self, t):
        return sprite_logo(520, 60, 64, 28)
    def centre(self, t):
        return (520.0, 60.0)


class MovingObject(Scenario):
    name, frames, seed, audio = "moving_object", 90, 12, False
    notes = "Fixed camera, static background, object crosses the frame. No audio track."
    def __init__(self):
        self.canvas = _canvas("bricks", self.seed, W, H)
    def bg(self, t):
        return self.canvas
    def centre(self, t):
        return (80 + 480 * t / (self.frames - 1), 180 + 60 * np.sin(2 * np.pi * t / self.frames))
    def object_sprite(self, t):
        cx, cy = self.centre(t)
        return sprite_disc(cx, cy, self.R)


class CameraPan(Scenario):
    name, frames, seed, camera_motion, bg_velocity = "camera_pan", 90, 13, True, (2, 1)
    notes = "LIMITATION CASE: camera pans (2,1) px/frame; the object is fixed in the world, so it never reveals the background."
    def __init__(self):
        self.canvas = _canvas("waves", self.seed, W + 2 * self.frames + 8, H + self.frames + 8)
    def bg(self, t):
        return self.canvas[t:t + H, 2 * t:2 * t + W]
    def centre(self, t):
        return (560.0 - 2 * t, 210.0 - 1 * t)
    def object_sprite(self, t):
        cx, cy = self.centre(t)
        return sprite_disc(cx, cy, self.R)


class ShotCut(Scenario):
    name, frames, seed, cuts = "shot_cut", 90, 14, [45]
    notes = "Hard cut at frame 45 to a different scene; the object keeps moving across the cut."
    def __init__(self):
        self.a = _canvas("bricks", self.seed, W, H)
        self.b = _canvas("waves", self.seed + 1, W, H)
    def bg(self, t):
        return self.a if t < 45 else self.b
    def centre(self, t):
        return (100 + 5 * t, 200 + 40 * np.sin(2 * np.pi * t / 60))
    def object_sprite(self, t):
        cx, cy = self.centre(t)
        return sprite_disc(cx, cy, self.R)


class Occlusion(Scenario):
    name, frames, seed, R = "occlusion", 120, 15, 30
    notes = "Object passes behind a foreground bar (x 300-342), exits the right edge, re-enters and is partly hidden again."
    def __init__(self):
        self.canvas = _canvas("waves", self.seed, W, H)
        r = rng(self.seed, 7)
        bar = np.zeros((H, 42, 3), np.float32)
        bar[:] = np.array([70, 74, 82], np.float32) + (np.arange(H, dtype=np.float32)[:, None, None] / H) * 20
        bar += r.normal(0, 3, bar.shape).astype(np.float32)
        self.bar = np.clip(bar, 0, 255)
    def occluder(self):
        return 300, 342, self.bar
    def bg(self, t):
        return self.canvas
    def centre(self, t):
        return (float(np.interp(t, [0, 70, 85, 119], [40, 700, 700, 330])), 240.0)
    def object_sprite(self, t):
        cx, cy = self.centre(t)
        return sprite_disc(cx, cy, self.R)


class LowLightNoise(Scenario):
    name, frames, seed = "lowlight_noise", 90, 16
    bias_level = 6
    notes = "Dark scene with strong sensor noise (sigma 9, new every frame, identical in input and truth)."
    def __init__(self):
        self.canvas = _canvas("waves", self.seed, W, H) * 0.28
    def noise_sigma(self):
        return 9.0
    def bg(self, t):
        return self.canvas
    def centre(self, t):
        return (120 + 4.5 * t, 190 + 50 * np.sin(2 * np.pi * t / 90))
    def object_sprite(self, t):
        cx, cy = self.centre(t)
        return sprite_disc(cx, cy, self.R, dim=0.45)


class LongTrack(Scenario):
    name, frames, seed, R = "long_track", 150, 17, 34
    notes = "5 s figure-eight path with sub-pixel motion: for tracker drift measurements."
    def __init__(self):
        self.canvas = _canvas("bricks", self.seed, W, H)
    def bg(self, t):
        return self.canvas
    def centre(self, t):
        return (320 + 200 * np.sin(2 * np.pi * t / 150), 180 + 90 * np.sin(4 * np.pi * t / 150))
    def object_sprite(self, t):
        cx, cy = self.centre(t)
        return sprite_disc(cx, cy, self.R)


ALL = [StaticLogo, MovingObject, CameraPan, ShotCut, Occlusion, LowLightNoise, LongTrack]


@lru_cache(maxsize=None)
def get(name: str) -> Scenario:  # cached instance per scenario name
    for c in ALL:
        if c.name == name:
            return c()
    raise KeyError(name)


def names():
    return [c.name for c in ALL]


def render_all(name):
    sc = get(name)
    out = [sc.render(t) for t in range(sc.frames)]
    return (np.stack([o[0] for o in out]), np.stack([o[1] for o in out]), np.stack([o[2] for o in out]))


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """square dilation by r pixels on the last two axes"""
    m = mask.copy()
    for _ in range(r):
        n = m.copy()
        n[..., 1:, :] |= m[..., :-1, :]; n[..., :-1, :] |= m[..., 1:, :]
        m = n
        n = m.copy()
        n[..., :, 1:] |= m[..., :, :-1]; n[..., :, :-1] |= m[..., :, 1:]
        m = n
    return m


def sha(arr: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(arr).tobytes()).hexdigest()


def reveal_stats(sc: Scenario, masks: np.ndarray):
    """How much of the object region is visible somewhere else in the clip?
    static  : same screen pixel, other frames (what a naive temporal plate could use)
    motion  : background content followed through its known velocity (what a motion-compensated plate can use)"""
    N = sc.frames
    t0 = N // 2
    seg = [t for t in range(N) if sum(1 for c in sc.cuts if c <= t) == sum(1 for c in sc.cuts if c <= t0)]
    m0 = masks[t0]
    bad = dilate(masks, 3)
    static = np.zeros_like(m0); motion = np.zeros_like(m0)
    vx, vy = sc.bg_velocity
    for t in seg:
        if t == t0:
            continue
        static |= ~bad[t]
        # content visible at p in frame t0 sits at p' = p + v*(t0 - t) in frame t  -> read frame t at p'
        dx, dy = vx * (t0 - t), vy * (t0 - t)
        ok = np.zeros_like(m0)
        ys = slice(max(0, -dy), min(H, H - dy)); xs = slice(max(0, -dx), min(W, W - dx))
        ys2 = slice(max(0, dy), min(H, H + dy)); xs2 = slice(max(0, dx), min(W, W + dx))
        ok[ys, xs] = ~bad[t][ys2, xs2]
        motion |= ok
    n = max(1, int(m0.sum()))
    return {"frame": t0, "static": float((static & m0).sum() / n), "motion_compensated": float((motion & m0).sum() / n)}
