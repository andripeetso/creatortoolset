"""One-time export of Meta's verified public SSCD model. No user media is used.

Requires Python with torch==2.11.0, onnx==1.19.1 and numpy==2.3.5.
Usage: python3 scripts/export-sscd.py /tmp/sscd.torchscript.pt runtime/sscd
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import torch

SOURCE_URL = "https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt"
SOURCE_SHA256 = "9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56"
source, destination = Path(sys.argv[1]), Path(sys.argv[2])
assert hashlib.sha256(source.read_bytes()).hexdigest() == SOURCE_SHA256, "Unrecognized source model"
destination.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(2)
torch.manual_seed(17)
model = torch.jit.load(str(source), map_location="cpu").eval()
sample = torch.randn(1, 3, 320, 320)
target = destination / "sscd.onnx"
with torch.no_grad():
    expected = model(sample).numpy()
    torch.onnx.export(model, sample, str(target), input_names=["image"],
                      output_names=["descriptor"], opset_version=17, dynamo=False)
np.savez(destination / "parity.npz", image=sample.numpy(), descriptor=expected)
# Plain floats also let the Node deployment verifier check TorchScript parity.
(destination / "parity.json").write_text(json.dumps({
    "image": sample.flatten().tolist(), "descriptor": expected.flatten().tolist()
}))
manifest = {"model": "sscd_disc_mixup", "source": SOURCE_URL,
            "sourceSha256": SOURCE_SHA256,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "dimensions": 512, "size": 320, "opset": 17,
            "torch": torch.__version__, "normalization": {
                "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]}}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
