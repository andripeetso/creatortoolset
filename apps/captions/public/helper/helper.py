#!/usr/bin/env python3
"""Creator Toolset helper: a Linux computer (with or without an NVIDIA graphics card) that turns speech into text for
its owner's Creator Toolset server, with models it downloads itself.

  helper.py pair <server> <code>   swap the one-time code from Settings → Devices → Add a computer for this computer's token
  helper.py run                    take transcripts until stopped (the systemd --user unit runs this)

Its folder is $CT_HELPER_HOME, else ~/.local/share/creator-toolset-helper: config.json (the server and the token, mode
0600), models/<id>/ (one folder per model; a model is ready once its .done file is there) and hf/ (the download
library's own cache). Nothing else is written.
The road it speaks is the server's contracts/devices.ts (TRANSCRIBE_KIND).
"""
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave

VERSION = "1"
HOME = os.environ.get("CT_HELPER_HOME") or os.path.expanduser("~/.local/share/creator-toolset-helper")
CONFIG = os.path.join(HOME, "config.json")
MODELS = os.path.join(HOME, "models")
# Hugging Face's own cache and logs go in this folder too, not ~/.cache
os.environ.setdefault("HF_HOME", os.path.join(HOME, "hf"))
KIND = "transcribe"
# exit status when the server no longer knows this computer (removed in Devices): the unit does not restart on it
REMOVED = 3

# The models the server may ask for (contracts/voice.ts STT_MODELS with `computer`): id → (Hugging Face repo, runtime).
# A test on the server checks these against the catalog's `download`.
CATALOG = {
    "whisper-large-v3-turbo": ("deepdml/faster-whisper-large-v3-turbo-ct2", "faster-whisper"),
    "whisper-large-v3": ("Systran/faster-whisper-large-v3", "faster-whisper"),
    "parakeet-tdt-0.6b-v3": ("istupakov/parakeet-tdt-0.6b-v3-onnx", "onnx-asr"),
}
RETRY_DOWNLOAD_S = 300
REPORT_EVERY_S = 60


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Removed(Exception):
    pass


def call(server, token, method, path, body=None, raw=False, timeout=60):
    headers = {"content-type": "application/json", "user-agent": f"creator-toolset-helper/{VERSION}"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(server + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 401 and token:
            raise Removed() from e
        detail = e.read().decode(errors="replace")[:300]
        try:
            detail = json.loads(detail)["error"]  # the server's own sentence
        except Exception:
            pass
        raise RuntimeError(f"{detail} ({e.code} on {path})") from e
    return data if raw else (json.loads(data) if data else None)


# ---- pairing ----

def pair(server, code):
    server = server.rstrip("/")
    name = socket.gethostname()
    try:
        r = call(server, None, "POST", "/api/devices/pair", {"code": code, "name": name, "version": VERSION})
    except (RuntimeError, OSError) as e:
        sys.exit(f"Not paired: {e}")
    os.makedirs(HOME, exist_ok=True)
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"server": server, "token": r["token"]}, f)
    print(f"Paired as {name}. It shows up in Settings → Devices once it runs (systemctl --user start creator-toolset-helper).")


# ---- what this computer is ----

