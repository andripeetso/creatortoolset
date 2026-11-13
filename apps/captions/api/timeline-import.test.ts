import { describe, expect, it } from "vitest";
import { filePath, importTimeline, rational, tcFrames, TimelineError, timelineSources } from "../contracts/timeline-import";

// One small cut, 25 fps, starting at 01:00:00:00, written the way Resolve 21.1
// exports it in each format (checked against its real exports of a 90 s reel):
//   V1 talent  A 0+50, B 50+40      V2 B-roll  roll 20+15
//   A1 VO      vo 0+90              A2 SFX     pop 10+5
const want = [
  ["V2", [[20, 15, "roll.mp4"]]],
  ["V1", [[0, 50, "A.MP4"], [50, 40, "B.MP4"]]],
  ["A1", [[0, 90, "vo.wav"]]],
  ["A2", [[10, 5, "pop.wav"]]],
];
const shape = (v: ReturnType<typeof importTimeline>) =>
  v.tracks.map((t) => [t.id, t.items.map((i) => [i.rec, i.len, i.label])]);

const rt = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: 25, value });
const range = (start: number, duration: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start), duration: rt(duration) });
const clip = (name: string, start: number, len: number) => ({
  OTIO_SCHEMA: "Clip.2", name, source_range: range(start, len), enabled: true,
  media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: `/Volumes/x/${name}` } },
  active_media_reference_key: "DEFAULT_MEDIA",
});
const gap = (len: number) => ({ OTIO_SCHEMA: "Gap.1", source_range: range(0, len) });
const track = (kind: string, name: string, children: unknown[]) => ({ OTIO_SCHEMA: "Track.1", kind, name, children });
const OTIO = JSON.stringify({
  OTIO_SCHEMA: "Timeline.1", name: "Cut", global_start_time: rt(90000),
  tracks: {
    OTIO_SCHEMA: "Stack.1",
    markers: [{ OTIO_SCHEMA: "Marker.2", name: "HOOK", color: "RED", marked_range: range(50, 1) }],
    children: [
      track("Video", "TALENT", [clip("A.MP4", 821472, 50), { OTIO_SCHEMA: "Transition.1", in_offset: rt(5), out_offset: rt(5) }, clip("B.MP4", 821600, 40)]),
      track("Video", "B-ROLL", [gap(20), clip("roll.mp4", 100, 15)]),
      track("Video", "CAPTIONS", []),
      track("Audio", "VO", [clip("vo.wav", 0, 90)]),
      track("Audio", "SFX", [gap(10), clip("pop.wav", 0, 5)]),
    ],
  },
});

const item = (name: string, start: number, end: number, inn: number, extra = "") => `
        <clipitem id="${name} 0"><name>${name}</name><duration>9000</duration>
          <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
          <start>${start}</start><end>${end}</end><enabled>TRUE</enabled><in>${inn}</in><out>${inn + end - (start < 0 ? end - 40 : start)}</out>
          <file id="${name} 1"><name>${name}</name><pathurl>file:///Volumes/x/${name}</pathurl>
            <timecode><string>09:07:38:22</string><rate><timebase>25</timebase></rate></timecode></file>${extra}
        </clipitem>`;
const FCP7 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence>
    <name>Cut (Resolve)</name><duration>90</duration>
    <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
    <in>-1</in><out>-1</out>
    <timecode><string>01:00:00:00</string><frame>90000</frame></timecode>
    <media>
      <video>
        <format><samplecharacteristics><width>1080</width><height>1920</height></samplecharacteristics></format>
        <track>${item("A.MP4", 0, 50, 128)}
          <transitionitem><start>45</start><end>55</end></transitionitem>${item("B.MP4", -1, 90, 256)}
        </track>
        <track>${item("roll.mp4", 20, 35, 100)}</track>
      </video>
      <audio>
        <track>${item("vo.wav", 0, 90, 0)}</track>
        <track>${item("pop.wav", 10, 15, 0)}</track>
      </audio>
    </media>
  </sequence>
