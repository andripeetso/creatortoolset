import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { AuthVars } from "./auth";
import {
  AiProviderError,
  anyAiConfigured,
  completeWithFallback,
  aiFor,
} from "./ai-complete";
import { env } from "./lib/env";
import {
  parseDocumentMarkdown,
  splitDocumentTitle,
  withDocumentTitle,
} from "../src/lib/document-markdown";
import { type SessionUser } from "./users";
import { generateGuideFromClip } from "./lib/guide-pipeline";
import {
  guideToMarkdown,
  isGuideAssetName,
  mergeGuideEdits,
  parseDocKind,
  parseStoredGuide,
  type DocKind,
  type GuideDoc,
} from "../src/lib/guide";

/**
 * Documents — assemble clips / caption projects into an editable
 * markdown page, optionally published at /documents/<id>.
 *
 * $DATA_DIR/documents/<id>/meta.json + body.md
 * Guides also store guide.json and JPEG stills in assets/.
 */

export const documentsApp = new Hono<{ Variables: AuthVars }>();

const DOCS_DIR = path.join(env.dataDir, "documents");
const CLIPS_DIR = path.join(env.dataDir, "clips");
const PROJECTS_DIR = path.join(env.dataDir, "projects");
const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);
const docDir = (id: string) => path.join(DOCS_DIR, id);
const MAX_SOURCES = 8;
const PACK_CHARS = 7500;

type SourceType = "clip" | "caption";
type Status = "ready" | "error";
type Kind = DocKind;

interface DocSource {
  type: SourceType;
  id: string;
  name: string;
  note?: string;
}

