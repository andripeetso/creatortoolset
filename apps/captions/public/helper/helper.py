#!/usr/bin/env python3
"""Creator Toolset helper: a Linux computer (with or without an NVIDIA graphics card) that turns speech into text for
its owner's Creator Toolset server, with models it downloads itself, and keeps copies of its Media Library in folders here.

  helper.py pair <server> <code>   swap the one-time code from Settings → Devices → Add a computer for this computer's token
  helper.py run                    take transcripts until stopped (the systemd --user unit runs this)
  helper.py add <folder> [<host>]  list a folder here (and, in a container, where it is on the host)
  helper.py remove <folder>        take a folder off the list
  helper.py folders                the folders this helper may read and write for the server

Its folder is $CT_HELPER_HOME, else ~/.local/share/creator-toolset-helper: config.json (the server and the token, mode
0600; also this computer's machineId and its folder list), scans.json (what the folder scans read: size, time and
fingerprints), models/<id>/ (one folder per model; a model is ready once its .done file is there) and hf/ (the download
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
import uuid
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
# the listed folders are read again this often (README "What it does"); a new folder from the server at once
SCAN_EVERY_S = 15 * 60
# a folder that does not answer in this long is unreadable this time; between two fingerprints a pause, so a scan never
# keeps a disk busy
SCAN_DIR_S = 10
QUICK_PAUSE_S = 0.05
# files in one report call (contracts/places.ts REPORT_FILES_MAX)
PAGE = 2000
MIB = 1 << 20
SCANS = os.path.join(HOME, "scans.json")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Removed(Exception):
    pass


def checked_server(server):
    """The server's address, when it may get the token and the code: https, or http to this computer only (as the Mac app)."""
    u = urllib.parse.urlsplit(server)
    if (u.scheme == "https" and u.hostname) or (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")):
        return server
    raise ValueError("the server address must be https:// (http:// only for localhost)")


def call(server, token, method, path, body=None, raw=False, timeout=60):
    server = checked_server(server)
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

def read_config():
    return read_json(CONFIG) or {}


def write_config(c):
    os.makedirs(HOME, exist_ok=True)
    write_json(CONFIG, c)


def machine_id(c):
    """This computer's own id, made once and kept in the config `c` (the caller writes it): paired again with it, the
    server keeps this computer's device id and its place rows."""
    if not re.fullmatch(r"[\w-]{8,80}", str(c.get("machineId") or "")):
        c["machineId"] = str(uuid.uuid4())
    return c["machineId"]


def pair(server, code):
    server = server.rstrip("/")
    name = socket.gethostname()
    c = read_config()
    try:
        r = call(server, None, "POST", "/api/devices/pair", {"code": code, "name": name, "version": VERSION, "machineId": machine_id(c)})
    except (RuntimeError, OSError, ValueError) as e:
        sys.exit(f"Not paired: {e}")
    c.update(server=server, token=r["token"])
    write_config(c)
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
LOCAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "hfsplus", "apfs"}


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


def mount_rows():
    """/proc/mounts as (source, mount point, file system) rows."""
    try:
        with open("/proc/mounts") as f:
            rows = [line.split() for line in f]
    except OSError:
        return []
    return [(r[0].replace("\\040", " "), r[1].replace("\\040", " "), r[2]) for r in rows if len(r) >= 3]


