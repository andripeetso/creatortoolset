import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClipSnapshot, useStudio } from "./store";
import { initPersistence, loadSession, takeServerCopy, takesServerCopy, untouched, type OpenProject } from "./persist";
import { openedInSync } from "./local-recovery";
import { DEFAULT_STYLE, type Cue, type Word } from "./types";

/**
 * A video sent to Caption Studio from the assistant's chat gets its captions from the server (api/captions-job.ts),
 * often after the person has opened the project. The rule these tests hold: what the person did on the page is theirs
 * and is never replaced; a project they have not touched takes what the server made for it.
 */

const open = (over: Partial<OpenProject> = {}): OpenProject => ({
  serverProjectReady: true,
  serverConflict: false,
  setupPending: false,
  serverRevision: 0,
  saveState: "saved",
  refining: false,
  applyingMaster: false,
  status: { phase: "idle" },
  words: [],
  cues: [],
  clips: [{ transcribed: false, status: { phase: "idle" }, uploadState: "done" }],
  ...over,
});
const word: Word = { id: 1, text: "Tiny", start: 0.1, end: 0.4 };

describe("whether an open project takes the server's copy", () => {
  it("takes a newer copy when the person has not touched the project, whether that copy has captions or says no words were heard", () => {
    expect(takesServerCopy(open(), 1)).toBe(true);
    expect(takesServerCopy(open({ serverRevision: 3 }), 7)).toBe(true);
    // a project opened here before, never saved from here
    expect(takesServerCopy(open({ saveState: "idle" }), 1)).toBe(true);
  });

  it("leaves the project alone when the server's copy is the one it has, or an older one", () => {
    expect(takesServerCopy(open(), 0)).toBe(false);
    expect(takesServerCopy(open({ serverRevision: 2 }), 2)).toBe(false);
    expect(takesServerCopy(open({ serverRevision: 2 }), 1)).toBe(false);
  });

  it("never replaces a transcript or captions the person has on the page, on any clip", () => {
    expect(takesServerCopy(open({ words: [word] }), 1)).toBe(false);
    expect(takesServerCopy(open({ cues: [{ id: 1, start: 0, end: 1, words: [word] }] }), 1)).toBe(false);
    const other = { transcribed: true, status: { phase: "done" as const }, uploadState: "done" as const };
    expect(takesServerCopy(open({ clips: [...open().clips, other] }), 1)).toBe(false);
  });

  it("never replaces a project with something running: a transcription, a cadence pass, an apply, a clip still uploading", () => {
    expect(takesServerCopy(open({ status: { phase: "transcribing", progress: 0 } }), 1)).toBe(false);
    expect(takesServerCopy(open({ status: { phase: "matching" } }), 1)).toBe(false);
    expect(takesServerCopy(open({ refining: true }), 1)).toBe(false);
    expect(takesServerCopy(open({ applyingMaster: true }), 1)).toBe(false);
    const clip = open().clips[0]!;
    expect(takesServerCopy(open({ clips: [{ ...clip, status: { phase: "extracting" } }] }), 1)).toBe(false);
    expect(takesServerCopy(open({ clips: [{ ...clip, uploadState: "uploading" }] }), 1)).toBe(false);
    // a transcription that failed here is not running: the server's captions are welcome
    expect(takesServerCopy(open({ status: { phase: "error", message: "no sound" } }), 1)).toBe(true);
  });

  it("never replaces a change the server has not taken: one waiting to be saved, one it refused", () => {
    expect(takesServerCopy(open({ saveState: "saving" }), 1)).toBe(false);
    expect(takesServerCopy(open({ saveState: "error" }), 1)).toBe(false);
    expect(takesServerCopy(open({ serverConflict: true }), 1)).toBe(false);
  });

  it("leaves a project that is not on the server yet, or still asks its first questions", () => {
    expect(untouched(open({ serverProjectReady: false }))).toBe(false);
    expect(untouched(open({ setupPending: true }))).toBe(false);
    expect(untouched(open())).toBe(true);
  });
});

// ---- the page's own code against a server that answers as api/projects.ts does (GET /:id, PUT /:id/sync)
const ID = "11111111-1111-4111-8111-111111111111";
const said: Word[] = ["Tiny", "Acrobatics", "starts", "with", "a", "roll."].map((text, i) => ({ id: i + 1, text, start: i * 0.3, end: i * 0.3 + 0.25 }));
const lines: Cue[] = [
  { id: 1, start: 0, end: 0.55, words: said.slice(0, 2) },
  { id: 2, start: 0.6, end: 1.75, words: said.slice(2) },
];
type Put = { baseRevision: number; snapshot: { clip: Record<string, unknown> } };
const server = {
  revision: 0,
  clip: {} as Record<string, unknown>,
  reads: 0,
  puts: [] as Put[],
  /** Runs while a read is under way (the person does something meanwhile). */
  duringRead: null as null | (() => void),
};
/** The server's own save for the project, on top of what it holds: the captions job (captions-job.ts), or "no words were heard". */
const serverMakesCaptions = (words = said, cues = lines) => {
  server.revision++;
  Object.assign(server.clip, {
    style: { ...DEFAULT_STYLE, ...((server.clip.style as object) ?? {}), fitBox: true, lowercase: false },
    words,
    originalWords: words,
    cues,
    peaks: [0.1, 0.4, 0.2],
    cadenceApplied: false,
    cadenceFit: null,
    cadenceDirty: false,
  });
};
const debounce = () => vi.advanceTimersByTimeAsync(5000);

