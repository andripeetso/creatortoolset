import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import {
  ANIMATION_BRIEF_MAX,
  MAX_ANIMATION_STYLES,
  MAX_INSPIRATIONS,
  MAX_MADE,
  PICTURE_MAX_BYTES,
  PICTURE_MAX_SIDE,
  STYLE_NAME_MAX,
  type AnimationStyle,
  type AnimationStylesView,
  type StylePicture,
} from "../../contracts/editor-styles";
import { picturesInChat } from "../assistant";
import { jobTurn, type AuthVars } from "../auth";
import { env } from "../lib/env";
import { ffmpeg } from "../library/media/run";
import { notTyped } from "./own-words";
import { change, read } from "./styles";

/**
 * Animation styles (contracts/editor-styles.ts): the `animation` list in the account's styles file (styles.ts), and
 * each style's pictures as files, $DATA_DIR/editor-styles/<username>/<styleId>/<pictureId>.jpg. A style is what the
 * person typed and the pictures they chose: nothing an AI wrote is saved here, and it holds no drawing code.
 * A picture is `made` only when addPicture is called with it, which the 👍 on an edit's card does with a still this
 * account's Mac drew. Every upload is an inspiration, and no route takes a picture's kind from its caller.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER = /^[a-zA-Z0-9_-]{1,64}$/;
/** The biggest file taken as a picture, before it is made small. */
const UPLOAD_MAX = 20 * 1024 * 1024;

/** What a save from the assistant's reply is told when the brief is not the person's own words (own-words.ts). */
export const BRIEF_NOT_TYPED = "The description was not saved: it is not the user's own words in this chat. Send a whole phrase they typed themselves, or a passage of a long text they pasted with this message, word for word, or leave brief out: they write it on the style's sheet (AI Editor, Animation styles).";
const FULL = `A style keeps ${MAX_INSPIRATIONS} inspirations. Take one out first.`;

const dirOf = (username: string, styleId: string) => path.join(env.dataDir, "editor-styles", username, styleId);

export const animationStyles = (username: string): AnimationStyle[] => read(username).animation ?? [];
export const findAnimation = (username: string, id: string): AnimationStyle | null => animationStyles(username).find((s) => s.id === id) ?? null;

/** A picture's file, or null when the style has no such picture. */
export function pictureFile(username: string, styleId: string, pictureId: string): string | null {
  if (!USER.test(username) || !ID.test(styleId) || !ID.test(pictureId)) return null;
  return findAnimation(username, styleId)?.pictures.some((p) => p.id === pictureId) ? path.join(dirOf(username, styleId), `${pictureId}.jpg`) : null;
}

/** The name and the brief a body carries, checked. A string is what is wrong with it. Nothing else of a style can be sent. */
function clean(body: Record<string, unknown>): { name?: string; brief?: string } | string {
  const out: { name?: string; brief?: string } = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return "Give the style a name";
    if (name.length > STYLE_NAME_MAX) return `A style's name is at most ${STYLE_NAME_MAX} characters`;
    out.name = name;
  }
  if (body.brief !== undefined) {
    if (typeof body.brief !== "string") return "brief is text";
    const brief = body.brief.trim();
    if (brief.length > ANIMATION_BRIEF_MAX) return `The brief is at most ${ANIMATION_BRIEF_MAX} characters`;
    out.brief = brief;
  }
  return out;
}

export function createAnimation(username: string, body: Record<string, unknown>): AnimationStyle | string {
  const given = clean(body);
  if (typeof given === "string") return given;
  if (!given.name) return "Give the style a name";
  const now = Date.now();
  const style: AnimationStyle = { id: randomUUID(), name: given.name, brief: given.brief ?? "", pictures: [], createdAt: now, updatedAt: now };
  return change(username, (f) => {
    const list = (f.animation ??= []);
    if (list.length >= MAX_ANIMATION_STYLES) return `You have ${MAX_ANIMATION_STYLES} animation styles, the most an account keeps. Delete one first.`;
    list.push(style);
    return style;
  });
}

/** Changes the name or the brief. Null: no such style. A string is why it was refused. */
export function updateAnimation(username: string, id: string, body: Record<string, unknown>): AnimationStyle | string | null {
  const given = clean(body);
  if (typeof given === "string") return given;
  return change(username, (f) => {
    const at = (f.animation ?? []).findIndex((s) => s.id === id);
    if (at < 0) return null;
    return (f.animation![at] = { ...f.animation![at]!, ...given, updatedAt: Date.now() });
  });
}

