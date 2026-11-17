#!/usr/bin/env python3
"""
The Media Library's cut model for the Mac app (Sources/CreatorToolsetMac/CutModel.swift): TransNetV2 (MIT) as a Core ML
model that runs on the Mac's graphics card. Run it on a Mac:

    python3 -m venv venv && venv/bin/pip install coremltools==8.3.0 torch==2.5.1 "numpy<2.2" onnx onnxruntime
    venv/bin/python apps/mac/scripts/transnetv2-coreml.py <work folder>

It takes the weights from the same ONNX export the server uses (apps/captions/api/library/cuts.ts TRANSNET, an export
of the upstream PyTorch port) and loads them into that port (soCzech/TransNetV2, both pinned by SHA-256), checks the
port against the ONNX file, converts it (FP16 ML program), checks the Core ML model on the graphics card against the
ONNX file on frames with cuts in them, and writes <work>/TransNetV2.mlpackage.zip with its SHA-256. Publish that zip
where CutModel.swift fetches it, and pin its SHA-256 there.

The colour histogram (a scatter-add, which Core ML can't run) is a second input, made outside the model: for each
frame, the count of its pixels in each of 512 colours (R, G and B >> 5), divided by the counts' length (L2).
"""
import hashlib
import re
import subprocess
import sys
import types
import urllib.request
from pathlib import Path

import coremltools as ct
import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import numpy_helper

ONNX = (
    "https://huggingface.co/elya5/transnetv2/resolve/e1cfcb717af91e41ffb84b5fd851505682c576ee/transnetv2.onnx",
    "c4d54a682bace32f25136ef83ca2c9d403e8f8193775efeb995172a0d95a8e0c",
)
PORT = (
    "https://raw.githubusercontent.com/soCzech/TransNetV2/85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed/inference-pytorch/transnetv2_pytorch.py",
    "f7c1d437465579a8ec28a5add19853d2cb2755248ea4a4207678210a609428e1",
)
WIN, H, W = 100, 27, 48


def fetch(work: Path, url: str, sha: str) -> Path:
    out = work / url.rsplit("/", 1)[1]
    if not out.exists() or hashlib.sha256(out.read_bytes()).hexdigest() != sha:
        urllib.request.urlretrieve(url, out)
    got = hashlib.sha256(out.read_bytes()).hexdigest()
    assert got == sha, f"{out.name}: SHA-256 {got}, expected {sha}"
    return out


def hist(frames: np.ndarray) -> np.ndarray:
    """[1, WIN, H, W, 3] 0-255 → [1, WIN, 512]: each frame's colour histogram, L2-normalised (CutModel.swift hist)."""
    b = frames.astype(np.int32) >> 5
    b = (b[..., 0] << 6) + (b[..., 1] << 3) + b[..., 2]
    h = np.stack([np.bincount(f.reshape(-1), minlength=512) for f in b[0]]).astype(np.float32)[None]
    return h / np.linalg.norm(h, axis=2, keepdims=True)


