/**
 * Ratchets for the local-first rule (owner, 2026-11-17): files and work stay on the person's computers unless something
 * was marked to run on the server. Each list can only shrink: a new entry needs the owner's OK.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesMatching, repo } from "./lib/scan-source";

/**
 * T1: every file under api/ that starts a decoder, an encoder, a browser or a model, with what gates it today. A new file
 * that starts one fails the build until it is gated and listed. Fixing one (its work moves to a computer) removes its row.
 */
const DECODERS: Record<string, string> = {
  // library jobs: DECODES run only where the server's video work is on (library/worker.ts leftToComputers, serverWorks)
  "api/library/worker.ts": "serverWorks (DECODES); probe is P3f",
  "api/library/media/probe.ts": "probe: P3f",
  "api/library/media/proxy.ts": "serverWorks (DECODES proxy)",
  "api/library/media/run.ts": "the runner of the library's ffmpeg calls",
  "api/library/media/sprite.ts": "serverWorks (DECODES sprite)",
  "api/library/media/thumb.ts": "serverWorks (DECODES thumb)",
  "api/library/media/wave.ts": "serverWorks (DECODES wave)",
  "api/library/fingerprint.ts": "serverWorks (DECODES fingerprint)",
  "api/library/transcribe.ts": "serverWorks (DECODES transcribe)",
  "api/library/describe.ts": "serverWorks (DECODES describe)",
  "api/library/look.ts": "serverWorks (DECODES look)",
  "api/library/vpdq.ts": "serverWorks (DECODES fingerprint)",
  "api/library/shots.ts": "serverWorks (DECODES look); unverified",
  "api/library/cuts.ts": "serverWorks (DECODES look); unverified",
  "api/library/timeline.ts": "OPEN P3f: the watch copy encode",
  "api/library/pictures.ts": "OPEN P3f",
  "api/library/turn.ts": "OPEN P3f: rotate on the thumb",
  "api/library/estimate.ts": "OPEN P3f; unverified",
  "api/library/watch.ts": "OPEN P3f; unverified",
  "api/library/storage/types.ts": "names a type only; unverified",
  // AI Editor steps: placeOf puts a step that reads video or sound on a computer; the server takes it only through
  // serverMayTake (work/place.ts mayRunHere)
  "api/editor/analyze.ts": "mayRunHere (placeOf)",
  "api/editor/animation-styles.ts": "OPEN P3d; unverified",
  "api/editor/cards/step.ts": "OPEN P3d: tiles the drawn cards (pictures, no footage)",
  "api/editor/critique.ts": "mayRunHere (placeOf)",
  "api/editor/eyeline.ts": "mayRunHere (placeOf)",
  "api/editor/generate.ts": "mayRunHere (placeOf)",
  "api/editor/grade.ts": "mayRunHere (placeOf); unverified",
  "api/editor/index.ts": "mayRunHere (placeOf)",
  "api/editor/mediapipe.ts": "mayRunHere (placeOf)",
  "api/editor/plan-render.ts": "mayRunHere (placeOf)",
  "api/editor/plan.ts": "mayRunHere (placeOf)",
  "api/editor/preview.ts": "mayRunHere (placeOf: preview on a computer)",
  "api/editor/speakers.ts": "mayRunHere (placeOf)",
  "api/editor/subject-engine.ts": "mayRunHere (placeOf); unverified",
  "api/editor/subject.ts": "mayRunHere (placeOf); unverified",
  "api/editor/sync.ts": "mayRunHere (placeOf)",
  // processing with no gate yet: the phase that moves it to a computer
  "api/projects.ts": "OPEN P3a: Caption Studio ingest and proxy",
  "api/captions-job.ts": "OPEN P3a",
  "api/exports.ts": "OPEN P3b",
  "api/export.ts": "OPEN P3b",
  "api/alpha-video.ts": "OPEN P3b",
  "api/caption-frames.ts": "OPEN P3b: headless browser",
  "api/review.ts": "serving (decision 5): the Review upload transcode",
  "api/work/tasks/review.ts": "computer task (work/tasks.ts mayRunHere)",
  "api/clips.ts": "OPEN P3d",
  "api/enhance.ts": "OPEN P3d",
  "api/transcribe.ts": "OPEN P3f",
  "api/lib/device-transcribe.ts": "OPEN P3f: the server speech model",
  "api/lib/device-embed.ts": "OPEN P3f",
  "api/lib/device-picture.ts": "OPEN P3f: picturesHere",
  "api/work/library.ts": "a computer's own work (the work package)",
  "api/work/look.ts": "a computer's own work (the work package)",
  "api/work/computer.ts": "a computer's own runner (CT_WORKER)",
  "api/work/tasks/design-pages.ts": "computer task (work/tasks.ts mayRunHere)",
  "api/work/tasks/frames.ts": "computer task (work/tasks.ts mayRunHere)",
  "api/work/tasks/social-prints.ts": "computer task (work/tasks.ts mayRunHere)",
  // not video work: AI programs, tools, the app itself
  "api/ffmpeg-runtime.ts": "finds the ffmpeg build",
  "api/lib/helper-check.ts": "the helper's own check",
  "api/lib/local-ai.ts": "AI programs on the person's own computer",
  "api/lib/local-claude.ts": "AI programs on the person's own computer",
  "api/lib/antigravity.ts": "an AI program on the person's own computer",
  "api/lib/folder-plugins.ts": "builds a plug-in folder on This Mac",
  "api/connect/connector.ts": "the tunnel (cloudflared), not media work",
  "api/assistant.ts": "the assistant's prompt names the tools; unverified",
  "api/boot.ts": "names the runtime; unverified",
};
/** The count at the start (local-first plan P0): it may only go down. */
const DECODERS_AT_START = 68;
const DECODE = /spawn\(|spawnSync|spawnKillable|execFile\(|execFileSync|execSync|ffmpeg|ffprobe|chromium|playwright|onnx/;

/** T8: every remaining deletion by age under api/, with why it stays. Library and export files have none (decision 8). */
const AGE_DELETES: Record<string, string> = {
  "api/editor/worker.ts": "AI Editor edits in the trash (LIBRARY_TRASH_DAYS); not library files",
  "api/enhance.ts": "ENHANCE_KEEP_DAYS, off unless set",
  "api/instagram.ts": "INSTAGRAM_KEEP_DAYS, off unless set",
  "api/projects.ts": "Caption Studio trash and ORIGINALS_KEEP_DAYS (off unless set)",
  "api/review.ts": "Review's own trash (its videos mirror into the library: owner item)",
  "api/retention.ts": "CONTENT_EXPIRES=1 only, never library or export files",
  "api/admin.ts": "shows retention's days",
  "api/kept.ts": "shows the trash days of Caption Studio and Review",
  "api/library/trash.ts": "Finals pieces' trash (rows and a cover; the versions stay)",
  "api/mcp-tools/finals.ts": "says the Finals pieces' trash days",
  "api/lib/mac-claude.ts": "in-memory blobs of a running request, not files",
};
const AGE = /[A-Z]+_(KEEP|TRASH)_(DAYS|HOURS|MS)|KEEP_(DAYS|HOURS)|TRASH_DAYS|trashDays\(|keepDaysFor\(|sweepExports|purgeTrash\b/;

const app = (re: RegExp) => filesMatching("apps/captions/api", re, /\.ts$/).map((f) => f.replace(/^apps\/captions\//, ""));

describe("local-first ratchets", () => {
  it("T1: every file that starts a decoder, encoder, browser or model is listed with its gate", () => {
    expect(app(DECODE)).toEqual(Object.keys(DECODERS).sort());
    expect(Object.keys(DECODERS).length).toBeLessThanOrEqual(DECODERS_AT_START);
  });

  it("T1: a computer task's work is started only through work/tasks.ts, which asks mayRunHere", () => {
    // a module in api/work/tasks/ registers its kind; a tool that imported one could run its work with no gate
    const importers = app(/^import (?!type )(?:[^;]*from )?"[^"]*\/tasks\/[\w-]+";/m).filter((f) => !f.endsWith(".test.ts"));
    expect(importers).toEqual(["api/work/task-kinds.ts"].filter((f) => importers.includes(f)));
  });

  it("T8: no deletion by age reaches library or export files", () => {
    expect(app(AGE)).toEqual(Object.keys(AGE_DELETES).sort());
    // the paths decision 8 closed: nothing in them goes for its age
    for (const f of ["api/exports.ts", "api/export.ts"]) expect(AGE_DELETES[f], f).toBeUndefined();
    expect(readFileSync(path.join(repo, "apps/captions/api/library/trash.ts"), "utf8")).not.toMatch(/FROM assets[^`]*trashed_at </);
  });

  it("T7: setup never opens by itself: openSetupAt is called only from a press", () => {
    const callers = filesMatching("apps/captions/src", /openSetupAt\(/, /\.tsx?$/);
    for (const f of callers) {
      const text = readFileSync(path.join(repo, f), "utf8");
      // a press: onClick / onSelect, or a handler named for one; never in an effect
      for (const effect of text.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)) expect(effect[1], f).not.toContain("openSetupAt(");
    }
    expect(callers).toEqual(["apps/captions/src/components/assistant/AssistantDock.tsx", "apps/captions/src/components/setup/FirstOpen.tsx", "apps/captions/src/components/setup/HelperStep.tsx", "apps/captions/src/lib/setup.ts", "apps/captions/src/pages/ToolsetHome.tsx"]);
  });
});
