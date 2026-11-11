import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClipSnapshot, playerRef, useStudio } from "./store";
import { initPersistence, loadSession, serverCopyChoice, takeServerCopy, untouched, type OpenProject } from "./persist";
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

const newer = { revision: 1, transcript: true };

describe("what an open project does with a newer copy on the server", () => {
  it("takes it when the person has not touched the project and the page has nothing left to send, whether that copy has captions or says no words were heard", () => {
    expect(serverCopyChoice(open(), false, newer)).toBe("take");
    expect(serverCopyChoice(open(), false, { revision: 1, transcript: false })).toBe("take");
    expect(serverCopyChoice(open({ serverRevision: 3 }), false, { revision: 7, transcript: true })).toBe("take");
    // a project opened here before, never saved from here
    expect(serverCopyChoice(open({ saveState: "idle" }), false, newer)).toBe("take");
  });

  it("leaves the project alone when the server's copy is the one it has, or an older one", () => {
    expect(serverCopyChoice(open(), false, { revision: 0, transcript: true })).toBe("keep");
    expect(serverCopyChoice(open({ serverRevision: 2 }), false, { revision: 2, transcript: true })).toBe("keep");
    expect(serverCopyChoice(open({ serverRevision: 2 }), true, { revision: 1, transcript: true })).toBe("keep");
  });

  it("never replaces a transcript or captions the person has on the page, on any clip, sent or not", () => {
    const cue = { id: 1, start: 0, end: 1, words: [word] };
    const other = { transcribed: true, status: { phase: "done" as const }, uploadState: "done" as const };
    for (const unsent of [false, true]) {
      expect(serverCopyChoice(open({ words: [word] }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ cues: [cue] }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ clips: [...open().clips, other] }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ cues: [cue], serverConflict: true, saveState: "error" }), unsent, newer)).toBe("keep");
    }
  });

  it("never replaces a project with something running, or one whose own transcription failed (what the person does after that is not sent)", () => {
    const clip = open().clips[0]!;
    for (const unsent of [false, true]) {
      expect(serverCopyChoice(open({ status: { phase: "transcribing", progress: 0 } }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ status: { phase: "matching" } }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ status: { phase: "error", message: "no sound" } }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ refining: true }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ applyingMaster: true }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ clips: [{ ...clip, status: { phase: "extracting" } }] }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ clips: [{ ...clip, status: { phase: "error", message: "no sound" } }] }), unsent, newer)).toBe("keep");
      expect(serverCopyChoice(open({ clips: [{ ...clip, uploadState: "uploading" }] }), unsent, newer)).toBe("keep");
    }
  });

  it("a change the server has not taken (waiting, or refused) is joined by the captions when they are the one save in between", () => {
    expect(serverCopyChoice(open(), true, newer)).toBe("join");
    expect(serverCopyChoice(open({ saveState: "saving" }), false, newer)).toBe("join");
    expect(serverCopyChoice(open({ saveState: "error", serverConflict: true }), false, newer)).toBe("join");
    expect(serverCopyChoice(open({ serverRevision: 4, saveState: "saving" }), true, { revision: 5, transcript: true })).toBe("join");
  });

  it("and stays a refused save, as it always was, when the server is ahead by anything else: two saves, or one that brought no transcript", () => {
    for (const s of [open(), open({ saveState: "saving" }), open({ saveState: "error", serverConflict: true })]) {
      expect(serverCopyChoice(s, true, { revision: 2, transcript: true })).toBe("keep");
      expect(serverCopyChoice(s, true, { revision: 1, transcript: false })).toBe("keep");
    }
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
  fps: null as number | null,
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
  Object.assign(server, { revision: 0, clip: {}, reads: 0, puts: [], duringRead: null, fps: null });
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
      const answer = { id: ID, name: "Tiny tumbles", revision: server.revision, fps: server.fps, model: null, autoCadence: null, script: "", clips: [{ id: "c1", name: "tumbles.mp4", duration: 2.4, srcWidth: 360, srcHeight: 640, srcFps: 30, hasOriginal: true, ...structuredClone(server.clip) }] };
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

  it("a video the player could not load (asked for before its editing copy existed) is asked for again; one that plays is left alone", async () => {
    const address = `/api/projects/${ID}/clips/c1/video`;
    playerRef.video = { error: null, readyState: 4 } as HTMLVideoElement;
    expect(await takeServerCopy(ID)).toBe(false);
    expect(useStudio.getState()).toMatchObject({ videoUrl: address, clips: [{ videoUrl: address }] });
    playerRef.video = { error: { code: 4 }, readyState: 0 } as HTMLVideoElement;
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(true);
    const s = useStudio.getState();
    expect(s.videoUrl).toMatch(/\/video\?ready=\d+$/);
    expect(s.clips[0]!.videoUrl).toBe(s.videoUrl);
    expect(s.cues).toHaveLength(2);
    playerRef.video = null;
  });

  it("a save waiting for another project is neither counted as this project's nor dropped", async () => {
    // a change in a project, then at once another project opened (the list does not wait for the save)
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    const other = useStudio.getState();
    useStudio.getState().reset();
    openedInSync.id = "22222222-2222-4222-8222-222222222222";
    useStudio.setState({ ...other, projectId: "22222222-2222-4222-8222-222222222222", style: other.style, localSaveState: "saved", saveState: "saved" });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === `/api/projects/${ID}/sync`) {
        server.puts.push(JSON.parse(String(init!.body)) as Put);
        return Response.json({ ok: true, revision: ++server.revision });
      }
      if (u === "/api/projects/22222222-2222-4222-8222-222222222222") return Response.json({ id: "22222222-2222-4222-8222-222222222222", name: "Other", revision: 1, fps: null, model: null, autoCadence: null, script: "", clips: [{ id: "c1", name: "other.mp4", duration: 2.4, words: said, originalWords: said, cues: lines }] });
      throw new Error(`No such route in this test: ${u}`);
    });
    // the other project is clean and one save behind: it takes the server's copy whole
    expect(await takeServerCopy("22222222-2222-4222-8222-222222222222")).toBe(true);
    expect(useStudio.getState()).toMatchObject({ fileName: "Other", serverRevision: 1 });
    // and the first project's change is still sent
    await debounce();
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toMatchObject({ baseRevision: 0, snapshot: { clip: { style: { fontFamily: "Poppins" } } } });
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

  it("a change not yet sent when the server's captions land: the captions join it, and both are saved on top (nothing is refused)", async () => {
    useStudio.getState().setStyle({ fontFamily: "Poppins" });
    useStudio.getState().addTextAt(0.5);
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(true);
    const s = useStudio.getState();
    expect(s).toMatchObject({ serverRevision: 1, serverConflict: false, style: { fontFamily: "Poppins" }, texts: [{ text: "Your text" }] });
    expect(s.cues.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["Tiny Acrobatics", "starts with a roll."]);
    await debounce();
    // one save, on top of the server's: her look, her text, the captions and the first transcript the server kept
    expect(server.puts.map((p) => p.baseRevision)).toEqual([1]);
    expect(server.clip).toMatchObject({ style: { fontFamily: "Poppins" }, texts: [{ text: "Your text" }], cues: lines, originalWords: said });
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, saveState: "saved", serverConflict: false });
    // undo cannot bring back the project without its captions
    useStudio.getState().undoEdit();
    expect(useStudio.getState().cues).toHaveLength(2);
  });

  it("the same when the page's save went out first and was refused: the captions join what was refused and it is sent again", async () => {
    useStudio.getState().addTextAt(0.5);
    serverMakesCaptions();
    await debounce(); // no notice was heard: the page's own save is what finds out
    expect(server.puts.map((p) => p.baseRevision)).toEqual([0, 1]);
    expect(server.clip).toMatchObject({ texts: [{ text: "Your text" }], cues: lines, originalWords: said });
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, saveState: "saved", serverConflict: false, saveError: null, texts: [{ text: "Your text" }] });
    expect(useStudio.getState().cues).toHaveLength(2);
  });

  it("a frame rate the page only assumed gives way to the one the server read from the file; one the person set stays", async () => {
    useStudio.getState().addTextAt(0.5);
    serverMakesCaptions();
    server.fps = 25;
    expect(await takeServerCopy(ID)).toBe(true);
    expect(useStudio.getState()).toMatchObject({ fps: 25, fpsManual: true });
  });

  it("as before, a refused save stays refused when the server is ahead by more than the captions: another save after them", async () => {
    useStudio.getState().addTextAt(0.5);
    serverMakesCaptions();
    server.revision++; // someone saved again, in another tab or on another device
    expect(await takeServerCopy(ID)).toBe(false);
    await debounce();
    expect(server.puts.map((p) => p.baseRevision)).toEqual([0]);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 0, serverConflict: true, saveState: "error", cues: [], texts: [{ text: "Your text" }] });
    expect(server.clip.cues).toEqual(lines);
  });

  it("as before, a refused save stays refused when the one save in between brought no transcript: another tab changed the look", async () => {
    useStudio.getState().addTextAt(0.5);
    server.revision++;
    server.clip.style = { ...DEFAULT_STYLE, fontFamily: "Anton" };
    expect(await takeServerCopy(ID)).toBe(false);
    await debounce();
    expect(useStudio.getState()).toMatchObject({ serverRevision: 0, serverConflict: true, saveState: "error", texts: [{ text: "Your text" }] });
    expect(server.clip.style).toMatchObject({ fontFamily: "Anton" });
  });

  it("no words were heard, and a change of hers was not sent yet: that record joins her change too; a later save by another tab is then a refusal, as before", async () => {
    useStudio.getState().addTextAt(0.5);
    serverMakesCaptions([], []);
    expect(await takeServerCopy(ID)).toBe(true);
    await debounce();
    expect(server.puts.map((p) => p.baseRevision)).toEqual([1]);
    expect(server.clip).toMatchObject({ texts: [{ text: "Your text" }], cues: [], originalWords: [] });
    // the page now holds that record itself: one more save elsewhere brought no transcript
    useStudio.getState().addTextAt(1);
    server.revision++;
    expect(await takeServerCopy(ID)).toBe(false);
    await debounce();
    expect(useStudio.getState()).toMatchObject({ serverConflict: true, saveState: "error" });
    expect(useStudio.getState().texts).toHaveLength(2);
  });

  it("after a transcription of their own that failed, what the person adds is not sent by the page, so it is never replaced", async () => {
    useStudio.setState({ status: { phase: "error", message: "No sound" } });
    useStudio.getState().addTextAt(0.5);
    serverMakesCaptions();
    expect(await takeServerCopy(ID)).toBe(false);
    expect(server.reads).toBe(0);
    expect(useStudio.getState()).toMatchObject({ serverRevision: 0, cues: [], texts: [{ text: "Your text" }] });
  });

  it("as before: a transcription the person started on the page is theirs and stays on the page; when the server's captions land first, the page's save of it is refused", async () => {
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

  it("with changes the server never took, it is sent: on top of the captions when they are the one save the server is ahead by", async () => {
    serverMakesCaptions();
    opened("saving");
    expect(await takeServerCopy(ID)).toBe(true);
    await debounce();
    expect(server.puts.map((p) => p.baseRevision)).toEqual([1]);
    expect(server.clip).toMatchObject({ style: { fontFamily: "Poppins" }, cues: lines });
    expect(useStudio.getState()).toMatchObject({ serverRevision: 2, saveState: "saved", serverConflict: false, style: { fontFamily: "Poppins" } });
  });

  it("with changes the server never took and a server further ahead, it is refused and stays as it is, as before", async () => {
    serverMakesCaptions();
    server.revision++;
    opened("saving");
    expect(await takeServerCopy(ID)).toBe(false);
    await debounce();
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
