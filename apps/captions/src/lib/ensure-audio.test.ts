import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./audio", () => ({ extractAudio: vi.fn() }));

import { extractAudio } from "./audio";
import { useStudio } from "./store";

const read = vi.mocked(extractAudio);
const sound = { pcm: new Float32Array(16000), peaks: new Float32Array([0.2, 0.9]), duration: 1 };

/** A clip on the timeline whose video is at `url`, with no sound picture yet. */
function open(url: string, id = "a"): void {
  useStudio.setState({ activeClipId: id, videoUrl: url, fileName: "clip.mp4", pcm: null, peaks: null, duration: 1 });
}

function server(answer: () => Response = () => new Response("video")) {
  const fetched = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("stopped", "AbortError");
    return answer();
  });
  vi.stubGlobal("fetch", fetched);
  return fetched;
}

afterEach(async () => {
  // a read left running would keep the next test's from starting
  useStudio.setState({ activeClipId: "done", videoUrl: null, pcm: null, peaks: null });
  await new Promise((r) => setTimeout(r));
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the timeline's sound picture, read from the clip's video", () => {
  it("is read for a clip that has none", async () => {
    server();
    read.mockResolvedValue(sound);
    open("/api/projects/p/clips/a/video");
    await useStudio.getState().ensureAudio();
    expect([...useStudio.getState().peaks!]).toEqual([...sound.peaks]);
  });

  it("is downloaded once when it is asked for again while the read runs", async () => {
    const fetched = server();
    let done!: (v: typeof sound) => void;
    read.mockReturnValue(new Promise((r) => (done = r)));
    open("/api/projects/p/clips/a/video");
    const first = useStudio.getState().ensureAudio();
    await useStudio.getState().ensureAudio();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    done(sound);
    await first;
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(useStudio.getState().peaks?.length).toBe(2);
  });

  it("stays with the clip when its address changes under the read", async () => {
    server();
    let done!: (v: typeof sound) => void;
    read.mockReturnValue(new Promise((r) => (done = r)));
    open("/api/projects/p/clips/a/video");
    const reading = useStudio.getState().ensureAudio();
    useStudio.setState({ videoUrl: "/api/projects/p/clips/a/video?ready=1" });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    done(sound);
    await reading;
    expect(useStudio.getState().peaks?.length).toBe(2);
  });

  it("a video with no sound to decode leaves an empty picture: no lane", async () => {
    server();
    read.mockRejectedValue(new Error("This file has no audio track"));
    open("/api/projects/p/clips/a/video");
    await useStudio.getState().ensureAudio();
    expect(useStudio.getState().peaks?.length).toBe(0);
  });

  it("a video the server does not have yet says nothing, and its new address is read", async () => {
    server(() => new Response("no", { status: 404 }));
    open("/api/projects/p/clips/a/video");
    await useStudio.getState().ensureAudio();
    expect(read).not.toHaveBeenCalled();
    expect(useStudio.getState().peaks).toBeNull();
    server();
    read.mockResolvedValue(sound);
    useStudio.setState({ videoUrl: "/api/projects/p/clips/a/video?ready=1" });
    await useStudio.getState().ensureAudio();
    expect(useStudio.getState().peaks?.length).toBe(2);
  });

  it("a download that fails says nothing either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    open("/api/projects/p/clips/a/video");
    await useStudio.getState().ensureAudio();
    expect(useStudio.getState().peaks).toBeNull();
  });

  it("a read stopped by another clip says nothing about either", async () => {
    server();
    read.mockImplementation((_file, _progress, signal) => new Promise((_, no) => signal!.addEventListener("abort", () => no(new DOMException("stopped", "AbortError")))));
    open("/api/projects/p/clips/a/video");
    const first = useStudio.getState().ensureAudio();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    open("/api/projects/p/clips/b/video", "b");
    void useStudio.getState().ensureAudio();
    await first;
    expect(useStudio.getState().peaks).toBeNull();
  });

  it("a video still only on this computer is left alone", async () => {
    const fetched = server();
    open("blob:local");
    await useStudio.getState().ensureAudio();
    expect(fetched).not.toHaveBeenCalled();
    expect(useStudio.getState().peaks).toBeNull();
  });
});
