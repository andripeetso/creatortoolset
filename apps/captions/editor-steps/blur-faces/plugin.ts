import { Hono } from "hono";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "../../api/auth";
import { anyVisionConfigured, completeVisionWithFallback } from "../../api/ai-vision";
import { env } from "../../api/lib/env";
import { chosenIn, FACE_PICK_SYSTEM } from "../../api/lib/face-pick";
import { definePlugin, requireGate } from "../../api/lib/plugin";
import { writeJsonAtomic } from "../../api/library/media/run";

/**
 * Face Blur: every face, or the ones the person names, covered in photos and videos on their own Mac or iPhone (the apps'
 * FaceBlur engine, Apple's face detector). The server keeps each account's settings and, in "Only some faces" mode, asks
 * the person's own AI which faces match their words (README.md has the whole contract).
 *   GET/PUT /api/x/blur-faces/settings   { mode, who, look }
 *   POST    /api/x/blur-faces/pick       { who, faces: [{ id, picture, note }] } → { blur: [ids] }; 409 + { error } when
 *                                        the AI can't answer, and then the device writes nothing
 */

export type Settings = { mode: "all" | "some"; who: string; look: "blur" | "mosaic" | "solid" };
export const DEFAULTS: Settings = { mode: "all", who: "Every child's face", look: "blur" };
export const LIMITS = { who: 500, faces: 40, picture: 200_000, note: 300 };
const MODES = ["all", "some"];
const LOOKS = ["blur", "mosaic", "solid"];
const PER_CALL = 10; // faces (one picture each) per question to the AI
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const fileOf = (user: string) => path.join(env.dataDir, "plugins", "blur-faces", `${user}.json`);

async function settingsOf(user: string): Promise<Settings> {
  const saved = await readFile(fileOf(user), "utf8").then((t) => JSON.parse(t) as Partial<Settings>, () => ({}));
  return { ...DEFAULTS, ...saved };
}

/** The settings a PUT sends, or what is wrong with them. */
export function checkSettings(b: unknown): Settings | string {
  const s = b as Partial<Settings> | null;
  if (!s || typeof s !== "object") return "Send mode, who and look.";
  if (!MODES.includes(s.mode as string)) return "mode is all or some.";
  if (!LOOKS.includes(s.look as string)) return "look is blur, mosaic or solid.";
  if (typeof s.who !== "string" || s.who.length > LIMITS.who) return `Which faces: a text of at most ${LIMITS.who} characters.`;
  return { mode: s.mode!, who: s.who, look: s.look! };
}

type Face = { id: string; picture: string; note: string };

/** The faces a pick sends, or what is wrong with them. */
export function checkPick(b: unknown): { who: string; faces: Face[] } | string {
  const p = b as { who?: unknown; faces?: unknown } | null;
  const who = typeof p?.who === "string" ? p.who.trim() : "";
  if (!who || who.length > LIMITS.who) return `Say which faces to blur, in at most ${LIMITS.who} characters.`;
  if (!Array.isArray(p!.faces)) return "Send the faces.";
  if (p!.faces.length > LIMITS.faces) return `At most ${LIMITS.faces} faces at a time.`;
  const seen = new Set<string>();
  for (const f of p!.faces as Partial<Face>[]) {
    if (typeof f?.id !== "string" || !ID.test(f.id) || seen.has(f.id)) return "Each face needs an id of its own.";
    seen.add(f.id);
    if (typeof f.picture !== "string" || !BASE64.test(f.picture)) return "Each face's picture is a JPEG as base64.";
    if (f.picture.length > Math.ceil(LIMITS.picture / 3) * 4) return `A face's picture is over ${LIMITS.picture / 1000} KB.`;
    if (typeof f.note !== "string" || f.note.length > LIMITS.note) return `A face's note is at most ${LIMITS.note} characters.`;
  }
  return { who, faces: p!.faces as Face[] };
}

const NOTHING = "Nothing was blurred.";

const routes = new Hono<{ Variables: AuthVars }>();
routes.use("*", requireGate("blur-faces"));

routes.get("/settings", async (c) => c.json(await settingsOf(c.get("user").username)));

routes.put("/settings", async (c) => {
  const s = checkSettings(await c.req.json().catch(() => null));
  if (typeof s === "string") return c.json({ error: s }, 400);
  const file = fileOf(c.get("user").username);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, s);
  return c.json(s);
});

routes.post("/pick", async (c) => {
  const user = c.get("user").username;
  const p = checkPick(await c.req.json().catch(() => null));
  if (typeof p === "string") return c.json({ error: p }, 400);
  if (!p.faces.length) return c.json({ blur: [] });
  if (!anyVisionConfigured(user)) return c.json({ error: `Face Blur needs your AI to choose the faces: connect one in Settings → Providers. ${NOTHING}` }, 409);
  const blur: string[] = [];
  for (let i = 0; i < p.faces.length; i += PER_CALL) {
    const batch = p.faces.slice(i, i + PER_CALL);
    const ids = batch.map((f) => f.id);
    const ask = `The person's instruction: "${p.who}"\n\nThe faces, one picture each, in this order:\n${batch.map((f) => `${f.id}: ${f.note}`).join("\n")}\n\nWhich faces match the instruction?`;
    let answer: string;
    try {
      answer = (await completeVisionWithFallback(FACE_PICK_SYSTEM, ask, batch.map((f) => ({ jpegBase64: f.picture })), c.req.raw.signal, (t) => t, user, { label: "Face Blur" })).value;
    } catch (e) {
      return c.json({ error: `Face Blur could not ask your AI which faces to blur (${(e as Error).message}). ${NOTHING}` }, 409);
    }
    try {
      blur.push(...chosenIn(answer, ids));
    } catch (e) {
      return c.json({ error: `Face Blur could not read your AI's answer (${(e as Error).message}). ${NOTHING} Try again, or another AI in Settings → Providers.` }, 409);
    }
  }
  return c.json({ blur });
});

// `kind` is read as text by Community's list of the team's plug-ins: a tool of its own, not a Home tool's, so it is listed under Other
export default definePlugin({
  id: "blur-faces",
  name: "Face Blur",
  about: "Covers every face, or only the ones you name, in your photos and videos, on your Mac and iPhone",
  kind: "tool",
  gates: { ids: ["blur-faces"] },
  routes,
});
