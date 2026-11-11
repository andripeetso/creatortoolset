// The Blur faces engine (Python, run in the face steps' shared venv), kept as text so the plug-in folder stays one bundle.
// Edit it as Python: no backticks and no dollar-brace in it, since it sits in a String.raw template.
export const ENGINE = String.raw`"""Blur faces engine, for the AI Editor's Blur faces step.

  python engine.py detect SOURCE OUT.json --ranges A-B,C-D [--ffmpeg PATH] [--ffprobe PATH]
  python engine.py render SOURCE OUT.mov --ellipses E.json --look blur|pixels [--ffmpeg PATH] [--ffprobe PATH]
  python engine.py --selftest

detect: MediaPipe's face detector on every other frame inside the ranges (source frames, 0-based, end exclusive), on the whole
frame and on two grids of overlapping tiles, so a small face in the background is found too. OUT.json: the file's size,
frame rate and frame count, and per frame the boxes [x, y, w, h, score] in upright full-size pixels.

render: OUT is the whole file again, every frame, as ProRes 422 HQ 10-bit with the source's size, frame rate, timecode
and sound. E.json is {frame: [[cx, cy, rx, ry], ...]}: each ellipse is covered whole and its edge fades out over a
quarter of its size. Every pixel outside them is the source's own.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

MODELS = Path(os.environ.get("FACE_BLUR_MODELS") or Path(__file__).parent)
FFMPEG, FFPROBE = "ffmpeg", "ffprobe"
HW = ["-hwaccel", "videotoolbox"] if sys.platform == "darwin" else []
DETECT_SHORT = 1080   # detection runs on frames no bigger than this on the short side
FEATHER = 0.25        # the soft edge, as a share of the ellipse's size, outside it
EVERY = 2             # detect on every EVERYth frame of a range (and its last): the tracks fill in between
ACROSS = 9            # what is left of a face: about this many samples (blur) or blocks (pixels) across it


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


def decode(video, args):
    """ffmpeg reading the whole file from its first frame, in order."""
    return subprocess.Popen([FFMPEG, "-v", "error", "-nostdin", *HW, "-i", str(video),
                             "-fps_mode", "passthrough", *args, "-f", "rawvideo", "-"], stdout=subprocess.PIPE)


# --- detect --------------------------------------------------------------------------------------------------------
def tiles(W, H):
    """(x, y, side) squares: the whole frame, then halves and thirds of the short side, overlapping by a quarter."""
    out = [(0, 0, 0)]
    for side in (min(W, H) // 2, min(W, H) // 3):
        st = max(1, int(side * 0.75))
        xs = sorted(set(list(range(0, max(1, W - side), st)) + [W - side]))
        ys = sorted(set(list(range(0, max(1, H - side), st)) + [H - side]))
        out += [(x, y, side) for y in ys for x in xs]
    return out


def iou(a, b):
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    i = ix * iy
    return i / max(1e-6, min(a[2] * a[3], b[2] * b[3]))   # of the smaller: a face cut by a tile's edge joins its whole


def merge(boxes):
    """Boxes of one face from the frame and its tiles become one: their average, weighted by score."""
    boxes = sorted(boxes, key=lambda b: -b[4])
    out = []
    for b in boxes:
        for g in out:
            if iou(g[0], b) > 0.5:
                g.append(b)
                break
        else:
            out.append([b])
    res = []
    for g in out:
        w = np.array([b[4] for b in g])
        m = (np.array([b[:4] for b in g]) * w[:, None]).sum(0) / w.sum()
        res.append([*[round(float(v), 1) for v in m], round(float(max(w)), 3)])
    return res


def detect(video, out, ranges):
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    info = probe(video)
    W0, H0, N = info["w"], info["h"], info["frames"]
    ranges = [(max(0, a), min(N, b)) for a, b in ranges if min(N, b) > max(0, a)]
    s = min(1.0, DETECT_SHORT / min(W0, H0))
    W, H = int(W0 * s) // 2 * 2, int(H0 * s) // 2 * 2
    kx, ky = W0 / W, H0 / H
    det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=str(MODELS / "blaze_face_short_range.tflite")),
        min_detection_confidence=0.6))
    grid = tiles(W, H)
    found, n_read = {}, 0
    if ranges:
        sel = "+".join(f"between(n\\,{a}\\,{b - 1})" for a, b in ranges)
        dec = decode(video, ["-vf", f"select={sel},scale={W}:{H}:flags=area", "-pix_fmt", "rgb24"])
        try:
            for a, b in ranges:
                for n in range(a, b):
                    raw = dec.stdout.read(W * H * 3)
                    if len(raw) < W * H * 3:
                        break
                    n_read += 1
                    if (n - a) % EVERY and n != b - 1:
                        continue
                    img = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
                    boxes = []
                    for x, y, side in grid:
                        crop = img if not side else np.ascontiguousarray(img[y:y + side, x:x + side])
                        for d in det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)).detections:
                            bb = d.bounding_box
                            x0, y0 = max(0, x + bb.origin_x), max(0, y + bb.origin_y)
                            x1, y1 = min(W, x + bb.origin_x + bb.width), min(H, y + bb.origin_y + bb.height)
                            if x1 - x0 > 4 and y1 - y0 > 4:
                                boxes.append((x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, d.categories[0].score))
                    if boxes:
                        found[str(n)] = merge(boxes)
        finally:
            dec.stdout.close(); dec.wait()
        want = sum(b - a for a, b in ranges)
        assert n_read == want, f"decoded {n_read} of {want} frames"
    meta = dict(w=W0, h=H0, fps=info["fps"], frames=N, tc=info["tc"], dets=found)
    Path(out).write_text(json.dumps(meta))
    return meta


# --- render --------------------------------------------------------------------------------------------------------
def alpha(shape, cx, cy, rx, ry):
    """1 inside the ellipse, fading to 0 at (1 + FEATHER) times its size, smoothly."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx + 0.5 - cx) / max(rx, 1e-3)) ** 2 + ((yy + 0.5 - cy) / max(ry, 1e-3)) ** 2)
    t = np.clip((1 + FEATHER - d) / FEATHER, 0, 1)
    return t * t * (3 - 2 * t)


def hide(region, across, look):
    """The region with the face's detail gone: down to about ACROSS samples across the face, then back up."""
    h, w = region.shape
    k = max(2.0, across / ACROSS)   # source pixels per sample
    sw, sh = max(1, round(w / k)), max(1, round(h / k))
    small = cv2.resize(region.astype(np.float32), (sw, sh), interpolation=cv2.INTER_AREA)
    if look == "pixels":
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    small = cv2.GaussianBlur(small, (0, 0), 1.0)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)


def cover(plane, cx, cy, rx, ry, look):
    """Blurs one ellipse into one plane (uint16, in place). Coordinates in this plane's pixels."""
    H, W = plane.shape
    m = 1 + FEATHER
    x0, x1 = max(0, int(cx - rx * m) - 1), min(W, int(cx + rx * m) + 2)
    y0, y1 = max(0, int(cy - ry * m) - 1), min(H, int(cy + ry * m) + 2)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    reg = plane[y0:y1, x0:x1]
    a = alpha(reg.shape, cx - x0, cy - y0, rx, ry)
    out = reg * (1 - a) + hide(reg, 2 * rx, look) * a
    plane[y0:y1, x0:x1] = np.clip(out + 0.5, 0, 1023).astype(np.uint16)


def encoder_args():
    out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    if "prores_videotoolbox" in out:
        return ["-c:v", "prores_videotoolbox", "-profile:v", "hq", "-pix_fmt", "p210le"]
    return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]


def render(video, out, ellipses, look):
    info = probe(video)
    W, H, fps, N = info["w"], info["h"], info["fps"], info["frames"]
    col = info["col"]
    enc = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-nostdin", "-i", str(video),
                            "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-s", f"{W}x{H}", "-r", str(fps), *col, "-i", "-",
                            "-map", "1:v", "-map", "0:a?", "-c:a", "copy", "-map_metadata", "0", "-r", str(fps),
                            *encoder_args(), *col, "-timecode", info["tc"], "-f", "mov", str(out)], stdin=subprocess.PIPE)
    dec = decode(video, ["-pix_fmt", "yuv420p10le"])
    n_y, n_c = W * H, (W // 2) * (H // 2)
    fsize = (n_y + 2 * n_c) * 2
    nf = 0
    try:
        while True:
            raw = dec.stdout.read(fsize)
            if len(raw) < fsize:
                break
            todo = ellipses.get(str(nf))
            if todo:
                a = np.frombuffer(raw, np.uint16).copy()
                Y = a[:n_y].reshape(H, W)
                U, V = a[n_y:n_y + n_c].reshape(H // 2, W // 2), a[n_y + n_c:].reshape(H // 2, W // 2)
                for cx, cy, rx, ry in todo:
                    cover(Y, cx, cy, rx, ry, look)
                    for c in (U, V):
                        cover(c, cx / 2, cy / 2, rx / 2, ry / 2, look)
                raw = a.data
            enc.stdin.write(raw)
            nf += 1
    finally:
        dec.stdout.close(); dec.wait()
        enc.stdin.close()
    assert enc.wait() == 0, "ffmpeg could not write the blurred file"
    assert nf == N, f"decoded {nf} of {N} frames"
    meta = dict(frames=N, timecode=info["tc"], fps=fps)
    Path(str(out) + ".json").write_text(json.dumps(meta))
    return meta


def selftest():
    assert tiles(1080, 1920)[0] == (0, 0, 0) and all(x + s <= 1080 and y + s <= 1920 for x, y, s in tiles(1080, 1920))
    # a face found whole and cut at a tile's edge is one face; two faces apart stay two
    assert len(merge([(100, 100, 80, 80, 0.9), (110, 100, 60, 75, 0.7), (400, 100, 80, 80, 0.8)])) == 2
    rng = np.random.default_rng(0)
    plane = rng.integers(64, 940, (200, 300)).astype(np.uint16)
    before = plane.copy()
    cover(plane, 150, 100, 30, 40, "blur")
    assert (plane[:, :100] == before[:, :100]).all(), "pixels outside the ellipse stay the source's"
    assert plane[90:110, 140:160].std() < before[90:110, 140:160].std() / 3, "the face's detail is gone"
    a = alpha((100, 100), 50, 50, 20, 20)
    assert a[50, 50] == 1 and a[50, 50 + 19] == 1 and a[50, 99] == 0
    import mediapipe  # noqa: F401  (the install is whole)
    print("selftest ok")


def main():
    global FFMPEG, FFPROBE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", choices=["detect", "render"])
    ap.add_argument("source", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--ranges", default="", help="A-B,C-D source frames to look at (end exclusive)")
    ap.add_argument("--ellipses", help="JSON file: {frame: [[cx, cy, rx, ry], ...]}")
    ap.add_argument("--look", default="blur", choices=["blur", "pixels"])
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    FFMPEG, FFPROBE = a.ffmpeg, a.ffprobe
    if a.command == "detect":
        ranges = [tuple(map(int, r.split("-"))) for r in a.ranges.split(",") if r]
        meta = detect(a.source, a.out, ranges)
        print(json.dumps({k: v for k, v in meta.items() if k != "dets"}), flush=True)
    else:
        meta = render(a.source, a.out, json.loads(Path(a.ellipses).read_text()), a.look)
        print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    main()
`;