beforeEach(async () => {
  vi.useFakeTimers();
  Object.assign(server, { revision: 0, clip: {}, reads: 0, puts: [], duringRead: null });
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === `/api/projects/${ID}/sync`) {
      const put = JSON.parse(String(init!.body)) as Put;
      server.puts.push(put);
      if (put.baseRevision !== server.revision) return Response.json({ error: "Project changed on another tab or device", code: "REVISION_CONFLICT", revision: server.revision }, { status: 409 });
      const { id: _id, name: _name, ...clip } = put.snapshot.clip;
      server.clip = clip; // the clip's record is replaced whole (applyProjectUpdate)
      return Response.json({ ok: true, revision: ++server.revision });
    }
    if (u === `/api/projects/${ID}`) {
      server.reads++;
      const answer = { id: ID, name: "Tiny tumbles", revision: server.revision, fps: null, model: null, autoCadence: null, script: "", clips: [{ id: "c1", name: "tumbles.mp4", duration: 2.4, srcWidth: 360, srcHeight: 640, srcFps: 30, hasOriginal: true, ...structuredClone(server.clip) }] };
      server.duringRead?.();
      return Response.json(answer);
    }
    throw new Error(`No such route in this test: ${u}`);
  });
  useStudio.getState().reset();
  // opened before the captions exist: nothing stored in this browser, so it comes from the server
  expect(await loadSession(ID)).toBe(true);
  server.reads = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
initPersistence();

describe("an open project and the captions the server makes for it", () => {
  it("an untouched project shows them, sends nothing back, and the person's next change is saved on top of them", async () => {
    expect(useStudio.getState()).toMatchObject({ projectId: ID, serverRevision: 0, saveState: "saved", cues: [] });
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(true);
    const s = useStudio.getState();
    expect(s.cues.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["Tiny Acrobatics", "starts with a roll."]);
    expect(s).toMatchObject({ serverRevision: 1, saveState: "saved", serverConflict: false, status: { phase: "done" } });
    expect(s.clips[0]).toMatchObject({ transcribed: true, status: { phase: "done" } });
    expect(Array.from(s.peaks!)).toHaveLength(3);
    // taking it is not an edit: nothing goes back to the server
    await debounce();
    expect(server.puts).toEqual([]);
    // the next change is saved at the server's revision, with the first transcript the server kept (it is not sent as "none")
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    await debounce();
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toMatchObject({ baseRevision: 1, snapshot: { clip: { originalWords: said, cues: lines, style: { fontFamily: "Poppins" } } } });
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, saveState: "saved", serverConflict: false });
  });

  it("keeps the person's place: the playhead, the project list if that is on screen", async () => {
    useStudio.setState({ currentTime: 1.2, projectLibraryOpen: true });
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(true);
    expect(useStudio.getState()).toMatchObject({ currentTime: 1.2, projectLibraryOpen: true, videoUrl: `/api/projects/${ID}/clips/c1/video` });
    expect(useStudio.getState().cues).toHaveLength(2);
  });

  it("no words were heard: the project takes that copy too, so its next save is accepted", async () => {
    serverMakesCaptions([], []);
    expect(await takeServerCopy(ID)).toBe(true);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 1, cues: [], words: [] });
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    await debounce();
    expect(server.puts.map((p) => p.baseRevision)).toEqual([1]);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, saveState: "saved" });
  });

  it("captions the person made on the page stay exactly as they are, and their next save is accepted", async () => {
    const mine: Word = { id: 0, text: "Mine.", start: 0, end: 1 };
    const s0 = useStudio.getState();
    useStudio.setState({ words: [mine], cues: [{ id: 7, start: 0, end: 1, words: [mine] }], status: { phase: "done" }, clips: s0.clips.map((c) => ({ ...c, transcribed: true, status: { phase: "done" as const } })) });
    await debounce(); // the page saves them: the server's job then finds captions and saves nothing (captions-job.ts)
    expect(server.revision).toBe(1);
    expect(await takeServerCopy(ID)).toBe(false);
    expect(server.reads).toBe(0);
    expect(useStudio.getState().cues).toEqual([{ id: 7, start: 0, end: 1, words: [mine] }]);
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    await debounce();
    expect(server.puts.map((p) => p.baseRevision)).toEqual([0, 1]);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, saveState: "saved", serverConflict: false });
  });

  it("a look the person chose and the page saved is kept: the server's captions came on top of it, and the project takes both", async () => {
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    await debounce();
    expect(server.revision).toBe(1);
    serverMakesCaptions(); // reads her look, lays the lines out for it, saves revision 2
    expect(await takeServerCopy(ID)).toBe(true);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, style: { fontFamily: "Poppins" } });
    expect(useStudio.getState().cues).toHaveLength(2);
    await debounce();
    expect(server.puts).toHaveLength(1);
  });

  it("something the person starts while the server's copy is being read is not replaced", async () => {
    serverMakesCaptions();
    server.duringRead = () => useStudio.setState({ status: { phase: "transcribing", progress: 0 } });
    expect(await takeServerCopy(ID)).toBe(false);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 0, cues: [], status: { phase: "transcribing" } });
  });

  it("as before: a change not yet saved when the server's captions land is sent first, refused, and stays on the page", async () => {
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(false);
    expect(server.puts.map((p) => p.baseRevision)).toEqual([0]);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 0, serverConflict: true, saveState: "error", cues: [], style: { fontFamily: "Poppins" } });
    // and the server still has its captions
    expect(server.clip.cues).toEqual(lines);
  });

  it("as before: a transcription the person started on the page is theirs; when the server's captions land first, the page's save is refused", async () => {
    useStudio.setState({ status: { phase: "transcribing", progress: 0 } });
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(false);
    expect(server.reads).toBe(0);
    // the page's own transcript lands and is saved at the revision the page opened
    const mine: Word = { id: 0, text: "Mine.", start: 0, end: 1 };
    useStudio.setState({ words: [mine], cues: [{ id: 7, start: 0, end: 1, words: [mine] }], status: { phase: "done" } });
    await debounce();
    expect(server.puts.map((p) => p.baseRevision)).toEqual([0]);
    expect(useStudio.getState()).toMatchObject({ serverConflict: true, saveState: "error", cues: [{ id: 7 }] });
    expect(server.clip.cues).toEqual(lines);
  });

  it("picked in the project list while it is open: shown as it is, with what the server made since, and nothing is sent", async () => {
    useStudio.setState({ projectLibraryOpen: true });
    expect(await loadSession(ID)).toBe(true);
    expect(useStudio.getState()).toMatchObject({ projectLibraryOpen: false, serverRevision: 0 });
    serverMakesCaptions();
    useStudio.setState({ projectLibraryOpen: true });
    expect(await loadSession(ID)).toBe(true);
    expect(useStudio.getState()).toMatchObject({ projectLibraryOpen: false, serverRevision: 1 });
    expect(useStudio.getState().cues).toHaveLength(2);
    await debounce();
    expect(server.puts).toEqual([]);
  });

  it("a project opened from the server is not sent back to it (that save went without the clip's first transcript)", async () => {
    serverMakesCaptions();
    useStudio.getState().reset();
    // as after another project was open in this browser
    useStudio.setState({ localSaveState: "saved" });
    expect(await loadSession(ID)).toBe(true);
    expect(getClipSnapshot("c1")?.originalWords).toEqual(said);
    await debounce();
    expect(server.puts).toEqual([]);
  });
});