def disks():
    """The network shares this computer has connected and its local disks (Disk in contracts/storage.ts): where each is,
    for a share its server and its name there, so the server knows which of its person's shared folders this computer
    reaches. Never a user name. Shares first."""
    out, local = [], []
    for src, at, kind in mount_rows():
        if kind in LOCAL_FS and os.path.isdir(at) and not at.startswith(("/boot", "/snap/", "/var/lib/")):
            st = soon(lambda at=at: os.statvfs(at))
            if st and st.f_blocks:
                gb = lambda n, st=st: round(n * st.f_frsize / 2**30, 1)
                local.append({"path": at, "name": os.path.basename(at.rstrip("/")) or at, "freeGb": gb(st.f_bavail), "totalGb": gb(st.f_blocks)})
            continue
        if kind not in NET_FS:
            continue
        fs = NET_FS[kind]
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
    return (out + local)[:20]


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
    def __init__(self, server, token, config=None):
        self.server, self.token = checked_server(server), token
        self.config = config if config is not None else {"server": server, "token": token}
        self.server_folders = []  # GET /api/devices/relay/folders, at each report
        self.known = dict(self.config.get("disks") or {})  # every disk this computer has had: path → name
        self.cache = read_json(SCANS) or {}  # scan_pages's cache
        self.cache_lock = threading.Lock()
        self.rescan = threading.Event()
        self.last_machine = {}
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
                samples = self.own_sound(job)
                if samples is None:  # a recording only the server has (a Caption Studio upload, the mic): its WAV
                    samples = read_wav(self.call("GET", f"/api/devices/relay/transcribe/{jid}", raw=True, timeout=600))
                t0 = time.time()
                out, gpu_used = self.runner.transcribe(job["model"], samples, job.get("languages") or [])
                log(f"transcript {jid}: {len(out['words'])} words, {len(samples) / 16000:.0f} s of audio in {time.time() - t0:.1f} s",
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
            given = os.path.expanduser(o.get("path") or "")
            fs = self.folders()
            here = to_mount(given, fs)
            if not allowed(here, fs):
                raise RuntimeError(refused(given))
            r = self.call("POST", base, folder_walk(here, depth, o.get("disk") == "1"))
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
        if root:
            fs = self.folders()
            here = to_mount(root, fs)
            # a folder that is not here asks to be reconnected (copy_run); one that is here must be on the list
            if os.path.isdir(here) and not allowed(here, fs):
                r = self.call("POST", base + "/fail", {"error": refused(root)})
                if r and r.get("editor"):
                    self.claim()
                return
            root, o = here, {**o, "root": here}
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
                self.remember(real(root, body["done"]["rel"]), body["done"]["sha256"])
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

    def base(self):
        """What every report carries (contracts/places.ts ReportV2)."""
        return {"reportVersion": 2, "machineId": machine_id(self.config), "drivers": [], "homes": [], "machine": self.last_machine, "version": VERSION}

    def report(self):
        """This computer as it is now, then its folders from the server (a new or moved one is scanned at once)."""
        self.last_machine = m = machine()
        new = {d["path"]: d["name"] for d in m.get("disks") or [] if self.known.get(d["path"]) != d["name"]}
        if new:
            self.known.update(new)
            c = read_config()  # as it is on disk: `helper.py add` may have written it since
            c["disks"] = self.known
            write_config(c)
        self.call("POST", "/api/devices/relay/report", self.base())
        try:
            got = (self.call("GET", "/api/devices/relay/folders") or {}).get("folders") or []
        except RuntimeError:
            return  # a server from before: no folders
        got = [f for f in got if isinstance(f, dict) and all(isinstance(f.get(k), str) and f[k] for k in ("id", "hostPath", "mountPath"))]
        if {(f["id"], f["mountPath"]) for f in got} != {(f["id"], f["mountPath"]) for f in self.server_folders}:
            self.rescan.set()
        self.server_folders = got

    def folders(self):
        return listed(self.server_folders, read_config())

    def scans(self):
        """Every SCAN_EVERY_S, and at once when the server's folders change: each Media folder of this computer listed and
        reported in pages; each file the server knows nothing of indexed where it is."""
        while not self.stop:
            self.rescan.wait(SCAN_EVERY_S)
            self.rescan.clear()
            mounted = {at for _, at, _ in mount_rows()}
            for f in [f for f in self.server_folders if f.get("use") == "media"]:
                for page in scan_pages(f, self.cache, self.known, mounted):
                    r = self.safe(self.call, "POST", "/api/devices/relay/report", {**self.base(), "folders": [page]}, timeout=120)
                    for x in (r or {}).get("index") or []:
                        if isinstance(x, dict) and x.get("folder") == f["id"] and isinstance(x.get("path"), str):
                            self.safe(self.index, f, x["path"])
                    if self.stop:
                        return
                self.save_cache()

    def own_sound(self, job):
        """The sound of a library file cut here from this computer's own copy (where the server says it is, with its size,
        in one of this helper's folders), as 16 kHz mono samples: the server's own cut (api/library/transcribe.ts
        soundArgs), so the same words, and the server decodes nothing for it. None when the job names no copy here."""
        o = job.get("options") or {}
        p, size = o.get("path"), str(o.get("bytes") or "")
        if not isinstance(p, str) or not p.startswith("/") or not size.isdigit():
            return None
        folders = listed(self.server_folders, self.config)
        here = to_mount(p, folders)
        if not allowed(here, folders) or not os.path.isfile(here) or os.path.getsize(here) != int(size):
            return None
        ff = shutil.which("ffmpeg")
        if not ff:
            raise RuntimeError("ffmpeg is not installed on this computer, so it can't read the sound of its own copy")
        r = subprocess.run([ff, "-nostdin", "-v", "error", "-i", here, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
                           capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(f"This computer could not read the sound of {os.path.basename(here)}: {r.stderr.decode(errors='replace').strip()[-200:]}")
        import numpy
        return numpy.frombuffer(r.stdout, dtype=numpy.int16).astype(numpy.float32) / 32768

    def index(self, f, path):
        """POST /api/devices/relay/index for one file of folder `f` (`path` on the host): what this computer reads of it,
        never its bytes. Only a file inside that folder."""
        here = to_mount(path, [f])
        if under(path, f["hostPath"]) is None or not allowed(here, [f]) or not os.path.isfile(here):
            return
        quick = (self.cache.get(here) or [None] * 4)[2] or quick_print(here)
        if quick:
            self.call("POST", "/api/devices/relay/index", {"folder": f["id"], "name": os.path.basename(here), "path": path,
                                                           "size": os.path.getsize(here), "quick": quick, "frames": [], **probe(here)}, timeout=120)

    def remember(self, p, sha):
        """A file this helper wrote (a copy) and its sha256, for the next report."""
        try:
            st = os.stat(p)
        except OSError:
            return
        self.cache[p] = [st.st_size, st.st_mtime_ns // 1_000_000, None, sha]
        self.save_cache()

    def save_cache(self):
        with self.cache_lock:
            os.makedirs(HOME, exist_ok=True)
            tmp = SCANS + ".tmp"
            with open(tmp, "w") as f:
                json.dump(dict(self.cache), f)
            os.replace(tmp, SCANS)

    def run(self):
        os.makedirs(MODELS, exist_ok=True)
        threading.Thread(target=self.work, daemon=True).start()
        threading.Thread(target=self.copy_work, daemon=True).start()
        threading.Thread(target=self.safe, args=(self.scans,), daemon=True).start()
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


# ---- the folders this helper keeps, and what is in them (local first: the computers report, the server records) ----
# A folder is {hostPath, mountPath} (and, from the server, id and use): mountPath is where it is here, hostPath where the
# computer itself has it (the same outside a container). Paths sent to the server are host paths; paths read are mount paths.

def local_folders(c):
    """The folders the person listed on this computer: config `folders` (a path, or {mountPath, hostPath}) and CT_FOLDERS
    (":"-separated paths, the container's)."""
    out = []
    for f in (c.get("folders") or []) + [p for p in os.environ.get("CT_FOLDERS", "").split(":") if p]:
        f = {"mountPath": f} if isinstance(f, str) else f
        m = f.get("mountPath") if isinstance(f, dict) else None
        if isinstance(m, str) and m.startswith("/"):
            h = f.get("hostPath")
            out.append({"hostPath": h if isinstance(h, str) and h.startswith("/") else m, "mountPath": m})
    return out


def listed(server_folders, c):
    """Where this helper may read and write for the server: its own list, the copy folders it already keeps (COPIES), and
    the server's Media folders that are here (their mountPath exists)."""
    own = local_folders(c) + [{"hostPath": r, "mountPath": r} for r in (read_json(COPIES) or {})]
    return own + [f for f in server_folders if f.get("use") == "media" and os.path.isdir(f["mountPath"])]


def under(p, root):
    """`p` inside `root`: the rest of it ("" for `root` itself), or None."""
    root = root.rstrip("/") or "/"
    if p == root:
        return ""
    pre = root if root == "/" else root + "/"
    return p[len(pre):] if p.startswith(pre) else None


def swap(p, folders, src, dst):
    """`p` from the folder's `src` path to its `dst` path (the deepest folder it is in); unchanged when in none."""
    for f in sorted(folders, key=lambda f: -len(f[src])):
        rest = under(p, f[src])
        if rest is not None:
            return f[dst].rstrip("/") + ("/" + rest if rest else "") or "/"
    return p


def to_host(p, folders):
    return swap(p, folders, "mountPath", "hostPath")


def to_mount(p, folders):
    return swap(p, folders, "hostPath", "mountPath")


def allowed(path, folders):
    """`path` (here) is one of `folders` or inside one, links resolved."""
    r = os.path.realpath(path)
    return any(under(r, os.path.realpath(f["mountPath"])) is not None for f in folders)


def refused(path):
    return f"{path} is not in this computer's folder list. On it: helper.py add <folder> (README \"Folders\")."


def quick_print(p):
    """SHA-256 over the size as decimal text, the first MiB and, over 2 MiB, the last MiB: the server's work/files.ts
    quickPrint and the Mac's, byte for byte. None when it can't be read."""
    try:
        with open(p, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            h = hashlib.sha256(str(size).encode())
            h.update(f.read(MIB))
            if size > 2 * MIB:
                f.seek(size - MIB)
                h.update(f.read(MIB))
            return h.hexdigest()
    except OSError:
        return None


def folder_state(path, known, mounted):
    """Why folder `path` can't be listed: ("disk_away", name) when the disk it is on (`known`: path → name, the disks
    this computer has had) is not mounted now (`mounted`: mount points), else ("not_found", None)."""
    on = [d for d in known if under(path, d) is not None and d != "/"]
    d = max(on, key=len, default=None)
    return ("disk_away", known[d]) if d and d not in mounted else ("not_found", None)


def scan_pages(f, cache, known, mounted, quick=quick_print, pause=QUICK_PAUSE_S):
    """One folder from the server listed: its report pages (contracts/places.ts ReportFolder), each at most PAGE files
    sharing one scan id, numbered from 0 (`page`, so the server knows the listing came whole), `complete` on the last. Never into hidden entries or links; media files only. A file's
    fingerprint is read once per size and time (`cache`: path here → [bytes, mtime, quick, sha256]), one at a time."""
    top, scan, seen, page = f["mountPath"], uuid.uuid4().hex, set(), 0
    host = lambda p: to_host(p, [f])
    # ponytail: an empty folder reads as not there (an unmounted share's mount point is empty too); a folder emptied on
    # purpose shows "not checked" instead of "missing" until a file is in it again
    if not (os.path.isdir(top) and soon(lambda: os.listdir(top), SCAN_DIR_S)):
        state, disk = folder_state(top, known, mounted)
        yield {"id": f["id"], "state": state, **({"disk": disk} if disk else {})}
        return
    files, unreadable, dirs = [], [], [top]
    while dirs:
        d = dirs.pop()
        got = soon(lambda d=d: list(os.scandir(d)), SCAN_DIR_S)
        if got is None:
            unreadable.append(host(d))
            continue
        for e in sorted(got, key=lambda e: e.name):
            try:
                if e.name.startswith(".") or e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    if not PACKAGE.search(e.name):
                        dirs.append(e.path)
                    continue
                if not e.is_file(follow_symlinks=False) or os.path.splitext(e.name)[1].lower() not in MEDIA:
                    continue
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            size, mtime = st.st_size, st.st_mtime_ns // 1_000_000
            c = cache.get(e.path)
            if not c or c[0] != size or c[1] != mtime:
                c = [size, mtime, None, None]
            if c[2] is None:
                c[2] = quick(e.path)
                time.sleep(pause)
            cache[e.path] = c
            seen.add(e.path)
            files.append({"path": host(e.path), "bytes": size, "mtime": mtime, **({"quick": c[2]} if c[2] else {}), **({"sha256": c[3]} if c[3] else {})})
            if len(files) == PAGE:
                yield {"id": f["id"], "state": "ok", "scan": scan, "page": page, "files": files, **({"unreadable": unreadable} if unreadable else {})}
                files, unreadable, page = [], [], page + 1
    for k in [k for k in list(cache) if under(k, top) is not None and k not in seen]:
        cache.pop(k, None)
    yield {"id": f["id"], "state": "ok", "scan": scan, "page": page, "complete": True, "files": files, **({"unreadable": unreadable} if unreadable else {})}


def probe(p):
    """A video's duration, width and height from ffprobe, when it is there; {} otherwise."""
    ff = shutil.which("ffprobe")
    if not ff:
        return {}
    try:
        out = json.loads(subprocess.run([ff, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", p],
                                        capture_output=True, text=True, timeout=30).stdout or "{}")
        r = {}
        d = float((out.get("format") or {}).get("duration") or 0)
        if d > 0:
            r["duration"] = d
        v = next((s for s in out.get("streams") or [] if s.get("codec_type") == "video" and s.get("width")), None)
        if v:
            r.update(width=int(v["width"]), height=int(v["height"]))
        return r
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}


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
        checked_server(newurl)  # the token never goes in clear, even on a redirect
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


def write_json(p, v, device=""):
    """`v` written whole as `p`: a temp file, always mode 0600 (config.json holds the token), renamed over it."""
    tmp = f"{p}.{device}.tmp" if device else f"{p}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)  # a temp file left by a crash keeps its old mode otherwise
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


def readable(paths, size, copied_too=True):
    """The first of `paths` this helper may read for the server, as its real path: a regular file of `size` bytes with a
    media extension, inside (prefix + "/") a network share this computer has connected (disks()), or in one of its own
    copy folders (whose marker is still its own) a file that marker lists as copied, at its rel and size: a folder the
    server named as a copy never opens the person's files already in it. Else None: "not on this computer". A server
    that names any other file (a key in ~/.ssh, found by its size) never gets it read, through a link or otherwise.
    `copied_too` False: shares only."""
    roots = [r for r in (os.path.realpath(d["path"]).rstrip("/") for d in disks() if d.get("network")) if r]
    copied = {}
    for root, copy in (read_json(COPIES) or {}).items() if copied_too else ():
        try:
            m = read_json(os.path.join(root, MARKER)) or {}
        except OSError:
            continue  # a share that went away
        if m.get("copy") != copy or not isinstance(m.get("files"), dict):
            continue
        for f in m["files"].values():
            if isinstance(f, dict) and rel_ok(f.get("rel")) and isinstance(f.get("size"), int):
                copied[os.path.realpath(os.path.join(root, f["rel"]))] = f["size"]
    for p in paths:
        if not isinstance(p, str):
            continue
        r = os.path.realpath(p)
        try:
            st = os.stat(r)
        except OSError:
            continue
        if not (stat.S_ISREG(st.st_mode) and st.st_size == size and os.path.splitext(r)[1].lower() in MEDIA):
            continue
        if any(r.startswith(x + "/") for x in roots) or copied.get(r) == size:
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
        """The very file this job would read from (indexed in place): only on a network share, where a library is indexed
        in place; a file the server names in a folder it called a copy is the person's own, never taken as copied."""
        if readable([p], size, copied_too=False) is None:
            return False
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
        c = read_config()
        if not c.get("token"):
            sys.exit(f"Not paired yet: run {sys.argv[0]} pair <server> <code> first (the code is in Settings → Devices → Add a computer).")
        was = c.get("machineId")
        if machine_id(c) != was:
            write_config(c)
        return Helper(c["server"], c["token"], c).run()
    if len(sys.argv) in (3, 4) and sys.argv[1] == "add" and sys.argv[2].startswith("/") and sys.argv[-1].startswith("/"):
        c = read_config()
        at = os.path.realpath(sys.argv[2])
        c["folders"] = [f for f in c.get("folders") or [] if (f if isinstance(f, str) else f.get("mountPath")) != at] + [{"mountPath": at, "hostPath": sys.argv[3] if len(sys.argv) == 4 else at}]
        write_config(c)
        return print(f"Listed {at}.")
    if len(sys.argv) == 3 and sys.argv[1] == "remove":
        c = read_config()
        at = os.path.realpath(sys.argv[2])
        c["folders"] = [f for f in c.get("folders") or [] if (f if isinstance(f, str) else f.get("mountPath")) not in (at, sys.argv[2])]
        write_config(c)
        return print(f"{sys.argv[2]} is off the list.")
    if len(sys.argv) == 2 and sys.argv[1] == "folders":
        c = read_config()
        for f in local_folders(c):
            print(f["mountPath"] + ("" if f["hostPath"] == f["mountPath"] else f"  (on the host: {f['hostPath']})"))
        for r in read_json(COPIES) or {}:
            print(r, " (a copy it keeps)")
        return print("…and the server's Media folders for this computer that are here.")
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
