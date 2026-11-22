"""The helper's folder list, container paths, fingerprint and scans. From this folder: python3 -I -m unittest"""
import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
SCRATCH = tempfile.mkdtemp(prefix="ct-helper-test-", dir=os.environ.get("CT_SCRATCH_DIR"))
os.environ["CT_HELPER_HOME"] = os.path.join(SCRATCH, "home")
os.environ.pop("CT_FOLDERS", None)
import helper  # noqa: E402

MIB = 1 << 20
# api/work/files.ts quickPrint on the same bytes (node, once)
PIN = {
    "big": "85f4bb4b1012537af207fa6212b9b9e5aa025b89470029907e2b33d24218dbc0",
    "small": "13c01436df3bf6daf91b250be62ef681f1a5a4cf188f080e71153095f265f24e",
    "empty": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
}


def write(p, data=b"x"):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    return p


def folder(d, fid="f1", host=None):
    return {"id": fid, "use": "media", "hostPath": host or d, "mountPath": d}


class Fake(helper.Helper):
    """A Helper whose server calls are written down."""

    def __init__(self, folders=(), config=None):
        super().__init__("https://server.invalid", "ctd_test", config or {"server": "x", "token": "ctd_test"})
        self.server_folders, self.sent = list(folders), []

    def call(self, method, path, body=None, **k):
        self.sent.append((method, path, body))
        return {"ok": True, "index": []}


