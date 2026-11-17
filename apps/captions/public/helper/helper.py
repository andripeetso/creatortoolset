#!/usr/bin/env python3
"""Creator Toolset helper: a Linux computer (with or without an NVIDIA graphics card) that turns speech into text for
its owner's Creator Toolset server, with models it downloads itself, and keeps copies of its Media Library in folders here.

  helper.py pair <server> <code>   swap the one-time code from Settings → Devices → Add a computer for this computer's token
  helper.py run                    take transcripts until stopped (the systemd --user unit runs this)

Its folder is $CT_HELPER_HOME, else ~/.local/share/creator-toolset-helper: config.json (the server and the token, mode
0600), models/<id>/ (one folder per model; a model is ready once its .done file is there) and hf/ (the download
library's own cache). Nothing else is written there; a copy's files go in the folder its owner picked for it.
The road it speaks is the server's contracts/devices.ts (TRANSCRIBE_KIND, COPY_KIND, FOLDER_LIST_KIND). Copies and folder
lists need the standard library only: without the speech libraries the helper keeps copies and nothing else.
"""
import errno
import hashlib
import importlib.util
import json
import os
import re
import queue
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
import wave

VERSION = "1"
HOME = os.environ.get("CT_HELPER_HOME") or os.path.expanduser("~/.local/share/creator-toolset-helper")
CONFIG = os.path.join(HOME, "config.json")
# the copy folders whose marker this helper wrote or read: the only folders besides network shares it reads a file from for the server
COPIES = os.path.join(HOME, "copies.json")
MODELS = os.path.join(HOME, "models")
# Hugging Face's own cache and logs go in this folder too, not ~/.cache
os.environ.setdefault("HF_HOME", os.path.join(HOME, "hf"))
KIND = "transcribe"
# a check of this computer for helping with heavy work (the server's lib/helper-check.ts): its disks again, a file read
# in each folder it is given, a short timed encode
CHECK = "helper-check"
MEDIA = {".mov", ".mp4", ".m4v", ".mxf", ".mkv", ".avi", ".mts", ".wav", ".mp3", ".aif", ".aiff", ".m4a", ".flac", ".jpg", ".png"}
ENCODE_S = 4
# a copy of a Media Library in a folder here (copy_run), and a folder listed for Add copy's folder browser (folder_walk)
COPY = "copy"
FOLDER_LIST = "folder-list"
# the speech libraries are there (install.sh puts them in the venv; the Docker image has none)
SPEECH = any(importlib.util.find_spec(m) for m in ("faster_whisper", "onnx_asr"))
KINDS = ([KIND] if SPEECH else []) + [CHECK, COPY, FOLDER_LIST]
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
    shares = disks()
    if shares:
        m["disks"] = shares
    return m


NET_FS = {"cifs": "smb", "smb3": "smb", "nfs": "nfs", "nfs4": "nfs"}


def soon(fn, wait=2):
    """fn() in a thread, or None after `wait` seconds: a share that went away can hang a statvfs for minutes."""
    box = []

    def run():
        try:
            box.append(fn())
        except OSError:
            pass
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(wait)
    return box[0] if box else None


