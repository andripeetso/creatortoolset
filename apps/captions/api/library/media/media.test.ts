import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { makeThumb } from "./thumb";
import { browserPlayable, countryAt, looksLikeSong, probe, parseProbe } from "./probe";
import { ffmpeg, ffmpegSlot } from "./run";
import { makeProxy, needsProxy } from "./proxy";
import { makeWave } from "./wave";
import { makeSprite } from "./sprite";
import { SPRITE_FRAMES, SPRITE_SIDE } from "../../../contracts/library";

// Fixtures are generated at run time, one second each, in scratch. Nothing large is committed.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-media-"));
const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const encoders = (() => {
  try {
    return execFileSync(ffmpegCommand(), ["-hide_banner", "-encoders"], { encoding: "utf8" });
  } catch {
    return "";
  }
})();
const hevcOk = /libx265|hevc_videotoolbox/.test(encoders);

const h264 = path.join(dir, "h264.mp4");
const hevc = path.join(dir, "hevc.mp4");
const sine = path.join(dir, "sine.m4a");
const tallinn = path.join(dir, "tallinn.mp4");

beforeAll(() => {
  // GPS-style and creation-time tags, as a phone writes them
  ff(["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    "-metadata", "creation_time=2024-01-02T03:04:05Z", "-metadata", "location=+12.3456+056.7890/", h264]);
  if (hevcOk) {
    ff(["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", hevc]);
  }
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", sine]);
  ff(["-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-metadata", "location=+59.4370+024.7536/", tallinn]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("probe", () => {
  it("gives duration, size and codecs of the fixture", async () => {
    const p = await probe(h264);
    expect(p.duration).toBeGreaterThan(0.9);
    expect(p.duration).toBeLessThan(1.2);
    expect(p).toMatchObject({ width: 320, height: 240, vcodec: "h264", acodec: "aac", pixFmt: "yuv420p" });
    expect(browserPlayable(p)).toBe(true);
  });

  it("stores no GPS and no tags, and reads the capture time from creation_time", async () => {
    const raw = execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", h264], { encoding: "utf8" });
    expect(raw).toMatch(/12\.3456/); // the fixture really carries a location
    const stored = JSON.stringify(await probe(h264));
    expect(stored).not.toMatch(/location|12\.3456|056\.7890/);
    expect((await probe(h264)).capturedAt).toBe(Date.parse("2024-01-02T03:04:05Z"));
  });

  it("keeps the country a clip was filmed in, never its coordinates", async () => {
    const stored = JSON.stringify(await probe(tallinn));
    expect(JSON.parse(stored).country).toBe("EE");
    expect(stored).not.toMatch(/59\.43|24\.75|location/);
    expect((await probe(h264)).country).toBe(""); // the other fixture is out at sea
    expect((await probe(sine)).country).toBe("");
  });

  it("finds the country offline: inland, on a beach, in an enclave, either side of 180°, and none at sea", async () => {
    const at = (lat: number, lon: number) => countryAt(lat, lon);
    expect(await at(59.437, 24.7536)).toBe("EE"); // Tallinn
    expect(await at(-29.31, 27.48)).toBe("LS"); // Maseru, inside South Africa's hole
    expect(await at(-26.2, 28.04)).toBe("ZA");
    expect(await at(-22.9711, -43.1822)).toBe("BR"); // a beach
    expect(await at(34.0083, -118.4987)).toBe("US"); // a pier
    expect(await at(43.695, 7.265)).toBe("FR");
    expect(await at(43.9356, 12.4473)).toBe("SM"); // San Marino, inside Italy
    expect(await at(-18.14, 178.44)).toBe("FJ");
    expect(await at(66.16, -169.8)).toBe("RU"); // Russia west of 180°
    expect(await at(30, -40)).toBe(""); // the Atlantic
  });

  it("reads the rotation as clockwise degrees: display matrix -90 is 90, the old rotate tag is taken as is", () => {
    const video = (extra: object) => ({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "video", ...extra }] });
    expect(parseProbe(video({ side_data_list: [{ rotation: -90 }] })).rotation).toBe(90);
    expect(parseProbe(video({ side_data_list: [{ rotation: 90 }] })).rotation).toBe(270);
    expect(parseProbe(video({ tags: { rotate: "270" } })).rotation).toBe(270);
    expect(parseProbe(video({})).rotation).toBe(0);
  });

  it("an iPhone HEIC's size is its tile grid's, not one 512 px tile's", () => {
    const tile = { codec_type: "video", codec_name: "hevc", width: 512, height: 512 };
    const grid = (w: number, h: number, main: number) => ({ type: "Tile Grid", disposition: { default: main }, components: [{ width: w, height: h }] });
    const photo = parseProbe({ format: { format_name: "mov,mp4" }, streams: [tile, tile], stream_groups: [grid(2016, 1512, 0), grid(4032, 3024, 1)] });
    expect(photo).toMatchObject({ width: 4032, height: 3024 });
  });

  it("a song's album art is a cover, not video; a real picture stream wins over a cover", () => {
    const art = { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } };
    const song = parseProbe({ format: { format_name: "mp3" }, streams: [{ codec_type: "audio", codec_name: "mp3" }, art] });
    expect(song).toMatchObject({ vcodec: "mjpeg", cover: true, acodec: "mp3" });
    const film = parseProbe({ format: { format_name: "mov,mp4" }, streams: [art, { codec_type: "video", codec_name: "h264", disposition: { attached_pic: 0 } }] });
    expect(film.vcodec).toBe("h264");
    expect(film.cover).toBeUndefined();
  });
});

describe("start timecode", () => {
  it("keeps a timecode-shaped tag from the video stream or a timecode track, and nothing else", () => {
    const tc = (streams: object[], format: object = {}) => parseProbe({ format: { format_name: "mov", ...format }, streams: streams as never[] }).timecode;
    expect(tc([{ codec_type: "video", tags: { timecode: "01:00:00:00" } }])).toBe("01:00:00:00");
    expect(tc([{ codec_type: "video" }, { codec_type: "data", tags: { timecode: "10:20:30;15" } }])).toBe("10:20:30;15");
    expect(tc([{ codec_type: "video", tags: { timecode: "soon" } }], { tags: { timecode: "1:2" } })).toBeUndefined();
  });

  it("reads the timecode ffmpeg wrote", async () => {
    const out = path.join(dir, "tc.mov");
    ff(["-f", "lavfi", "-i", "testsrc=duration=0.2:size=64x64:rate=25", "-timecode", "01:02:03:04", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    expect((await probe(out)).timecode).toBe("01:02:03:04");
  });
});

describe("ffmpeg", () => {
  it("runs one at a time: two calls together take as long as both in a row", async () => {
    const half = ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.5", "-af", "arealtime", "-f", "null", "-"]; // arealtime: 0.5 s of wall time
    delete process.env.FFMPEG_CONCURRENCY; // the default, 1
    const t = Date.now();
    await Promise.all([ffmpeg(half), ffmpeg(half)]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });
});

describe("ffmpeg", () => {
  it("a picture never waits for a long run that already started", async () => {
    delete process.env.FFMPEG_CONCURRENCY;
    let free!: () => void;
    const long = ffmpegSlot(() => new Promise<void>((r) => (free = r))); // a 46-minute transcript holds the one slot
    const picture = ffmpegSlot(async () => "drawn", true);
    expect(await Promise.race([picture, new Promise((r) => setTimeout(() => r("waiting"), 300))])).toBe("drawn");
    free();
    await long;
  });
});

describe("songs", () => {
  const sound = (tags: Record<string, string>, streams: object[] = [{ codec_type: "audio", codec_name: "mp3" }]) => parseProbe({ format: { duration: "200", tags }, streams });
  it("are known by an artist or album on a sound, or by a song's name", () => {
    expect(looksLikeSong("track 1", sound({ ARTIST: "Northlight" }))).toBe(true);
    expect(looksLikeSong("Somewhere I Belong (Official Music Video) [4K UPGRADE]", sound({}))).toBe(true);
    expect(looksLikeSong("Song name (Lyrics)", sound({}))).toBe(true);
    expect(looksLikeSong("voice memo", sound({ title: "New Recording" }))).toBe(false);
    // a filmed video with an artist tag is not a song
    expect(looksLikeSong("gameplay-1", sound({ artist: "me" }, [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac" }]))).toBe(false);
  });
});

describe("thumb", () => {
  it("writes a 480 px wide JPEG", async () => {
    const out = path.join(dir, "thumb.jpg");
    await makeThumb(h264, out, 1);
    expect(existsSync(out)).toBe(true);
    expect((await probe(out)).width).toBe(480);
    expect(existsSync(`${out}.part.jpg`)).toBe(false);
  });

  it("reads a photo (one frame: any -ss writes nothing)", async () => {
    const photo = path.join(dir, "photo.jpg");
    const out = path.join(dir, "photo-thumb.jpg");
    ff(["-f", "lavfi", "-i", "testsrc=size=1600x1200", "-frames:v", "1", photo]);
    await makeThumb(photo, out, (await probe(photo)).duration);
    expect((await probe(out)).width).toBe(480);
  });
});

describe("proxy", () => {
  it("is not needed for a browser-playable source", async () => {
    expect(needsProxy(await probe(h264))).toBe(false);
  });

  it("a sound file plays as it is when its sound does, else gets an AAC copy of its sound only", async () => {
    const wav = path.join(dir, "song.wav");
    const mp3 = path.join(dir, "song.mp3");
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", mp3]);
    expect(needsProxy(await probe(mp3))).toBe(false);
    expect(needsProxy(await probe(wav))).toBe(true);
    const out = path.join(dir, "song-proxy.mp4");
    await makeProxy(wav, out, true);
    expect(await probe(out)).toMatchObject({ acodec: "aac", vcodec: "" });
  });

  it("keeps every sound track, so the transcript hears the same one from the proxy, at the same times", async () => {
    // track 1 a silent mono guide, track 2 the voice in stereo and marked the default: ffmpeg's own pick (the
    // transcript's, the sound levels': the default track, then the most channels) is track 2
    const two = path.join(dir, "two-tracks.mov");
    ff(["-f", "lavfi", "-i", "testsrc=duration=2:size=1280x720:rate=30", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      "-filter_complex", "[2:a]aformat=channel_layouts=stereo[v]", "-map", "0:v", "-map", "1:a", "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-disposition:a:0", "0", "-disposition:a:1", "default", "-t", "2", two]);
    const out = path.join(dir, "two-proxy.mp4");
    await makeProxy(two, out);
    const channels = (f: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=channels", "-of", "csv=p=0", f], { encoding: "utf8" }).trim().split("\n");
    expect(channels(out)).toEqual(channels(two));
    // the transcript's own cut of the sound (library/transcribe.ts, DEVICE_AUDIO)
    const heard = (f: string) => {
      const pcm = execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-i", f, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 24 });
      const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
      return { n: x.length, rms: Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) };
    };
    const [a, b] = [heard(two), heard(out)];
    expect(a.rms).toBeGreaterThan(0.05); // the voice, not the silent guide
    expect(b.rms).toBeGreaterThan(0.05);
    // the same length to a few ms (AAC's own frame), so a cut measured on the proxy lands on the original's times
    expect(Math.abs(a.n - b.n) / 16000).toBeLessThan(0.03);
    const [pa, pb] = [await probe(two), await probe(out)];
    expect(Math.abs(pa.duration - pb.duration)).toBeLessThan(0.05);
    expect(pb).toMatchObject({ height: 720, width: 1280 });
  });

  it.skipIf(!hevcOk)("is needed for HEVC and makes H.264 without upscaling", async () => {
    const src = await probe(hevc);
    expect(needsProxy(src)).toBe(true);
    const out = path.join(dir, "proxy.mp4");
    // the 320x240 fixture's H.264 copy is no smaller than its HEVC source, so no proxy is kept (UNIFIED-PRD §4.1 rule 3)
    expect(await makeProxy(hevc, out)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});

describe("wave", () => {
  it("gives ten peaks a second for the sine fixture", async () => {
    const out = path.join(dir, "wave.json");
    await makeWave(sine, out, true);
    const w = JSON.parse(readFileSync(out, "utf8")) as { perSecond: number; peaks: number[] };
    expect(w.perSecond).toBe(10);
    expect(w.peaks.length).toBeGreaterThanOrEqual(9);
    expect(w.peaks.length).toBeLessThanOrEqual(11);
    expect(Math.min(...w.peaks.slice(0, 8))).toBeGreaterThan(0.05);
  });

  it("writes an empty list for a file with no audio", async () => {
    const out = path.join(dir, "wave-none.json");
    await makeWave(h264, out, false);
    expect(JSON.parse(readFileSync(out, "utf8")).peaks).toEqual([]);
  });
});

describe("sprite", () => {
  // the mean grey of frame `i` of a strip, 0 to 255
  // a 16:9 clip's frames are SPRITE_SIDE × 144
  const [W, H] = [SPRITE_SIDE, 144];
  const grey = (file: string, i: number) => {
    const raw = execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `crop=${W}:${H}:${i * W}:0,scale=1:1:flags=area,format=gray`, "-f", "rawvideo", "-"]);
    return raw[0]!;
  };

  it("lays the frames across the clip side by side, in time order, and leaves no parts behind", async () => {
    // dark for the first second, light for the second: the strip's first half is dark, its second half light
    const clip = path.join(dir, "dark-light.mp4");
    ff(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=2,geq=lum='if(lt(T,1),20,230)':cb=128:cr=128", "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", clip]);
    const out = path.join(dir, "sprite.jpg");
    await makeSprite(clip, out, 2);
    expect(await probe(out)).toMatchObject({ width: W * SPRITE_FRAMES, height: H });
    expect(grey(out, 0)).toBeLessThan(60);
    expect(grey(out, SPRITE_FRAMES / 2 - 1)).toBeLessThan(60);
    expect(grey(out, SPRITE_FRAMES / 2)).toBeGreaterThan(180);
    expect(grey(out, SPRITE_FRAMES - 1)).toBeGreaterThan(180);
    expect(readFileSync(out).length).toBeLessThan(150_000);
    expect(readdirSync(dir).filter((f) => /^sprite\.jpg\.|\.part\./.test(f))).toEqual([]);
  });

  it("keeps an upright 10-bit clip's frames upright", async () => {
    const clip = path.join(dir, "upright10.mp4");
    ff(["-f", "lavfi", "-i", "testsrc=duration=2:size=360x640:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p10le", clip]);
    const out = path.join(dir, "upright-sprite.jpg");
    await makeSprite(clip, out, 2);
    expect(await probe(out)).toMatchObject({ width: 144 * SPRITE_FRAMES, height: SPRITE_SIDE });
  });

  it("a clip of a second, and one whose picture ends before its sound, still get every frame", async () => {
    const clip = path.join(dir, "short-picture.mp4");
    ff(["-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30", "-f", "lavfi", "-i", "sine=duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
    for (const [src, length] of [[h264, (await probe(h264)).duration], [clip, (await probe(clip)).duration]] as const) {
      const out = path.join(dir, `short-${path.basename(src)}.jpg`);
      await makeSprite(src, out, length);
      const { width, height } = await probe(out);
      expect([width / SPRITE_FRAMES, height]).toContain(SPRITE_SIDE);
      expect(Number.isInteger(width / SPRITE_FRAMES)).toBe(true);
    }
  });

  it("refuses a clip with no length", async () => {
    await expect(makeSprite(h264, path.join(dir, "none.jpg"), 0)).rejects.toThrow(/length/);
  });
});
