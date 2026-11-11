import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Every test's temp files go in one folder per run, removed when the run ends. Tests make theirs with
 * mkdtemp(os.tmpdir()) and many never removed them: one computer had 70,000 such folders, 7 GB, in its temp folder.
 * os.tmpdir() reads TMPDIR, and the test workers start after this, so they inherit it.
 */
export default function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-test-"));
  process.env.TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
