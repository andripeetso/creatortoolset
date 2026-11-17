"""The Linux helper's copier (public/helper/helper.py, contracts/devices.ts COPY_KIND) without a server: the marker, an
older version into .versions/, a file in the way, a file already there, a resumed partial, a full disk, the folder walk.
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
import unittest

spec = importlib.util.spec_from_file_location("helper", os.path.join(os.path.dirname(__file__), "../public/helper/helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

sha = lambda b: hashlib.sha256(b).hexdigest()


class Resp(io.BytesIO):
    """A server's answer to a GET of the file, Range honoured."""

    def __init__(self, body, offset):
        super().__init__(body[offset:])
        self.status = 206 if offset else 200
        self.headers = {"content-range": f"bytes {offset}-{len(body) - 1}/{len(body)}"} if offset else {}


class Copies(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(dir=os.environ.get("CT_SCRATCH_DIR"))
        self.asked = []

    def tearDown(self):
        shutil.rmtree(self.root)

    def job(self, op, **o):
        return helper.copy_run({"op": op, "copy": "cp_1", "library": "lib_1", "root": self.root, **o}, self.fetch, helper.Lease(self.root))

    def fetch(self, url, offset):
        self.asked.append(offset)
        return Resp(self.body, offset)

    def put(self, key, body, rel, n=1, **o):
        self.body = body
        return self.job("copy", **{"key": key, "asset": "a1", "n": str(n), "rel": rel, "size": str(len(body)), "sha256": sha(body), "paths": "[]", "url": "/f", **o})

    def marker(self):
        with open(os.path.join(self.root, helper.MARKER)) as f:
            return json.load(f)

    def read(self, rel):
        with open(os.path.join(self.root, rel), "rb") as f:
            return f.read()

    def test_marker_and_reconnect(self):
        self.assertEqual(self.job("check"), {"state": "reconnect"})  # no marker, not its first job
        self.assertEqual(self.job("check", init="1"), {"gone": []})
        self.assertEqual(self.marker(), {"library": "lib_1", "copy": "cp_1", "files": {}})
        # another library's marker is never taken over; the same library's is (stopped, added again)
        self.assertEqual(helper.copy_run({"op": "check", "copy": "cp_2", "library": "lib_2", "root": self.root, "init": "1"}, None, helper.Lease(self.root)), {"state": "reconnect"})
        self.assertEqual(helper.copy_run({"op": "check", "copy": "cp_2", "library": "lib_1", "root": self.root, "init": "1"}, None, helper.Lease(self.root)), {"gone": []})
        self.assertEqual(self.marker()["copy"], "cp_2")
        self.assertEqual(self.job("check", root=self.root + "/missing"), {"state": "reconnect"})
        self.assertFalse(os.path.exists(os.path.join(self.root, helper.LOCK)))

    def test_versions_beside_and_gone(self):
        self.job("check", init="1")
        v1 = b"take one"
        self.assertEqual(self.put("v1", v1, "Interviews/Kitchen.mov")["done"], {"rel": "Interviews/Kitchen.mov", "size": 8, "sha256": sha(v1)})
        # the same job again (the server did not hear it): nothing fetched, the same answer
        self.asked = []
        self.assertEqual(self.put("v1", v1, "Interviews/Kitchen.mov")["done"]["rel"], "Interviews/Kitchen.mov")
        self.assertEqual(self.asked, [])
        # a newer version: the older one into .versions/ as "v1", never over one already there
        os.makedirs(os.path.join(self.root, ".versions/Interviews"))
        open(os.path.join(self.root, ".versions/Interviews/Kitchen v1.mov"), "wb").close()
        self.put("v2", b"take two!", "Interviews/Kitchen.mov", n=2, prev="Interviews/Kitchen.mov")
        self.assertEqual(self.read("Interviews/Kitchen.mov"), b"take two!")
        self.assertEqual(self.read(".versions/Interviews/Kitchen v1 2.mov"), v1)
        self.assertEqual(self.marker()["files"]["v1"]["rel"], ".versions/Interviews/Kitchen v1 2.mov")
        # the person's own file in the way stays; the new one goes beside it
        with open(os.path.join(self.root, "Mine.mov"), "wb") as f:
            f.write(b"not ours")
        self.assertEqual(self.put("v3", b"other clip", "Mine.mov")["done"]["rel"], "Mine 2.mov")
        self.assertEqual(self.read("Mine.mov"), b"not ours")
        # this very file already there (indexed in place) counts as copied
        with open(os.path.join(self.root, "Here.mov"), "wb") as f:
            f.write(b"in place")
        self.asked = []
        self.assertEqual(self.put("v4", b"in place", "Here.mov")["done"]["rel"], "Here.mov")
        self.assertEqual(self.asked, [])
        # a file gone from the disk is reported and leaves the marker
        os.unlink(os.path.join(self.root, "Mine 2.mov"))
        self.assertEqual(self.job("check"), {"gone": ["v3"]})
        self.assertNotIn("v3", self.marker()["files"])

    def test_path_resume_and_checksum(self):
        self.job("check", init="1")
        body = b"0123456789" * 1000
        # a path on this computer with the right size is read, not the server
        src = os.path.join(self.root, "src.bin")
        with open(os.path.join(self.root, ".src.bin.partial"), "wb"):
            pass
        with open(src, "wb") as f:
            f.write(body)
        self.assertEqual(self.put("p1", body, "From path.bin", paths=json.dumps(["/nope", src]))["done"]["sha256"], sha(body))
        self.assertEqual(self.asked, [])
        # a partial is resumed with Range
        with open(os.path.join(self.root, ".Resumed.bin.partial"), "wb") as f:
            f.write(body[:4000])
        self.put("p2", body, "Resumed.bin")
        self.assertEqual(self.asked, [4000])
        self.assertEqual(self.read("Resumed.bin"), body)
        # a file that is not the library's is never put in place
        self.body = body
        with self.assertRaises(RuntimeError):
            self.job("copy", key="p3", rel="Bad.bin", size=str(len(body)), sha256="0" * 64, paths="[]", url="/f")
        self.assertFalse(os.path.lexists(os.path.join(self.root, "Bad.bin")))
        self.assertFalse(os.path.lexists(os.path.join(self.root, ".Bad.bin.partial")))
        # an old partial is swept by the check, a fresh one kept
        os.utime(os.path.join(self.root, ".src.bin.partial"), (0, 0))
        with open(os.path.join(self.root, ".Fresh.bin.partial"), "wb"):
            pass
        self.job("check")
        self.assertFalse(os.path.exists(os.path.join(self.root, ".src.bin.partial")))
        self.assertTrue(os.path.exists(os.path.join(self.root, ".Fresh.bin.partial")))
        # a path outside the folder is refused
        with self.assertRaises(RuntimeError):
            self.put("p4", body, "../out.bin")

    def test_full_and_lease(self):
        self.job("check", init="1")

        def full(url, offset):
            raise OSError(errno.ENOSPC, "No space left on device")
        self.assertEqual(helper.copy_run({"op": "copy", "copy": "cp_1", "library": "lib_1", "root": self.root, "key": "f", "rel": "F.bin", "size": "3", "paths": "[]", "url": "/f"}, full, helper.Lease(self.root)), {"state": "full"})
        # another writer's fresh lease: this one does not write
        other = helper.Lease(self.root)
        other.take()
        with self.assertRaises(RuntimeError):
            self.job("check")
        other.drop()
        self.assertEqual(self.job("check"), {"gone": []})

    def test_folder_walk(self):
        for p in ("a/b/c", "a/.hidden", "z.app/inside"):
            os.makedirs(os.path.join(self.root, p))
        with open(os.path.join(self.root, "a/f.txt"), "wb") as f:
            f.write(b"12345")
        os.symlink("/", os.path.join(self.root, "link"))
        w = helper.folder_walk(self.root, 2, False)
        self.assertEqual(w["entries"], [{"path": "a", "dir": True}, {"path": "z.app", "dir": True}, {"path": "a/b", "dir": True}, {"path": "a/f.txt", "size": 5}])
        self.assertEqual(w["deeper"], 1)
        with self.assertRaises(RuntimeError):
            helper.folder_walk("/", 1, False)
        self.assertTrue(any(e.get("dir") for e in helper.folder_walk("/", 1, True)["entries"]))


if __name__ == "__main__":
    unittest.main()
