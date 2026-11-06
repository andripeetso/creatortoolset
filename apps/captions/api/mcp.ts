import { Hono } from "hono";

/**
 * Creator Toolset as a remote MCP server: POST /api/mcp, MCP's Streamable HTTP answered as plain JSON, no sessions. Only a Full AI key gets here
 * (boot.ts: the key is the account itself), sent as `Authorization: Bearer ctk_…` (claude.ai: the connector's
 * Request headers). Every tool calls the site's own routes with the caller's credentials, so each route's checks
 * stay the only checks.
 */

type Call = (path: string, init: RequestInit) => Promise<Response>;
type Args = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

class ToolError extends Error {}

const ORIGIN = "https://creatortoolset.com";
/** MCP clients give up on a tool call after about a minute: a reply still thinking hands back its id to wait on. */
const WAIT_MAX_S = 55;

const INSTRUCTIONS = `Creator Toolset (creatortoolset.com), as the signed-in user's account.

Content Workshop: the same projects, sessions, pieces and chat the user sees on the site and the iPhone app, so whatever
you do here shows there at once. A project is one brand (audience, voice, CTA). A session is one idea: its sources,
notes, pieces and chat, with a status (draft, writing, production, editing, toPost = ready to post, published,
shelved). A piece is one reel, carousel, ad, free or youtube script: blocks (lines or slides, each with an id), hook
variations, a caption (post description) and a pinned comment. Two ways to write: workshop_chat asks the Workshop's
own writer, which reads the project, the user's posts and past rewrites (it runs on a paired Mac and can take minutes), or
change the text yourself with workshop_edit_piece. Locked blocks are ones the user approved: leave them as they are.

Review: his videos waiting for feedback, their versions and timed comments (with the frame each points at).
Resolve a comment only once the change it asks for is made.`;

const str = { type: "string" };
const lines = { type: "array", items: { type: "object", properties: { id: str, text: str }, required: ["text"] } };
export const TOOLS = [
  { name: "workshop_projects", description: "The Workshop's projects (brands): id, name, audience, voice, CTA, notes.", inputSchema: { type: "object", properties: {} } },
  { name: "workshop_sessions", description: "Workshop sessions, newest first: id, title, status, project, pinned, posted.", inputSchema: { type: "object", properties: { project: { type: "string", description: "only this project's (id)" } } } },
  {
    name: "workshop_session",
    description: "One session: title, status, notes, sources, every piece with its blocks (ids and text), hooks, caption and pinned comment, and the last chat messages.",
    inputSchema: { type: "object", properties: { session: str, messages: { type: "integer", description: "how many recent chat messages (default 10)" } }, required: ["session"] },
  },
  {
    name: "workshop_new_session",
    description: "Start a session (in the current project unless one is named). It comes with one empty piece to write in.",
    inputSchema: { type: "object", properties: { title: str, project: str, notes: { type: "string", description: "the idea, what it's for, anything the writer should know" } }, required: ["title"] },
  },
  {
    name: "workshop_update_session",
    description: "Change a session's title, notes or status (moves it through the stages).",
    inputSchema: {
      type: "object",
      properties: { session: str, title: str, notes: str, status: { type: "string", enum: ["draft", "writing", "production", "editing", "toPost", "published", "shelved"] } },
      required: ["session"],
    },
  },
  {
    name: "workshop_new_piece",
    description: "Add another piece to a session; text becomes its first block (split it with workshop_edit_piece).",
    inputSchema: { type: "object", properties: { session: str, kind: { type: "string", enum: ["reel", "carousel", "ad", "free", "youtube"] }, title: str, text: str }, required: ["session", "kind"] },
  },
  {
    name: "workshop_edit_piece",
    description: "Write in a piece yourself. blocks replaces the whole list in order: keep each kept block's id, leave id out for a new one, drop a block to delete it. Anything left out stays as it is.",
    inputSchema: { type: "object", properties: { session: str, piece: str, title: str, blocks: lines, hooks: lines, caption: str, pinned: str }, required: ["session", "piece"] },
  },
  {
    name: "workshop_chat",
    description: "Ask the Workshop's writer, in a session's chat, about one piece (it may edit the piece). Waits up to wait_s for the reply; if it's still thinking, call workshop_wait with the reply id.",
    inputSchema: {
      type: "object",
      properties: {
        session: str,
        piece: str,
        message: str,
        scope: { type: "string", enum: ["slight", "rewrite"], description: "how much it may change (unset = normal)" },
        wait_s: { type: "integer", description: `default and max ${WAIT_MAX_S}` },
      },
      required: ["session", "piece", "message"],
    },
  },
  { name: "workshop_wait", description: "Keep waiting for a workshop_chat reply.", inputSchema: { type: "object", properties: { session: str, reply: str, wait_s: { type: "integer" } }, required: ["session", "reply"] } },
  { name: "list_reviews", description: "His videos in Review: approval, versions, latest file, comment counts, link.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_review",
    description: "One review (its link or id, or a share link): each version, and every comment with its time, text, author, replies, resolved, drawing and references, plus the frames the open timed comments point at (drawing painted on).",
    inputSchema: { type: "object", properties: { link: str, version: { type: "integer" }, frames: { type: "integer", description: "how many comment frames to show (default 4, max 12)" } }, required: ["link"] },
  },
  {
    name: "resolve_comment",
    description: "Mark a Review comment done once the change it asks for is made (resolved: false reopens it).",
    inputSchema: { type: "object", properties: { link: str, comment_id: str, resolved: { type: "boolean" } }, required: ["link", "comment_id"] },
  },
];