def disks():
    """The network shares this computer has connected (Disk in contracts/storage.ts): where each is, its server and its
    name there, so the server knows which of its person's shared folders this computer reaches. Never a user name."""
    out = []
    try:
        with open("/proc/mounts") as f:
            rows = [line.split() for line in f]
    except OSError:
        return out
    for row in rows:
        if len(row) < 3 or row[2] not in NET_FS:
            continue
        src, at, fs = row[0].replace("\\040", " "), row[1].replace("\\040", " "), NET_FS[row[2]]
        if fs == "smb":
            if not src.startswith("//") or "/" not in src[2:]:
                continue
            server, share = src[2:].split("/", 1)
            server = server.rsplit("@", 1)[-1]
        elif ":" in src:
            server, share = src.split(":", 1)
        else:
            continue
        st = soon(lambda: os.statvfs(at))
        if not st or not share.strip("/"):
            continue
        gb = lambda n: round(n * st.f_frsize / 2**30, 1)
        out.append({"path": at, "name": os.path.basename(at.rstrip("/")) or at, "freeGb": gb(st.f_bavail), "totalGb": gb(st.f_blocks),
                    "network": True, "server": server.lower(), "fs": fs, "share": share.strip("/")})
    return out[:20]


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
        self.copies = queue.Queue()
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
                r = self.call("POST", "/api/devices/relay/editor/claim", {"kinds": KINDS, "models": held(), "getting": sorted(self.getting)})
                job = r.get("job")
                kind = job and job.get("kind")
                if kind in (CHECK, FOLDER_LIST):
                    # never behind a transcript or a copy: someone waits on this screen
                    threading.Thread(target=self.safe, args=(self.check if kind == CHECK else self.folder_list, job), daemon=True).start()
                elif kind == COPY:
                    self.copies.put(job)  # the server hands a computer one copy job at a time
                elif job:
                    self.jobs.put(job)
                did = did or bool(job)
                if not SPEECH or not self.sync(r.get("models") or []):
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

    def check(self, job):
        """A check (CHECK): the report again with its disks read now, then each folder read and, for a test, an encode."""
        jid = job["id"]
        opts = job.get("options") or {}
        self.report()
        body = {"ffmpeg": bool(shutil.which("ffmpeg")), "folders": [read_folder(i, p) for i, p in json.loads(opts.get("folders") or "{}").items()]}
        if opts.get("test") == "1":
            speed = encode_speed()
            if speed:
                body["encode"] = speed
        r = self.call("POST", f"/api/devices/relay/job/{CHECK}/{jid}", body)
        if r and r.get("editor"):
            self.claim()

    def folder_list(self, job):
        """A folder listed (FOLDER_LIST_KIND), as the server's walkFolder does, or why not."""
        base = f"/api/devices/relay/job/{FOLDER_LIST}/{job['id']}"
        o = job.get("options") or {}
        try:
            depth = min(6, max(1, int(o.get("depth") or 6)))
        except ValueError:
            depth = 6
        try:
            r = self.call("POST", base, folder_walk(os.path.expanduser(o.get("path") or ""), depth, o.get("disk") == "1"))
        except Removed:
            raise
        except Exception as e:
            r = self.call("POST", base + "/fail", {"error": str(e)[:500] or type(e).__name__})
        if r and r.get("editor"):
            self.claim()

    def copy_work(self):
        """One copy job at a time, beside the transcripts."""
        while True:
            self.safe(self.copy, self.copies.get())

    def copy(self, job):
        """A copy job (COPY_KIND): its beat every 30 s while it runs (the folder's lease too), then its answer, or why it
        failed. A job whose lease another computer took stops, and its file is never reported as done."""
        o = job.get("options") or {}
        root = "" if o.get("op") == "send" else (o.get("root") or "")
        base = f"/api/devices/relay/job/{COPY}/{job['id']}"
        folder, ended = Folder(root, o.get("device") or ""), threading.Event()

        def beat():
            while not ended.wait(BEAT_S):
                folder.beat()
                if folder.lost:
                    return
                self.safe(self.call, "POST", base, {"beat": True, **free_of(root)})
        threading.Thread(target=beat, daemon=True).start()
        r = None
        try:
            if o.get("op") == "send":
                body, r = None, send_file(o, self.post)
                if r is None:
                    r = self.call("POST", base + "/fail", {"error": "The original is not on this computer any more"})
            else:
                body = copy_run(o, self.fetch, folder)
                if folder.lost:
                    raise Lost()
        except Removed:
            raise
        except Exception as e:
            log(f"copy {job['id']} failed:", str(e)[:300])
            body = None
            r = self.call("POST", base + "/fail", {"error": str(e)[:300] or type(e).__name__})
        finally:
            ended.set()
        if body is not None:
            if "done" in body:
                log("copied", body["done"]["rel"], "to", root)
            r = self.call("POST", base, {**body, **free_of(root)}, timeout=120)
        if r and r.get("editor"):
            self.claim()

    def fetch(self, url, offset):
        """GET `url` (on the server) from byte `offset`; the token never goes to another host a redirect leads to."""
        headers = {"authorization": f"Bearer {self.token}", "user-agent": f"creator-toolset-helper/{VERSION}"}
        if offset:
            headers["range"] = f"bytes={offset}-"
        try:
            return OPENER.open(urllib.request.Request(self.server + url, headers=headers), timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise Removed() from e
            raise RuntimeError(f"The server did not send the file ({e.code})") from e

    def post(self, url, f, size):
        """POST the open file `f` (`size` bytes) to `url` on the server, streamed; the server's answer."""
        headers = {"authorization": f"Bearer {self.token}", "user-agent": f"creator-toolset-helper/{VERSION}",
                   "content-type": "application/octet-stream", "content-length": str(size)}
        try:
            with OPENER.open(urllib.request.Request(self.server + url, data=f, method="POST", headers=headers), timeout=600) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise Removed() from e
            raise RuntimeError(f"The server did not take the file ({e.code})") from e
        return json.loads(data) if data else None

    def report(self):
        self.call("POST", "/api/devices/relay/report", {"drivers": [], "homes": [], "machine": machine(), "version": VERSION})

    def run(self):
        os.makedirs(MODELS, exist_ok=True)
        threading.Thread(target=self.work, daemon=True).start()
        threading.Thread(target=self.copy_work, daemon=True).start()
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
                r = self.call("POST", "/api/devices/relay/wait", {"blobs": False, "editor": KINDS})
                failures = 0
                if r and r.get("editor"):
                    # the server hints again while a wish stays open: wait a little instead of asking at once
                    if not self.claim():
                        time.sleep(5)
                elif r and r.get("id"):
                    # an AI request: this computer runs no AI tools, so it says so at once instead of letting it wait
                    self.call("POST", f"/api/devices/relay/{r['id']}/fail", {"error": "This computer runs no AI tools"})
            except Removed:
                break
            except Exception as e:
                failures += 1
                log("server:", str(e)[:300])
                time.sleep(min(60, 2 ** failures))
        log("This computer was removed in Settings → Devices. Pair it again with a new code.")
        sys.exit(REMOVED)


def read_folder(fid, path):
    """One folder of a check: part of a media file in it read (else any file; an empty folder is read by listing it)."""
    if not os.path.isdir(path):
        return {"id": fid, "ok": False, "error": f"{path} is not on this computer. Connect the shared drive again."}
    by, pick, media = time.time() + 5, None, None
    try:
        os.listdir(path)
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            seen = [os.path.join(root, f) for f in files if not f.startswith(".")]
            pick = pick or (seen[0] if seen else None)
            media = next((f for f in seen if os.path.splitext(f)[1].lower() in MEDIA), None)
            if media or time.time() > by:
                break
        pick = media or pick
        if pick:
            with open(pick, "rb") as fh:
                fh.read(4 << 20)
        return {"id": fid, "ok": True}
    except OSError as e:
        return {"id": fid, "ok": False, "error": f"This computer could not read {path}: {e.strerror or e}"}


def encode_speed():
    """Seconds of 720p video encoded per second, or None when ffmpeg is missing or fails."""
    ff = shutil.which("ffmpeg")
    if not ff:
        return None
    t0 = time.time()
    r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
                        "-t", str(ENCODE_S), "-c:v", "libx264", "-preset", "veryfast", "-f", "null", "-"], capture_output=True, timeout=120)
    took = time.time() - t0
    return round(ENCODE_S / took, 2) if r.returncode == 0 and took > 0 else None