</xmeml>`;

const FCPXML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format width="1080" height="1920" frameDuration="1/25s" name="FFVideoFormatRateUndefined" id="r0"/>
    <asset id="r1" name="A.MP4" start="821472/25s" duration="39228/25s" hasVideo="1" hasAudio="1" format="r0"/>
    <asset id="r2" name="roll.mp4" start="0/1s" duration="300/25s" hasVideo="1" format="r0"/>
    <asset id="r3" name="pop.wav" start="0/1s" duration="5/25s" hasAudio="1"/>
    <media id="r9" name="Compound"><sequence format="r0"><spine><gap offset="0s" duration="1s"/></spine></sequence></media>
  </resources>
  <library>
    <event name="Cut (Resolve)">
      <project name="Cut (Resolve)">
        <sequence duration="90/25s" tcStart="3600/1s" format="r0" tcFormat="NDF">
          <spine>
            <clip name="A.MP4" offset="3600/1s" start="821472/25s" duration="2/1s" format="r0">
              <video ref="r1" offset="821472/25s" start="821472/25s" duration="39228/25s"/>
              <asset-clip name="roll.mp4" ref="r2" lane="1" offset="821492/25s" start="4/1s" duration="15/25s"/>
              <clip name="vo.wav" lane="4" offset="821472/25s" start="0/1s" duration="90/25s">
                <audio ref="r3" offset="0/1s" start="0/1s" duration="90/25s"/>
              </clip>
              <asset-clip name="pop.wav" ref="r3" lane="5" offset="821482/25s" start="0/1s" duration="5/25s"/>
              <marker start="821522/25s" duration="1/25s" value="HOOK"/>
            </clip>
            <asset-clip name="B.MP4" ref="r1" offset="90050/25s" start="821600/25s" duration="40/25s" format="r0"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;

const EDL = `TITLE: Cut
FCM: NON-DROP FRAME

001  AX       V     C        09:07:38:22 09:07:40:22 01:00:00:00 01:00:02:00
* FROM CLIP NAME: A.MP4

