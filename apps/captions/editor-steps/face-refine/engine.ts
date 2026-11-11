// The face refinement engine (Python, run in the step's own venv), kept as text so the plug-in folder stays one bundle.
// Edit it as Python: no backticks and no dollar-brace in it, since it sits in a String.raw template.
export const ENGINE = String.raw`"""Face refinement engine: skin retouch and under-eye lift on the speaker's face, for the AI Editor's Face refinement step.

  python engine.py SOURCE OUT --ranges A-B,C-D [--work DIR] [--ffmpeg PATH] [--ffprobe PATH] [--smooth 0.28] ...
  python engine.py --selftest

A-B are source frames (0-based, end exclusive). OUT is the whole file again, every frame, as ProRes 422 HQ 10-bit with
the source's size, frame rate, timecode and sound; only the frames inside the ranges are retouched, and of those only
the face: every pixel it doesn't touch is the source's own. OUT.json beside it says how many frames had a face.

How: MediaPipe face landmarks and face-skin segmentation (selfie_multiclass) on half-size frames; a skin-only mask that
leaves beard, brows, eyes, lips and nostrils alone; a skin-weighted guided filter that evens out blotches while the
pore band is kept (texture-keeping smoothing); dark circles lifted toward the cheek's tone. Landmarks are smoothed
over time (One Euro, forward and backward), segmentation averaged over +-2 frames, the beard mask carried over
between frames, so nothing crawls. Only the union of the face crops comes into Python (10-bit YUV), and goes back as
a YUV difference that the encoder's ffmpeg lays over the source it decodes itself.
"""
import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np

MODELS = Path(os.environ.get("FACE_REFINE_MODELS") or Path(__file__).parent)
TRACK_SCALE = 0.5   # landmarks run on half-size frames: plenty for a face this big, 4x faster
FFMPEG, FFPROBE = "ffmpeg", "ffprobe"
HW = ["-hwaccel", "videotoolbox"] if sys.platform == "darwin" else []   # VideoToolbox decode on a Mac

# Strengths and sizes. Sizes are fractions of the face width (outer eye corners x 2.2).
DEFAULTS = dict(
    smooth=0.28,       # 0..1 how much of the mid band (blotches, redness, fine lines) goes
    undereye=0.6,      # 0..1 dark-circle removal: lift and de-purple the hollow under each eye
    eyes=0.3,          # 0..1 iris unsharp mask
    detail=1.0,        # 0..1.5 pore band kept (1 = all of it)
    base_r=0.035,      # guided-filter radius: size of what gets evened out
    base_eps=0.0016,   # guided-filter eps: edges stronger than ~0.04 survive
    pore_sigma=0.004,  # pores = finer than this Gaussian
    feather=0.03,      # skin-mask edge softness
    hair=3.0,          # beard cut-off: more than ~this x the calm skin's fine texture = hair, left alone
    hair_steady=0.5,   # 0..0.9 how much of the previous frames' beard mask carries over (stops edge crawl)
    beta=0.004,        # One Euro speed coefficient (landmark smoothing): higher = follows fast moves tighter
)

# --- MediaPipe face mesh indices -----------------------------------------------------------------------------------
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
        377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
L_EYE = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7]
R_EYE = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249]
L_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
R_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
NOSTRILS = [98, 97, 2, 326, 327, 294, 278, 344, 440, 275, 4, 45, 220, 115, 48, 64]
L_LID = [33, 7, 163, 144, 145, 153, 154, 155, 133]   # lower lid, outer -> inner
R_LID = [263, 249, 390, 373, 374, 380, 381, 382, 362]
IRIS_L, IRIS_R = list(range(468, 473)), list(range(473, 478))
KR, KB = 0.2126, 0.0722            # bt709
KG = 1 - KR - KB
GRID = 8      # crop edges snap to multiples of this, so the downsampled grids keep their phase as the face moves
GF_SUB = 4    # guided filter runs on a GF_SUB-times smaller copy


# --- I/O -----------------------------------------------------------------------------------------------------------
def probe(video):
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_frames,duration,color_primaries,color_transfer,color_space,"
                          "color_range:stream_tags=timecode:stream_side_data=rotation:format=duration:format_tags=timecode",
                          "-of", "json", video], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    s = d["streams"][0]
    num, den = map(int, s["r_frame_rate"].split("/"))
    fps = num / den
    w, h = s["width"], s["height"]
    if any(abs(int(x.get("rotation", 0))) % 180 == 90 for x in s.get("side_data_list", [])):
        w, h = h, w   # ffmpeg turns the frames upright as it decodes them
    frames = int(s.get("nb_frames") or 0) or round(float(s.get("duration") or d["format"]["duration"]) * fps)
    tc = s.get("tags", {}).get("timecode") or d["format"].get("tags", {}).get("timecode") or "00:00:00:00"
    tag = lambda key, default: s.get(key) if s.get(key) not in (None, "unknown", "reserved") else default
    col = ["-color_primaries", tag("color_primaries", "bt709"), "-color_trc", tag("color_transfer", "bt709"),
           "-colorspace", tag("color_space", "bt709"), "-color_range", tag("color_range", "tv")]
    return dict(w=w, h=h, fps=fps, frames=frames, tc=tc, col=col)


def tc_add(tc, n, fps):
    hh, mm, ss, ff = map(int, tc.replace(";", ":").split(":"))
    fr = round(fps)
    t = ((hh * 60 + mm) * 60 + ss) * fr + ff + n
    return f"{t // (3600 * fr):02d}:{t // (60 * fr) % 60:02d}:{t // fr % 60:02d}:{t % fr:02d}"


def decode(video, args):
    """ffmpeg reading the whole file from its first frame, in order."""
    return subprocess.Popen([FFMPEG, "-v", "error", "-nostdin", *HW, "-i", str(video),
                             "-fps_mode", "passthrough", *args, "-f", "rawvideo", "-"], stdout=subprocess.PIPE)


def yuv_to_rgb(Y, U, V):
    """10-bit tv-range 4:2:0 planes (crop, even origin) -> float RGB 0..1."""
    h, w = Y.shape
    y = (Y.astype(np.float32) - 64) / 876
    cb = cv2.resize((U.astype(np.float32) - 512) / 896, (w, h), interpolation=cv2.INTER_LINEAR)
    cr = cv2.resize((V.astype(np.float32) - 512) / 896, (w, h), interpolation=cv2.INTER_LINEAR)
    r, b = y + 2 * (1 - KR) * cr, y + 2 * (1 - KB) * cb
    return np.clip(np.dstack([r, (y - KR * r - KB * b) / KG, b]), 0, 1)


def delta_yuv(d):
    """RGB difference -> (dY full res, dCb dCr at 4:2:0) in 10-bit tv code values, float16."""
    dy = d[..., 0] * KR + d[..., 1] * KG + d[..., 2] * KB
    h, w = dy.shape
    half = lambda c: cv2.resize(c, (w // 2, h // 2), interpolation=cv2.INTER_AREA).astype(np.float16)
    return ((dy * 876).astype(np.float16), half((d[..., 2] - dy) * (896 / (2 * (1 - KB)))),
            half((d[..., 0] - dy) * (896 / (2 * (1 - KR)))))


# --- tracking ------------------------------------------------------------------------------------------------------
def one_euro(x, fps, mincut=1.0, beta=0.004, dcut=1.0):
    """One Euro filter along axis 0 of x (T, ...), run forward and backward and averaged: no lag."""
    def run(seq):
        out = np.empty_like(seq)
        out[0] = prev = seq[0]
        dprev = np.zeros_like(seq[0])
        a = lambda c: 1.0 / (1.0 + fps / (2 * np.pi * c))
        for t in range(1, len(seq)):
            dprev = dprev + a(dcut) * ((seq[t] - prev) * fps - dprev)
            prev = prev + a(mincut + beta * np.abs(dprev)) * (seq[t] - prev)
            out[t] = prev
        return out
    return 0.5 * (run(x) + run(x[::-1])[::-1])


def square_box(p):
    cx, cy = p[:, 0].mean(), p[:, 1].mean()
    side = 1.5 * max(np.ptp(p[:, 0]), np.ptp(p[:, 1]))
    return int(cx - side / 2), int(cy - side / 2), int(side)


def crop_pad(img, x0, y0, side):
    H, W = img.shape[:2]
    out = np.zeros((side, side) + img.shape[2:], img.dtype)
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + side, W), min(y0 + side, H)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
    return out


def track(video, info, ranges, work, threads=4):
    """Landmarks (full-res px) + face-skin segmentation (256x256 in each frame's square face box) per frame of each
    range, cached in WORK/track_<a>_<b>.npz. One decode for all ranges that aren't cached yet."""
    todo = [(a, b) for a, b in ranges if not (Path(work) / f"track_{a}_{b}.npz").exists()]
    if todo:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
        W, H = int(info["w"] * TRACK_SCALE) // 2 * 2, int(info["h"] * TRACK_SCALE) // 2 * 2
        local = threading.local()

        def segment(crop):
            if not hasattr(local, "seg"):
                local.seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
                    base_options=BaseOptions(model_asset_path=str(MODELS / "selfie_multiclass.tflite")),
                    output_confidence_masks=True))
            m = local.seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)).confidence_masks[3].numpy_view()
            return cv2.resize(m, (256, 256), interpolation=cv2.INTER_AREA).astype(np.float16)

        sel = "+".join(f"between(n\\,{a}\\,{b - 1})" for a, b in todo)
        dec = decode(video, ["-vf", f"select={sel},scale={W}:{H}:flags=area", "-pix_fmt", "rgb24"])
        with ThreadPoolExecutor(threads) as pool:
            for a, b in todo:
                lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(   # fresh per range
                    base_options=BaseOptions(model_asset_path=str(MODELS / "face_landmarker.task")),
                    running_mode=vision.RunningMode.VIDEO, num_faces=1))
                pts, boxes, skins = [], [], []
                for i in range(b - a):
                    raw = dec.stdout.read(W * H * 3)
                    if len(raw) < W * H * 3:
                        break
                    img = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
                    r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=img), int(i * 1000 / info["fps"]))
                    if not r.face_landmarks:
                        pts.append(np.full((478, 2), np.nan, np.float32)); boxes.append((0, 0, 1))
                        skins.append(np.zeros((256, 256), np.float16)); continue
                    p = np.array([[q.x * info["w"], q.y * info["h"]] for q in r.face_landmarks[0]], np.float32)
                    pts.append(p)
                    x0, y0, side = square_box(p)
                    boxes.append((x0, y0, side))
                    s = TRACK_SCALE   # the 256 px segmenter needs the face big: run it on a crop around the face
                    skins.append(pool.submit(segment, crop_pad(img, int(x0 * s), int(y0 * s), max(2, int(side * s)))))
                    if sum(not isinstance(x, np.ndarray) and not x.done() for x in skins[-4 * threads:]) >= 3 * threads:
                        skins[-3 * threads].result()   # backpressure: don't queue the whole range's crops in memory
                lm.close()
                skins = [x if isinstance(x, np.ndarray) else x.result() for x in skins]
                assert len(pts) == b - a, f"decoded {len(pts)} of {b - a} frames"
                raw = np.stack(pts)
                good = ~np.isnan(raw[:, 0, 0])
                if good.any() and (~good).any():   # frames without a face borrow the nearest tracked frame for smoothing
                    idx = np.flatnonzero(good)
                    raw[~good] = raw[idx[np.abs(np.flatnonzero(~good)[:, None] - idx).argmin(1)]]
                np.savez_compressed(Path(work) / f"track_{a}_{b}.npz", raw=raw, boxes=np.array(boxes),
                                    skin=np.stack(skins), good=good)
        dec.stdout.close(); dec.wait()
    return [np.load(Path(work) / f"track_{a}_{b}.npz") for a, b in ranges]


class Track:
    """One range's smoothed landmarks and segmentation."""
    def __init__(self, trk, fps, k):
        self.pts = one_euro(trk["raw"].astype(np.float64), fps, beta=k["beta"]).astype(np.float32)
        sk = trk["skin"].astype(np.float32)   # segmentation flickers: average +-2 frames in face-box space
        self.seg = np.stack([sk[max(0, i - 2):i + 3].mean(0) for i in range(len(sk))])
        self.seg_boxes, self.good = trk["boxes"], trk["good"]


# --- masks and retouch ---------------------------------------------------------------------------------------------
def poly(mask, q, val=1.0):
    cv2.fillPoly(mask, [np.round(q * 16).astype(np.int32)], val, cv2.LINE_AA, shift=4)


def scaled(q, s):
    c = q.mean(0)
    return c + (q - c) * s


def face_width(p):
    return float(np.linalg.norm(p[33] - p[263])) * 2.2


def box_affine(box, size=256):
    """Crop coords -> size x size grid of the square face box (x0, y0, side in crop coords)."""
    x0, y0, side = box
    return np.float32([[size / side, 0, -x0 * size / side], [0, size / side, -y0 * size / side]])


def face_crop(p, w, h):
    """Crop around the face with room for the masks' blur, inside the frame."""
    x0, y0 = p.min(0)
    x1, y1 = p.max(0)
    m = 0.25 * (x1 - x0)
    return int(max(0, x0 - m)), int(max(0, y0 - m)), int(min(w, x1 + m)), int(min(h, y1 + m))


def crop_box(p, W, H):
    x0, y0, x1, y1 = face_crop(p, W, H)
    return x0 // GRID * GRID, y0 // GRID * GRID, min(W, -(-x1 // GRID) * GRID), min(H, -(-y1 // GRID) * GRID)


def gblur(x, sigma, win=None):
    """GaussianBlur. From sigma 5 px up it runs on a 2/4/8x smaller copy: the result is a smooth field anyway.
    win = (y0, y1, x0, x1): return only that window, at full resolution."""
    f = 8 if sigma >= 20 else 4 if sigma >= 10 else 2 if sigma >= 5 else 1
    h, w = x.shape[:2]
    y0, y1, x0, x1 = win or (0, h, 0, w)
    if f == 1:
        return cv2.GaussianBlur(x, (0, 0), sigma)[y0:y1, x0:x1]
    lo = cv2.GaussianBlur(cv2.resize(x, (w // f, h // f), interpolation=cv2.INTER_AREA), (0, 0), sigma / f)
    if win is None:
        return cv2.resize(lo, (w, h), interpolation=cv2.INTER_LINEAR)
    sx, sy = (w // f) / w, (h // f) / h   # resize's own pixel-centre mapping, for the window only
    M = np.float32([[sx, 0, (x0 + 0.5) * sx - 0.5], [0, sy, (y0 + 0.5) * sy - 0.5]])
    return cv2.warpAffine(lo, M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                          borderMode=cv2.BORDER_REPLICATE)


def wblur(x, w, sigma, win=None):
    """Blur of x counting only where w is high (normalised): neighbours with w=0 don't bleed in."""
    den = np.maximum(gblur(w, sigma, win), 1e-4)
    return gblur(x * w[..., None], sigma, win) / den[..., None]


def guided(I, ps, r, eps, s=GF_SUB):
    """He's colour guided filter of each 2-D p in ps, guide I (HxWx3), box radius r, as cv2.ximgproc.guidedFilter
    computes it per channel, on an s-times smaller copy. Returns (outputs, I) at that size. eps is in ximgproc's
    units (it scales eps by 255^2 for float images), so at the default it acts as a plain double box blur: the look."""
    eps *= 255 * 255
    h, w = I.shape[:2]
    small = (lambda x: cv2.resize(x, (w // s, h // s), interpolation=cv2.INTER_AREA)) if s > 1 else (lambda x: x)
    rs = max(1, round(r / s))
    box = lambda x: cv2.boxFilter(x, -1, (2 * rs + 1, 2 * rs + 1), borderType=cv2.BORDER_REFLECT)
    Is = small(I)
    mI = box(Is)
    var = lambda a, b: box(Is[..., a] * Is[..., b]) - mI[..., a] * mI[..., b]
    rr, rg, rb, gg, gb, bb = var(0, 0) + eps, var(0, 1), var(0, 2), var(1, 1) + eps, var(1, 2), var(2, 2) + eps
    inv = [gg * bb - gb * gb, gb * rb - rg * bb, rg * gb - gg * rb, rr * bb - rb * rb, rb * rg - rr * gb, rr * gg - rg * rg]
    det = rr * inv[0] + rg * inv[1] + rb * inv[2]
    i00, i01, i02, i11, i12, i22 = (c / det for c in inv)
    out = []
    for p in ps:
        p = small(p)
        mp_ = box(p)
        c0, c1, c2 = (box(Is[..., j] * p) - mI[..., j] * mp_ for j in range(3))
        a = np.dstack([i00 * c0 + i01 * c1 + i02 * c2, i01 * c0 + i11 * c1 + i12 * c2, i02 * c0 + i12 * c1 + i22 * c2])
        b = mp_ - (a * mI).sum(2)
        out.append((box(a) * Is).sum(2) + box(b))
    return out, Is


def oval_pts(p):
    q = p[OVAL].copy()   # the mesh oval stops mid-forehead: push its top up; segmentation finds the hairline
    up = q[:, 1] < p[168, 1]
    q[up] = p[168] + (q[up] - p[168]) * [1.05, 1.35]
    return q


def hair_map(y, p, fw, box, k):
    """1 on bare skin, 0 on beard/stubble (fine-texture energy against the calmest 30% of the face), as a 256x256
    face-box map before carry-over. y = luma of the crop."""
    f = 4
    e = np.abs(y - cv2.GaussianBlur(y, (0, 0), 1.2))
    lo = cv2.GaussianBlur(cv2.resize(e, (y.shape[1] // f, y.shape[0] // f), interpolation=cv2.INTER_AREA),
                          (0, 0), 0.012 * fw / f)
    oval = np.zeros_like(lo)
    poly(oval, (oval_pts(p) - (f - 1) / 2) / f)
    sel = oval > 0.5
    ref = np.percentile(lo[sel], 30) if sel.any() else 1.0
    h = np.clip((k["hair"] - lo / max(ref, 1e-6)) / 0.8, 0, 1)
    A = np.vstack([box_affine(box), [0, 0, 1]]) @ np.float32([[f, 0, (f - 1) / 2], [0, f, (f - 1) / 2], [0, 0, 1]])
    return cv2.warpAffine(h, A[:2].astype(np.float32), (256, 256), flags=cv2.INTER_LINEAR, borderValue=1)


def masks(img, p, seg_map, seg_box, box, hb, k):
    """(skin, undereye, irises) float masks in crop coords; hb = the carried-over beard map."""
    H, W = img.shape[:2]
    fw = face_width(p)
    skin = np.zeros((H, W), np.float32)
    poly(skin, oval_pts(p))
    seg = cv2.warpAffine(seg_map, box_affine(seg_box), (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    hair = cv2.warpAffine(hb, box_affine(box), (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=1)
    skin *= np.clip((seg - 0.3) / 0.4, 0, 1) * gblur(hair, 0.01 * fw)
    cut = np.zeros((H, W), np.float32)   # glasses lenses, bridge, brows, lips, nostrils
    for eye, brow in ((L_EYE, L_BROW), (R_EYE, R_BROW)):
        e = p[eye]
        c, ew = e.mean(0), np.ptp(e[:, 0])
        cv2.ellipse(cut, (int(c[0]), int(c[1] + 0.05 * ew)), (int(1.05 * ew), int(0.9 * ew)), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
        poly(cut, scaled(p[brow], 1.25))
    br = (p[168] + p[6]) / 2
    cv2.ellipse(cut, (int(br[0]), int(br[1])), (int(0.08 * fw), int(0.05 * fw)), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
    poly(cut, scaled(p[LIPS], 1.15))
    poly(cut, scaled(p[NOSTRILS], 1.05))
    f = max(3, int(k["feather"] * fw))
    cut = gblur(cv2.dilate(cut, None, iterations=2), f / 3)
    skin = gblur(cv2.erode(skin, None, iterations=2), f / 2) * (1 - np.clip(cut, 0, 1))
    opening = np.zeros((H, W), np.float32)
    for e in (L_EYE, R_EYE):
        poly(opening, scaled(p[e], 1.1))
    opening = gblur(opening, 0.008 * fw)
    ue = np.zeros((H, W), np.float32)   # the hollow under each eye: from just below the lashes down ~0.5 eye widths
    for lid in (L_LID, R_LID):
        q = p[lid]
        ew = np.ptp(q[:, 0])
        bottom = q[::-1] + [0, 0.5 * ew]
        bottom[:, 0] = q[:, 0].mean() + (bottom[:, 0] - q[:, 0].mean()) * 0.9
        poly(ue, np.vstack([q + [0, 0.08 * ew], bottom]))
    ue = gblur(ue, 0.035 * fw) * (1 - np.clip(cv2.dilate(opening, None, iterations=6) * 2, 0, 1))
    iris = np.zeros((H, W), np.float32)   # irises only: sharpening the whites reads as bleached
    for ir in (IRIS_L, IRIS_R):
        c = p[ir[0]]
        rad = np.linalg.norm(p[ir[1:]] - c, axis=1).mean() * 1.1
        cv2.circle(iris, (int(c[0] * 16), int(c[1] * 16)), int(rad * 16), 1.0, -1, cv2.LINE_AA, shift=4)
    iris = gblur(iris, 0.004 * fw) * opening
    return skin, ue, iris


def undereye(out, skin, ue, fw, strength):
    """Dark circles: move the low band of the hollow toward the surrounding skin's brightness, take out the blue/purple
    beyond what that skin has, nudge its red toward the skin's. Only the low band moves, so texture stays. Pixels much
    darker (frame rim, lashes) or brighter (lens reflections) than the skin around are left alone."""
    ys, xs = np.nonzero(ue > 1e-3)
    if not len(ys):
        return out
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    ycc = cv2.cvtColor(out[y0:y1, x0:x1], cv2.COLOR_RGB2YCrCb)
    around = cv2.cvtColor(wblur(out, skin, 0.09 * fw, (y0, y1, x0, x1)), cv2.COLOR_RGB2YCrCb)
    u = ue[y0:y1, x0:x1]
    dy = around[..., 0] - ycc[..., 0]
    keep = np.clip((0.18 - dy) / 0.06, 0, 1) * np.clip((dy + 0.02) / 0.03, 0, 1)
    low = wblur(ycc, keep * (u > 0.01), 0.02 * fw)
    w = strength * u * keep
    ycc[..., 0] += np.clip(around[..., 0] - low[..., 0], 0, 0.1) * w
    ycc[..., 2] += np.minimum(around[..., 2] - low[..., 2], 0) * w * 0.7   # Cb: blue/purple above the skin's
    ycc[..., 1] += (around[..., 1] - low[..., 1]) * w * 0.3                # Cr: a little toward the skin's
    out[y0:y1, x0:x1] = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
    return out


def retouch(img, p, seg_map, seg_box, box, hb, k):
    """img: float32 RGB 0..1 crop around the face. Returns the retouched crop."""
    fw = face_width(p)
    skin, ue, iris = masks(img, p, seg_map, seg_box, box, hb, k)
    r = max(2, int(k["base_r"] * fw))
    # normalised guided filter: only skin feeds the smoothed base, so beard, frames and brows don't halo the cheek
    wgt = np.clip(skin * 1.5, 0, 1)
    (*num, den), lo = guided(img, [img[..., 0] * wgt, img[..., 1] * wgt, img[..., 2] * wgt, wgt], r, k["base_eps"])
    base = np.where(den[..., None] > 0.05, np.dstack(num) / np.maximum(den, 0.05)[..., None], lo)
    base = cv2.resize(base, img.shape[1::-1], interpolation=cv2.INTER_LINEAR)
    blur = cv2.GaussianBlur(img, (0, 0), max(0.6, k["pore_sigma"] * fw))
    d = base - blur   # = smooth - img, smooth = base + detail * (img - blur)
    if k["detail"] != 1:
        d += (k["detail"] - 1) * (img - blur)
    out = img + (k["smooth"] * skin)[..., None] * d
    if k["undereye"] > 0:
        out = undereye(out, skin, ue, fw, k["undereye"])
    ys, xs = np.nonzero(iris > 1e-3)
    if k["eyes"] > 0 and len(ys):   # iris unsharp mask, on the irises' box only (padded past the blur's reach)
        s = max(0.8, 0.0025 * fw)
        pad = int(4 * s) + 2
        y0, y1 = max(0, ys.min() - pad), min(out.shape[0], ys.max() + pad + 1)
        x0, x1 = max(0, xs.min() - pad), min(out.shape[1], xs.max() + pad + 1)
        o = out[y0:y1, x0:x1]
        out[y0:y1, x0:x1] = o + (k["eyes"] * iris[y0:y1, x0:x1])[..., None] * (o - cv2.GaussianBlur(o, (0, 0), s))
    return np.clip(out, 0, 1)


def retouch_job(job):
    """One frame's face crop in a worker: 10-bit YUV crop in, YUV difference out."""
    Y, U, V, p, seg_map, seg_box, box, hb, k = job
    img = yuv_to_rgb(Y, U, V)
    return delta_yuv(retouch(img, p, seg_map, seg_box, box, hb, k) - img)


# --- render --------------------------------------------------------------------------------------------------------
def encoder_args():
    out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    if "prores_videotoolbox" in out:
        return ["-c:v", "prores_videotoolbox", "-profile:v", "hq", "-pix_fmt", "p210le"]
    return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]


def render(video, out, ranges, work, k, workers):
    info = probe(video)
    W, H, fps, N = info["w"], info["h"], info["fps"], info["frames"]
    ranges = [(max(0, a), min(N, b)) for a, b in ranges if min(N, b) > max(0, a)]
    t0 = time.time()
    tracks = [Track(t, fps, k) for t in track(video, info, ranges, work)]
    t_track = time.time() - t0
    at = {}   # source frame -> (track, index in it)
    for (a, b), t in zip(ranges, tracks):
        for i in range(b - a):
            at[a + i] = (t, i)
    good = [p for t in tracks for p in t.pts[t.good]]
    faces = sum(int(t.good.sum()) for t in tracks)
    meta = dict(frames=N, faces=faces, ranges=ranges, timecode=info["tc"], fps=fps, track_s=round(t_track, 1))
    if not faces:
        Path(str(out) + ".json").write_text(json.dumps(meta))
        return meta
    boxes = np.array([crop_box(p, W, H) for p in good])
    ux, uy, ux1, uy1 = boxes[:, 0].min(), boxes[:, 1].min(), boxes[:, 2].max(), boxes[:, 3].max()
    uw, uh = ux1 - ux, uy1 - uy
    # integer frame-number timestamps on both inputs pair patch i with source frame i, also when patches come late
    fr_ = Fraction(fps).limit_denominator(100000)
    ts = f"settb={fr_.denominator}/{fr_.numerator},setpts=N"
    col = info["col"]   # the source's own tags, on the patch too: an untagged input next to tagged output gets converted
    enc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-nostdin", *HW, "-i", str(video),
                            "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-s", f"{uw}x{uh}", "-r", str(fps), *col, "-i", "-",
                            "-filter_complex", f"[0:v]{ts},format=yuv420p10le[m];[1:v]{ts}[p];"
                            # the frames come out upright: a phone file's rotation must not go on them a second time
                            f"[m][p]overlay={ux}:{uy}:format=yuv420p10,sidedata=mode=delete:type=DISPLAYMATRIX[v]", "-map", "[v]", "-map", "0:a?", "-c:a", "copy",
                            "-map_metadata", "0", "-r", str(fps), *encoder_args(), *col,
                            "-timecode", info["tc"], "-f", "mov", str(out)], stdin=subprocess.PIPE)
    dec = decode(video, ["-vf", f"crop={uw}:{uh}:{ux}:{uy}", "-pix_fmt", "yuv420p10le"])
    pool = ProcessPoolExecutor(workers, initializer=cv2.setNumThreads, initargs=(1,)) if workers else None
    fsize = uw * uh * 3   # bytes of one yuv420p10le patch
    q_in, q_out, err = queue.Queue(8), queue.Queue(2 * max(1, workers)), []

    def finish(Y, U, V, box, job):
        if box is not None:
            dy, du, dv = job.result() if pool else job
            Y, U, V = Y.copy(), U.copy(), V.copy()
            x0, y0, x1, y1 = box
            Y[y0:y1, x0:x1] = np.clip(Y[y0:y1, x0:x1] + dy + 0.5, 0, 1023)
            U[y0 // 2:y1 // 2, x0 // 2:x1 // 2] = np.clip(U[y0 // 2:y1 // 2, x0 // 2:x1 // 2] + du + 0.5, 0, 1023)
            V[y0 // 2:y1 // 2, x0 // 2:x1 // 2] = np.clip(V[y0 // 2:y1 // 2, x0 // 2:x1 // 2] + dv + 0.5, 0, 1023)
        for plane in (Y, U, V):
            enc.stdin.write(np.ascontiguousarray(plane).data)

    def reader():   # own thread, so ffmpeg decodes ahead instead of waiting on the pipe while we compute
        try:
            for _ in range(N):
                raw = dec.stdout.read(fsize)
                if len(raw) < fsize:
                    break
                q_in.put(raw)
        finally:
            q_in.put(None)

    def writer():   # own thread: waits for the workers, builds the patch, feeds the encoder
        while (item := q_out.get()) is not None:
            if not err:
                try:
                    finish(*item)
                except Exception as e:   # keep draining so the main loop never blocks; raised below
                    err.append(e)

    threads = [threading.Thread(target=reader, daemon=True), threading.Thread(target=writer, daemon=True)]
    for t in threads:
        t.start()
    nf, hb_prev, hs, t1 = 0, None, k["hair_steady"], time.time()
    try:
        while not err:
            raw = q_in.get()
            if raw is None:
                break
            n = nf
            nf += 1
            a = np.frombuffer(raw, np.uint16)
            n_y, n_c = uw * uh, uw * uh // 4
            Y = a[:n_y].reshape(uh, uw)
            U, V = a[n_y:n_y + n_c].reshape(uh // 2, uw // 2), a[n_y + n_c:].reshape(uh // 2, uw // 2)
            t, i = at.get(n, (None, 0))
            if t is None or not t.good[i]:
                hb_prev = None
                q_out.put((Y, U, V, None, None))
                continue
            p = t.pts[i] - [ux, uy]   # patch coords from here on
            x0, y0, x1, y1 = (c - o for c, o in zip(crop_box(t.pts[i], W, H), (ux, uy, ux, uy)))
            pc = p - [x0, y0]
            bx, by, side = square_box(p)
            sb = t.seg_boxes[i]
            fbox = (bx - x0, by - y0, side)
            Yc = Y[y0:y1, x0:x1]
            hb = hair_map((Yc.astype(np.float32) - 64) / 876, pc, face_width(p), fbox, k)
            if hb_prev is not None and hs > 0 and i > 0:
                hb = hs * hb_prev + (1 - hs) * hb
            hb_prev = hb
            job = (Yc, U[y0 // 2:y1 // 2, x0 // 2:x1 // 2], V[y0 // 2:y1 // 2, x0 // 2:x1 // 2], pc, t.seg[i],
                   (sb[0] - ux - x0, sb[1] - uy - y0, sb[2]), fbox, hb, k)
            q_out.put((Y, U, V, (x0, y0, x1, y1), pool.submit(retouch_job, job) if pool else retouch_job(job)))
    finally:
        q_out.put(None)
        threads[1].join()
        if pool:
            pool.shutdown(cancel_futures=True)
        dec.stdout.close(); dec.wait()
        enc.stdin.close()
    if err:
        raise err[0]
    assert enc.wait() == 0, "ffmpeg could not write the retouched file"
    assert nf == N, f"decoded {nf} of {N} frames"
    meta.update(render_s=round(time.time() - t1, 1), patch=[int(ux), int(uy), int(uw), int(uh)])
    Path(str(out) + ".json").write_text(json.dumps(meta))
    return meta


def selftest():
    assert tc_add("08:46:21:12", 13, 25) == "08:46:22:00"
    x = np.cumsum(np.ones((50, 1)), 0)   # a steady ramp passes through without lag
    assert np.abs(one_euro(x, 25)[5:-5] - x[5:-5]).max() < 0.5
    rng = np.random.default_rng(0)
    I = cv2.GaussianBlur(rng.random((240, 200, 3), np.float32), (0, 0), 2)
    p = rng.random((240, 200), np.float32)
    ref = cv2.ximgproc.guidedFilter(I, p, 9, 0.0016)
    assert np.abs(guided(I, [p], 9, 0.0016, s=1)[0][0] - ref)[20:-20, 20:-20].max() < 2e-3, "guided filter"
    Y = rng.integers(64, 940, (64, 48)).astype(np.uint16)
    U, V = (rng.integers(64, 960, (32, 24)).astype(np.uint16) for _ in range(2))
    img = yuv_to_rgb(Y, U, V)
    dy, du, dv = delta_yuv(img - img)
    assert not dy.any() and not du.any() and du.shape == (32, 24), "untouched pixels must stay the source's"
    import mediapipe  # noqa: F401  (the install is whole)
    print("selftest ok")


def main():
    global FFMPEG, FFPROBE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--ranges", help="A-B,C-D source frames to retouch (end exclusive)")
    ap.add_argument("--work", help="tracking cache folder (default: beside OUT)")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--workers", type=int, default=max(1, min(4, (os.cpu_count() or 4) // 4)), help="0 = in-process")
    ap.add_argument("--selftest", action="store_true")
    for key, val in DEFAULTS.items():
        ap.add_argument(f"--{key}", type=float, default=val)
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    FFMPEG, FFPROBE = a.ffmpeg, a.ffprobe
    ranges = [tuple(map(int, r.split("-"))) for r in a.ranges.split(",")]
    work = Path(a.work or str(a.out) + ".track")
    work.mkdir(parents=True, exist_ok=True)
    meta = render(a.source, a.out, ranges, work, {key: getattr(a, key) for key in DEFAULTS}, a.workers)
    print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    main()
`;