# ---- a folder listed for the server (FOLDER_LIST_KIND; the server's lib/folder-list.ts walkFolder) ----

WALK_MOST, WALK_S = 20_000, 10
PACKAGE = re.compile(r"\.(app|bundle|framework|photoslibrary|fcpbundle|fcpxbundle|imovielibrary|lrlibrary|tvlibrary|musiclibrary|aplibrary|logicx|band|rtfd|pages|numbers|key)$", re.I)


def folder_walk(given, depth, disk):
    """What is in `given`, `depth` levels down, level by level, never into hidden entries, links or packages: the body
    the server takes ({entries, deeper, unreadable?, stopped?}). Raises with a sentence when it is not walked.
    `disk`: any folder may be listed, a disk's own top folder too (Add copy's folder browser starts at /)."""
    if not given.startswith("/"):
        raise RuntimeError(f"Not a full path: {given}")
    root = os.path.realpath(given)
    if not os.path.isdir(root):
        raise RuntimeError(f"No such folder on this computer: {given}")
    try:
        os.listdir(root)
    except OSError:
        raise RuntimeError(f"{given} could not be read on this computer (no permission to read it).") from None
    home = os.path.realpath(os.path.expanduser("~"))
    if not disk and (root in ("/", home) or os.path.dirname(root) == "/" or os.path.ismount(root)):
        raise RuntimeError(f"{root} is a whole disk or home folder: name the folder the files are in.")
    by, entries, deeper, unreadable = time.time() + WALK_S, [], 0, 0

    def done(stopped):
        return {"entries": entries, "deeper": deeper, **({"unreadable": unreadable} if unreadable else {}), **({"stopped": True} if stopped else {})}
    level = [""]
    for d in range(1, depth + 1):
        nxt = []
        for rel in level:
            if len(entries) >= WALK_MOST or time.time() > by:
                return done(True)
            try:
                with os.scandir(os.path.join(root, rel)) as it:
                    found = sorted(it, key=lambda e: (e.name.lower(), e.name))
            except OSError:
                unreadable += 1
                continue
            for e in found:
                if e.name.startswith(".") or e.is_symlink():
                    continue
                p = f"{rel}/{e.name}" if rel else e.name
                if e.is_dir(follow_symlinks=False):
                    entries.append({"path": p, "dir": True})
                    if PACKAGE.search(e.name):
                        continue
                    if d < depth:
                        nxt.append(p)
                    else:
                        deeper += 1
                elif e.is_file(follow_symlinks=False):
                    try:
                        size = e.stat(follow_symlinks=False).st_size
                    except OSError:
                        size = 0
                    entries.append({"path": p, "size": size})
        level = nxt
    return done(False)