002  AX       V     C        09:07:43:24 09:07:45:14 01:00:02:00 01:00:03:15
* FROM CLIP NAME: B.MP4
`;

describe("timeline import", () => {
  it("OTIO, FCP 7 XML and FCPXML of one cut put every clip on the same frames", () => {
    for (const [name, text] of [["Cut.otio", OTIO], ["Cut.xml", FCP7], ["Info.fcpxml", FCPXML]]) {
      const v = importTimeline(name, text);
      expect(shape(v), name).toEqual(want);
      expect(v.fps).toBe(25);
      expect(v.duration).toBe(90);
    }
  });

  it("a clip or track switched off in the editing app comes through as off (it never shows or sounds)", () => {
    const off = JSON.parse(OTIO);
    off.tracks.children[0].children[0].enabled = false; // talent A
    off.tracks.children[1].enabled = false; // the whole B-roll track
    const v = importTimeline("Cut.otio", JSON.stringify(off));
    const item = (track: string, rec: number) => v.tracks.find((t) => t.id === track)!.items.find((i) => i.rec === rec)!;
    expect(item("V1", 0).off).toBe(true);
    expect(item("V1", 50).off).toBeUndefined();
    expect(item("V2", 20).off).toBe(true);
    expect(importTimeline("Cut.otio", OTIO).tracks.flatMap((t) => t.items).some((i) => i.off)).toBe(false);
  });

  it("a video lane switched off whole under the talent (the takes under their retouched copies) is V0, so the talent is V1", () => {
    const off = JSON.parse(OTIO);
    const raw = track("Video", "TALENT (original)", [clip("A_raw.MP4", 821472, 50), clip("B_raw.MP4", 821600, 40)]);
    raw.children.forEach((c) => ((c as { enabled: boolean }).enabled = false));
    off.tracks.children.unshift(raw, { ...raw, name: "older takes" });
    const v = importTimeline("Cut.otio", JSON.stringify(off));
    expect(v.tracks.map((t) => t.id)).toEqual(["V2", "V1", "V0", "A1", "A2"]);
    expect(v.tracks.find((t) => t.id === "V0")!.items.every((i) => i.off)).toBe(true);
    expect(v.tracks.find((t) => t.id === "V1")!.items.map((i) => i.label)).toEqual(["A.MP4", "B.MP4"]);
    // a lane switched off above the talent keeps its place
    const above = JSON.parse(OTIO);
    above.tracks.children[1].enabled = false;
    expect(importTimeline("Cut.otio", JSON.stringify(above)).tracks.map((t) => t.id)).toEqual(["V2", "V1", "A1", "A2"]);
  });

  it("an EDL (video track only) lines up with them, at the video's frame rate or its own guess", () => {
    expect(shape(importTimeline("Cut.edl", EDL, 25))).toEqual([want[1]]);
    expect(importTimeline("Cut.edl", EDL).fps).toBe(25); // frame numbers up to 24 → 25 fps
    expect(importTimeline("Cut.edl", EDL, 25).tracks[0].items[0].detail).toBe("source 09:07:38:22");
  });

  it("keeps markers and names but never a path", () => {
    const o = importTimeline("Cut.otio", OTIO);
    expect(o.markers).toEqual([{ frame: 50, name: "HOOK", color: "Red" }]);
    expect(importTimeline("Info.fcpxml", FCPXML).markers).toEqual([{ frame: 50, name: "HOOK" }]);
    expect(o.tracks.find((t) => t.id === "V1")!.name).toBe("TALENT");
    for (const text of [OTIO, FCP7, FCPXML]) expect(JSON.stringify(importTimeline("x", text))).not.toContain("/Volumes");
  });

  it("FCPXML: a secondary storyline, a title on a gap and Final Cut's audio below the storyline", () => {
    const v = importTimeline("x.fcpxml", `<fcpxml version="1.11"><resources>
      <format id="f" frameDuration="1001/30000s" width="1920" height="1080"/>
      <asset id="a" name="cam.mov" hasVideo="1" hasAudio="1"/><asset id="m" name="song.m4a" hasAudio="1" hasVideo="0"/>
    </resources><library><event><project name="Edit &amp; Co"><sequence format="f" tcStart="0s"><spine>
      <asset-clip ref="a" offset="0s" start="0s" duration="3003/1000s">
        <spine lane="1" offset="1001/1000s">
          <asset-clip ref="a" name="s1" offset="0s" start="10s" duration="1001/1000s"/>
          <asset-clip ref="a" name="s2" offset="1001/1000s" start="20s" duration="1001/1000s"/>
        </spine>
        <asset-clip ref="m" name="song" lane="-1" offset="0s" start="0s" duration="3003/1000s"/>
      </asset-clip>
      <gap offset="3003/1000s" start="3600s" duration="2002/1000s">
        <title name="Lower third" lane="1" offset="3600s" start="0s" duration="1001/1000s"/>
      </gap>
    </spine></sequence></project></event></library></fcpxml>`);
    expect(v.name).toBe("Edit & Co");
    expect(v.fps).toBe(29.97);
    expect(shape(v)).toEqual([
      ["V2", [[30, 30, "s1"], [60, 30, "s2"], [90, 30, "Lower third"]]],
      ["V1", [[0, 90, "cam.mov"]]],
      ["A1", [[0, 90, "song"]]],
    ]);
  });

  it("FCP 7 XML: a sequence In/Out (Premiere renders that range) and NTSC", () => {
    const v = importTimeline("x.xml", `<xmeml version="4"><sequence><name>S</name>
      <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate><in>30</in><out>90</out>
      <media><video><track>
        <clipitem><name>a</name><start>0</start><end>60</end><in>0</in><out>60</out></clipitem>
        <clipitem><name>b</name><start>60</start><end>120</end><in>0</in><out>60</out></clipitem>
        <clipitem><name>c</name><start>100</start><end>130</end><in>0</in><out>30</out></clipitem>
      </track></video></media></sequence></xmeml>`);
    expect(v.fps).toBe(29.97);
    expect(shape(v)).toEqual([["V1", [[0, 30, "a"], [30, 30, "b"]]]]);
  });

  it("EDL: drop-frame timecode and events before the hour", () => {
    expect(tcFrames("00:10:00;00", 29.97)).toBe(17982);
    expect(tcFrames("01:00:00:00", 25)).toBe(90000);
    const v = importTimeline("x.edl", `001  R1  V  C  00:00:00:00 00:00:01:00 00:00:05:00 00:00:06:00
