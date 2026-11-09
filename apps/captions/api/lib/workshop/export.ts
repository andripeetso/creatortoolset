import type { DocKind, DraftKind, DraftMeta, Document, ImageRef, SessionMeta, SessionStatus } from "./types";
import { PICTURE_TOKEN, carouselObsidianMarkdown, frontmatterBlock, obsidianFilename, pictureIds, reelObsidianMarkdown } from "../../../src/lib/workshop-markdown";
import { PICTURE_EXT } from "./pictures";

/**
 * The note's frontmatter: the vault's property names, the values the media property takes, and the lines in their order.
 * The public default is generic; a plug-in sets its vault's format through setObsidianFormat.
 */
export interface ObsidianFormat {
  /** The media property's value for each kind of piece. */
  media: Record<"reel" | "carousel", string>;
  /** A piece's frontmatter lines in order, [property, value]; "" writes the property alone. `media` is the value for its kind. */
  frontmatter: (piece: { kind: "reel" | "carousel"; day: string; status: string; media: string }) => Array<[string, string]>;
}

const GENERIC_FORMAT: ObsidianFormat = {
  media: { reel: "reel", carousel: "carousel" },
  frontmatter: ({ day, status, media }) => [
    ["change", day],
    ["status", status],
    ["media", media],
  ],
};

let format: ObsidianFormat = GENERIC_FORMAT;

/** The hook a plug-in uses to set the frontmatter its vault reads. `null` puts the generic format back. */
export function setObsidianFormat(next: ObsidianFormat | null): void {
  format = next ?? GENERIC_FORMAT;
}

/** The public default: each Workshop status under its plain name. Missing = draft. */
const GENERIC_STATUS: Record<string, string> = {
  draft: "Idea",
  writing: "Writing",
  ready: "Ready",
  production: "Filming",
  editing: "Editing",
  toPost: "Ready to post",
  published: "Published",
  shelved: "Shelved",
};

let statusLabels = new Map(Object.entries(GENERIC_STATUS));

/**
 * The hook a plug-in uses to set the Obsidian status values its vault reads (a status property list, say): one label per
 * Workshop status it names, the rest keep their generic label. `null` puts the generic labels back.
 */
export function setObsidianStatusLabels(labels: Record<string, string> | null): void {
  statusLabels = new Map(Object.entries(labels ? { ...GENERIC_STATUS, ...labels } : GENERIC_STATUS));
}

export function obsidianStatus(status: string | undefined): string {
  return statusLabels.get(status ?? "draft") ?? statusLabels.get("draft")!;
}

/** A note's status value back to the Workshop's status; undefined for a value the Workshop has no word for. */
export function sessionStatusOf(obsidian: string): SessionStatus | undefined {
  for (const [status, value] of statusLabels) if (value === obsidian) return status as SessionStatus;
  return undefined;
}

/**
 * The session's first reel with script text, as an Obsidian note; null when there is none.
 * `types` = the stored type of each picture id (missing = the picture is gone). Each picture in
 * the note becomes `![[<title> n.ext]]` where its token stood, numbered in order; `pictures`
 * lists the files to put in the zip beside the note (none = a plain note).
 */
type ObsidianNote = { filename: string; markdown: string; pictures: Array<{ id: string; file: string; type: ImageRef["type"] }> };

/**
 * The session's pieces as the author's Obsidian notes, one file each: the first reel
 * and the first carousel with words. One piece: `<title>.md`. Both: `<title>-Reel.md` and `<title>-Carousel.md`.
 */
export function obsidianExports(
  session: Pick<SessionMeta, "title" | "status">,
  docs: Document[],
  day: string,
  types: Map<string, ImageRef["type"]> = new Map(),
): ObsidianNote[] {
  return obsidianPieces(session, docs, day, types).map(({ filename, markdown, pictures }) => ({ filename, markdown, pictures }));
}

/** A piece as its note, plus what a custom export's template can name: its kind, its media value, post description and body (no frontmatter). */
export type ObsidianPiece = ObsidianNote & { kind: "reel" | "carousel"; media: string; caption: string; body: string; frontmatter: string };

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