/** The style goes with its pictures, and the editing styles that named it name none. False: no such style. */
export async function deleteAnimation(username: string, id: string): Promise<boolean> {
  const gone = change(username, (f) => {
    const n = f.animation?.length ?? 0;
    f.animation = (f.animation ?? []).filter((s) => s.id !== id);
    for (const s of f.editing) if (s.animation === id) s.animation = null;
    return f.animation.length < n;
  });
  if (gone && USER.test(username) && ID.test(id)) await rm(dirOf(username, id), { recursive: true, force: true });
  return gone;
}

/**
 * `src` as a JPEG at `out`, no longer than `side` on its long side and no bigger than `bytes`: the quality goes down,
 * then the size, until it fits. Throws when the file is no picture ffmpeg reads.
 */
export async function fitJpeg(src: string, out: string, side: number, bytes: number): Promise<void> {
  for (let s = side; s >= 64; s = Math.round(s * 0.7)) {
    for (const q of [3, 6, 10, 16, 24, 31]) {
      await ffmpeg(["-i", src, "-frames:v", "1", "-vf", `scale=w='min(${s},iw)':h='min(${s},ih)':force_original_aspect_ratio=decrease`, "-q:v", String(q), "-f", "mjpeg", out], true);
      if ((await stat(out)).size <= bytes) return;
    }
  }
  throw new Error("The picture could not be made small enough");
}

/**
 * Adds the picture at `src` to a style, made small (PICTURE_MAX_SIDE, PICTURE_MAX_BYTES). An inspiration over
 * MAX_INSPIRATIONS is refused; a made one over MAX_MADE takes the place of the oldest made one. Null: no such style.
 * A string is why it was refused. `chat`: the assistant chat's picture it comes from; one the style already has from
 * there is not added again (the style comes back as it is).
 */
export async function addPicture(username: string, styleId: string, src: string, kind: StylePicture["kind"], chat?: string): Promise<AnimationStyle | string | null> {
  const full = FULL;
  const now = findAnimation(username, styleId);
  if (!now || !USER.test(username) || !ID.test(styleId)) return null;
  if (chat && now.pictures.some((p) => p.chat === chat)) return now;
  if (kind === "inspiration" && now.pictures.filter((p) => p.kind === kind).length >= MAX_INSPIRATIONS) return full;
  const dir = dirOf(username, styleId);
  const pic: StylePicture = { id: randomUUID(), kind, at: Date.now(), ...(chat ? { chat } : {}) };
  const file = path.join(dir, `${pic.id}.jpg`);
  await mkdir(dir, { recursive: true });
  try {
    await fitJpeg(src, file, PICTURE_MAX_SIDE, PICTURE_MAX_BYTES);
  } catch {
    await rm(file, { force: true });
    return "That file is not a picture this app can read";
  }
  const dropped: string[] = [];
  const saved = change(username, (f) => {
    const s = f.animation?.find((x) => x.id === styleId);
    if (!s) return null;
    const same = s.pictures.filter((p) => p.kind === kind);
    if (kind === "inspiration" && same.length >= MAX_INSPIRATIONS) return full;
    // the oldest liked stills make room: the collection follows what the person likes now
    for (const old of kind === "made" ? same.sort((a, b) => a.at - b.at).slice(0, Math.max(0, same.length + 1 - MAX_MADE)) : []) dropped.push(old.id);
    s.pictures = [...s.pictures.filter((p) => !dropped.includes(p.id)), pic];
    s.updatedAt = Date.now();
    return s;
  });
  if (!saved || typeof saved === "string") await rm(file, { force: true });
  for (const id of dropped) await rm(path.join(dir, `${id}.jpg`), { force: true });
  return saved;
}

/** Takes a picture out of a style. Null: no such style or picture. */
export async function removePicture(username: string, styleId: string, pictureId: string): Promise<AnimationStyle | null> {
  const file = pictureFile(username, styleId, pictureId);
  if (!file) return null;
  const saved = change(username, (f) => {
    const s = f.animation?.find((x) => x.id === styleId);
    if (!s) return null;
    s.pictures = s.pictures.filter((p) => p.id !== pictureId);
    s.updatedAt = Date.now();
    return s;
  });
  await rm(file, { force: true });
  return saved;
}

/** The routes, mounted inside /api/editor at /animation-styles (routes.ts), before /:id. */
export const animationApp = new Hono<{ Variables: AuthVars }>();

