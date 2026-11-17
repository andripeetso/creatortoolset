import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Moves } from "@contracts/transition";
import {
  badge,
  CLIP_UPLOAD_MOVES,
  getProjectPersistenceStatus,
  LOCAL_SAVE_MOVES,
  SERVER_SAVE_MOVES,
  type ClipUploadState,
} from "./persistence-status";

const clip = (
  uploadState: ClipUploadState,
  uploadPct = 0,
) => ({ uploadState, uploadPct });

describe("getProjectPersistenceStatus", () => {
  it("marks a fresh idle project without a server id as not saved", () => {
    const status = getProjectPersistenceStatus({
      projectId: null,
      saveState: "idle",
      clips: [clip("local")],
    });

    expect(status.fullySaved).toBe(false);
    expect(status.badge).toContain("Not saved");
  });

  it("reports first-project upload progress as not saved", () => {
    const status = getProjectPersistenceStatus({
      projectId: null,
      saveState: "idle",
      clips: [clip("uploading", 63)],
    });

    expect(status.badge).toBe("Not saved · uploading 63%");
  });

  it("does not mistake a client-generated id for a confirmed cloud project", () => {
    const status = getProjectPersistenceStatus({
      projectId: "client-project-id",
      serverProjectReady: false,
      saveState: "idle",
      localSaveState: "saved",
      clips: [clip("local")],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      badge: "Saved locally · waiting to upload",
    });
  });

  it("shows danger when neither the client-id project nor local backup is durable", () => {
    const status = getProjectPersistenceStatus({
      projectId: "client-project-id",
      serverProjectReady: false,
      saveState: "idle",
      localSaveState: "error",
      clips: [clip("local")],
    });

    expect(status).toMatchObject({
      workSafe: false,
      tone: "danger",
      badge: "Not saved · local copy failed",
    });
  });

  it("does not call a project saved while another clip is pending", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saved",
      clips: [clip("done"), clip("processing")],
    });

    expect(status.fullySaved).toBe(false);
    expect(status.badge).toContain("Partly saved");
  });

  it("only reports saved when the project and all clips are persisted", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "idle",
      clips: [clip("done")],
    });

    expect(status).toMatchObject({ fullySaved: true, badge: "Saved" });
  });

  it("says edits are recoverable while a source upload is still running", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saving",
      localSaveState: "saved",
      clips: [clip("uploading", 35)],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      tone: "warning",
      badge: "Edits saved locally · source video uploading 35%",
    });
    expect(status.message).toContain("in the local copy");
  });

  it("keeps an upload failure separate from saved transcript edits", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saved",
      localSaveState: "saved",
      clips: [clip("error", 35)],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      badge: "Saved · source video upload failed",
    });
    expect(status.message).toContain("transcript and edits are saved");
  });

  it("uses a red not-saved state when browser recovery storage fails", () => {
    const status = getProjectPersistenceStatus({
      projectId: null,
      saveState: "error",
      localSaveState: "error",
      clips: [clip("local")],
    });

    expect(status).toMatchObject({
      workSafe: false,
      fullySaved: false,
      tone: "danger",
      badge: "Not saved · local copy failed",
    });
  });

  it("keeps cloud-saved edits safe when only the local backup fails", () => {
    const status = getProjectPersistenceStatus({
      projectId: "project-1",
      saveState: "saved",
      localSaveState: "error",
      clips: [clip("error", 35)],
    });

    expect(status).toMatchObject({
      workSafe: true,
      fullySaved: false,
      tone: "warning",
      badge: "Saved · source video upload failed",
    });
  });
});

/*
 * Which function makes which move, by the `site` it gives to `badge`. `from: "start"` is not a move (the store's
 * first state, a project opened, restored, imported or closed, a new clip). A `from` in a comment's "late" list is
 * reached only when the answer lands after something else changed the state.
 */