def clip(seed: int) -> np.ndarray:
    """WIN frames of four shots (hard cuts after frames 29, 54 and 79): each a colour gradient with a disc moving across."""
    rng = np.random.RandomState(seed)
    out = np.zeros((1, WIN, H, W, 3), np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    for a, b in [(0, 30), (30, 55), (55, 80), (80, WIN)]:
        c0, c1, c2 = rng.randint(0, 255, (3, 3))
        cx, cy, r = rng.randint(10, 38), rng.randint(8, 19), rng.randint(4, 9)
        for t in range(a, b):
            f = (xx / W)[..., None] * c1 + (1 - xx / W)[..., None] * c0
            f[(xx - cx - (t - a) * 0.4) ** 2 + (yy - cy) ** 2 < r * r] = c2
            out[0, t] = f.round()
    return out


def main(work: Path) -> None:
    work.mkdir(parents=True, exist_ok=True)
    onnx_file = fetch(work, *ONNX)
    # the port as published, less its check that frames come as uint8 (the Core ML model takes them as floats 0-255)
    src = fetch(work, *PORT).read_text()
    check = re.search(r"\n +assert isinstance\(inputs, torch.Tensor\).*?shape\"\n", src, re.S)
    assert check, "the port's input check moved: look at its forward"
    T = types.ModuleType("transnetv2_pytorch")
    exec(compile(src.replace(check[0], "\n"), "transnetv2_pytorch.py", "exec"), T.__dict__)

    # the ONNX file's weights by the port's names: its MatMul weights are the Linear layers' (transposed), named by the
    # bias added after them
    g = onnx.load(str(onnx_file)).graph
    inits = {i.name: numpy_helper.to_array(i) for i in g.initializer}
    after = {i: n for n in g.node for i in n.input}
    state = {k.removeprefix("model."): torch.from_numpy(v.copy()) for k, v in inits.items() if k.startswith("model.")}
    for n in g.node:
        w = next((i for i in n.input if i.startswith("onnx::MatMul")), None)
        if n.op_type == "MatMul" and w:
            bias = next(i for i in after[n.output[0]].input if i.endswith(".bias"))
            state[bias.removeprefix("model.").removesuffix(".bias") + ".weight"] = torch.from_numpy(inits[w].T.copy())
    for k in [k for k in T.TransNetV2().state_dict() if k.endswith("num_batches_tracked")]:
        state[k] = torch.tensor(0)
    net = T.TransNetV2()
    net.load_state_dict(state, strict=True)
    net.eval()

    ref = ort.InferenceSession(str(onnx_file), providers=["CPUExecutionProvider"])
    x = clip(0)
    want = ref.run(None, {"input": x})
    with torch.no_grad():
        one, many = net(torch.from_numpy(x.astype(np.uint8)))
    d = max(float(np.abs(torch.sigmoid(o).numpy() - r).max()) for o, r in zip([one, many["many_hot"]], want))
    print(f"port vs ONNX: largest difference {d:.2e}")
    assert d < 1e-4

    given = {}
    T.ColorHistograms.compute_color_histograms = staticmethod(lambda frames: given["hist"])

    class WithHist(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.net = net

        def forward(self, frames, hist):
            given["hist"] = hist
            one, more = self.net(frames)
            return torch.sigmoid(one), torch.sigmoid(more["many_hot"])

    traced = torch.jit.trace(WithHist().eval(), (torch.tensor(x), torch.tensor(hist(x))))
    ml = ct.convert(
        traced,
        inputs=[ct.TensorType(name="frames", shape=(1, WIN, H, W, 3)), ct.TensorType(name="hist", shape=(1, WIN, 512))],
        outputs=[ct.TensorType(name="one"), ct.TensorType(name="many")],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS13,
    )
    ml.short_description = "TransNetV2 shot boundaries (MIT, Copyright (c) 2020 Tomáš Souček): 100 frames 48×27 RGB 0-255 and their colour histograms → each frame's odds of a cut (one) and of being in a transition (many)"
    pkg = work / "TransNetV2.mlpackage"
    subprocess.run(["rm", "-rf", str(pkg)], check=True)
    ml.save(str(pkg))

    gpu = ct.models.MLModel(str(pkg), compute_units=ct.ComputeUnit.CPU_AND_GPU)
    for seed in range(3):
        x = clip(seed)
        want = ref.run(None, {"input": x})
        got = gpu.predict({"frames": x, "hist": hist(x)})
        d = max(float(np.abs(got[k].reshape(-1) - r.reshape(-1)).max()) for k, r in zip(["one", "many"], want))
        cuts = [i for i in range(WIN) if got["one"].reshape(-1)[i] > 0.5]
        print(f"clip {seed}: Core ML on the graphics card vs ONNX: largest difference {d:.3f}; cut frames {cuts}")
        assert d < 0.02 and cuts == [29, 54, 79], cuts

    out = work / "TransNetV2.mlpackage.zip"
    out.unlink(missing_ok=True)
    subprocess.run(["ditto", "-c", "-k", "--keepParent", str(pkg), str(out)], check=True)
    print(f"{out} ({out.stat().st_size / 1e6:.1f} MB) SHA-256 {hashlib.sha256(out.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("transnetv2-coreml"))
