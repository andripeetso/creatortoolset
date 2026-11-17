// The subject tracker's Python engine (subject.ts writes it to the data folder and runs it in its own venv).
export const ENGINE = String.raw`"""Subject tracker for the AI Editor's reframe: follows one thing (a game character, a player, a product) through each
shot of a stretch with SAM 2.1's video predictor on an NVIDIA graphics card, and prints where it is, frame by frame.

  python engine.py SOURCE --plan JSON --models DIR --ffmpeg PATH [--fps 10]
  python engine.py --selftest   loads the models and tracks a square across a made-up clip

--plan is each shot to follow, [{"s", "e", "seed"}] (seconds in SOURCE), tracked on its own from its seed (subject.ts
seedShots): a point the person clicked ({"t", "x", "y"}: x y fractions of the picture), or what a description names
({"t", "text"}), found by a text detector at t (a second later, or the shot's middle, when not there then); null: not
followed. A shot longer than CHUNK seconds is tracked in pieces, each seeded with the box the one before ended on.
Prints {"frames": [{"t", "box": [x, y, w, h] | null}], "seeded": [how each shot was]}, box as fractions of the picture.
"""

import argparse
import json
import os
import re
import subprocess

import numpy as np

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# the models, each at the commit it was measured with (Apache-2.0 both; THIRD_PARTY_NOTICES.md)
SAM = ("facebook/sam2.1-hiera-small", "ee5bba1d82bb8749febdf90f45e84b687142ba03")
DINO = ("IDEA-Research/grounding-dino-tiny", "a2bb814dd30d776dcf7e30523b00659f4f141c71")
# the picture SAM 2 reads is 1024 px on its long side; decoding at that size loses nothing it would see
SIDE = 1024
# the longest piece tracked in one go (s): the predictor keeps every frame's memory of a piece on the card
CHUNK = 10
# a box the text detector is less sure of than this is no seed; nor is one this big (a share of the picture: a wall, the
# whole frame), nor one on a frame this dark (a fade from black)
SURE = 0.4
BIGGEST = 0.5
DARK = 20
# a mask SAM 2 is less sure of than this (its object score, a logit) is "not in the picture"
SEEN = 0.0


def gpu():
    import torch

    if not torch.cuda.is_available():
        return None
    free, total = torch.cuda.mem_get_info()
    return {"name": torch.cuda.get_device_name(0), "free": free >> 20, "total": total >> 20}


def frames_of(ffmpeg, src, a, b, fps):
    """The frames from a to b seconds at fps, long side SIDE, as one uint8 array (n, h, w, 3)."""
    probe = subprocess.run([ffmpeg, "-hide_banner", "-ss", str(a), "-i", src, "-t", "0.01", "-f", "null", "-"], capture_output=True, text=True).stderr
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", probe)
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1920, 1080)
    rot = re.search(r"rotation of (-?\d+)", probe) or re.search(r"rotate\s*:\s*(-?\d+)", probe)
    if rot and abs(int(rot.group(1))) % 180 == 90:
        w, h = h, w
    k = SIDE / max(w, h)
    W, H = max(2, round(w * k / 2) * 2), max(2, round(h * k / 2) * 2)
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", str(a), "-i", src, "-t", str(max(0.1, b - a)), "-an", "-sn",
         "-vf", f"fps={fps},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    n = len(out) // (W * H * 3)
    return np.frombuffer(out[: n * W * H * 3], dtype=np.uint8).reshape(n, H, W, 3)


class Models:
    def __init__(self, models):
        import torch
        from transformers import Sam2VideoModel, Sam2VideoProcessor

        self.torch = torch
        self.dir = models
        self.sam = Sam2VideoModel.from_pretrained(SAM[0], revision=SAM[1], cache_dir=models).to("cuda", dtype=torch.bfloat16).eval()
        self.proc = Sam2VideoProcessor.from_pretrained(SAM[0], revision=SAM[1], cache_dir=models)
        self._dino = None

    def find(self, frame, text):
        """The box (px, x0 y0 x1 y1) of what the text names in the frame, the surest one, or None."""
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        if self._dino is None:
            self._dino = (
                AutoProcessor.from_pretrained(DINO[0], revision=DINO[1], cache_dir=self.dir),
                AutoModelForZeroShotObjectDetection.from_pretrained(DINO[0], revision=DINO[1], cache_dir=self.dir).to("cuda").eval(),
            )
        p, m = self._dino
        # the detector reads lower-case phrases ending in a full stop
        phrase = text.strip().lower().rstrip(".") + "."
        inputs = p(images=frame, text=phrase, return_tensors="pt").to("cuda")
        with self.torch.no_grad():
            out = m(**inputs)
        r = p.post_process_grounded_object_detection(out, inputs.input_ids, threshold=SURE, text_threshold=SURE, target_sizes=[frame.shape[:2]])[0]
        if not len(r["scores"]):
            return None
        return [float(v) for v in r["boxes"][int(r["scores"].argmax())]]

    def track(self, frames, k, point=None, box=None):
        """Boxes (fractions x0 y0 x1 y1) of the object at frame k (a point, or a box, px) in every frame, None where it is
        not seen. Read from the predictor's own 256 x 256 mask, which covers the whole picture."""
        torch = self.torch
        s = self.proc.init_video_session(video=list(frames), inference_device="cuda", video_storage_device="cpu", dtype=torch.bfloat16)
        size = frames.shape[1:3]
        if point is not None:
            self.proc.add_inputs_to_inference_session(s, frame_idx=k, obj_ids=1, input_points=[[[point]]], input_labels=[[[1]]], original_size=size)
        else:
            self.proc.add_inputs_to_inference_session(s, frame_idx=k, obj_ids=1, input_boxes=[[box]], original_size=size)
        boxes = [None] * len(frames)
        with torch.no_grad():
            self.sam(inference_session=s, frame_idx=k)
            for reverse in (False, True):
                for o in self.sam.propagate_in_video_iterator(s, start_frame_idx=k, reverse=reverse):
                    if o.object_score_logits is not None and float(o.object_score_logits.flatten()[0]) < SEEN:
                        continue
                    m = o.pred_masks[0, 0] > 0
                    n = m.shape[-1]
                    ys, xs = torch.nonzero(m, as_tuple=True)
                    if len(xs):
                        boxes[o.frame_idx] = [int(xs.min()) / n, int(ys.min()) / m.shape[-2], (int(xs.max()) + 1) / n, (int(ys.max()) + 1) / m.shape[-2]]
        return boxes


def sane(box, frame):
    """The detector's box when it can be a subject: not on a dark frame, not most of the picture."""
    if box is None or frame.mean() < DARK:
        return None
    H, W = frame.shape[:2]
    return box if (box[2] - box[0]) * (box[3] - box[1]) <= BIGGEST * W * H else None


def run(args):
    m = Models(args.models)
    frames_out, seeded = [], []
    for shot in json.loads(args.plan):
        s0, s1, seed = shot["s"], shot["e"], shot["seed"]
        n = max(1, round((s1 - s0) * args.fps))
        ts = [round(s0 + i / args.fps, 3) for i in range(n)]
        if not seed:
            seeded.append("none")
            frames_out += [{"t": t, "box": None} for t in ts]
            continue
        # the piece with the seed first, then outwards: each later piece seeded with the box its neighbour ended on
        pieces = [(max(s0, s0 + i * CHUNK), min(s1, s0 + (i + 1) * CHUNK)) for i in range(int(np.ceil((s1 - s0) / CHUNK)))]
        at = min(range(len(pieces)), key=lambda i: 0 if pieces[i][0] <= seed["t"] < pieces[i][1] else 1)
        got = {}
        order = [at] + list(range(at + 1, len(pieces))) + list(range(at - 1, -1, -1))
        how = "point" if "x" in seed else "text"
        for i in order:
            p0, p1 = pieces[i]
            fr = frames_of(args.ffmpeg, args.src, p0, p1, args.fps)
            if not len(fr):
                continue
            H, W = fr.shape[1:3]
            if i == at:
                k = min(len(fr) - 1, max(0, round((seed["t"] - p0) * args.fps)))
                if "x" in seed:
                    b = m.track(fr, k, point=[seed["x"] * W, seed["y"] * H])
                else:
                    # the frame at t, else a second on, else the piece's middle: the first that shows what the text names
                    box = None
                    for k in dict.fromkeys(min(len(fr) - 1, j) for j in (k, k + round(args.fps), len(fr) // 2)):
                        box = sane(m.find(fr[k], seed["text"]), fr[k])
                        if box:
                            break
                    if box is None:
                        how = "not found"
                        break
                    b = m.track(fr, k, box=box)
            else:
                # the neighbour's box at the edge they share
                edge = got.get(round(p0 - 1 / args.fps, 3)) if i > at else got.get(round(p1, 3))
                if edge is None:
                    continue
                k = 0 if i > at else len(fr) - 1
                b = m.track(fr, k, box=[edge[0] * W, edge[1] * H, (edge[0] + edge[2]) * W, (edge[1] + edge[3]) * H])
            for j, bx in enumerate(b):
                if bx is not None:
                    got[round(p0 + j / args.fps, 3)] = [bx[0], bx[1], bx[2] - bx[0], bx[3] - bx[1]]
        seeded.append(how)
        frames_out += [{"t": t, "box": [round(v, 4) for v in got[t]] if t in got else None} for t in ts]
    return {"frames": frames_out, "seeded": seeded}


def selftest(models, ffmpeg):
    import tempfile

    d = tempfile.mkdtemp()
    src = os.path.join(d, "sq.mp4")
    # a white square crossing a dark picture, left to right, in 2 s
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x202020:s=640x360:d=2:r=10", "-f", "lavfi", "-i", "color=c=white:s=80x80:d=2:r=10",
                    "-filter_complex", "[0][1]overlay=x='40+t*250':y=140", "-pix_fmt", "yuv420p", "-y", src], check=True)
    plan = [{"s": 0, "e": 2, "seed": {"t": 0, "x": 80 / 640, "y": 180 / 360}}]
    a = argparse.Namespace(src=src, plan=json.dumps(plan), fps=10, models=models, ffmpeg=ffmpeg)
    out = run(a)["frames"]
    last = out[-1]["box"]
    assert last and abs(last[0] + last[2] / 2 - (80 + 1.9 * 250) / 640) < 0.08, out[-1]
    print(json.dumps({"ok": True, **gpu()}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?")
    ap.add_argument("--fps", type=float, default=10)
    ap.add_argument("--plan", default="[]")
    ap.add_argument("--models", default=os.environ.get("SUBJECT_MODELS", "models"))
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest(a.models, a.ffmpeg)
    print(json.dumps(run(a)))


if __name__ == "__main__":
    main()
`;
