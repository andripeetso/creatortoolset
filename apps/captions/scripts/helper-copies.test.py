"""The Linux helper's copier (public/helper/helper.py, contracts/devices.ts COPY_KIND) without a server: the marker, an
older version into .versions/, a file in the way, a file already there, a resumed partial, a full disk, the lease a Mac
writes too, the folder that went away, partials per computer, names, op send, the folder walk.
  CT_SCRATCH_DIR=<dir> python3 apps/captions/scripts/helper-copies.test.py
"""
import errno
import hashlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import time
import unicodedata
import unittest

spec = importlib.util.spec_from_file_location("helper", os.path.join(os.path.dirname(__file__), "../public/helper/helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

sha = lambda b: hashlib.sha256(b).hexdigest()
ME = "dev-helper"


class Resp(io.BytesIO):
    """A server's answer to a GET of the file, Range honoured."""

    def __init__(self, body, offset):
        super().__init__(body[offset:])
        self.status = 206 if offset else 200
        self.headers = {"content-range": f"bytes {offset}-{len(body) - 1}/{len(body)}"} if offset else {}


def fake_helper(calls):
    """A Helper with no server: each call it makes is kept in `calls`."""
    h = helper.Helper.__new__(helper.Helper)
    h.call = lambda method, path, body=None, **k: calls.append((path, body)) or {}
    return h


class Copies(unittest.TestCase):
    def setUp(self):
        self.top = tempfile.mkdtemp(dir=os.environ.get("CT_SCRATCH_DIR"))
        self.root = os.path.join(self.top, "copy")
        os.mkdir(self.root)
        self.asked = []
        self.folder = None
        # a network share this computer has connected (disks()), and the helper's list of its own copy folders
        self.share = os.path.join(self.top, "share")
        os.mkdir(self.share)
        self.saved = helper.disks, helper.COPIES
        helper.disks = lambda: [{"path": self.share}]
        helper.COPIES = os.path.join(self.top, "copies.json")

    def tearDown(self):
        helper.disks, helper.COPIES = self.saved
        shutil.rmtree(self.top)

    def job(self, op, device=ME, fetch=None, **o):
        self.folder = helper.Folder(o.get("root", self.root), device)
        return helper.copy_run({"op": op, "copy": "cp_1", "library": "lib_1", "root": self.root, **o}, fetch or self.fetch, self.folder)

    def fetch(self, url, offset):
        self.asked.append(offset)
        return Resp(self.body, offset)

    def put(self, key, body, rel, n=1, **o):
        self.body = body
        return self.job("copy", **{"key": key, "asset": "a1", "n": str(n), "rel": rel, "size": str(len(body)), "sha256": sha(body), "paths": "[]", "url": "/f", **o})

    def path(self, rel):
        return os.path.join(self.root, rel)

    def write(self, rel, body=b""):
        with open(self.path(rel), "wb") as f:
            f.write(body)

    def read(self, rel):
        with open(self.path(rel), "rb") as f:
            return f.read()

    def marker(self):
        return json.loads(self.read(helper.MARKER))

    def lock_as(self, device, at=None):
        with open(self.path(helper.LOCK), "w") as f:
            json.dump({"at": int(at or time.time()), "device": device}, f)  # as the Mac writes it

    def partials(self):
        return sorted(x for x in os.listdir(self.root) if x.endswith(".partial"))

    def test_marker_and_reconnect(self):
        self.assertEqual(self.job("check"), {"state": "reconnect"})  # no marker, not its first job
        self.assertEqual(self.job("check", init="1"), {"gone": []})
        self.assertEqual(self.marker(), {"library": "lib_1", "copy": "cp_1", "files": {}})
        # another library's marker is never taken over; the same library's is (stopped, added again)
        self.assertEqual(self.job("check", copy="cp_2", library="lib_2", init="1"), {"state": "reconnect"})
        self.assertEqual(self.job("check", copy="cp_2", init="1"), {"gone": []})
        self.assertEqual(self.marker()["copy"], "cp_2")
        self.assertEqual(self.job("check", root=self.root + "/missing"), {"state": "reconnect"})
        self.assertFalse(os.path.exists(self.path(helper.LOCK)))
        # a server that sends no computer id: a plain error
        with self.assertRaisesRegex(RuntimeError, "update the server"):
            self.job("check", device="")

    def test_versions_beside_and_gone(self):
        self.job("check", init="1")
        v1 = b"take one"
        self.assertEqual(self.put("v1", v1, "Interviews/Kitchen.mov")["done"], {"rel": "Interviews/Kitchen.mov", "size": 8, "sha256": sha(v1)})
        # the same job again (the server did not hear it): nothing fetched, the same answer
        self.asked = []
        self.assertEqual(self.put("v1", v1, "Interviews/Kitchen.mov")["done"]["rel"], "Interviews/Kitchen.mov")
        self.assertEqual(self.asked, [])
        # a newer version: the older one into .versions/ as "v1", never over one already there
        os.makedirs(self.path(".versions/Interviews"))
        self.write(".versions/Interviews/Kitchen v1.mov")
        self.put("v2", b"take two!", "Interviews/Kitchen.mov", n=2, prev="Interviews/Kitchen.mov")
        self.assertEqual(self.read("Interviews/Kitchen.mov"), b"take two!")
        self.assertEqual(self.read(".versions/Interviews/Kitchen v1 2.mov"), v1)
        self.assertEqual(self.marker()["files"]["v1"]["rel"], ".versions/Interviews/Kitchen v1 2.mov")
        # the person's own file in the way stays; the new one goes beside it
        self.write("Mine.mov", b"not ours")
        self.assertEqual(self.put("v3", b"other clip", "Mine.mov")["done"]["rel"], "Mine 2.mov")
        self.assertEqual(self.read("Mine.mov"), b"not ours")
        # this very file already there (its hash matches) counts as copied
        self.write("Here.mov", b"in place")
        self.asked = []
        self.assertEqual(self.put("v4", b"in place", "Here.mov")["done"]["rel"], "Here.mov")
        self.assertEqual(self.asked, [])
        # a file gone from the disk is reported and leaves the marker
        os.unlink(self.path("Mine 2.mov"))
        self.assertEqual(self.job("check"), {"gone": ["v3"]})
        self.assertNotIn("v3", self.marker()["files"])

    def test_marker_written_again_from_disk(self):
        # an entry another computer put in the marker on disk stays when this job writes it
        self.job("check", init="1")
        m = self.marker()
        m["files"]["mac"] = {"asset": "a", "n": 1, "rel": "Mac.mov", "size": 1, "sha256": "0" * 64}
        with open(self.path(helper.MARKER), "w") as f:
            json.dump(m, f)
        self.put("h1", b"from the helper", "Helper.mov")
        self.assertEqual(sorted(self.marker()["files"]), ["h1", "mac"])

    def test_no_adoption_without_sha(self):
        self.job("check", init="1")
        self.write("Same.mov", b"same size!")
        self.body = b"different!"
        # a file of the same size is not this file without a hash
        self.assertEqual(self.job("copy", key="s1", rel="Same.mov", size="10", paths="[]", url="/f")["done"]["rel"], "Same 2.mov")
        self.assertEqual(self.read("Same.mov"), b"same size!")
        # with no hash, only the source itself (a path the job reads from) counts as copied
        self.write("Src.mov", b"the source")
        self.asked = []
        self.assertEqual(self.job("copy", key="s2", rel="Src.mov", size="10", paths=json.dumps([self.path("Src.mov")]), url="/f")["done"]["rel"], "Src.mov")
        self.assertEqual(self.asked, [])

    def test_final_check_reads_the_disk(self):
        self.job("check", init="1")
        body = b"the library's bytes"

        def hole(part, size, want, o, paths, fetch, folder):
            with open(part, "wb") as f:
                f.write(b"\0" * size)  # zeros on the disk, while the stream itself was right
            return sha(body)
        real, helper.write_part = helper.write_part, hole
        try:
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                self.put("d1", body, "Disk.mov")
        finally:
            helper.write_part = real
        self.assertFalse(os.path.lexists(self.path("Disk.mov")))

    def test_folder_gone_before_rename(self):
        for remount in (False, True):
            with self.subTest(remount=remount):
                self.job("check", init="1")

                def unmount(part, size, want, o, paths, fetch, folder):
                    with open(part, "wb") as f:
                        f.write(self.body)
                    shutil.rmtree(self.root)
                    if remount:
                        os.mkdir(self.root)  # the empty folder under the mount point
                real, helper.write_part = helper.write_part, unmount
                try:
                    self.assertEqual(self.put("g1", b"gone", "Sub/Gone.mov"), {"state": "reconnect"})
                finally:
                    helper.write_part = real
                if remount:
                    self.assertEqual(os.listdir(self.root), [])
                else:
                    self.assertFalse(os.path.exists(self.root))
                    os.mkdir(self.root)

    def test_lease_interop(self):
        self.job("check", init="1")
        lock = self.path(helper.LOCK)
        # the Mac's lease, fresh: refused
        self.lock_as("dev-mac")
        with self.assertRaisesRegex(RuntimeError, "Another computer"):
            self.job("check")
        # 11 minutes old on the share: taken; what the helper writes is the same JSON
        os.utime(lock, (time.time() - 660, time.time() - 660))
        f = helper.Folder(self.root, ME)
        f.open()
        written = json.loads(self.read(helper.LOCK))
        self.assertEqual(set(written), {"device", "at"})
        self.assertEqual(written["device"], ME)
        f.drop()
        self.assertFalse(os.path.exists(lock))
        # an old plain-text lock is another writer's: refused while fresh, taken when stale
        self.write(helper.LOCK, b"somehost 123 abc")
        with self.assertRaises(RuntimeError):
            self.job("check")
        os.utime(lock, (0, 0))
        self.assertEqual(self.job("check"), {"gone": []})
        # a lease another computer holds is never dropped by this one
        self.lock_as("dev-mac", at=1)
        f.held = True
        f.drop()
        self.assertTrue(os.path.exists(lock))

    def test_beat_stops_a_job_taken_over(self):
        self.job("check", init="1")
        body = b"x" * (3 * helper.CHUNK)

        def stolen(url, offset):
            self.lock_as("dev-mac")
            self.folder.beat()
            return Resp(body, offset)
        self.body = body
        with self.assertRaises(helper.Lost):
            self.job("copy", fetch=stolen, key="b1", rel="Big.mov", size=str(len(body)), sha256=sha(body), paths="[]", url="/f")
        self.assertFalse(os.path.lexists(self.path("Big.mov")))
        self.assertEqual(json.loads(self.read(helper.LOCK))["device"], "dev-mac")

    def test_taken_over_is_never_reported_done(self):
        self.job("check", init="1")
        calls = []
        h = fake_helper(calls)
        body = b"y" * 100

        def stolen(url, offset):
            self.lock_as("dev-mac")
            time.sleep(0.3)  # the beat comes meanwhile
            return Resp(body, offset)
        h.fetch = stolen
        beat, helper.BEAT_S = helper.BEAT_S, 0.05
        try:
            h.copy({"id": 7, "options": {"op": "copy", "device": ME, "copy": "cp_1", "library": "lib_1", "root": self.root, "key": "t1",
                                         "rel": "T.mov", "size": "100", "sha256": sha(body), "paths": "[]", "url": "/f"}})
        finally:
            helper.BEAT_S = beat
        self.assertEqual([p for p, b in calls if not (b or {}).get("beat")], ["/api/devices/relay/job/copy/7/fail"])
        self.assertFalse(os.path.lexists(self.path("T.mov")))

    def test_sweep_own_partials_only(self):
        self.job("check", init="1")
        self.write(".Old.mov.dev-helper.partial")
        os.utime(self.path(".Old.mov.dev-helper.partial"), (0, 0))
        self.write(".New.mov.dev-helper.partial")
        self.write(".Theirs.mov.dev-mac.partial")
        os.utime(self.path(".Theirs.mov.dev-mac.partial"), (0, 0))
        self.job("check")
        self.assertEqual(self.partials(), [".Theirs.mov.dev-mac.partial"])
        # a copy job sweeps too, but keeps (and resumes with Range) its own file's partial
        self.write(".Gone.mov.dev-helper.partial")
        body = b"0123456789" * 1000
        self.write(".Resumed.bin.dev-helper.partial", body[:4000])
        self.put("r1", body, "Resumed.bin")
        self.assertEqual(self.asked, [4000])
        self.assertEqual(self.read("Resumed.bin"), body)
        self.assertEqual(self.partials(), [".Theirs.mov.dev-mac.partial"])

    def test_names(self):
        self.job("check", init="1")
        nfd = unicodedata.normalize("NFD", "Café.mov")
        self.write(nfd, b"cafe clip")
        # an NFD name on the disk is the same name: this very file (by hash), and never overwritten when it is another
        self.asked = []
        self.assertEqual(self.put("n1", b"cafe clip", "Café.mov")["done"]["rel"], "Café.mov")
        self.assertEqual(self.asked, [])
        self.assertEqual(self.put("n2", b"another", "Café.mov")["done"]["rel"], "Café 2.mov")
        self.assertEqual(self.read(nfd), b"cafe clip")
        # "\" becomes "_"
        self.assertEqual(self.put("n3", b"slash", "a\\b.mov")["done"]["rel"], "a_b.mov")
        self.assertEqual(self.read("a_b.mov"), b"slash")
        # a long stem is trimmed so the partial's name fits 255 bytes
        rel = self.put("n4", b"long", "é" * 200 + ".mov")["done"]["rel"]
        self.assertLessEqual(len(os.path.basename(helper.part_of(rel, ME)).encode()), 255)
        self.assertTrue(rel.startswith("éé") and rel.endswith(".mov"))
        self.assertEqual(self.read(rel), b"long")

    def test_path_checksum_and_outside(self):
        self.job("check", init="1")
        body = b"0123456789" * 1000
        # a path on this computer with the right size is read, not the server
        src = os.path.join(self.share, "src.mov")
        with open(src, "wb") as f:
            f.write(body)
        self.assertEqual(self.put("p1", body, "From path.bin", paths=json.dumps(["/nope", src]))["done"]["sha256"], sha(body))
        self.assertEqual(self.asked, [])
        # a file that is not the library's is never put in place
        self.body = body
        with self.assertRaises(RuntimeError):
            self.job("copy", key="p3", rel="Bad.bin", size=str(len(body)), sha256="0" * 64, paths="[]", url="/f")
        self.assertFalse(os.path.lexists(self.path("Bad.bin")))
        self.assertEqual(self.partials(), [])
        # a path outside the folder is refused
        with self.assertRaises(RuntimeError):
            self.put("p4", body, "../out.bin")

    def test_full(self):
        self.job("check", init="1")

        def full(url, offset):
            raise OSError(errno.ENOSPC, "No space left on device")
        self.assertEqual(self.job("copy", fetch=full, key="f", rel="F.bin", size="3", paths="[]", url="/f"), {"state": "full"})

    def test_send(self):
        body = b"the original" * 500
        src = os.path.join(self.share, "orig.mov")
        with open(src, "wb") as f:
            f.write(body)
        got = []

        def post(url, f, size):
            got.append((url, f.read(), size))
            return {}
        o = {"op": "send", "key": "k", "size": str(len(body)), "url": "/api/devices/relay/job/copy/9/file", "paths": json.dumps(["/nope", src])}
        calls = []
        h = fake_helper(calls)
        h.post = post
        h.copy({"id": 9, "options": o})
        self.assertEqual(got, [("/api/devices/relay/job/copy/9/file", body, len(body))])
        self.assertEqual(calls, [])
        # not at that size any more: the job fails with why
        h.copy({"id": 9, "options": {**o, "size": "5"}})
        self.assertEqual(calls, [("/api/devices/relay/job/copy/9/fail", {"error": "The original is not on this computer any more"})])

    def test_readable_only_media_on_a_share_or_own_copy(self):
        """A server can't have the helper read any file it names (a key in ~/.ssh, found by its size)."""
        key = b"-----BEGIN OPENSSH PRIVATE KEY-----" + b"x" * 364
        ssh = os.path.join(self.top, "home", ".ssh")
        os.makedirs(ssh)
        with open(os.path.join(ssh, "id_ed25519"), "wb") as f:
            f.write(key)
        self.assertIsNone(helper.readable([os.path.join(ssh, "id_ed25519")], len(key)))
        # named with a media extension, or linked from inside the share: still outside it
        os.symlink(os.path.join(ssh, "id_ed25519"), os.path.join(ssh, "id.mov"))
        self.assertIsNone(helper.readable([os.path.join(ssh, "id.mov")], len(key)))
        os.symlink(os.path.join(ssh, "id_ed25519"), os.path.join(self.share, "take.mov"))
        self.assertIsNone(helper.readable([os.path.join(self.share, "take.mov")], len(key)))
        # not a media file, even on the share
        with open(os.path.join(self.share, "notes.txt"), "wb") as f:
            f.write(b"12345")
        self.assertIsNone(helper.readable([os.path.join(self.share, "notes.txt")], 5))
        # a video on the share is read
        clip = os.path.join(self.share, "Day 1", "Kitchen.MOV")
        os.makedirs(os.path.dirname(clip))
        with open(clip, "wb") as f:
            f.write(b"video")
        self.assertEqual(helper.readable([os.path.join(self.top, "nope.mov"), clip], 5), os.path.realpath(clip))
        self.assertIsNone(helper.readable([clip], 6))
        # a copy folder is read once its marker is this helper's, not before
        self.write("In copy.mov", b"copy!")
        self.assertIsNone(helper.readable([self.path("In copy.mov")], 5))
        self.job("check", init="1")
        self.assertEqual(helper.readable([self.path("In copy.mov")], 5), os.path.realpath(self.path("In copy.mov")))
        # send refuses the key: "not on this computer"
        calls = []
        h = fake_helper(calls)
        h.post = lambda url, f, size: self.fail("the key was sent")
        h.copy({"id": 3, "options": {"op": "send", "key": "k", "size": str(len(key)), "url": "/api/devices/relay/job/copy/3/file", "paths": json.dumps([os.path.join(ssh, "id_ed25519")])}})
        self.assertEqual(calls, [("/api/devices/relay/job/copy/3/fail", {"error": "The original is not on this computer any more"})])

    def test_folder_walk(self):
        for p in ("a/b/c", "a/.hidden", "z.app/inside"):
            os.makedirs(self.path(p))
        self.write("a/f.txt", b"12345")
        os.symlink("/", self.path("link"))
        w = helper.folder_walk(self.root, 2, False)
        self.assertEqual(w["entries"], [{"path": "a", "dir": True}, {"path": "z.app", "dir": True}, {"path": "a/b", "dir": True}, {"path": "a/f.txt", "size": 5}])
        self.assertEqual(w["deeper"], 1)
        with self.assertRaises(RuntimeError):
            helper.folder_walk("/", 1, False)
        self.assertTrue(any(e.get("dir") for e in helper.folder_walk("/", 1, True)["entries"]))


if __name__ == "__main__":
    unittest.main()