export function obsidianPieces(
  session: Pick<SessionMeta, "title" | "status">,
  docs: Document[],
  day: string,
  types: Map<string, ImageRef["type"]> = new Map(),
): ObsidianPiece[] {
  const worded = (kind: Document["kind"]) => docs.find((d) => d.kind === kind && d.blocks.some((b) => b.text.trim()));
  const pieces = [worded("reel"), worded("carousel")].filter((d): d is Document => !!d);
  const base = obsidianFilename(session.title).replace(/\.md$/, "");
  return pieces.map((doc) => {
    const stem = pieces.length > 1 ? `${base}-${doc.kind === "reel" ? "Reel" : "Carousel"}` : base;
    const hooks = doc.kind === "reel" ? (doc.hooks ?? []).map((h) => h.text) : [];
    const texts = doc.blocks.map((b) => b.text);
    const pictures: ObsidianNote["pictures"] = [];
    const embed = new Map<string, string>();
    for (const id of [...hooks, ...texts].flatMap(pictureIds)) {
      const type = types.get(id);
      if (!type || embed.has(id)) continue;
      const file = `${stem} ${pictures.length + 1}.${PICTURE_EXT[type]}`;
      pictures.push({ id, file, type });
      embed.set(id, file);
    }
    // a picture that is gone leaves nothing behind
    const swap = (text: string) => text.replace(PICTURE_TOKEN, (_all, _alt: string, id: string) => (embed.has(id) ? `![[${embed.get(id)}]]` : ""));
    const kind = doc.kind as "reel" | "carousel";
    const media = format.media[kind];
    const head = frontmatterBlock(format.frontmatter({ kind, day, status: obsidianStatus(session.status), media }));
    const blocks = doc.blocks.map((b) => ({ text: swap(b.text) }));
    const markdown =
      kind === "reel"
        ? reelObsidianMarkdown({ head, hooks: doc.hooks ? doc.hooks.map((h) => ({ text: swap(h.text) })) : null, blocks })
        : carouselObsidianMarkdown({ head, blocks });
    return { filename: `${stem}.md`, markdown, pictures, kind, media, caption: doc.caption?.text.trim() ?? "", body: markdown.replace(FRONTMATTER, ""), frontmatter: head };
  });
}

/** The reel's note alone (one-piece sessions name it `<title>.md`). */
export function obsidianReelExport(
  session: Pick<SessionMeta, "title" | "status">,
  docs: Document[],
  day: string,
  types: Map<string, ImageRef["type"]> = new Map(),
): ObsidianNote | null {
  return obsidianExports(session, docs.filter((d) => d.kind === "reel"), day, types)[0] ?? null;
}

/** Content-Disposition with an ASCII fallback and the exact UTF-8 name. */
export function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const KIND_TITLE: Record<Exclude<DocKind, "notes">, string> = {
  reel: "Reel script",
  carousel: "Carousel",
  ad: "Ad copy",
  free: "Draft",
  youtube: "YouTube script",
  newsletter: "Newsletter",
  thread: "X post / thread",
  article: "Article",
};

/** Push every heading one level down so a draft nests under the session. */
export function demoteHeadings(md: string): string {
  return md.replace(/^(#{1,5})(\s)/gm, "#$1$2");
}

export interface ExportSource {
  handle: string;
  kind: string;
  url: string;
  note?: string;
}

export function buildExportMarkdown(
  session: Pick<SessionMeta, "title" | "createdAt">,
  notes: string,
  sources: ExportSource[],
  drafts: Array<{ draft: DraftMeta; markdown: string }>,
): string {
  const lines: string[] = [`# ${session.title || "Workshop session"}`, ""];
  lines.push("## Notes", "", notes.trim() || "_No notes yet._", "");
  lines.push("## Sources", "");
  if (!sources.length) lines.push("_No sources selected._");
  for (const s of sources) {
    lines.push(`- @${s.handle} — ${s.kind} — ${s.url}${s.note ? ` — ${s.note}` : ""}`);
  }
  lines.push("");
  const ready = drafts.filter((d) => d.draft.status === "ready");
  if (ready.length) {
    lines.push("## Drafts", "");
    for (const { draft, markdown } of ready) {
      const when = new Date(draft.finishedAt ?? draft.createdAt).toISOString().slice(0, 10);
      lines.push(`### ${draft.title || "Untitled"} — ${KIND_TITLE[draft.kind]} — ${when}`, "");
      lines.push(demoteHeadings(demoteHeadings(markdown.trim())), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