describe("this browser's stored copy, opened again", () => {
  // what local-recovery.ts sets when it opens a stored copy: the project, and whether it holds changes the server never took
  const opened = (saveState: "saving" | "saved", more: Partial<ReturnType<typeof useStudio.getState>> = {}) => {
    const s = useStudio.getState();
    useStudio.getState().reset();
    openedInSync.id = saveState === "saved" ? ID : null;
    useStudio.setState({ ...s, localSaveState: "saved", saveState, style: { ...s.style, fontFamily: "Poppins" }, ...more });
  };

  it("with changes the server never took, it is sent; the server refuses it when it has a newer copy, and the stored one stays", async () => {
    serverMakesCaptions();
    opened("saving");
    expect(await takeServerCopy(ID)).toBe(false);
    expect(server.puts.map((p) => p.baseRevision)).toEqual([0]);
    expect(useStudio.getState()).toMatchObject({ serverConflict: true, cues: [], style: { fontFamily: "Poppins" } });
  });

  it("with nothing the server lacks, it is not sent, and the project takes the server's newer copy", async () => {
    serverMakesCaptions();
    opened("saved");
    await debounce();
    expect(server.puts).toEqual([]);
    expect(await takeServerCopy(ID)).toBe(true);
    expect(useStudio.getState().cues).toHaveLength(2);
  });

  it("with nothing the server lacks, it is not sent even when it holds a transcript (that save was sent on every opening)", async () => {
    opened("saved", { words: said, cues: lines, status: { phase: "done" } });
    await debounce();
    expect(server.puts).toEqual([]);
  });
});

describe("a project the autosave sees for the first time", () => {
  it("made while its first transcription was already running: the transcript is saved when it lands", async () => {
    // as importing a video does when the transcription starts with it: the project reaches the server mid-transcription
    const s = useStudio.getState();
    useStudio.getState().reset();
    useStudio.setState({ ...s, localSaveState: "saved", status: { phase: "transcribing", progress: 0 } });
    await debounce();
    expect(server.puts).toEqual([]);
    useStudio.setState({ words: said, cues: lines, status: { phase: "done" } });
    await debounce();
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toMatchObject({ baseRevision: 0 });
  });
});