interface Meta {
  id: string;
  name: string;
  owner?: string;
  kind?: Kind;
  prompt: string;
  sources: DocSource[];
  published: boolean;
  status: Status;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

void mkdir(DOCS_DIR, { recursive: true }).catch(() => {});

const canSee = (meta: Meta, user: SessionUser) =>
  user.role === "admin" || meta.owner === user.username;

const ownsSource = (owner: string | undefined, user: SessionUser) =>
  owner === user.username || (user.role === "admin" && !owner);

async function persist(meta: Meta): Promise<void> {
  meta.updatedAt = Date.now();
  await mkdir(docDir(meta.id), { recursive: true });
  await writeFile(
    path.join(docDir(meta.id), "meta.json"),
    JSON.stringify(meta),
  );
}

async function readMeta(id: string): Promise<Meta | null> {
  if (!okId(id)) return null;
  try {
    return JSON.parse(
      await readFile(path.join(docDir(id), "meta.json"), "utf-8"),
    ) as Meta;
  } catch {
    return null;
  }
}

async function readBody(id: string): Promise<string> {
  try {
    const raw = await readFile(path.join(docDir(id), "body.md"), "utf-8");
    const parsed = parseDocumentMarkdown(raw);
    const trimmed = raw.trim();
    if (parsed && parsed !== trimmed && trimmed.startsWith("{")) {
      await writeFile(path.join(docDir(id), "body.md"), parsed).catch(() => {});
    }
    return parsed;
  } catch {
    return "";
  }
}

async function writeBody(id: string, body: string): Promise<void> {
  await mkdir(docDir(id), { recursive: true });
  await writeFile(path.join(docDir(id), "body.md"), body);
}

const assetsDir = (id: string) => path.join(docDir(id), "assets");
const guidePath = (id: string) => path.join(docDir(id), "guide.json");

async function readGuide(id: string): Promise<GuideDoc | null> {
  try {
    return parseStoredGuide(
      JSON.parse(await readFile(guidePath(id), "utf-8")),
    );
  } catch {
    return null;
  }
}

async function writeGuide(id: string, guide: GuideDoc): Promise<void> {
  await mkdir(docDir(id), { recursive: true });
  await writeFile(guidePath(id), JSON.stringify(guide));
}

async function publicDoc(meta: Meta, body?: string) {
  const kind = parseDocKind(meta.kind);
  const md = body ?? (await readBody(meta.id));
  const guide = kind === "guide" ? await readGuide(meta.id) : undefined;
  return {
    ...meta,
    kind,
    body: md,
    ...(guide ? { guide } : {}),
  };
}

async function ownedMeta(id: string, user: SessionUser): Promise<Meta | null> {
  const meta = await readMeta(id);
  return meta && canSee(meta, user) ? meta : null;
}

function assertGuideSources(sources: DocSource[]): void {
  if (sources.length !== 1 || sources[0].type !== "clip") {
    throw new Error("A guide uses exactly one clip");
  }
}

async function runGuideGenerate(
  meta: Meta,
  resolved: (DocSource & { pack: string })[],
  owner: string,
): Promise<{ title: string; markdown: string }> {
  assertGuideSources(resolved);
  const clip = resolved[0];
  const dest = assetsDir(meta.id);
  const tmp = path.join(docDir(meta.id), `assets-${randomUUID()}`);
  const prev = path.join(docDir(meta.id), `assets-prev-${randomUUID()}`);
  let movedPrev = false;
  try {
    const out = await generateGuideFromClip({
      prompt: meta.prompt,
      note: clip.note,
      clipId: clip.id,
      assetsDir: tmp,
      owner,
    });
    if (existsSync(dest)) {
      await rename(dest, prev);
      movedPrev = true;
    }
    await rename(tmp, dest);
    await writeGuide(meta.id, out.guide);
    await writeBody(meta.id, out.markdown);
    if (movedPrev) await rm(prev, { recursive: true, force: true }).catch(() => {});
    return { title: out.title, markdown: out.markdown };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (movedPrev) {
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      await rename(prev, dest).catch(() => {});
    }
    throw e;
  }
}

function titleFromBody(body: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  const t = (m?.[1] || fallback).trim().replace(/\s+/g, " ");
  return t.slice(0, 120) || fallback;
}

function timedTranscript(
  words: { text: string; start: number; end?: number }[],
  max = PACK_CHARS,
): string {
  const parts: string[] = [];
  let buf: string[] = [];
  let t0 = 0;
  const flush = () => {
    if (!buf.length) return;
    const mm = Math.floor(t0 / 60);
    const ss = Math.floor(t0 % 60);
    parts.push(
      `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${buf.join(" ")}`,
    );
    buf = [];
  };
  for (const w of words) {
    if (!buf.length) t0 = w.start;
    buf.push(w.text);
    if (w.start - t0 >= 10 || buf.join(" ").length > 140) flush();
  }
  flush();
  return parts.join("\n").slice(0, max);
}

async function packClip(id: string): Promise<{ name: string; pack: string; owner?: string } | null> {
  const dir = path.join(CLIPS_DIR, id);
  try {
    const meta = JSON.parse(
      await readFile(path.join(dir, "meta.json"), "utf-8"),
    ) as {
      name?: string;
      owner?: string;
      summary?: string;
      chapters?: { t: number; title: string }[];
      blocks?: {
        kind: string;
        text?: string;
        items?: { text: string; t?: number }[];
        chapters?: { t: number; title: string }[];
      }[];
    };
    const lines = [`Title: ${meta.name || "Untitled clip"}`, `Link: /clips/${id}`];
    if (meta.summary) lines.push(`Summary: ${meta.summary}`);
    const chapters = meta.chapters?.length
      ? meta.chapters
      : meta.blocks?.find((b) => b.kind === "chapters")?.chapters;
    if (chapters?.length) {
      lines.push(
        "Chapters:",
        ...chapters.map((ch) => `- [${ch.t}s] ${ch.title}`),
      );
    }
    for (const b of meta.blocks ?? []) {
      if (b.kind === "summary" && b.text) lines.push(`Summary: ${b.text}`);
      if (b.items?.length && (b.kind === "takeaways" || b.kind === "actions" || b.kind === "quotes")) {
        lines.push(
          `${b.kind}:`,
          ...b.items.map((it) => `- ${it.text}`),
        );
      }
    }
    try {
      const tr = JSON.parse(
        await readFile(path.join(dir, "transcript.json"), "utf-8"),
      ) as { words?: { text: string; start: number; end: number }[] };
      if (tr.words?.length) {
        lines.push("Transcript:", timedTranscript(tr.words));
      }
    } catch {
      /* no transcript */
    }
    const pack = lines.join("\n").trim();
    if (pack === `Title: ${meta.name || "Untitled clip"}\nLink: /clips/${id}`) {
      return null;
    }
    return { name: meta.name || "Untitled clip", pack, owner: meta.owner };
  } catch {
    return null;
  }
}

async function packCaption(id: string): Promise<{ name: string; pack: string; owner?: string } | null> {
  const dir = path.join(PROJECTS_DIR, id);
  try {
    const meta = JSON.parse(
      await readFile(path.join(dir, "meta.json"), "utf-8"),
    ) as {
      name?: string;
      owner?: string;
      deletedAt?: number;
      clips?: { id: string; name: string }[];
    };
    if (meta.deletedAt) return null;
    const lines = [
      `Title: ${meta.name || "Untitled project"}`,
      `Link: /captions?view=projects`,
    ];
    let words = 0;
    for (const clip of meta.clips ?? []) {
      try {
        const data = JSON.parse(
          await readFile(
            path.join(dir, "clips", clip.id, "data.json"),
            "utf-8",
          ),
        ) as {
          words?: { text: string; start: number; end: number }[];
          cues?: { words?: { text: string; start: number; end: number }[] }[];
        };
        const w =
          data.words?.length
            ? data.words
            : (data.cues ?? []).flatMap((c) => c.words ?? []);
        if (!w.length) continue;
        words += w.length;
        lines.push(`Clip: ${clip.name || clip.id}`, timedTranscript(w));
      } catch {
        /* skip clip */
      }
    }
    if (!words) return null;
    return {
      name: meta.name || "Untitled project",
      pack: lines.join("\n"),
      owner: meta.owner,
    };
  } catch {
    return null;
  }
}

async function resolveSource(
  src: DocSource,
  user: SessionUser,
): Promise<DocSource & { pack: string }> {
  if (!okId(src.id)) throw new Error("Invalid source");
  const packed =
    src.type === "clip" ? await packClip(src.id) : await packCaption(src.id);
  if (!packed) {
    throw new Error(
      src.type === "clip"
        ? "That clip has no transcript to write from"
        : "That caption project has no transcript to write from",
    );
  }
  if (!ownsSource(packed.owner, user)) {
    throw new Error("You can only use your own media");
  }
  const note = typeof src.note === "string" ? src.note.trim().slice(0, 400) : "";
  return {
    type: src.type,
    id: src.id,
    name: (src.name || packed.name).slice(0, 120),
    ...(note ? { note } : {}),
    pack: packed.pack,
  };
}

function parseSources(raw: unknown): DocSource[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error("Pick at least one clip or caption project");
  }
  if (raw.length > MAX_SOURCES) {
    throw new Error(`At most ${MAX_SOURCES} sources`);
  }
  const out: DocSource[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const rec = it as { type?: unknown; id?: unknown; name?: unknown; note?: unknown };
    if (rec.type !== "clip" && rec.type !== "caption") continue;
    if (typeof rec.id !== "string" || !okId(rec.id)) continue;
    const note =
      typeof rec.note === "string" ? rec.note.trim().slice(0, 400) : "";
    out.push({
      type: rec.type,
      id: rec.id,
      name: typeof rec.name === "string" ? rec.name.trim().slice(0, 120) : rec.id,
      ...(note ? { note } : {}),
    });
  }
  if (!out.length) throw new Error("Pick at least one clip or caption project");
  return out;
}

