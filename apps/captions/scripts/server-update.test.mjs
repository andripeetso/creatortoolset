import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The updater against a real git checkout and a stand-in `docker`: what runs "in the app" runs here, with the data
// folder in DATA_DIR, and every build or restart is written to a log.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(APP, "node_modules", ".tmp", `server-update-test-${process.pid}`);
const origin = path.join(root, "origin");
const site = path.join(root, "site");
const data = path.join(root, "data");
const log = path.join(root, "docker.log");
const script = path.join(site, "apps", "captions", "scripts", "server-update.sh");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
const change = (name) => (writeFileSync(path.join(origin, name), name), git(origin, "add", "."), git(origin, "commit", "-qm", name), git(origin, "rev-parse", "HEAD"));
const hourNow = String(new Date().getHours());
const run = (env = {}) =>
  spawnSync("sh", [script], { encoding: "utf8", env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, DATA_DIR: data, FAKE: root, CT_UPDATE_WAIT: "0", TMPDIR: root, ...env } });
const status = () => JSON.parse(readFileSync(path.join(data, "server-update", "status.json"), "utf8"));
const request = path.join(data, "server-update", "request");
const built = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l === "compose build").length : 0);

beforeAll(() => {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  change("a");
  git(root, "clone", "-q", origin, site);
  mkdirSync(path.dirname(script), { recursive: true });
  cpSync(path.join(APP, "scripts", "server-update.sh"), script);
  writeFileSync(
    path.join(root, "bin", "docker"),
    `#!/bin/sh\ncase "$2" in\n  build) echo "compose build" >> "$FAKE/docker.log"; [ ! -e "$FAKE/build-fails" ] ;;\n  up) echo "compose up" >> "$FAKE/docker.log" ;;\n  exec) shift 4; case "$1" in node) exit 0 ;; *) exec "$@" ;; esac ;;\nesac\n`,
  );
  chmodSync(path.join(root, "bin", "docker"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("says what is waiting, updates on the button and at the night hour, and leaves a failed build alone", () => {
  run();
  expect(status()).toEqual({ behind: 0, nightly: null, failed: false });

  const b = change("b");
  run();
  expect(status()).toEqual({ behind: 1, nightly: null, failed: false });
  expect(built()).toBe(0); // nobody asked, and no night hour is set

  writeFileSync(request, "ada");
  expect(run().status).toBe(0);
  expect(built()).toBe(1);
  expect(readFileSync(log, "utf8")).toContain("compose up");
  expect(existsSync(request)).toBe(false);
  expect(status()).toEqual({ behind: 0, nightly: null, failed: false });
  expect(git(site, "config", "--get", "creatortoolset.running")).toBe(b);

  change("c");
  writeFileSync(path.join(root, "build-fails"), "");
  writeFileSync(request, "ada");
  expect(run().status).toBe(1);
  expect(existsSync(request)).toBe(false);
  expect(status()).toEqual({ behind: 1, nightly: null, failed: true });
  run({ CT_UPDATE_HOUR: hourNow }); // the night does not try the build that failed
  expect(built()).toBe(2);
  expect(status()).toMatchObject({ behind: 1, failed: true });
  const due = status().nightly - Date.now() / 1000; // the next start of this hour: tomorrow
  expect(due).toBeGreaterThan(22 * 3600);
  expect(due).toBeLessThanOrEqual(24 * 3600);

  rmSync(path.join(root, "build-fails"));
  const d = change("d");
  run({ CT_UPDATE_HOUR: String((Number(hourNow) + 1) % 24) }); // not the hour yet
  expect(built()).toBe(2);
  run({ CT_UPDATE_HOUR: hourNow.padStart(2, "0") });
  expect(built()).toBe(3);
  expect(status()).toMatchObject({ behind: 0, failed: false });
  expect(git(site, "config", "--get", "creatortoolset.running")).toBe(d);
});