# ---- copies of a Media Library (COPY_KIND) ----
# The folder format is contracts/devices.ts COPY_KIND, the same on the Mac: MARKER (contracts/library.ts CopyMarker)
# says which copy it is and each file copied, by key; LOCK keeps one writer; a file is written as
# .<name>.<device>.partial, synced, checked on the disk and renamed; an older version moves to .versions/<dir>/<stem>
# v<n><ext>; a file in the way that is not this one stays, the new one goes beside it as "<stem> 2<ext>". Nothing is
# deleted but this computer's own partials and its own lease file. The folder itself is never made.

MARKER = ".creatortoolset-copy.json"
LOCK = ".creatortoolset-copy.lock"
BEAT_S = 30
# a lease whose file was not written on the share for this long was left by a writer that stopped
LOCK_STALE_S = 600
CHUNK = 1 << 20
DEVICE = re.compile(r"[\w-]{1,100}")


class Reconnect(Exception):
    """The folder, or this copy's marker in it, is not there (or not the folder the job opened)."""


class Full(Exception):
    """The disk is full."""


class Lost(Exception):
    """Another computer took the folder's lease: this job stops."""

    def __init__(self):
        super().__init__("Another computer is writing to this folder now")


class _NoTokenElsewhere(urllib.request.HTTPRedirectHandler):
    """Follows a redirect (a stored original may be on another host), with the token only on the server's own host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            new.remove_header("Authorization")
        return new


OPENER = urllib.request.build_opener(_NoTokenElsewhere)


def free_of(root):
    """{"free": bytes free where `root` is}, or {} when it can't be read (a share that went away)."""
    st = soon(lambda: os.statvfs(root)) if root else None
    return {"free": st.f_bavail * st.f_frsize} if st else {}


def size_of(p):
    try:
        return os.stat(p).st_size if os.path.isfile(p) else None
    except OSError:
        return None