type Site = { from: "start" | readonly string[]; to: readonly string[] };
const SITES: Record<"SERVER_SAVE_MOVES" | "LOCAL_SAVE_MOVES" | "CLIP_UPLOAD_MOVES", Record<string, Site>> = {
  // saveState
  SERVER_SAVE_MOVES: {
    "first state": { from: "start", to: ["idle"] }, // store.ts
    importFiles: { from: "start", to: ["idle"] }, // store.ts: a new project
    reset: { from: "start", to: ["idle"] }, // store.ts: no project
    applyServerProject: { from: "start", to: ["saved"] }, // persist.ts: the server's copy becomes the open project
    restoreRecoveryProject: { from: "start", to: ["error", "saving", "saved", "idle"] }, // local-recovery.ts: as it was stored
    // persist.ts. A project not on the server yet is made there: first try, or again after a failed one
    ensureServerProject: { from: ["idle", "error"], to: ["saving"] },
    // late (idle, saved): the answer is not matched to its project, so it lands on one opened meanwhile
    "ensureServerProject: failed": { from: ["saving", "idle", "saved"], to: ["error"] },
    // an edit: from saved, or again after a save that failed
    scheduleSave: { from: ["saved", "error"], to: ["saving"] },
    // a save goes out (the edit's own, a background clip's transcript, a new clip order)
    putData: { from: ["saved", "error"], to: ["saving"] },
    // the server took it: saved, or saving when another edit waits. From error when the save before it in the line failed
    "syncData: saved": { from: ["saving", "error"], to: ["saved", "saving"] },
    // the server refused it. From saved when the save before it in the line was taken
    "syncData: server copy deleted": { from: ["saving", "saved"], to: ["error"] },
    "syncData: newer server version": { from: ["saving", "saved"], to: ["error"] },
    "syncData: gave up": { from: ["saving", "saved"], to: ["error"] },
    // a clip's upload finds the project gone, whatever the save was doing
    "ensureRemoteClip: server copy deleted": { from: ["saving", "saved"], to: ["error"] },
  },
  // localSaveState: all in local-recovery.ts but the starts. Every state is left for every other, because a write's
  // answer is not matched to the save that asked.
  LOCAL_SAVE_MOVES: {
    "first state": { from: "start", to: ["idle"] }, // store.ts
    importFiles: { from: "start", to: ["saving"] }, // store.ts
    reset: { from: "start", to: ["idle"] }, // store.ts
    restoreRecoveryProject: { from: "start", to: ["saved"] },
    scheduleRecoverySave: { from: ["idle", "saved", "error"], to: ["saving"] }, // any change to the project
    // 200 ms later there is nothing to keep (no project). Late (saved, error): an older write answered in those 200 ms
    "saveRecoveryNow: nothing to keep": { from: ["saving", "saved", "error"], to: ["idle"] },
    // the write's answer. Late: idle (nothing to keep since), error and saved (another write answered first)
    "saveRecoveryNow: written": { from: ["saving", "idle", "error"], to: ["saved"] },
    "saveRecoveryNow: write failed": { from: ["saving", "idle", "saved"], to: ["error"] },
    // the copy could not be built: after the 200 ms (saving), or straight after a restore (saved)
    "saveRecoveryNow: failed": { from: ["saving", "saved"], to: ["error"] },
  },
  // ClipInfo.uploadState
  CLIP_UPLOAD_MOVES: {
    importFiles: { from: "start", to: ["local"] }, // store.ts: a new clip
    addClips: { from: "start", to: ["local"] }, // store.ts: a new clip
    applyServerProject: { from: "start", to: ["done"] }, // persist.ts: the server's clips
    restoreRecoveryProject: { from: "start", to: ["local", "uploading", "processing", "done", "error"] }, // local-recovery.ts: as stored
    // store.ts: a file is given to a clip again (Export's attach), whatever its upload was doing
    retainClipSourceFile: { from: ["done", "error", "uploading", "processing"], to: ["local"] },
    // local-recovery.ts: a restored clip gets its kept file back, so its upload starts over
    attachRecoveredSourceFiles: { from: ["uploading", "processing", "error", "done"], to: ["local"] },
    // persist.ts. An upload starts only from these two (its own check)
    uploadClip: { from: ["local", "error"], to: ["uploading"] },
    // late (local, error, done): a file was attached again, or a second upload of the clip answered, while it ran
    "uploadClip: stored": { from: ["uploading", "local", "error"], to: ["done"] },
    "uploadClip: failed": { from: ["uploading", "local", "done"], to: ["error"] },
    retryClipUpload: { from: ["error"], to: ["local"] }, // the error badge's Retry, Export's retry
    // the editing copy is ready, minutes after the upload: done already, or late as above
    switchToProxy: { from: ["local", "uploading", "error"], to: ["done"] },
  },
};
const TABLES = { SERVER_SAVE_MOVES, LOCAL_SAVE_MOVES, CLIP_UPLOAD_MOVES } as Record<keyof typeof SITES, Moves<string>>;
const FIELD = { saveState: "SERVER_SAVE_MOVES", localSaveState: "LOCAL_SAVE_MOVES", uploadState: "CLIP_UPLOAD_MOVES" } as const;

