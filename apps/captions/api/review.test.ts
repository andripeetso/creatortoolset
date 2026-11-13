import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const h264 = (out: string) =>
  spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", out,
  ]);
const inode = (p: string) => statSync(p).ino;

const { reviewApp, addVersion, browserPlayable, cleanDrawing, paintStrokes, parseProbe, readMeta } = await import("./review");

// the owner is logged in (x-as: someone else, as admin); share links see an
// anonymous reviewer, like boot.ts
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  const as = c.req.header("x-as");
  c.set(
    "user",
    /^\/[sp]\//.test(c.req.path)
      ? { username: "visitor", role: "visitor", cloud: false, off: [] }
      : as
        ? { username: as, role: "admin", cloud: false, off: [] }
        : { username: "owner", role: "user", cloud: false, off: [] },
  );
  await next();
});
app.route("/", reviewApp);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

// not real video: processing fails fast, so nothing stays "processing"
const up = async (name: string, projectId?: string, bytes = Buffer.from(name)) => {
  const init = await read(app.request("/uploads", json({ name, size: bytes.length, projectId })));
  await app.request(`/uploads/${init.id}/parts/1`, {
    method: "POST",
    headers: {
      "upload-length": String(bytes.length),
      "upload-part-size": String(init.partSize),
      "content-length": String(bytes.length),
    },
    body: bytes,
  });
  const asset = await read(app.request(`/uploads/${init.id}/complete`, { method: "POST" }));
  for (let i = 0; i < 100; i++) {
    const { versions } = (await read(app.request(`/assets/${asset.id}`))).asset;
    if (versions[0].status !== "processing") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return asset;
};

const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });

describe("review", () => {
  it("deletes the earlier versions' files, keeping comments and the version a kept one was made from", async () => {
    const asset = await up("Round1.mov");
    const add = async (name: string) => {
      const bytes = Buffer.from(name.repeat(50));
      const init = await read(app.request("/uploads", json({ name, size: bytes.length, assetId: asset.id })));
      await app.request(`/uploads/${init.id}/parts/1`, {
        method: "POST",
        headers: { "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
        body: bytes,
      });
      await app.request(`/uploads/${init.id}/complete`, { method: "POST" });
    };
    await add("Round2.mov");
    await add("Round3-captioned.mov");
    for (let i = 0; i < 100 && (await read(app.request(`/assets/${asset.id}`))).asset.versions.some((v: { status: string }) => v.status === "processing"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await app.request(`/assets/${asset.id}/v/3`, patch({ captioned: true, madeFrom: 1 }));
    await app.request(`/assets/${asset.id}/comments`, json({ version: 2, t: 0, text: "Round 2 note" }));

    const cleared = await read(app.request(`/assets/${asset.id}/v/3/clear-earlier`, { method: "POST" }));
    expect(cleared.asset.versions.map((v: { removed: boolean }) => v.removed)).toEqual([false, true, false]);
    expect(cleared.freed).toBeGreaterThan(0);
    const src = (n: number) => path.join(dataDir, "review", asset.id, `v${n}`, "source");
    expect([existsSync(src(1)), existsSync(src(2)), existsSync(src(3))]).toEqual([true, false, true]);
    expect((await app.request(`/assets/${asset.id}/v/2/download`)).status).toBe(410);
    expect((await app.request(`/assets/${asset.id}/v/2/captions`, { method: "POST" })).status).toBe(410);
    const view = await read(app.request(`/assets/${asset.id}`));
    expect(view.comments.map((c: { text: string }) => c.text)).toContain("Round 2 note");
    // again: nothing left to clear
    expect((await read(app.request(`/assets/${asset.id}/v/3/clear-earlier`, { method: "POST" }))).freed).toBe(0);
  });

  it("names a video after its newest file, unless it was renamed by hand", async () => {
    const place = async () => {};
    const v = (name: string) => ({ owner: "owner", name, mime: "video/mp4", bytes: 1 });
    const first = await addVersion(undefined, v("C9591_V1B_D12_720p.mp4"), place);
    const id = first!.meta.id;
    await addVersion(id, v("C9591_V1B_D14.mp4"), place);
    expect((await readMeta(id))!.name).toBe("C9591_V1B_D14");
    await app.request(`/assets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Golden window B" }) });
    await addVersion(id, v("C9591_V1B_D15.mp4"), place);
    expect((await readMeta(id))!.name).toBe("Golden window B");
  });

  it("tells the owner's open screens about a reviewer's comment on a share link", async () => {
    const { syncApp } = await import("./lib/sync");
    // the review topic's newest change for `user`, from the hello of their change stream
    const newest = async (user: string) => {
      const a = new Hono<{ Variables: AuthVars }>();
      a.use("*", async (c, next) => {
        c.set("user", { username: user, role: "user", cloud: false, off: [] });
        await next();
      });
      a.route("/", syncApp);
      const ac = new AbortController();
      const reader = (await a.request("/events", { signal: ac.signal })).body!.getReader();
      let buf = "";
      while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
      ac.abort();
      return (JSON.parse(/data: (.*)/.exec(buf)![1]).topics.review as number | undefined) ?? 0;
    };
    const asset = await up("Linked.mov");
    const token = (await read(app.request(`/assets/${asset.id}`, patch({ share: { enabled: true } })))).share.token;
    await new Promise((r) => setTimeout(r, 1100)); // the failed processing's last notice has gone out
    const before = await newest("owner");
    const posted = await app.request(`/s/${token}/comments`, json({ version: 1, t: 0, text: "Tiny note", author: "Client" }, { "x-review-key": "k".repeat(24) }));
    expect(posted.status).toBe(200);
    expect(await newest("owner")).toBeGreaterThan(before);
  });

  it("keeps a video marked Finished or In progress by hand", async () => {
    const added = await addVersion(undefined, { owner: "owner", name: "Published.mp4", mime: "video/mp4", bytes: 1 }, async () => {});
    const mark = async (finished: unknown) =>
      read(app.request(`/assets/${added!.meta.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ finished }) }));
    expect((await mark(true)).done).toMatchObject({ finished: true });
    expect((await mark("yes")).done).toMatchObject({ finished: true }); // not a boolean: unchanged
    expect((await mark(false)).done).toMatchObject({ finished: false });
  });

  it("tells Caption Studio which Review version a project came from", async () => {
    const { writeFileSync } = await import("node:fs");
    const added = await addVersion(undefined, { owner: "someone", name: "Sample_V1A_D4.mp4", mime: "video/mp4", bytes: 1 },
      async () => {});
    const meta = await readMeta(added!.meta.id);
    meta!.versions[0].captions = { projectId: "cs-project-1", clipId: "c1" };
    writeFileSync(path.join(dataDir, "review", meta!.id, "meta.json"), JSON.stringify(meta));
    const mine = await read(app.request("/origin/cs-project-1", { headers: { "x-as": "someone" } }));
    expect(mine).toEqual({ review: { asset: meta!.id, n: 1, name: "Sample_V1A_D4" } });
    expect(await read(app.request("/origin/cs-project-1"))).toEqual({});        // not the owner's
    expect(await read(app.request("/origin/nothing-here", { headers: { "x-as": "someone" } }))).toEqual({});
  });

  it("paints a drawing's strokes onto a frame", () => {
    const rgba = Buffer.alloc(100 * 50 * 4);
    paintStrokes(rgba, 100, 50, [{ color: "#ff0000", points: [[0.1, 0.5], [0.9, 0.5]] }]);
    const px = (x: number, y: number) => [...rgba.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
    expect(px(50, 25)).toEqual([255, 0, 0, 255]); // on the line
    expect(px(50, 5)).toEqual([0, 0, 0, 0]); // above it
    expect(px(2, 25)).toEqual([0, 0, 0, 0]); // before it starts
  });

  it.skipIf(!hasFfmpeg)("shows the frame a comment is on, with its drawing", async () => {
    const src = path.join(dataDir, "black.mp4");
    spawnSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=black:size=160x90:rate=25:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", src,
    ]);
    const asset = await up("black.mp4", undefined, readFileSync(src));
    const drawn = await read(app.request(`/assets/${asset.id}/comments`, json({
      version: 1, t: 1, text: "This corner", drawing: [{ color: "#ff0000", points: [[0.1, 0.5], [0.9, 0.5]] }],
    })));
    const res = await app.request(`/assets/${asset.id}/v/1/frame?c=${drawn.id}&w=160`);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const rgb = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
      input: Buffer.from(await res.arrayBuffer()),
    }).stdout;
    const px = (x: number, y: number) => [...rgb.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
    expect(px(80, 45)[0]).toBeGreaterThan(200); // the stroke, red
    expect(px(80, 10)[0]).toBeLessThan(40); // the black frame
    expect((await app.request(`/assets/${asset.id}/v/1/frame`)).status).toBe(400);
    expect((await app.request(`/assets/${asset.id}/v/1/frame?t=0.5`)).status).toBe(200);
  });

  it.skipIf(!hasFfmpeg)("keeps a comment's references, with the JPEG an AI reads, and drops them with it", async () => {
    const asset = await up("Refs.mov");
    const clip = path.join(dataDir, "ref.mp4");
    h264(clip);
    const attach = (body: Buffer | string, type: string) =>
      app.request(`/assets/${asset.id}/v/1/refs?name=style.mp4`, {
        method: "POST",
        headers: { "content-type": type, "content-length": String(body.length) },
        body,
      });
    const ref = await read(attach(readFileSync(clip), "video/mp4"));
    expect(ref).toMatchObject({ name: "style.mp4", kind: "video", mime: "video/mp4" });
    expect((await attach("<svg onload=alert(1)/>", "image/svg+xml")).status).toBe(415);
    expect((await attach("not a picture", "image/png")).status).toBe(400);

    // a comment can be only references
    const cm = await read(app.request(`/assets/${asset.id}/comments`, json({ version: 1, text: "", refs: [ref.id, "nope"] })));
    expect(cm.refs).toEqual([ref]);
    const look = await app.request(`/assets/${asset.id}/v/1/refs/${ref.id}/look`);
    expect(look.headers.get("content-type")).toBe("image/jpeg");
    const size = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "pipe:0"], {
      input: Buffer.from(await look.arrayBuffer()),
    }).stdout.toString().trim();
    expect(size).toBe("480,270"); // 3×3 frames, never enlarged
    expect((await app.request(`/assets/${asset.id}/v/1/refs/${ref.id}/file`)).headers.get("content-type")).toBe("video/mp4");

    await app.request(`/assets/${asset.id}/comments/${cm.id}`, { method: "DELETE" });
    expect(existsSync(path.join(dataDir, "review", asset.id, "v1", "refs", ref.id))).toBe(false);
  });

  it("proxies only what a browser can't play", () => {
    const probe = (format: string, vcodec: string, pixFmt: string, acodec: string) =>
      browserPlayable(parseProbe({
        format: { format_name: format, duration: "1" },
        streams: [
          { codec_type: "video", codec_name: vcodec, pix_fmt: pixFmt },
          { codec_type: "audio", codec_name: acodec },
        ],
      }));
    expect(probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "yuv420p", "aac")).toBe(true);
    expect(probe("matroska,webm", "vp9", "yuv420p", "opus")).toBe(true);
    expect(probe("mov,mp4,m4a,3gp,3g2,mj2", "prores", "yuv422p10le", "pcm_s16le")).toBe(false);
    expect(probe("mov,mp4,m4a,3gp,3g2,mj2", "hevc", "yuv420p", "aac")).toBe(false);
    expect(probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "yuv420p10le", "aac")).toBe(false);
  });

  it("clamps drawings from reviewers", () => {
    expect(cleanDrawing([{ color: "red;x", points: [[2, -1], ["a", 0]] }])).toEqual([
      { color: "#ff3b30", points: [[1, 0]] },
    ]);
    expect(cleanDrawing("nope")).toBeUndefined();
  });

  it.skipIf(!hasFfmpeg)(
    "uploads, transcodes, shares and takes guest comments",
    async () => {
      const src = path.join(dataDir, "in.mov");
      spawnSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=2",
        "-c:v", "mpeg4", src,
      ]);
      const bytes = readFileSync(src);

      const init = await read(app.request("/uploads", json({ name: "Cut.mov", mime: "video/quicktime", size: bytes.length })));
      const part = await app.request(`/uploads/${init.id}/parts/1`, {
        method: "POST",
        headers: {
          "upload-length": String(bytes.length),
          "upload-part-size": String(init.partSize),
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      expect(part.status).toBe(200);
      const asset = await read(app.request(`/uploads/${init.id}/complete`, { method: "POST" }));
      expect(asset.name).toBe("Cut");

      let v = asset.versions[0];
      for (let i = 0; i < 100 && v.status === "processing"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        v = (await read(app.request(`/assets/${asset.id}`))).asset.versions[0];
      }
      expect(v).toMatchObject({ status: "ready", fps: 25, width: 160, height: 90 });
      const play = await app.request(`/assets/${asset.id}/v/1/play`, { headers: { range: "bytes=0-" } });
      expect(play.status).toBe(206);
      expect(play.headers.get("content-type")).toBe("video/mp4"); // the proxy

      const token = (await read(app.request(`/assets/${asset.id}`, { ...json({ share: { enabled: true } }), method: "PATCH" }))).share.token;
      const s = `/s/${token}`;
      expect((await app.request(s)).status).toBe(200);

      const guest = { "x-review-key": "k".repeat(24) };
      const posted = await app.request(`${s}/comments`, json({ version: 1, t: 1.24, tEnd: 99, text: "Cut here", author: "Client" }, guest));
      const cm = await read(posted);
      expect(cm).toMatchObject({ t: 1.24, tEnd: 2, author: "Client", mine: true });
      expect(cm.guestKey).toBeUndefined();

      // another reviewer can't delete it; the owner can see it's new
      const other = { "x-review-key": "z".repeat(24) };
      expect((await app.request(`${s}/comments/${cm.id}`, { method: "DELETE", headers: other })).status).toBe(403);
      expect((await app.request(`${s}/approval`, json({ status: "approved", author: "Client" }, other))).status).toBe(200);
      const [listed] = await read(app.request("/"));
      expect(listed).toMatchObject({ comments: 1, newComments: 1, approval: { status: "approved", by: "Client" } });
      expect(listed.share.enabled).toBe(true);

      // downloads stay off for reviewers until the owner allows them
      expect((await app.request(`${s}/v/1/download`)).status).toBe(403);

      // resetting the link kills the old one
      await app.request(`/assets/${asset.id}`, { ...json({ share: { reset: true } }), method: "PATCH" });
      expect((await app.request(s)).status).toBe(404);
    },
    20_000,
  );

  it("files videos into projects, stacks them and breaks them apart", async () => {
    const project = await read(app.request("/projects", json({ name: "Launch" })));
    const a = await up("a.mp4", project.id);
    const b = await up("b.mp4", project.id);
    expect(a.projectId).toBe(project.id);
    await app.request(`/assets/${b.id}/comments`, json({ version: 1, text: "on b" }));

    // drop b on a: one video named b, b on top as V2 with its comment
    const stacked = await read(app.request(`/assets/${a.id}/stack`, json({ from: b.id })));
    expect(stacked.name).toBe("b");
    expect(stacked.versions.map((v: { n: number; name: string }) => `${v.n}:${v.name}`)).toEqual(["1:a.mp4", "2:b.mp4"]);
    expect((await app.request(`/assets/${b.id}`)).status).toBe(404);
    expect((await read(app.request(`/assets/${a.id}`))).comments).toMatchObject([{ version: 2, text: "on b" }]);
    expect(readFileSync(path.join(dataDir, "review", a.id, "v2", "source"), "utf-8")).toBe("b.mp4");

    // and apart again: a keeps V1, b is its own video in the same project, comment and all
    await app.request(`/assets/${a.id}/unstack`, { method: "POST" });
    const mine = (await read(app.request("/"))).filter((x: { projectId: string }) => x.projectId === project.id);
    const byName = Object.fromEntries(mine.map((x: { name: string }) => [x.name, x]));
    expect(byName.a).toMatchObject({ id: a.id, versions: [{ n: 1, name: "a.mp4" }] });
    expect(byName.b).toMatchObject({ versions: [{ n: 1, name: "b.mp4" }], comments: 1 });
    expect(readFileSync(path.join(dataDir, "review", byName.b.id, "v1", "source"), "utf-8")).toBe("b.mp4");

    // deleting the project takes its videos to the trash
    await app.request(`/projects/${project.id}`, { method: "DELETE" });
    expect((await app.request(`/assets/${byName.b.id}`)).status).toBe(404);
    const trashed = (await read(app.request("/trash"))).map((x: { id: string }) => x.id);
    expect(trashed).toEqual(expect.arrayContaining([a.id, byName.b.id]));
    for (const id of trashed) await app.request(`/trash/${id}`, { method: "DELETE" });
  });

  it("reorders a stack and takes one version out", async () => {
    const [s1, s2, s3] = [await up("s1.mp4"), await up("s2.mp4"), await up("s3.mp4")];
    await app.request(`/assets/${s2.id}/comments`, json({ version: 1, text: "on s2" }));
    await app.request(`/assets/${s1.id}/stack`, json({ from: s2.id }));
    await app.request(`/assets/${s1.id}/stack`, json({ from: s3.id }));
    const names = (x: { versions: { n: number; name: string }[] }) => x.versions.map((v) => `${v.n}:${v.name}`);
    const source = (n: number) => readFileSync(path.join(dataDir, "review", s1.id, `v${n}`, "source"), "utf-8");

    // every version exactly once, or nothing moves
    expect((await app.request(`/assets/${s1.id}/order`, json({ order: [1, 1, 2] }))).status).toBe(400);
    // s2 to the top: it leads and names the video, its file and comment go with it
    const moved = await read(app.request(`/assets/${s1.id}/order`, json({ order: [1, 3, 2] })));
    expect(moved.name).toBe("s2");
    expect(names(moved)).toEqual(["1:s1.mp4", "2:s3.mp4", "3:s2.mp4"]);
    expect([source(2), source(3)]).toEqual(["s3.mp4", "s2.mp4"]);
    expect((await read(app.request(`/assets/${s1.id}`))).comments).toMatchObject([{ version: 3, text: "on s2" }]);

    // s3 out of the middle: its own video; the rest close up, s2 still on top
    const left = await read(app.request(`/assets/${s1.id}/unstack`, json({ n: 2 })));
    expect([left.name, ...names(left)]).toEqual(["s2", "1:s1.mp4", "2:s2.mp4"]);
    expect(source(2)).toBe("s2.mp4");
    const own = (await read(app.request("/"))).find((x: { name: string }) => x.name === "s3");
    expect(names(own)).toEqual(["1:s3.mp4"]);
  });

  it("shares a whole project and tells the owner about comments", async () => {
    await app.request("/notifications/read", json({})); // earlier tests' notes
    const project = await read(app.request("/projects", json({ name: "Client cut" })));
    const inside = await up("inside.mp4", project.id);
    const outside = await up("outside.mp4");
    const { share } = await read(app.request(`/projects/${project.id}`, patch({ share: { enabled: true } })));
    const p = `/p/${share.token}`;

    const listed = await read(app.request(p));
    expect(listed).toMatchObject({ name: "Client cut", assets: [{ id: inside.id, download: false }] });
    expect((await app.request(`${p}/a/${outside.id}`)).status).toBe(404);
    expect((await app.request(`${p}/a/${inside.id}/v/1/download`)).status).toBe(403);

    // a guest comments through the project link; the owner hears about it
    const guest = { "x-review-key": "g".repeat(24) };
    const cm = await read(app.request(`${p}/a/${inside.id}/comments`, json({ version: 1, text: "Love it", author: "Ada" }, guest)));
    await app.request(`${p}/a/${inside.id}/approval`, json({ status: "approved", author: "Ada" }, guest));
    const inbox = await read(app.request("/notifications"));
    expect(inbox.unread).toBe(2);
    expect(inbox.items.slice(0, 2)).toMatchObject([
      { kind: "approved", by: "Ada", name: "inside" },
      { kind: "comment", by: "Ada", text: "Love it", href: `/review/${inside.id}?v=1&c=${cm.id}` },
    ]);

    // an admin's reply reaches the owner; nobody hears about their own comments
    await app.request(`/assets/${inside.id}/comments`, json({ version: 1, text: "Agreed", parentId: cm.id }, { "x-as": "alex" }));
    await app.request(`/assets/${inside.id}/comments`, json({ version: 1, text: "Thanks" }));
    const after = await read(app.request("/notifications"));
    expect(after.items[0]).toMatchObject({ kind: "reply", by: "alex", text: "Agreed" });
    expect(after.unread).toBe(3);
    await app.request("/notifications/read", json({}));
    expect((await read(app.request("/notifications"))).unread).toBe(0);

    // switching the link off closes every video in it
    await app.request(`/projects/${project.id}`, patch({ share: { enabled: false } }));
    expect((await app.request(`${p}/a/${inside.id}`)).status).toBe(404);
  });

  it("marks a version captioned, links its clean version, and keeps the link through a stack", async () => {
    const clean = await up("clean.mp4");
    const burned = await up("burned.mp4");
    await app.request(`/assets/${clean.id}/stack`, json({ from: burned.id })); // burned is V2

    // a version can't be made from itself, or from nothing that exists
    expect((await app.request(`/assets/${clean.id}/v/2`, patch({ captioned: true, madeFrom: 2 }))).status).toBe(400);
    expect((await app.request(`/assets/${clean.id}/v/2`, patch({ captioned: true, madeFrom: 9 }))).status).toBe(400);
    const marked = await read(app.request(`/assets/${clean.id}/v/2`, patch({ captioned: true, madeFrom: 1 })));
    expect(marked.versions).toMatchObject([{ n: 1, captioned: false }, { n: 2, captioned: true, madeFrom: 1 }]);
    // unmarking drops the link; marking again brings it back
    const unmarked = await read(app.request(`/assets/${clean.id}/v/2`, patch({ captioned: false })));
    expect(unmarked.versions[1]).toMatchObject({ captioned: false });
    expect(unmarked.versions[1].madeFrom).toBeUndefined();
    await app.request(`/assets/${clean.id}/v/2`, patch({ captioned: true, madeFrom: 1 }));

    // stacked onto another video, the pair keeps pointing at each other
    const first = await up("first.mp4");
    const moved = await read(app.request(`/assets/${first.id}/stack`, json({ from: clean.id })));
    expect(moved.versions).toMatchObject([{ n: 1 }, { n: 2, captioned: false }, { n: 3, captioned: true, madeFrom: 2 }]);
    // and split apart, nothing points into another video
    await app.request(`/assets/${first.id}/unstack`, { method: "POST" });
    const all = await read(app.request("/"));
    expect(all.find((x: { name: string }) => x.name === "burned").versions[0]).toMatchObject({ captioned: true });
    expect(all.find((x: { name: string }) => x.name === "burned").versions[0].madeFrom).toBeUndefined();
  });

  it("deletes into the trash and restores from it", async () => {
    const a = await up("oops.mp4");
    await app.request(`/assets/${a.id}`, patch({ share: { enabled: true } }));
    const token = (await read(app.request(`/assets/${a.id}`))).asset.share.token;
    await app.request(`/assets/${a.id}`, { method: "DELETE" });
    expect((await app.request(`/assets/${a.id}`)).status).toBe(404);
    expect((await app.request(`/s/${token}`)).status).toBe(404);
    const [trashed] = await read(app.request("/trash"));
    expect(trashed).toMatchObject({ id: a.id, name: "oops" });
    expect(trashed.deletedAt).toBeGreaterThan(0);

    await app.request(`/trash/${a.id}/restore`, { method: "POST" });
    expect((await app.request(`/s/${token}`)).status).toBe(200);
    expect(await read(app.request("/trash"))).toEqual([]);

    await app.request(`/assets/${a.id}`, { method: "DELETE" });
    await app.request(`/trash/${a.id}`, { method: "DELETE" });
    expect(await read(app.request("/trash"))).toEqual([]);
    expect(existsSync(path.join(dataDir, "review", "trash", a.id))).toBe(false);
  });

  it.skipIf(!hasFfmpeg)(
    "opens a version in Caption Studio on the same file, never a copy",
    async () => {
      // a plain upload opens as a new project on the same file
      const file = path.join(dataDir, "upload.mp4");
      h264(file);
      const bytes = readFileSync(file);
      const init = await read(app.request("/uploads", json({ name: "Talk.mp4", mime: "video/mp4", size: bytes.length })));
      await app.request(`/uploads/${init.id}/parts/1`, {
        method: "POST",
        headers: {
          "upload-length": String(bytes.length),
          "upload-part-size": String(init.partSize),
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      const talk = await read(app.request(`/uploads/${init.id}/complete`, { method: "POST" }));
      const opened = await read(app.request(`/assets/${talk.id}/v/1/captions`, { method: "POST" }));
      const meta = JSON.parse(readFileSync(path.join(dataDir, "projects", opened.projectId, "meta.json"), "utf-8"));
      expect(meta).toMatchObject({ name: "Talk", owner: "owner", clips: [{ name: "Talk.mp4" }] });
      const clipDir = path.join(dataDir, "projects", opened.projectId, "clips", meta.clips[0].id);
      expect(inode(path.join(clipDir, "original"))).toBe(inode(path.join(dataDir, "review", talk.id, "v1", "source")));
      expect(existsSync(path.join(clipDir, "proxy.mp4"))).toBe(true);
      // and again: the same project, not a second one
      expect(await read(app.request(`/assets/${talk.id}/v/1/captions`, { method: "POST" }))).toEqual(opened);
    },
    30_000,
  );
});

describe("resumable uploads", () => {
  it("tells a returning browser which parts it already has", async () => {
    const size = 16 * 1024 * 1024 + 10;
    const init = await read(app.request("/uploads", json({ name: "Long.mov", size })));
    const part = await app.request(`/uploads/${init.id}/parts/2`, {
      method: "POST",
      headers: { "upload-length": String(size), "upload-part-size": String(init.partSize), "content-length": "10" },
      body: Buffer.alloc(10),
    });
    expect(part.status).toBe(200);
    expect(await read(app.request(`/uploads/${init.id}/parts`))).toEqual({ partSize: init.partSize, parts: [2] });
    expect((await app.request("/uploads/00000000-0000-4000-8000-000000000000/parts")).status).toBe(404);
  });
});

describe("timeline file on a version", () => {
  const EDL = "TITLE: Tiny Proto\n\n001  talkmp4  V     C        00:00:00:10 00:00:04:10 00:00:00:00 00:00:04:00\n";
  const putTimeline = (id: string, body: string | Buffer, name = "Tiny.edl") =>
    app.request(`/assets/${id}/v/1/timeline?name=${name}`, { method: "PUT", headers: { "content-type": "text/plain" }, body });

  it("keeps the owner's timeline, shows it to share-link viewers, and names the file only to people who can manage", async () => {
    const asset = await up("Tiny cut.mp4");
    const put = await read(putTimeline(asset.id, EDL));
    expect(put.versions[0]).toMatchObject({ timeline: true, timelineFile: "Tiny.edl" });

    expect((await read(app.request(`/assets/${asset.id}`))).asset.versions[0].timelineFile).toBe("Tiny.edl");

    const { share } = await read(app.request(`/assets/${asset.id}`, patch({ share: { enabled: true } })));
    const shared = await read(app.request(`/s/${share.token}`));
    expect(shared.asset.versions[0]).toMatchObject({ timeline: true });
    expect(shared.asset.versions[0]).not.toHaveProperty("timelineFile");
    expect((await app.request(`/s/${share.token}/v/1/timeline`)).status).toBe(200);
  });

  it("a share-link reviewer pins a comment to one clip or to several", async () => {
    const asset = await up("Tiny pins.mp4");
    await read(putTimeline(asset.id, EDL));
    const { share } = await read(app.request(`/assets/${asset.id}`, patch({ share: { enabled: true } })));
    const guest = { "x-review-key": "g".repeat(24) };
    const clip = (rec: number) => ({ track: "V1", rec, len: 25, label: `talk ${rec}` });
    const one = await read(app.request(`/s/${share.token}/comments`, json({ version: 1, text: "This shot", author: "Client", anchor: clip(0) }, guest)));
    expect(one.anchor).toEqual(clip(0));
    expect(one).not.toHaveProperty("anchors");
    const many = await read(app.request(`/s/${share.token}/comments`,
      json({ version: 1, text: "These two", author: "Client", anchor: clip(0), anchors: [clip(0), clip(50), { track: "X9" }] }, guest)));
    expect(many.anchors).toEqual([clip(0), clip(50)]);
  });

  it("gives the owner the timeline's file paths, never a share link", async () => {
    const project = await read(app.request("/projects", json({ name: "Tiny project" })));
    const asset = await up("Tiny paths.mp4", project.id);
    const edl = `${EDL}* SOURCE FILE: /Volumes/Tiny Drive/Süvi/talk.mp4\n`;
    await read(putTimeline(asset.id, edl));
    const res = await app.request(`/assets/${asset.id}/v/1/timeline/sources`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ s1: "/Volumes/Tiny Drive/Süvi/talk.mp4" });
    expect(JSON.stringify(await read(app.request(`/assets/${asset.id}/v/1/timeline`)))).not.toContain("Volumes");

    const { share } = await read(app.request(`/assets/${asset.id}`, patch({ share: { enabled: true } })));
    expect((await app.request(`/s/${share.token}/v/1/timeline/sources`)).status).toBe(404);
    const p = await read(app.request(`/projects/${project.id}`, patch({ share: { enabled: true } })));
    expect((await app.request(`/p/${p.share.token}/a/${asset.id}/v/1/timeline`)).status).toBe(200);
    expect((await app.request(`/p/${p.share.token}/a/${asset.id}/v/1/timeline/sources`)).status).toBe(404);

    const none = await up("Tiny none.mp4");
    expect((await app.request(`/assets/${none.id}/v/1/timeline/sources`)).status).toBe(404);
  });

  it("refuses an oversized timeline from its declared length, before reading the body", async () => {
    const asset = await up("Tiny big.mp4");
    const { MAX_TIMELINE_BYTES } = await import("../contracts/timeline-import");
    const res = await putTimeline(asset.id, Buffer.alloc(MAX_TIMELINE_BYTES + 1, 0x20));
    expect(res.status).toBe(413);
    expect((await read(app.request(`/assets/${asset.id}`))).asset.versions[0].timeline).toBe(false);
  });
});

describe("plug-in data and edit references", () => {
  const payload = { "tiny-edits": { edits: [{ key: "shot-1", label: "Shot 1", zoom: 1.2 }] } };
  const count = async (id: string) => (await read(app.request(`/assets/${id}`))).comments.length;

  it("stores a manager's plug-in data on the comment and returns it to the manager", async () => {
    const asset = await up("Plugin cut.mp4");
    const cm = await read(app.request(`/assets/${asset.id}/comments`, json({ version: 1, text: "Tighter", plugins: payload })));
    expect(cm.plugins).toEqual(payload);
    expect((await read(app.request(`/assets/${asset.id}`))).comments).toMatchObject([{ id: cm.id, plugins: payload }]);
  });

  it("does not show plug-in data to a viewer who can only read (the share link)", async () => {
    const asset = await up("Plugin read.mp4");
    await app.request(`/assets/${asset.id}/comments`, json({ version: 1, text: "Tighter", plugins: payload }));
    const token = (await read(app.request(`/assets/${asset.id}`, patch({ share: { enabled: true } })))).share.token;
    const [seen] = (await read(app.request(`/s/${token}`))).comments;
    expect(seen).toMatchObject({ text: "Tighter" });
    expect(seen.plugins).toBeUndefined();
  });

  it("refuses plug-in data from a share-link reviewer with 403, and stores nothing", async () => {
    const asset = await up("Plugin shared.mp4");
    const token = (await read(app.request(`/assets/${asset.id}`, patch({ share: { enabled: true } })))).share.token;
    const guest = { "x-review-key": "k".repeat(24) };
    const res = await app.request(`/s/${token}/comments`, json({ version: 1, text: "Tighter", author: "Client", plugins: payload }, guest));
    expect(res.status).toBe(403);
    expect(await count(asset.id)).toBe(0);
  });

  it("refuses a reply that carries only plug-in data, since the data would be dropped", async () => {
    const asset = await up("Plugin reply.mp4");
    const parent = await read(app.request(`/assets/${asset.id}/comments`, json({ version: 1, text: "Parent" })));
    const res = await app.request(`/assets/${asset.id}/comments`, json({ version: 1, parentId: parent.id, plugins: payload }));
    expect(res.status).toBe(400);
    expect(await count(asset.id)).toBe(1);
  });

  it("keeps a version's AI Editor draft reference for managers and hides it from share links", async () => {
    const place = async () => {};
    const added = await addVersion(undefined, {
      owner: "owner", name: "Draft.mp4", mime: "video/mp4", bytes: 1, edit: { project: "tiny-proj", draft: "Main" },
    }, place);
    const id = added!.meta.id;
    expect((await read(app.request(`/assets/${id}`))).asset.versions[0].edit).toEqual({ project: "tiny-proj", draft: "Main" });
    const token = (await read(app.request(`/assets/${id}`, patch({ share: { enabled: true } })))).share.token;
    const shared = await read(app.request(`/s/${token}`));
    expect(shared.asset.versions[0]).not.toHaveProperty("edit");
  });
});