const notFound = { error: "Not found", code: "not_found" };
const json = async (req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> => {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

animationApp.get("/", (c) => c.json({ styles: animationStyles(c.get("user").username) } satisfies AnimationStylesView));

// the brief is the person's own words, also when the assistant saves it (own-words.ts)
animationApp.post("/", async (c) => {
  const b = await json(c.req);
  if (notTyped(c, b, ["brief"])) return c.json({ error: BRIEF_NOT_TYPED, code: "not_typed" }, 409);
  const made = createAnimation(c.get("user").username, b);
  return typeof made === "string" ? c.json({ error: made, code: "invalid" }, 400) : c.json(made);
});

// `addBrief` adds a line under the brief the style has (one it already holds is not added twice): what the person
// wrote before stays, as with an editing style's notes
animationApp.put("/:id", async (c) => {
  const b = await json(c.req);
  if (notTyped(c, b, ["brief", "addBrief"])) return c.json({ error: BRIEF_NOT_TYPED, code: "not_typed" }, 409);
  if (typeof b.addBrief === "string" && b.addBrief.trim()) {
    const had = findAnimation(c.get("user").username, c.req.param("id"))?.brief ?? "";
    const add = b.addBrief.trim();
    b.brief = had.toLowerCase().includes(add.toLowerCase()) ? had : [had, add].filter(Boolean).join("\n");
  }
  const changed = updateAnimation(c.get("user").username, c.req.param("id"), b);
  if (!changed) return c.json(notFound, 404);
  return typeof changed === "string" ? c.json({ error: changed, code: "invalid" }, 400) : c.json(changed);
});

animationApp.delete("/:id", async (c) => ((await deleteAnimation(c.get("user").username, c.req.param("id"))) ? c.json({ ok: true }) : c.json(notFound, 404)));

/** Pictures the person adds: each `file` of the form becomes an inspiration. Whatever else the form says is not read. */
animationApp.post("/:id/pictures", async (c) => {
  const user = c.get("user").username;
  const id = c.req.param("id");
  if (!findAnimation(user, id) || !ID.test(id)) return c.json(notFound, 404);
  const form = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
  const files = [form.file].flat().filter((f): f is File => f instanceof File);
  if (!files.length) return c.json({ error: "Send the picture as file", code: "invalid" }, 400);
  let style: AnimationStyle | null = null;
  for (const f of files) {
    if (f.size > UPLOAD_MAX) return c.json({ error: "A picture is at most 20 MB", code: "invalid" }, 400);
    const dir = dirOf(user, id);
    const tmp = path.join(dir, `${randomUUID()}.upload`);
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, Buffer.from(await f.arrayBuffer()));
    const added = await addPicture(user, id, tmp, "inspiration").finally(() => rm(tmp, { force: true }));
    if (!added) return c.json(notFound, 404);
    if (typeof added === "string") return c.json({ error: added, code: "invalid" }, 400);
    style = added;
  }
  return c.json(style);
});

/**
 * The newest `newest` pictures the person sent in the chat a reply is being written in become inspirations. The
 * assistant's own call only: the pictures are found by that reply's token, never by an id or a path the caller names.
 * One the style already has from that chat is passed over, so asking twice adds nothing twice; a picture the app can't
 * read is passed over too. `added` is how many went in, `full` that the style holds all it keeps.
 */
animationApp.post("/:id/pictures/chat", async (c) => {
  const user = c.get("user").username;
  const id = c.req.param("id");
  if (!findAnimation(user, id) || !ID.test(id)) return c.json(notFound, 404);
  const auth = c.req.header("authorization");
  const sent = /^Bearer ctj_/.test(auth ?? "") ? picturesInChat(user, jobTurn(auth) ?? "") : null;
  if (!sent) return c.json({ error: "Pictures come from the app's own chat. Outside it the user adds them on the style's sheet (AI Editor, Animation styles).", code: "invalid" }, 400);
  const n = Number((await json(c.req)).newest);
  if (!Number.isInteger(n) || n < 1) return c.json({ error: "Give newest: how many of the newest pictures the user sent in this chat to add", code: "invalid" }, 400);
  let added = 0;
  let full = false;
  for (const p of sent.slice(-n)) {
    const had = findAnimation(user, id)?.pictures.length ?? 0;
    const now = await addPicture(user, id, p.file, "inspiration", p.id);
    if (!now) return c.json(notFound, 404);
    if (now === FULL) {
      full = true;
      break;
    }
    if (typeof now !== "string" && now.pictures.length > had) added++;
  }
  return c.json({ style: findAnimation(user, id), added, ...(sent.length ? {} : { none: true }), ...(full ? { full: true } : {}) });
});

animationApp.get("/:id/pictures/:pid", async (c) => {
  const file = pictureFile(c.get("user").username, c.req.param("id"), c.req.param("pid"));
  const bytes = file && (await readFile(file).catch(() => null));
  if (!bytes) return c.json(notFound, 404);
  // a picture never changes under its id
  return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } });
});

animationApp.delete("/:id/pictures/:pid", async (c) => {
  const style = await removePicture(c.get("user").username, c.req.param("id"), c.req.param("pid"));
  return style ? c.json(style) : c.json(notFound, 404);
});