class FolderList(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(dir=SCRATCH)
        self.mine, self.other = os.path.join(self.d, "Tiny Footage"), os.path.join(self.d, "Elsewhere")
        write(os.path.join(self.mine, "a.mp4"))
        write(os.path.join(self.other, "secret.mp4"))

    def test_folder_list_refused_off_the_list(self):
        h = Fake([folder(self.mine)])
        h.folder_list({"id": 7, "options": {"path": self.other}})
        self.assertTrue(h.sent[-1][1].endswith("/7/fail"))
        self.assertIn("not in this computer's folder list", h.sent[-1][2]["error"])
        h.folder_list({"id": 8, "options": {"path": "/", "disk": "1"}})
        self.assertTrue(h.sent[-1][1].endswith("/8/fail"))
        h.folder_list({"id": 9, "options": {"path": self.mine}})
        self.assertEqual(h.sent[-1][1], "/api/devices/relay/job/folder-list/9")
        self.assertEqual(h.sent[-1][2]["entries"], [{"path": "a.mp4", "size": 1}])

    def test_copy_root_refused_off_the_list(self):
        h = Fake()
        h.copy({"id": 3, "options": {"op": "copy", "root": self.other, "device": "dev-1"}})
        self.assertTrue(h.sent[-1][1].endswith("/3/fail"))
        self.assertIn("folder list", h.sent[-1][2]["error"])

    def test_listed_from_config_env_and_server(self):
        gone = folder(os.path.join(self.d, "not-mounted"), "f2")
        c = {"folders": [self.other]}
        fs = helper.listed([folder(self.mine), gone, {**folder(self.d, "f3"), "use": "exports"}], c)
        self.assertTrue(helper.allowed(os.path.join(self.mine, "a.mp4"), fs))
        self.assertTrue(helper.allowed(self.other, fs))
        self.assertFalse(helper.allowed(os.path.join(self.d, "not-mounted"), fs))  # the server's, but not here
        self.assertFalse(helper.allowed(self.d, fs))  # an exports folder is not read
        self.assertFalse(helper.allowed(self.mine + "x", fs))
        os.symlink(self.other, os.path.join(self.mine, "link"))
        self.assertFalse(helper.allowed(os.path.join(self.mine, "link"), helper.listed([folder(self.mine)], {})))
        os.environ["CT_FOLDERS"] = self.other
        try:
            self.assertTrue(helper.allowed(self.other, helper.listed([], {})))
        finally:
            del os.environ["CT_FOLDERS"]


class ContainerPaths(unittest.TestCase):
    F = [{"hostPath": "/mnt/tank/Tiny Footage", "mountPath": "/footage"}, {"hostPath": "/mnt/tank", "mountPath": "/tank"}]

    def test_both_ways(self):
        self.assertEqual(helper.to_host("/footage/2026/a.mp4", self.F), "/mnt/tank/Tiny Footage/2026/a.mp4")
        self.assertEqual(helper.to_mount("/mnt/tank/Tiny Footage/2026/a.mp4", self.F), "/footage/2026/a.mp4")
        self.assertEqual(helper.to_mount("/mnt/tank/other/b.mp4", self.F), "/tank/other/b.mp4")
        self.assertEqual(helper.to_host("/footage", self.F), "/mnt/tank/Tiny Footage")
        self.assertEqual(helper.to_host("/footagex/a.mp4", self.F), "/footagex/a.mp4")
        for p in ("/footage/a b/c.mov", "/tank/x.mov"):
            self.assertEqual(helper.to_mount(helper.to_host(p, self.F), self.F), p)

    def test_scan_reports_host_paths(self):
        d = tempfile.mkdtemp(dir=SCRATCH)
        write(os.path.join(d, "Shoot", "a.mp4"), b"tinyacrobatics")
        pages = list(helper.scan_pages(folder(d, host="/mnt/tank/Tiny Footage"), {}, {}, set(), pause=0))
        self.assertEqual([f["path"] for f in pages[-1]["files"]], ["/mnt/tank/Tiny Footage/Shoot/a.mp4"])

    def test_index_reads_the_mount_and_sends_the_host_path(self):
        d = tempfile.mkdtemp(dir=SCRATCH)
        write(os.path.join(d, "a.mp4"), b"tinyacrobatics")
        f = folder(d, host="/mnt/tank/Tiny Footage")
        h = Fake([f])
        h.index(f, "/mnt/tank/Tiny Footage/a.mp4")
        body = h.sent[-1][2]
        self.assertEqual((body["path"], body["name"], body["size"], body["folder"]), ("/mnt/tank/Tiny Footage/a.mp4", "a.mp4", 14, "f1"))
        self.assertEqual(body["quick"], helper.quick_print(os.path.join(d, "a.mp4")))
        n = len(h.sent)
        h.index(f, "/etc/passwd")  # not inside the folder: nothing read, nothing sent
        self.assertEqual(len(h.sent), n)


class OwnSound(unittest.TestCase):
    """A transcript of a file in this helper's folders: the sound is cut here from its own copy, never asked of the server."""

    def setUp(self):
        self.d = tempfile.mkdtemp(dir=SCRATCH)
        self.f = folder(self.d, host="/mnt/tank/Tiny Footage")
        self.h = Fake([self.f])

    def job(self, path, size):
        return {"id": 3, "kind": "transcribe", "options": {"version": "v1", "path": path, "bytes": str(size)}}

    def test_no_copy_here_is_none(self):
        write(os.path.join(self.d, "a.mp4"), b"tinyacrobatics")
        self.assertIsNone(self.h.own_sound({"id": 3, "kind": "transcribe"}))  # a recording the server holds
        self.assertIsNone(self.h.own_sound(self.job("/mnt/tank/Tiny Footage/a.mp4", 99)))  # another size: not this file
        self.assertIsNone(self.h.own_sound(self.job("/etc/passwd", os.path.getsize("/etc/passwd"))))  # off the list
        self.assertEqual(self.h.sent, [])

    @unittest.skipUnless(helper.shutil.which("ffmpeg") and helper.importlib.util.find_spec("numpy"), "needs ffmpeg and numpy")
    def test_cuts_its_own_copy(self):
        src = os.path.join(self.d, "Shoot", "tone.m4a")
        os.makedirs(os.path.dirname(src))
        helper.subprocess.run([helper.shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", src], check=True)
        samples = self.h.own_sound(self.job("/mnt/tank/Tiny Footage/Shoot/tone.m4a", os.path.getsize(src)))
        self.assertAlmostEqual(len(samples) / 16000, 2, delta=0.1)
        self.assertGreater(float(abs(samples).max()), 0.1)
        self.assertEqual(self.h.sent, [])  # nothing asked of the server


class Quick(unittest.TestCase):
    def test_same_as_the_server(self):
        d = tempfile.mkdtemp(dir=SCRATCH)
        big = (bytes(range(251)) * (2 * MIB // 251 + 100))[:2 * MIB + 12345]
        files = {"big": big, "small": b"tinyacrobatics" * 1000, "empty": b""}
        for name, data in files.items():
            self.assertEqual(helper.quick_print(write(os.path.join(d, name), data)), PIN[name], name)
        self.assertIsNone(helper.quick_print(os.path.join(d, "none")))


class Scan(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(dir=SCRATCH)
        for i in range(7):
            write(os.path.join(self.d, f"s{i % 2}", f"c{i}.mp4"), bytes([i]) * (i + 1))
        write(os.path.join(self.d, "notes.txt"))
        write(os.path.join(self.d, ".hidden.mp4"))
        self.reads = []

    def quick(self, p):
        self.reads.append(p)
        return helper.quick_print(p)

    def test_pages_share_a_scan_and_complete_on_the_last(self):
        old, helper.PAGE = helper.PAGE, 3
        try:
            cache = {}
            pages = list(helper.scan_pages(folder(self.d), cache, {}, set(), quick=self.quick, pause=0))
            self.assertEqual([len(p["files"]) for p in pages], [3, 3, 1])
            self.assertEqual(len({p["scan"] for p in pages}), 1)
            self.assertEqual([p.get("complete", False) for p in pages], [False, False, True])
            self.assertEqual([p["page"] for p in pages], [0, 1, 2])
            self.assertEqual(len(self.reads), 7)
            self.assertTrue(all(len(f["quick"]) == 64 for p in pages for f in p["files"]))
            # again: nothing read twice, a new scan id
            again = list(helper.scan_pages(folder(self.d), cache, {}, set(), quick=self.quick, pause=0))
            self.assertEqual(len(self.reads), 7)
            self.assertNotEqual(again[0]["scan"], pages[0]["scan"])
            # a file changed is read again; a file deleted leaves the cache
            write(os.path.join(self.d, "s0", "c0.mp4"), b"changed")
            os.unlink(os.path.join(self.d, "s1", "c1.mp4"))
            list(helper.scan_pages(folder(self.d), cache, {}, set(), quick=self.quick, pause=0))
            self.assertEqual(len(self.reads), 8)
            self.assertNotIn(os.path.join(self.d, "s1", "c1.mp4"), cache)
        finally:
            helper.PAGE = old

    @unittest.skipIf(os.geteuid() == 0, "root reads every folder")
    def test_an_unreadable_folder_is_named(self):
        locked = os.path.join(self.d, "s1")
        os.chmod(locked, 0)
        try:
            pages = list(helper.scan_pages(folder(self.d, host="/host"), {}, {}, set(), pause=0))
        finally:
            os.chmod(locked, 0o755)
        self.assertEqual(pages[-1]["unreadable"], ["/host/s1"])
        self.assertTrue(pages[-1]["complete"])

    def test_a_copy_reports_its_sha256(self):
        h = Fake([folder(self.d)])
        p = os.path.join(self.d, "s0", "c0.mp4")
        h.remember(p, "ab" * 32)
        files = list(helper.scan_pages(folder(self.d), h.cache, {}, set(), pause=0))[-1]["files"]
        self.assertEqual(next(f for f in files if f["path"] == p)["sha256"], "ab" * 32)
        self.assertEqual(helper.read_json(helper.SCANS)[p][3], "ab" * 32)  # kept across a restart


class States(unittest.TestCase):
    def test_disk_away_and_not_found(self):
        known = {"/mnt/tiny-share": "Tiny Footage", "/": "/"}
        f = folder("/mnt/tiny-share/Shoots")
        away = list(helper.scan_pages(f, {}, known, {"/"}))
        self.assertEqual(away, [{"id": "f1", "state": "disk_away", "disk": "Tiny Footage"}])
        mounted = list(helper.scan_pages(f, {}, known, {"/", "/mnt/tiny-share"}))
        self.assertEqual(mounted, [{"id": "f1", "state": "not_found"}])
        self.assertEqual(list(helper.scan_pages(folder("/no/such/folder"), {}, known, {"/"})), [{"id": "f1", "state": "not_found"}])

    def test_an_empty_folder_is_not_listed_as_empty(self):
        d = tempfile.mkdtemp(dir=SCRATCH)
        self.assertEqual(list(helper.scan_pages(folder(d), {}, {}, set())), [{"id": "f1", "state": "not_found"}])


class Machine(unittest.TestCase):
    def test_made_once(self):
        c = {}
        a = helper.machine_id(c)
        self.assertRegex(a, r"^[\w-]{8,80}$")
        self.assertEqual(helper.machine_id(c), a)
        self.assertEqual(Fake(config={"machineId": a}).base()["machineId"], a)

    def test_report_has_version_2(self):
        h = Fake()
        h.report()
        post = next(b for m, p, b in h.sent if p == "/api/devices/relay/report")
        self.assertEqual((post["reportVersion"], post["machineId"]), (2, h.config["machineId"]))


class Security(unittest.TestCase):
    def test_token_only_to_https_or_this_computer(self):
        for ok in ("https://tools.example.test", "http://localhost:43127", "http://127.0.0.1", "http://[::1]:8080"):
            self.assertEqual(helper.checked_server(ok), ok)
        for bad in ("http://tools.example.test", "http://localhost.example.test", "http://localhost@tools.example.test",
                    "ftp://tools.example.test", "https://", "tools.example.test"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                helper.checked_server(bad)

    def test_config_is_0600_even_over_an_old_temp_file(self):
        p = os.path.join(SCRATCH, "config.json")
        with open(p + ".tmp", "w") as f:
            f.write("old")
        os.chmod(p + ".tmp", 0o644)
        helper.write_json(p, {"token": "ctd_test"})
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        with open(p) as f:
            self.assertEqual(json.load(f), {"token": "ctd_test"})


if __name__ == "__main__":
    unittest.main()