def sha_of(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h.hexdigest()


def nfc(s):
    return unicodedata.normalize("NFC", s)


def rel_ok(rel):
    """A path inside the folder, as the server's isRel takes it."""
    return isinstance(rel, str) and 0 < len(rel) <= 1000 and not re.search(r"[\0\n\r\\]", rel) and not rel.startswith("/") and all(s not in ("", ".", "..") for s in rel.split("/"))


def real(root, rel, make=False):
    """`rel` in `root` as the disk names it (each name compared in NFC: an NFD name there is the same name). With `make`,
    its missing folders are made one at a time (os.mkdir), so `root` itself is never made."""
    p, parts = root, rel.split("/")
    for i, s in enumerate(parts):
        q = os.path.join(p, s)
        if not os.path.lexists(q):
            try:
                q = next((os.path.join(p, x) for x in os.listdir(p) if nfc(x) == nfc(s)), q)
            except OSError:
                pass
            if make and i < len(parts) - 1 and not os.path.lexists(q):
                os.mkdir(q)
        p = q
    return p


def part_of(final, device):
    d, name = os.path.split(final)
    return os.path.join(d, f".{name}.{device}.partial")


def sync_dir(d):
    try:
        fd = os.open(d, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass  # some network file systems can't sync a folder
    finally:
        os.close(fd)


def read_json(p):
    """The JSON object in `p`; None when it is not there or not an object."""
    try:
        with open(p) as f:
            v = json.load(f)
    except FileNotFoundError:
        return None
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def write_json(p, v, device):
    """`v` written whole as `p`: a temp file renamed over it."""
    tmp = f"{p}.{device}.tmp"
    with open(tmp, "w") as f:
        json.dump(v, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)
    sync_dir(os.path.dirname(p))


class Folder:
    """One job's hold on a copy's folder: the lease (LOCK), the folder it opened (its st_dev) and the marker's writes."""

    def __init__(self, root, device):
        self.root, self.device, self.lock = root, device, os.path.join(root, LOCK)
        self.dev, self.copy, self.held, self.lost = None, None, False, False

    def holder(self):
        """The device in LOCK; None when it is not the lease's JSON (another writer's all the same)."""
        v = read_json(self.lock)
        return v.get("device") if v and isinstance(v.get("device"), str) else None

    def write_lock(self):
        write_json(self.lock, {"device": self.device, "at": int(time.time())}, self.device)

    def open(self):
        """The folder as it is now (its st_dev), and its lease: taken when absent, stale (its file untouched on the share
        for LOCK_STALE_S) or this computer's own; read back after it is written, and ours only if it names us."""
        self.dev = os.stat(self.root).st_dev
        try:
            fresh = time.time() - os.stat(self.lock).st_mtime < LOCK_STALE_S
        except FileNotFoundError:
            fresh = False
        if fresh and self.holder() != self.device:
            raise RuntimeError("Another computer is writing to this folder now")
        # ponytail: two writers that find the same stale lease at once may both take it; the read-back and the beats settle it
        self.write_lock()
        if self.holder() != self.device:
            raise Lost()
        self.held = True

    def beat(self):
        """Every BEAT_S: the lease read first, rewritten only while it is ours; when it is not, the job stops."""
        if not self.held or self.lost:
            return
        try:
            if self.holder() != self.device:
                self.lost = True
                return
            self.write_lock()
        except OSError:
            pass  # a share that went away: the guard answers reconnect

    def drop(self):
        if not self.held:
            return
        self.held = False
        try:
            if self.holder() == self.device:
                os.unlink(self.lock)
        except OSError:
            pass

    def guard(self):
        """Before each write: the lease still ours, the folder still the one opened (same st_dev) and its marker there."""
        if self.lost:
            raise Lost()
        try:
            if os.stat(self.root).st_dev != self.dev or not os.path.isfile(os.path.join(self.root, MARKER)):
                raise Reconnect()
        except OSError:
            raise Reconnect() from None

    def save(self, changes):
        """The marker on disk read again, this job's `changes` (key → entry, None to delete) applied, written whole."""
        self.guard()
        m = read_json(os.path.join(self.root, MARKER))
        if not m or m.get("copy") != self.copy:
            raise Reconnect()
        files = m.setdefault("files", {})
        for k, v in changes.items():
            if v is None:
                files.pop(k, None)
            else:
                files[k] = v
        write_json(os.path.join(self.root, MARKER), m, self.device)


def marker_for(folder, o):
    """This copy's marker, written on its first job (`init`). Reconnect when the folder holds no marker of this copy. A
    folder that held a copy of the same library before (stopped, then added again) is taken over with the files it
    lists; one of another library's is never mixed in."""
    path = os.path.join(folder.root, MARKER)
    m = read_json(path)
    folder.copy = o.get("copy")
    if m and m.get("copy") == o.get("copy") and m.get("library") == o.get("library"):
        m.setdefault("files", {})
        own_copy(folder.root, m["copy"])
        return m
    if o.get("init") == "1" and (m is None or m.get("library") == o.get("library")):
        m = {"library": o["library"], "copy": o["copy"], "files": (m or {}).get("files") or {}}
        write_json(path, m, folder.device)
        own_copy(folder.root, m["copy"])
        return m
    raise Reconnect()


def own_copy(root, copy):
    """Remembers `root` as a copy folder of this helper's (COPIES), for readable()."""
    known = read_json(COPIES) or {}
    if known.get(root) != copy:
        known[root] = copy
        os.makedirs(HOME, exist_ok=True)
        tmp = f"{COPIES}.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(known, f)
        os.replace(tmp, COPIES)


def readable(paths, size):
    """The first of `paths` this helper may read for the server, as its real path: a regular file of `size` bytes with a
    media extension, inside (prefix + "/") a network share this computer has connected (disks()) or one of its own copy
    folders whose marker is still its own. Else None: "not on this computer". A server that names any other file (a key
    in ~/.ssh, found by its size) never gets it read, through a link or otherwise."""
    roots = [d["path"] for d in disks()]
    for root, copy in (read_json(COPIES) or {}).items():
        try:
            if (read_json(os.path.join(root, MARKER)) or {}).get("copy") == copy:
                roots.append(root)
        except OSError:
            pass  # a share that went away
    roots = [r for r in (os.path.realpath(x).rstrip("/") for x in roots) if r]
    for p in paths:
        if not isinstance(p, str):
            continue
        r = os.path.realpath(p)
        try:
            st = os.stat(r)
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode) and st.st_size == size and os.path.splitext(r)[1].lower() in MEDIA and any(r.startswith(x + "/") for x in roots):
            return r
    return None


def sweep(root, device, keep=None):
    """Deletes this computer's own partials (.<name>.<device>.partial), of any age, but `keep` (this job's, resumed);
    another computer's are never touched."""
    end = f".{device}.partial"
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") or x == ".versions"]
        for f in files:
            p = os.path.join(d, f)
            if f.startswith(".") and f.endswith(end) and len(f) > len(end) + 1 and p != keep:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def copy_check(folder, m):
    """op "check": each file the marker `m` lists still there at its size; the gone ones leave the marker and are reported."""
    sweep(folder.root, folder.device)
    gone = [k for k, f in m["files"].items() if size_of(real(folder.root, f["rel"])) != f["size"]]
    if gone:
        folder.save({k: None for k in gone})
    return gone


def beside(rel, i, device):
    """`rel` with " <i>" after its stem ("a/b 2.mov"; i = 1: `rel`), the stem trimmed so its partial's name fits 255 bytes."""
    d, name = os.path.split(rel)
    stem, ext = os.path.splitext(name)
    tail = (f" {i}" if i > 1 else "") + ext
    room = 255 - len(f"..{device}.partial{tail}".encode())
    return os.path.join(d, stem.encode()[:max(room, 0)].decode(errors="ignore") + tail)


def free_rel(root, rel, device):
    """`rel`, else the first "<stem> <i><ext>" not taken: nothing is overwritten."""
    i = 1
    while os.path.lexists(real(root, beside(rel, i, device))):
        i += 1
    return beside(rel, i, device)


def copy_file(folder, o, fetch, m):
    """op "copy": the file put in the folder at `rel` (or beside a file in the way); its done answer {rel, size, sha256}."""
    root, dev = folder.root, folder.device
    key, size, want = o["key"], int(o["size"]), (o.get("sha256") or "").lower()
    rel, prev = (o.get("rel") or "").replace("\\", "_"), (o.get("prev") or "").replace("\\", "_")
    if not rel_ok(rel) or (prev and not rel_ok(prev)):
        raise RuntimeError("The server sent a path outside the folder")
    paths = [p for p in json.loads(o.get("paths") or "[]") if isinstance(p, str)]
    files = m["files"]
    sweep(root, dev, keep=part_of(real(root, beside(rel, 1, dev)), dev))

    def record(at, sha):
        folder.save({key: {"asset": o.get("asset", ""), "n": int(o.get("n") or 1), "rel": at, "size": size, "sha256": sha}})
        return {"rel": at, "size": size, "sha256": sha}

    def source(p):
        """The very file this job would read from (indexed in place)."""
        for s in paths:
            try:
                if os.path.samefile(p, s):
                    return True
            except OSError:
                pass
        return False

    # copied before, and the server did not hear it (or forgot it): the marker lists it, and it is there
    had = files.get(key)
    if had and size_of(real(root, had["rel"])) == size and (not want or had.get("sha256") == want):
        return {"rel": had["rel"], "size": size, "sha256": had["sha256"]}
    # the older version of this clip moves into .versions/ first, never overwritten
    old = next(((k, f) for k, f in files.items() if prev and nfc(f["rel"]) == nfc(prev) and k != key), None)
    if old and size_of(real(root, prev)) == old[1]["size"]:
        d, name = os.path.split(prev)
        stem, ext = os.path.splitext(name)
        to = free_rel(root, os.path.join(".versions", d, f"{stem} v{old[1]['n']}{ext}"), dev)
        folder.guard()
        os.rename(real(root, prev), real(root, to, make=True))
        folder.save({old[0]: {**old[1], "rel": to}})
    # a file in the way: it counts as copied only by its hash (or, with none known, when it is the source itself);
    # another stays and the new one goes beside it
    i = 1
    while os.path.lexists(at := real(root, beside(rel, i, dev))):
        if size_of(at) == size:
            if want and sha_of(at) == want:
                return record(beside(rel, i, dev), want)
            if not want and source(at):
                return record(beside(rel, i, dev), sha_of(at))
        i += 1
    rel = beside(rel, i, dev)
    folder.guard()
    final = real(root, rel, make=True)
    part = part_of(final, dev)
    try:
        write_part(part, size, want, o, paths, fetch, folder)
        folder.guard()
        # the file on the disk, read back: what was streamed is not what the disk holds when a write went wrong
        sha = sha_of(part) if size_of(part) == size else None
        if sha is None or (want and sha != want):
            os.unlink(part)
            raise RuntimeError("The file read is not the library's file (its size or checksum differs)")
        folder.guard()
        if os.path.lexists(final):
            raise RuntimeError(f"{rel} appeared while it was copied")
        os.rename(part, final)
        sync_dir(os.path.dirname(final))
        return record(rel, sha)
    except OSError as e:
        if e.errno in (errno.ENOSPC, errno.EDQUOT):
            try:
                os.unlink(part)  # its own partial: the space is the person's
            except OSError:
                pass
            raise Full() from e
        raise


def write_part(part, size, want, o, paths, fetch, folder):
    """Writes the file to `part`, from a path on this computer at the right size, else the server's `url` (resuming a
    partial with Range when its hash is known: a partial is never taken on its size alone); synced."""
    src = readable(paths, size)

    def pour(i, out):
        for b in iter(lambda: i.read(CHUNK), b""):
            if folder.lost:
                raise Lost()
            out.write(b)
        out.flush()
        os.fsync(out.fileno())

    if src:
        with open(src, "rb") as i, open(part, "wb") as out:
            pour(i, out)
        return
    if "url" not in o:
        raise RuntimeError("No copy of this file on this computer, and the server keeps none")
    have = (size_of(part) or 0) if want else 0
    if have >= size:
        have = 0
    with fetch(o["url"], have) as r:
        if have and not (r.status == 206 and (r.headers.get("content-range") or "").startswith(f"bytes {have}-")):
            have = 0  # the whole file came: start again
        with open(part, "ab" if have else "wb") as out:
            pour(r, out)


def send_file(o, post):
    """op "send": the original's bytes from the first path at `size`, streamed to `url` by `post(url, file, size)`; its
    answer, or None when no path holds it."""
    size, url = int(o["size"]), o.get("url") or ""
    if not url.startswith("/"):
        raise RuntimeError("The server sent an address that is not its own")
    src = readable(json.loads(o.get("paths") or "[]"), size)
    if src is None:
        return None
    with open(src, "rb") as f:
        return post(url, f, size)


def copy_run(o, fetch, folder):
    """One copy job (contracts/devices.ts COPY_KIND, op check or copy) without the server: its answer's body, less `free`."""
    if not DEVICE.fullmatch(folder.device or ""):
        raise RuntimeError("The server sent no computer id with this copy job: update the server")
    root = o.get("root") or ""
    if not root.startswith("/") or not os.path.isdir(root):
        return {"state": "reconnect"}
    if o.get("op") not in ("check", "copy"):
        raise RuntimeError(f"This helper does not know op {o.get('op')}: update it")
    try:
        folder.open()
        m = marker_for(folder, o)
        if o["op"] == "check":
            return {"gone": copy_check(folder, m)}
        return {"done": copy_file(folder, o, fetch, m)}
    except Reconnect:
        return {"state": "reconnect"}
    except Full:
        return {"state": "full"}
    except OSError as e:
        if e.errno in (errno.ENOSPC, errno.EDQUOT):
            return {"state": "full"}
        raise
    finally:
        folder.drop()


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