002  R2  AA  C  00:00:00:00 00:00:02:00 00:00:05:00 00:00:07:00`, 30);
    expect(shape(v)).toEqual([["V1", [[150, 30, "R1"]]], ["A1", [[150, 60, "R2"]]]]);
  });

  it("reads rational times and refuses what isn't a timeline", () => {
    expect(rational("1001/30000s")).toBeCloseTo(1 / 29.97, 6);
    expect(rational("3600s")).toBe(3600);
    expect(() => importTimeline("notes.xml", "<html><body>hi</body></html>")).toThrow(TimelineError);
    expect(() => importTimeline("x.otio", "{ nope")).toThrow(/valid JSON/);
    expect(() => importTimeline("x.xml", "<xmeml><sequence><rate><timebase>25</timebase></rate></sequence></xmeml>")).toThrow(/no clips/);
  });
});

// One take on V1 with its sound on A1 (in at 10 of 250 frames, 25 fps) and a B-roll file, its folder named with spaces
// and Estonian letters, the way each format writes the files: what Review plays from the person's own computer.
describe("timeline import: source files", () => {
  const TAKE = "/Volumes/Tiny Drive/Süvi lõik/Tiny take.MP4";
  const ROLL = "/Volumes/Tiny Drive/b roll.mov";
  const url = (p: string) => `file://${encodeURI(p)}`;
  const take = { src: "s1", ins: 0.4, before: 10, after: 190 };
  const items = (v: ReturnType<typeof importTimeline>) =>
    Object.fromEntries(v.tracks.map((t) => [t.id, t.items.map(({ src, ins, before, after }) => ({ src, ins, before, after }))]));
  const strip = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o));

  const ext = (target_url: string, available_range?: unknown) => ({ OTIO_SCHEMA: "ExternalReference.1", target_url, available_range });
  const at = (ref: unknown, start: number, len: number) => ({ OTIO_SCHEMA: "Clip.2", name: "c", source_range: range(start, len), media_reference: ref });
  const otioFile = JSON.stringify({
    OTIO_SCHEMA: "Timeline.1", name: "T",
    tracks: { OTIO_SCHEMA: "Stack.1", children: [
      track("Video", "V", [at(ext(url(TAKE), range(0, 250)), 10, 50)]),
      track("Video", "B", [at(ext(ROLL), 25, 25)]),
      track("Audio", "A", [at(ext(url(TAKE), range(0, 250)), 10, 50)]),
    ] },
  });
  const fcp7File = `<xmeml version="5"><sequence><name>T</name><rate><timebase>25</timebase></rate><media>
    <video>
      <track><clipitem id="c1"><name>Tiny take</name><start>0</start><end>50</end><in>10</in><out>60</out>
        <file id="f1"><name>Tiny take.MP4</name><pathurl>file://localhost${encodeURI(TAKE)}</pathurl><duration>250</duration></file>
      </clipitem></track>
      <track><clipitem id="c2"><name>b roll</name><start>0</start><end>25</end><in>25</in><out>50</out>
        <file id="f2"><name>b roll.mov</name><pathurl>${url(ROLL)}</pathurl></file>
      </clipitem></track>
    </video>
    <audio><track><clipitem id="c3"><name>Tiny take</name><start>0</start><end>50</end><in>10</in><out>60</out><file id="f1"/></clipitem></track></audio>
  </media></sequence></xmeml>`;
  const fcpxmlFile = `<fcpxml version="1.10"><resources>
    <format id="r0" frameDuration="1/25s" width="1080" height="1920"/>
    <asset id="r1" name="Tiny take.MP4" start="3600s" duration="10s" hasVideo="1" hasAudio="1" format="r0">
      <media-rep kind="original-media" src="${url(TAKE)}"/>
    </asset>
    <asset id="r2" name="b roll.mov" src="${url(ROLL)}" start="0s" hasVideo="1" format="r0"/>
  </resources><library><event><project name="T"><sequence format="r0" tcStart="0s"><spine>
    <asset-clip ref="r1" offset="0s" start="90010/25s" duration="2s">
      <asset-clip ref="r2" lane="1" offset="90010/25s" start="1s" duration="1s"/>
      <audio ref="r1" lane="-1" offset="90010/25s" start="90010/25s" duration="2s"/>
    </asset-clip>
  </spine></sequence></project></event></library></fcpxml>`;
  const edlFile = `TITLE: T
001  TAKE     V     C        00:00:00:10 00:00:02:10 01:00:00:00 01:00:02:00
* FROM CLIP NAME: Tiny take.MP4
* SOURCE FILE: ${TAKE}
002  TAKE     A     C        00:00:00:10 00:00:02:10 01:00:00:00 01:00:02:00
* FROM CLIP NAME: Tiny take.MP4
003  ROLL     V     C        00:00:01:00 00:00:02:00 01:00:02:00 01:00:03:00
* FROM CLIP NAME: b roll.mov
`;

  it("each format gives every clip its file's key, where it starts in it and the media past its ends", () => {
    const roll = { src: "s2", ins: 1 };
    expect(strip(items(importTimeline("T.otio", otioFile)))).toEqual({ V2: [roll], V1: [take], A1: [take] });
    expect(strip(items(importTimeline("T.xml", fcp7File)))).toEqual({ V2: [{ ...roll, before: 25 }], V1: [take], A1: [take] });
    expect(strip(items(importTimeline("T.fcpxml", fcpxmlFile)))).toEqual({ V2: [{ ...roll, before: 25 }], V1: [take], A1: [take] });
    // an EDL says no length (and no file for the B-roll, which has no file comment)
    expect(strip(items(importTimeline("T.edl", edlFile, 25)))).toEqual({ V1: [{ src: "s1", ins: 0.4 }, {}], A1: [{ src: "s1", ins: 0.4 }] });
  });

  it("no media room past an end the file says is shorter; an EDL lends a file by clip name, never by reel", () => {
    const still = JSON.stringify({ OTIO_SCHEMA: "Timeline.1", name: "T", tracks: { OTIO_SCHEMA: "Stack.1", children: [
      track("Video", "V", [at(ext(url(TAKE), range(0, 1)), 0, 50)]),
    ] } });
    expect(strip(items(importTimeline("T.otio", still)))).toEqual({ V1: [{ src: "s1", ins: 0, before: 0 }] });
    const reels = `TITLE: T
001  AX  V  C  00:00:00:00 00:00:01:00 01:00:00:00 01:00:01:00
* SOURCE FILE: ${TAKE}
002  AX  V  C  00:00:00:00 00:00:01:00 01:00:01:00 01:00:02:00
`;
    expect(strip(items(importTimeline("T.edl", reels, 25)))).toEqual({ V1: [{ src: "s1", ins: 0 }, {}] });
  });

  it("the paths come only from timelineSources, decoded; the view stays path-free", () => {
    for (const [name, file] of [["T.otio", otioFile], ["T.xml", fcp7File], ["T.fcpxml", fcpxmlFile]]) {
      expect(timelineSources(name, file), name).toEqual({ s1: TAKE, s2: ROLL });
      expect(JSON.stringify(importTimeline(name, file)), name).not.toMatch(/Volumes|Tiny Drive/);
    }
    expect(timelineSources("T.edl", edlFile, 25)).toEqual({ s1: TAKE });
    expect(JSON.stringify(importTimeline("T.edl", edlFile, 25))).not.toContain("Volumes");
  });

  it("a file's path: URLs decoded, Windows paths, nothing for a relative or broken one", () => {
    expect(filePath("file://localhost/Volumes/A%20B/%C3%A4.mov")).toBe("/Volumes/A B/ä.mov");
    expect(filePath("/Volumes/x/g_%05d.png")).toBe("/Volumes/x/g_%05d.png");
    expect(filePath("file:///Volumes/x/g_%2505d.png")).toBe("/Volumes/x/g_%05d.png");
    expect(filePath("file:///C:/Users/tiny/a.mov")).toBe("C:/Users/tiny/a.mov");
    expect(filePath("D:\\footage\\a.mov")).toBe("D:/footage/a.mov");
    expect(filePath("media/talk.mp4")).toBeUndefined();
    expect(filePath("file:///bad%E0.mov")).toBeUndefined();
    expect(filePath("https://example.com/a.mov")).toBeUndefined();
  });
});