const lib = import.meta.dirname;
const source = (file: string) => readFileSync(path.join(lib, file), "utf-8");

describe("Caption Studio's badge states", () => {
  afterEach(() => void vi.unstubAllEnvs());

  it("each table holds exactly the moves its sites make: none missing, none nobody makes", () => {
    for (const [name, sites] of Object.entries(SITES)) {
      const made: Record<string, string[]> = Object.fromEntries(Object.keys(TABLES[name as keyof typeof SITES]).map((k) => [k, []]));
      for (const site of Object.values(sites)) {
        if (site.from === "start") continue;
        for (const from of site.from) for (const to of site.to) if (from !== to && !made[from]!.includes(to)) made[from]!.push(to);
      }
      const sorted = (t: Record<string, readonly string[]>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v].sort()]));
      expect(sorted(made), name).toEqual(sorted(TABLES[name as keyof typeof SITES]));
    }
  });

  it("the sites above are the ones in the code: every badge() call is listed with the states it writes", () => {
    const code = ["store.ts", "persist.ts", "local-recovery.ts"].map(source).join("\n");
    const calls = [...code.matchAll(/badge\(\s*(\w+),\s*([^,]+?),\s*([\s\S]+?),\s*"([^"]+)",?\s*\)/g)];
    const seen = new Set<string>();
    for (const [, table, from, to, site] of calls) {
      const listed = SITES[table as keyof typeof SITES]?.[site!];
      expect(listed, `${table} ${site}`).toBeDefined();
      expect(from === "null", `${table} ${site}: a start`).toBe(listed!.from === "start");
      // the states the call spells out are among the ones listed (a restore also writes what the stored copy held)
      for (const [, state] of to!.matchAll(/"(\w+)"/g)) expect(listed!.to, `${table} ${site}`).toContain(state);
      seen.add(`${table} ${site}`);
    }
    expect([...seen].sort()).toEqual(Object.entries(SITES).flatMap(([table, sites]) => Object.keys(sites).map((site) => `${table} ${site}`)).sort());
  });

  it("nothing in src writes a badge state but badge(), with that state's own table", () => {
    const files = (readdirSync(path.join(lib, ".."), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    const stray: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(lib, "..", f), "utf-8");
      for (const m of text.matchAll(/\b(saveState|localSaveState|uploadState)\s*:\s*(?:badge\(\s*(\w+)|(\S[^\n]*))/g)) {
        const [, field, table, other] = m;
        // not a write: the field's type, and the status helper's input read from the store
        if (other !== undefined && /^(?:ProjectSaveState|ClipUploadState);$|^state\.\w+,$/.test(other)) continue;
        if (table !== FIELD[field as keyof typeof FIELD]) stray.push(`${f}: ${m[0]}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("a move the table lists, staying put and a start pass through", () => {
    expect(badge(SERVER_SAVE_MOVES, "saving", "saved", "test")).toBe("saved");
    expect(badge(SERVER_SAVE_MOVES, "saved", "saved", "test")).toBe("saved");
    expect(badge(SERVER_SAVE_MOVES, null, "idle", "test")).toBe("idle");
  });

  it("a move the table does not list fails under vitest, and in the running app is made and reported", () => {
    expect(() => badge(SERVER_SAVE_MOVES, "saved", "idle", "test")).toThrow('"saved" → "idle"');
    vi.stubEnv("MODE", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(badge(CLIP_UPLOAD_MOVES, "done", "uploading", "test")).toBe("uploading");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(test): "done" → "uploading"'));
    warn.mockRestore();
  });
});