def gpu():
    """The NVIDIA card's name, memory and free memory in GB, or None."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        name, total, free = [x.strip() for x in out[0].split(",")]
        return name, int(total) / 1024, int(free) / 1024
    except Exception:
        return None


def machine():
    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            mem[k] = int(v.split()[0]) / 1048576  # kB → GB
    cpu = ""
    with open("/proc/cpuinfo") as f:
        for line in f:
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    cpus = os.cpu_count() or 1
    m = {"os": "linux", "host": socket.gethostname(), "cpu": cpu, "cpus": cpus, "load": min(1, os.getloadavg()[0] / cpus),
         "memGb": mem.get("MemTotal", 1), "freeGb": mem.get("MemAvailable", 0)}
    g = gpu()
    if g:
        m.update(gpu=g[0], gpuMemGb=g[1], gpuFreeGb=g[2])
    return m


def cuda_libs():
    """The CUDA libraries pip put in this venv (nvidia-*-cu12), which CTranslate2 loads by name."""
    import site
    dirs = []
    for sp in site.getsitepackages():
        base = os.path.join(sp, "nvidia")
        if os.path.isdir(base):
            dirs += [os.path.join(base, d, "lib") for d in sorted(os.listdir(base)) if os.path.isdir(os.path.join(base, d, "lib"))]
    return dirs


# ---- models ----

def model_dir(mid):
    return os.path.join(MODELS, mid)


def held():
    return [m for m in CATALOG if os.path.exists(os.path.join(model_dir(m), ".done"))]


class Runner:
    """Runs one model at a time; the last one stays loaded for the next transcript."""

    def __init__(self):
        self.loaded = (None, None)
        self.cuda = gpu() is not None

    def model(self, mid, cuda):
        if self.loaded[0] == (mid, cuda):
            return self.loaded[1]
        self.loaded = (None, None)
        runtime = CATALOG[mid][1]
        if runtime == "faster-whisper":
            from faster_whisper import WhisperModel
            m = WhisperModel(model_dir(mid), device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")
        else:
            # ONNX Runtime's CPU build: its CUDA build wants other CUDA libraries than CTranslate2's, and Parakeet is quick on a CPU
            import onnx_asr
            m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path=model_dir(mid), providers=["CPUExecutionProvider"]).with_timestamps()
        self.loaded = ((mid, cuda), m)
        return m

    def transcribe(self, mid, pcm, languages):
        """The words, and whether the graphics card made them."""
        if self.cuda and CATALOG[mid][1] == "faster-whisper":
            try:
                return self._run(mid, pcm, languages, True), True
            except Exception as e:
                msg = str(e).lower()
                if not any(w in msg for w in ("cuda", "cublas", "cudnn", "libcu", "gpu", "out of memory")):
                    raise
                self.loaded = (None, None)
                # a missing CUDA library (it often shows here, not when the model loads) is for good; a full card is for now
                if any(w in msg for w in ("cannot be loaded", "not found", "cannot open shared object")):
                    log("graphics card can't be used, from now on the CPU:", str(e)[:200])
                    self.cuda = False
                else:
                    log("graphics card failed on this one, it runs on the CPU:", str(e)[:200])
        return self._run(mid, pcm, languages, False), False

    def _run(self, mid, pcm, languages, cuda):
        m = self.model(mid, cuda)
        if CATALOG[mid][1] == "faster-whisper":
            segs, info = m.transcribe(pcm, word_timestamps=True, language=languages[0] if len(languages) == 1 else None)
            words = [{"text": w.word.strip(), "start": w.start, "end": w.end} for s in segs for w in (s.words or []) if w.word.strip()]
            return {"words": words, "language": info.language}
        # Parakeet hears English only (the server sends it English only); in pieces, so a long recording fits in memory.
        # ponytail: a word cut by a piece's edge comes back as two; cut at silences (onnx-asr's VAD) if that shows in transcripts
        words, piece = [], 16000 * 120
        for at in range(0, len(pcm), piece):
            res = m.recognize(pcm[at:at + piece], sample_rate=16000)
            words += parakeet_words(res, at / 16000)
        return {"words": words, "language": "en"}


def parakeet_words(res, offset):
    """onnx-asr gives tokens and their start times; a token that starts with a space (or "▁") starts a word."""
    words = []
    for tok, start in zip(res.tokens, res.timestamps):
        if tok[:1] in (" ", "▁") or not words:
            words.append({"text": tok.lstrip(" ▁"), "start": offset + float(start), "end": None})
        else:
            words[-1]["text"] += tok
    for i, w in enumerate(words):
        w["end"] = words[i + 1]["start"] if i + 1 < len(words) else w["start"] + 0.3
    return [w for w in words if w["text"]]


def read_wav(data):
    """The server sends 16 kHz mono 16-bit WAV: read with the standard library, so no audio library is needed."""
    import io
    import numpy
    with wave.open(io.BytesIO(data)) as w:
        return numpy.frombuffer(w.readframes(w.getnframes()), dtype=numpy.int16).astype(numpy.float32) / 32768


# ---- the road to the server ----

class Helper:
    def __init__(self, server, token):
        self.server, self.token = server, token
        self.lock = threading.Lock()  # one claim at a time, and the download state
        self.getting = set()  # downloading now, or failed and waiting to try again
        self.failed = {}  # id → when to try again
        self.busy = None  # the model a transcript is using now (never deleted under it)
        self.jobs = queue.Queue()
        self.runner = Runner()
        self.stop = None  # the reason to stop (Removed)

    def call(self, *a, **k):
        return call(self.server, self.token, *a, **k)

    def claim(self):
        """Says what it has and is downloading, takes a transcript if one waits, and does what its owner wants. False when
        nothing came of it (a wish it can't follow now: the model a transcript is using, or one this helper doesn't know)."""
        did = False
        with self.lock:
            for _ in range(3):
                r = self.call("POST", "/api/devices/relay/editor/claim", {"kinds": [KIND], "models": held(), "getting": sorted(self.getting)})
                if r.get("job"):
                    self.jobs.put(r["job"])
                    did = True
                if not self.sync(r.get("models") or []):
                    return did
                did = True
        return did

    def sync(self, wanted):
        """Deletes each model it has that is not wanted (its own folder only), starts a download for each wanted one it
        lacks. True when what it has changed, so the server is told at once."""
        changed = False
        for m in [m for m in self.failed if m not in wanted]:  # a failed download no longer wanted is not tried again
            del self.failed[m]
            self.getting.discard(m)
            changed = True
        for m in held():
            if m not in wanted and m != self.busy:
                log("removing", m)
                shutil.rmtree(model_dir(m), ignore_errors=True)
                changed = True
        for m in wanted:
            if m in CATALOG and m not in held() and m not in self.getting:
                self.getting.add(m)
                threading.Thread(target=self.download, args=(m,), daemon=True).start()
                changed = True
        return changed

    def download(self, mid):
        try:
            from huggingface_hub import snapshot_download
            log("downloading", mid, "from", CATALOG[mid][0])
            snapshot_download(CATALOG[mid][0], local_dir=model_dir(mid))
            open(os.path.join(model_dir(mid), ".done"), "w").close()
            log("downloaded", mid)
            with self.lock:
                self.getting.discard(mid)
        except Exception as e:
            # it stays in `getting` (so its owner's wish does not wake every poll) and is tried again later
            log("download failed:", mid, str(e)[:300])
            with self.lock:
                self.failed[mid] = time.time() + RETRY_DOWNLOAD_S
            return
        self.safe(self.claim)

    def retry_downloads(self):
        now = time.time()
        with self.lock:
            due = [m for m, t in self.failed.items() if t <= now]
            for m in due:
                del self.failed[m]
                threading.Thread(target=self.download, args=(m,), daemon=True).start()

    def work(self):
        """One transcript at a time, in the order claimed."""
        while True:
            job = self.jobs.get()
            jid = job["id"]
            try:
                if job.get("kind") != KIND or job.get("model") not in held():
                    raise RuntimeError(f"This computer does not have {job.get('model')}")
                self.busy = job["model"]
                audio = self.call("GET", f"/api/devices/relay/transcribe/{jid}", raw=True, timeout=600)
                t0 = time.time()
                out, gpu_used = self.runner.transcribe(job["model"], read_wav(audio), job.get("languages") or [])
                log(f"transcript {jid}: {len(out['words'])} words, {len(audio) / 32000:.0f} s of audio in {time.time() - t0:.1f} s",
                    "on the graphics card" if gpu_used else "on the CPU")
                r = self.safe(self.call, "POST", f"/api/devices/relay/transcribe/{jid}", out)
            except Removed:
                self.stop = Removed()
                return
            except Exception as e:
                log(f"transcript {jid} failed:", str(e)[:300])
                r = self.safe(self.call, "POST", f"/api/devices/relay/transcribe/{jid}/fail", {"error": str(e)[:300] or type(e).__name__})
            finally:
                self.busy = None
            if r and r.get("editor"):
                self.safe(self.claim)

    def safe(self, fn, *a, **k):
        """Calls fn; a lost connection is logged (the poll tries again), a removed computer stops the helper."""
        try:
            return fn(*a, **k)
        except Removed:
            self.stop = Removed()
        except Exception as e:
            log("server:", str(e)[:300])
        return None

    def report(self):
        self.call("POST", "/api/devices/relay/report", {"drivers": [], "homes": [], "machine": machine(), "version": VERSION})

    def run(self):
        os.makedirs(MODELS, exist_ok=True)
        threading.Thread(target=self.work, daemon=True).start()
        log(f"Creator Toolset helper {VERSION} for {self.server}, models in {MODELS},", "graphics card:", (gpu() or ["none"])[0])
        reported, failures = 0.0, 0
        while not self.stop:
            try:
                if time.time() - reported > REPORT_EVERY_S:
                    self.report()
                    reported = time.time()
                    self.claim()
                self.retry_downloads()
                # the server holds this for up to 25 s: as long as it runs the computer is online, also while it downloads or transcribes
                r = self.call("POST", "/api/devices/relay/wait", {"blobs": False, "editor": [KIND]})
                failures = 0
                if r and r.get("editor"):
                    # the server hints again while a wish stays open: wait a little instead of asking at once
                    if not self.claim():
                        time.sleep(5)
                elif r and r.get("id"):
                    # an AI request: this computer runs no AI tools, so it says so at once instead of letting it wait
                    self.call("POST", f"/api/devices/relay/{r['id']}/fail", {"error": "This computer runs speech models only"})
            except Removed:
                break
            except Exception as e:
                failures += 1
                log("server:", str(e)[:300])
                time.sleep(min(60, 2 ** failures))
        log("This computer was removed in Settings → Devices. Pair it again with a new code.")
        sys.exit(REMOVED)


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "pair":
        return pair(sys.argv[2], sys.argv[3])
    if len(sys.argv) == 2 and sys.argv[1] == "run":
        # CTranslate2 and ONNX Runtime find the CUDA libraries pip installed only through the loader's path: set it and start again
        libs = [d for d in cuda_libs() if d not in os.environ.get("LD_LIBRARY_PATH", "").split(":")]
        if libs:
            env = dict(os.environ, LD_LIBRARY_PATH=":".join(libs + [p for p in os.environ.get("LD_LIBRARY_PATH", "").split(":") if p]))
            os.execve(sys.executable, [sys.executable, *sys.argv], env)
        try:
            with open(CONFIG) as f:
                c = json.load(f)
        except FileNotFoundError:
            sys.exit(f"Not paired yet: run {sys.argv[0]} pair <server> <code> first (the code is in Settings → Devices → Add a computer).")
        return Helper(c["server"], c["token"]).run()
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