const pick = (row: Args, keys: string[]) => Object.fromEntries(keys.filter((k) => row[k] != null && row[k] !== "" && !(Array.isArray(row[k]) && !(row[k] as unknown[]).length)).map((k) => [k, row[k]]));
const linesOf = (blocks: unknown) => ((blocks as Args[] | undefined) ?? []).map((b) => ({ id: b.id, text: b.text }));
const piece = (d: Args) => ({
  ...pick(d, ["id", "kind", "title", "locked"]),
  blocks: linesOf(d.blocks),
  ...((d.hooks as unknown[] | undefined)?.length ? { hooks: linesOf(d.hooks) } : {}),
  ...(d.caption ? { caption: (d.caption as Args).text } : {}),
  ...(d.pinned ? { pinned: (d.pinned as Args).text } : {}),
});
const message = (m: Args) => pick(m, ["id", "role", "text", "status", "error", "docId", "usage", "edits"]);
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const when = (ms: unknown) => (typeof ms === "number" && ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A review link or id → its API path (the user's own, a share link's, or a shared folder's video). */
function reviewPath(link: string): string {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const p = (() => {
    try {
      return new URL(link, ORIGIN).pathname;
    } catch {
      return link;
    }
  })();
  for (const [re, api] of [
    [new RegExp(`^/?(${uuid})/?$`, "i"), (a: string[]) => `/api/review/assets/${a[0]}`],
    [new RegExp(`/review/(${uuid})`, "i"), (a: string[]) => `/api/review/assets/${a[0]}`],
    [new RegExp(`/r/(${uuid})`, "i"), (a: string[]) => `/api/review/s/${a[0]}`],
    [new RegExp(`/rp/(${uuid})/(${uuid})`, "i"), (a: string[]) => `/api/review/p/${a[0]}/a/${a[1]}`],
  ] as const) {
    const m = re.exec(p) ?? re.exec(link);
    if (m) return api(m.slice(1));
  }
  throw new ToolError(`That isn't a review link: expected ${ORIGIN}/review/<id>, /r/<token> or /rp/<token>/<id>.`);
}

/** The tools, each a thin client of the site's own routes with the caller's credentials. */
function tools(call: Call, auth: Headers) {
  const api = async (path: string, method = "GET", body?: unknown): Promise<Response> => {
    const headers = new Headers();
    for (const h of ["authorization", "cookie"]) if (auth.get(h)) headers.set(h, auth.get(h)!);
    if (body !== undefined) headers.set("content-type", "application/json");
    const r = await call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 404) throw new ToolError("Not found, or not this account's.");
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new ToolError(j?.error || `${path} answered ${r.status}`);
    }
    return r;
  };
  const json = async <T = Args>(path: string, method = "GET", body?: unknown) => (await (await api(path, method, body)).json()) as T;
  const ws = <T = Args>(path: string, method = "GET", body?: unknown) => json<T>(`/api/workshop${path}`, method, body);
  const pieces = async (session: string) => (await ws<Args[]>(`/sessions/${session}/docs`)).filter((d) => d.kind !== "notes").map(piece);

  const wait = async (a: Args) => {
    const end = Date.now() + Math.max(0, Math.min(Number(a.wait_s ?? WAIT_MAX_S), WAIT_MAX_S)) * 1000;
    for (;;) {
      const msg = (await ws<Args[]>(`/sessions/${a.session}/chat`)).find((m) => m.id === a.reply);
      if (!msg) throw new ToolError("That reply isn't in this session's chat.");
      if (msg.status !== "thinking" || Date.now() >= end) {
        if (msg.status === "thinking") return { reply: message(msg), note: `Still thinking (${msg.stage ?? "working"}): call workshop_wait again.` };
        return { reply: message(msg), ...(msg.docId ? { piece: piece(await ws(`/sessions/${a.session}/docs/${msg.docId}`)) } : {}) };
      }
      await sleep(3000);
    }
  };

  const handlers: Record<string, (a: Args) => Promise<unknown>> = {
    workshop_projects: async () => ({ projects: (await ws<Args[]>("/projects")).map((p) => pick(p, ["id", "name", "audience", "voice", "cta", "notes"])) }),
    workshop_sessions: async (a) => ({
      sessions: (await ws<Args[]>(`/sessions${a.project ? `?projectId=${encodeURIComponent(String(a.project))}` : ""}`)).map((r) =>
        pick(r, ["id", "title", "status", "projectId", "projectName", "pinned", "posted", "updatedAt"]),
      ),
    }),
    workshop_session: async (a) => {
      const meta = await ws(`/sessions/${a.session}`);
      const chat = await ws<Args[]>(`/sessions/${a.session}/chat`);
      const n = Math.max(0, Number(a.messages ?? 10));
      return {
        ...pick(meta, ["id", "title", "status", "projectId", "notes", "query", "posted"]),
        sources: ((meta.posts as Args[] | undefined) ?? []).map((p) => pick(p, ["id", "url", "caption"])),
        pieces: await pieces(String(a.session)),
        chat: n ? chat.slice(-n).map(message) : [],
      };
    },
    workshop_new_session: async (a) => {
      const made = await ws("/sessions", "POST", { title: a.title, ...(a.project ? { projectId: a.project } : {}), ...(a.notes ? { notes: a.notes } : {}) });
      // opening it makes its Notes and the empty piece to write in, as the site does
      return { ...pick(made, ["id", "title", "status", "projectId"]), pieces: await pieces(String(made.id)) };
    },
    workshop_update_session: async (a) => {
      const body = pick(a, ["title", "notes", "status"]);
      if (!Object.keys(body).length) throw new ToolError("Nothing to change: give a title, notes or status.");
      return pick(await ws(`/sessions/${a.session}`, "PATCH", body), ["id", "title", "status"]);
    },
    workshop_new_piece: async (a) => piece(await ws(`/sessions/${a.session}/docs`, "POST", pick(a, ["kind", "title", "text"]))),
    workshop_edit_piece: async (a) => {
      const body = pick(a, ["title", "blocks", "hooks", "caption", "pinned"]);
      if (!Object.keys(body).length) throw new ToolError("Nothing to change.");
      return piece(await ws(`/sessions/${a.session}/docs/${a.piece}`, "PATCH", body));
    },
    workshop_chat: async (a) => {
      const started = await ws<{ reply: Args }>(`/sessions/${a.session}/chat`, "POST", { docId: a.piece, text: a.message, ...(a.scope ? { scope: a.scope } : {}) });
      return wait({ session: a.session, reply: started.reply.id, wait_s: a.wait_s });
    },
    workshop_wait: wait,
    list_reviews: async () => ({
      reviews: (await json<Args[]>("/api/review")).map((r) => {
        const versions = (r.versions as Args[] | undefined) ?? [];
        return {
          ...pick(r, ["id", "name"]),
          approval: (r.approval as Args | undefined)?.status,
          versions: versions.length,
          latest_file: versions.at(-1)?.name,
          latest_comments: r.comments,
          new_comments: r.newComments,
          updated: when(r.updatedAt),
          link: `${ORIGIN}/review/${r.id}`,
        };
      }),
    }),
    get_review: async (a) => {
      const path = reviewPath(String(a.link));
      const view = await json(path);
      const asset = view.asset as Args;
      const versions = new Map(((asset.versions as Args[] | undefined) ?? []).map((v) => [v.n as number, v]));
      const all = (view.comments as Args[] | undefined) ?? [];
      const threads = all
        .filter((c) => !c.parentId && (a.version == null || c.version === Number(a.version)))
        .sort((x, y) => (Number(x.version) - Number(y.version)) || ((x.t as number) ?? -1) - ((y.t as number) ?? -1))
        .map((c): Args => {
          const fps = Number(versions.get(c.version as number)?.fps) || 0;
          const points = ((c.drawing as Args[] | undefined) ?? []).flatMap((s) => (s.points as number[][] | undefined) ?? []);
          return {
            ...pick(c, ["id", "version", "text", "author", "resolved"]),
            when: when(c.createdAt),
            ...(typeof c.t === "number" ? { at: clock(c.t) + (typeof c.tEnd === "number" ? `–${clock(c.tEnd)}` : ""), start: c.t, end: c.tEnd, ...(fps ? { frame: Math.round(c.t * fps) } : {}) } : {}),
            ...(points.length ? { drawing_box: [Math.min(...points.map((p) => p[0]!)), Math.min(...points.map((p) => p[1]!)), Math.max(...points.map((p) => p[0]!)), Math.max(...points.map((p) => p[1]!))] } : {}),
            ...((c.refs as Args[] | undefined)?.length ? { references: (c.refs as Args[]).map((r) => pick(r, ["id", "name", "kind"])) } : {}),
            replies: all.filter((r) => r.parentId === c.id).map((r) => ({ author: r.author, text: r.text, when: when(r.createdAt) })),
          };
        });
      const shaped = {
        ...pick(asset, ["id", "name"]),
        link: `${ORIGIN}/review/${asset.id}`,
        approval: (asset.approval as Args | undefined)?.status,
        versions: [...versions.values()].map((v) => pick(v, ["n", "name", "duration", "fps", "width", "height", "status", "removed"])),
        open_comments: threads.filter((t) => !t.resolved).length,
        comments: threads,
      };
      const out: Content[] = [{ type: "text", text: JSON.stringify(shaped, null, 1) }];
      const timed = threads.filter((t) => "start" in t && !t.resolved && !versions.get(t.version as number)?.removed);
      for (const t of timed.slice(0, Math.max(0, Math.min(Number(a.frames ?? 4), 12)))) {
        const r = await api(`${path}/v/${t.version}/frame?c=${encodeURIComponent(String(t.id))}`).catch(() => null);
        if (!r) continue;
        out.push({ type: "text", text: `Comment ${t.id} (v${t.version}, ${t.at}): ${t.text}` });
        out.push({ type: "image", mimeType: "image/jpeg", data: Buffer.from(await r.arrayBuffer()).toString("base64") });
      }
      return out;
    },
    resolve_comment: async (a) => {
      const id = ((await json(reviewPath(String(a.link)))).asset as Args).id;
      const cm = await json(`/api/review/assets/${id}/comments/${encodeURIComponent(String(a.comment_id))}`, "PATCH", { resolved: a.resolved !== false });
      return { id: cm.id, resolved: !!cm.resolved, text: cm.text };
    },
  };
  return handlers;
}

async function callTool(call: Call, auth: Headers, name: string, args: Args) {
  const handler = tools(call, auth)[name];
  try {
    if (!handler) throw new ToolError(`Unknown tool ${name}.`);
    const result = await handler(args ?? {});
    return { content: Array.isArray(result) ? (result as Content[]) : [{ type: "text", text: JSON.stringify(result, null, 1) }] };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/** One JSON-RPC message in, its answer out (null for a notification). */
export async function handle(call: Call, auth: Headers, msg: Args): Promise<Args | null> {
  if (msg.id === undefined) return null;
  const params = (msg.params ?? {}) as Args;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "creator-toolset", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      return ok(await callTool(call, auth, String(params.name), (params.arguments ?? {}) as Args));
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
  }
}

export function mcpApp(call: Call) {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Args | Args[] | null;
    if (!body) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const auth = c.req.raw.headers;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(call, auth, m)))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(call, auth, body);
    return out ? c.json(out) : c.body(null, 202);
  });
  // no server-sent stream: everything is answered in the POST
  app.get("/", (c) => c.body(null, 405, { Allow: "POST" }));
  return app;
}
