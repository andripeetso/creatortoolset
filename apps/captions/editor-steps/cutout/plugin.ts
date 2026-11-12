import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantView } from "../../contracts/assistant";
import type { AuthVars } from "../../api/auth";
import { CUTOUT_LIMITS, cutOut } from "../../api/lib/cutouts";
import { env } from "../../api/lib/env";
import { definePlugin } from "../../api/lib/plugin";
import { ToolError, type Args, type ToolContext } from "../../api/mcp-tools/types";

/**
 * Cut-out: the subject of a still picture cut out of its background by the person's own Mac (api/lib/cutouts.ts, the
 * Mac app's Cutout.swift), for the assistant now and for the app's other AI jobs later. No page and no tile.
 *   POST /api/x/cutout { data } (the picture, base64) or { path } (a file on this computer, when the server runs there)
 *        → { id, href, bytes } once the Mac sent the PNG; a refusal is a 409 with the reason
 *   GET  /api/x/cutout/<id>.png   the cut-out, to its own account only
 * Kept in $DATA_DIR/plugins/cutout/<user>/<id>.png.
 */

const dirOf = (user: string) => path.join(env.dataDir, "plugins", "cutout", user);
const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
const tooBig = `The picture is over ${CUTOUT_LIMITS.bytes / 1e6} MB.`;

/** The picture a call names: a file on this computer by its path, or the bytes sent. A sentence when there is none. */
async function pictureOf(b: Record<string, unknown> | null): Promise<Buffer | string> {
  if (typeof b?.path === "string") {
    if (process.env.CT_LOCAL !== "1") return "This server isn't on your computer: send the picture in the chat.";
    if (!path.isAbsolute(b.path)) return "Give the picture's full path, such as /Users/you/Pictures/photo.heic.";
    const st = await stat(b.path).catch(() => null);
    if (!st?.isFile()) return `There's no file at ${b.path}.`;
    return st.size > CUTOUT_LIMITS.bytes ? tooBig : readFile(b.path);
  }
  if (typeof b?.data !== "string" || !b.data) return "Send the picture: data (base64) or path.";
  return b.data.length > Math.ceil(CUTOUT_LIMITS.bytes / 3) * 4 ? tooBig : Buffer.from(b.data, "base64");
}

const routes = new Hono<{ Variables: AuthVars }>();

routes.post("/", async (c) => {
  const user = c.get("user").username;
  const picture = await pictureOf((await c.req.json().catch(() => null)) as Record<string, unknown> | null);
  if (typeof picture === "string") return c.json({ error: picture }, 409);
  let png: Buffer;
  try {
    png = await cutOut(user, picture);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
  // ponytail: kept until the account goes; a sweep when cut-outs pile up on a disk
  const name = `${randomUUID()}.png`;
  const file = path.join(dirOf(user), name);
  await mkdir(dirOf(user), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, png, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return c.json({ id: name.slice(0, -4), href: `/api/x/cutout/${name}`, bytes: png.length });
});

routes.get("/:name", async (c) => {
  const name = c.req.param("name");
  const png = FILE.test(name) ? await readFile(path.join(dirOf(c.get("user").username), name)).catch(() => null) : null;
  if (!png) return c.json({ error: "Not found" }, 404);
  return c.body(new Uint8Array(png), 200, { "content-type": "image/png", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
});

/** A picture of the message the running reply answers, by the name the AI was told (attached/01-<name>.png), as base64. */
async function chatPicture(ctx: ToolContext, name: string): Promise<string> {
  const n = Number(/(?:^|\/)(\d{2})-[^/]*$/.exec(name)?.[1]);
  if (!n) throw new ToolError("Give picture as its attached/ name, or path for a file on this computer.");
  const messages = (await ctx.json<AssistantView>("/api/assistant")).messages;
  const running = messages.findIndex((m) => m.status === "thinking" && !m.wait);
  const asked = messages.slice(0, running < 0 ? messages.length : running).reverse().find((m) => m.role === "user");
  const im = asked?.images?.[n - 1];
  if (!im) throw new ToolError(`${name} isn't a picture of the message you are answering: ask for it again.`);
  return Buffer.from(await (await ctx.api(`/api/assistant/images/${im.id}`)).arrayBuffer()).toString("base64");
}

const tools = {
  defs: [
    {
      name: "picture_cutout",
      description: "Cuts the subject of a still picture (PNG, JPEG or HEIC) out of its background on the user's Mac: a PNG with a see-through background. Give picture (its attached/ name) or path.",
      inputSchema: { type: "object", properties: { picture: { type: "string" }, path: { type: "string" } } },
    },
  ],
  handlers: {
    picture_cutout: async (a: Args, ctx: ToolContext) => {
      const body = a.path ? { path: String(a.path) } : { data: await chatPicture(ctx, String(a.picture ?? "")) };
      const { href } = await ctx.json<{ href: string }>("/api/x/cutout", "POST", body);
      return { said: `Cut out: put ![Cut-out](${href}) in your reply to show it.`, href };
    },
  },
  steps: { picture_cutout: "Cutting the picture out on your Mac" },
};

// `kind` is read as text by Community's list of the team's plug-ins
const cutout = {
  id: "cutout",
  name: "Cut-out",
  about: "Your assistant cuts the subject of a picture out of its background, on your Mac",
  kind: "Assistant tool",
  routes,
  tools,
};
export default definePlugin(cutout);