async function generateBody(
  prompt: string,
  resolved: (DocSource & { pack: string })[],
  owner: string | undefined,
): Promise<string> {
  const user = [
    prompt.trim() ? `Author brief:\n${prompt.trim().slice(0, 4000)}` : "",
    ...resolved.map((s, i) => {
      const href = s.type === "clip" ? `/clips/${s.id}` : `/captions?view=projects`;
      return [
        `Source ${i + 1} (${s.type}, use in this order): [${s.name}](${href})`,
        s.note ? `How to use this source: ${s.note}` : "",
        s.pack,
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ]
    .filter(Boolean)
    .join("\n\n");

  return completeWithFallback(
    `You write a finished document from ordered media sources (screen recordings and captioned videos). It should read like something someone would send as a Google Doc — a title, sections, the videos in place, and prose a client can share. Not notes, not JSON.
Rules:
- Return markdown only. Never JSON. Never wrap in {"markdown":...}. Never use a markdown fence.
- Respect source order and any per-source notes and the author brief.
- Only use facts present in the sources. Do not invent.
- Put each source video on its own line as a markdown link using the Link: path (e.g. [Title](/clips/<id>)), then write the section under it.
- Start with a single # title, then ## sections. Use lists where they help.`,
    user,
    undefined,
    parseDocumentMarkdown,
    aiFor(owner, "notes", "Documents"),
  );
}

async function captionHasText(id: string, clips: { id: string }[]): Promise<boolean> {
  for (const clip of clips) {
    try {
      const data = JSON.parse(
        await readFile(
          path.join(PROJECTS_DIR, id, "clips", clip.id, "data.json"),
          "utf-8",
        ),
      ) as { words?: unknown[]; cues?: { words?: unknown[] }[] };
      if (data.words?.length) return true;
      if (data.cues?.some((c) => c.words?.length)) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

documentsApp.get("/availability", (c) =>
  c.json({ ai: anyAiConfigured(c.get("user")) }),
);

documentsApp.get("/media", async (c) => {
  const user = c.get("user");
  const clips: {
    id: string;
    name: string;
    duration: number;
    hasTranscript: boolean;
    hasThumb: boolean;
    createdAt: number;
  }[] = [];
  try {
    const ids = (await readdir(CLIPS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
    for (const id of ids) {
      try {
        const meta = JSON.parse(
          await readFile(path.join(CLIPS_DIR, id, "meta.json"), "utf-8"),
        ) as {
          name?: string;
          owner?: string;
          duration?: number;
          createdAt?: number;
        };
        if (!ownsSource(meta.owner, user)) continue;
        clips.push({
          id,
          name: meta.name || "Untitled clip",
          duration: meta.duration || 0,
          hasTranscript: existsSync(path.join(CLIPS_DIR, id, "transcript.json")),
          hasThumb: existsSync(path.join(CLIPS_DIR, id, "thumb.jpg")),
          createdAt: meta.createdAt || 0,
        });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no clips dir */
  }
  clips.sort((a, b) => b.createdAt - a.createdAt);

  const captions: {
    id: string;
    name: string;
    duration: number;
    clipCount: number;
    hasText: boolean;
    thumbClipId: string | null;
    updatedAt: number;
  }[] = [];
  try {
    const ids = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
    for (const id of ids) {
      try {
        const meta = JSON.parse(
          await readFile(path.join(PROJECTS_DIR, id, "meta.json"), "utf-8"),
        ) as {
          name?: string;
          owner?: string;
          duration?: number;
          updatedAt?: number;
          deletedAt?: number;
          incompleteRecovery?: boolean;
          clips?: { id: string }[];
        };
        if (meta.deletedAt || meta.incompleteRecovery) continue;
        if (!ownsSource(meta.owner, user)) continue;
        const list = meta.clips ?? [];
        captions.push({
          id,
          name: meta.name || "Untitled project",
          duration: meta.duration || 0,
          clipCount: list.length,
          hasText: await captionHasText(id, list),
          thumbClipId: list[0]?.id ?? null,
          updatedAt: meta.updatedAt || 0,
        });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no projects dir */
  }
  captions.sort((a, b) => b.updatedAt - a.updatedAt);

  return c.json({ clips, captions });
});

documentsApp.get("/", async (c) => {
  const user = c.get("user");
  let ids: string[] = [];
  try {
    ids = (await readdir(DOCS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(okId);
  } catch {
    return c.json([]);
  }
  const metas = (await Promise.all(ids.map(readMeta))).filter(
    (m): m is Meta =>
      !!m && (m.owner === user.username || (user.role === "admin" && !m.owner)),
  );
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(metas.map((m) => ({ ...m, kind: parseDocKind(m.kind) })));
});

documentsApp.post("/", async (c) => {
  const user = c.get("user");
  if (!anyAiConfigured(user)) {
    return c.json({ error: "AI is not configured" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as {
    prompt?: unknown;
    sources?: unknown;
    kind?: unknown;
  } | null;
  let sources: DocSource[];
  try {
    sources = parseSources(body?.sources);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const kind = parseDocKind(body?.kind);
  if (kind === "guide") {
    try {
      assertGuideSources(sources);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
  let resolved: (DocSource & { pack: string })[];
  try {
    resolved = await Promise.all(sources.map((s) => resolveSource(s, user)));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const id = randomUUID();
  const meta: Meta = {
    id,
    name: kind === "guide" ? "Untitled guide" : "Untitled document",
    owner: user.username,
    kind,
    prompt,
    sources: resolved.map(({ pack: _p, ...s }) => s),
    published: false,
    status: "ready",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    const md =
      kind === "guide"
        ? (await runGuideGenerate(meta, resolved, user.username)).markdown
        : await generateBody(prompt, resolved, user.username);
    meta.name = titleFromBody(md, meta.name);
    await persist(meta);
    if (kind !== "guide") await writeBody(id, md);
    return c.json(await publicDoc(meta, md));
  } catch (e) {
    meta.status = "error";
    meta.error = e instanceof Error ? e.message : String(e);
    await persist(meta);
    await writeBody(id, "");
    return c.json(await publicDoc(meta, ""));
  }
});

documentsApp.get("/:id/assets/:file", async (c) => {
  const id = c.req.param("id");
  const file = path.basename(c.req.param("file") || "");
  if (!isGuideAssetName(file)) return c.json({ error: "Not found" }, 404);
  const meta = await readMeta(id);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const user = c.get("user");
  const allowed =
    meta.published ||
    (user && user.role !== "guest" && canSee(meta, user));
  if (!allowed) return c.json({ error: "Not found" }, 404);
  const dir = path.resolve(assetsDir(id));
  const full = path.resolve(dir, file);
  if (!full.startsWith(dir + path.sep)) return c.json({ error: "Not found" }, 404);
  if (!existsSync(full)) return c.json({ error: "Not found" }, 404);
  const st = await stat(full);
  return new Response(
    Readable.toWeb(createReadStream(full)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(st.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": meta.published
          ? "private, max-age=3600"
          : "private, no-store",
      },
    },
  );
});

documentsApp.get("/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await readMeta(id);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const user = c.get("user");
  const allowed =
    meta.published ||
    (user && user.role !== "guest" && canSee(meta, user));
  if (!allowed) return c.json({ error: "Not found" }, 404);
  const body = await readBody(id);
  if (meta.name === "Untitled document" || meta.name === "Untitled guide") {
    const name = titleFromBody(body, meta.name);
    if (name !== meta.name) {
      meta.name = name;
      await persist(meta);
    }
  }
  return c.json(await publicDoc(meta, body));
});

documentsApp.patch("/:id", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    body?: unknown;
    prompt?: unknown;
    sources?: unknown;
    published?: unknown;
    kind?: unknown;
    guide?: unknown;
  } | null;
  if (typeof body?.name === "string" && body.name.trim()) {
    meta.name = body.name.trim().slice(0, 120);
  }
  if (typeof body?.prompt === "string") {
    meta.prompt = body.prompt.trim().slice(0, 4000);
  }
  if (typeof body?.published === "boolean") {
    meta.published = body.published;
  }
  if (body?.kind === "guide" || body?.kind === "brief") {
    meta.kind = body.kind;
  }
  if (body?.sources !== undefined) {
    try {
      const sources = parseSources(body.sources);
      if (parseDocKind(meta.kind) === "guide") assertGuideSources(sources);
      meta.sources = sources;
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  const isGuide = parseDocKind(meta.kind) === "guide";
  if (isGuide && body?.guide !== undefined) {
    const current = await readGuide(meta.id);
    if (!current) return c.json({ error: "Guide is not ready yet" }, 400);
    const next = mergeGuideEdits(current, body.guide);
    await writeGuide(meta.id, next);
    await writeBody(meta.id, guideToMarkdown(meta.name, next));
  } else if (!isGuide && typeof body?.body === "string") {
    await writeBody(meta.id, body.body.slice(0, 200_000));
  } else if (typeof body?.name === "string" && body.name.trim()) {
    if (isGuide) {
      const g = await readGuide(meta.id);
      if (g) await writeBody(meta.id, guideToMarkdown(meta.name, g));
    } else {
      const { rest } = splitDocumentTitle(await readBody(meta.id));
      await writeBody(meta.id, withDocumentTitle(rest, meta.name));
    }
  }
  await persist(meta);
  return c.json(await publicDoc(meta));
});

documentsApp.post("/:id/generate", async (c) => {
  const user = c.get("user");
  const meta = await ownedMeta(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!anyAiConfigured(user)) {
    return c.json({ error: "AI is not configured" }, 400);
  }
  const kind = parseDocKind(meta.kind);
  let resolved: (DocSource & { pack: string })[];
  try {
    if (kind === "guide") assertGuideSources(meta.sources);
    resolved = await Promise.all(
      meta.sources.map((s) => resolveSource(s, user)),
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  try {
    const md =
      kind === "guide"
        ? (await runGuideGenerate(meta, resolved, user.username)).markdown
        : await generateBody(meta.prompt, resolved, user.username);
    meta.name = titleFromBody(md, meta.name);
    meta.status = "ready";
    meta.error = undefined;
    await persist(meta);
    if (kind !== "guide") await writeBody(meta.id, md);
    return c.json(await publicDoc(meta, md));
  } catch (e) {
    meta.status = "error";
    meta.error = e instanceof Error ? e.message : String(e);
    await persist(meta);
    const status = e instanceof AiProviderError ? 502 : 400;
    return c.json(
      { ...(await publicDoc(meta)), error: meta.error },
      status,
    );
  }
});

documentsApp.delete("/:id", async (c) => {
  const meta = await ownedMeta(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  await rm(docDir(meta.id), { recursive: true, force: true });
  return c.json({ ok: true });
});
