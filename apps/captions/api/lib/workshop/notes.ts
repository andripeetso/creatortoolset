import { randomUUID } from "node:crypto";
import type { DraftKind, SessionStatus } from "./types";
import { blocksFromMarkdown } from "./doc";
import { okId } from "./validate";
import { OBSIDIAN_TEMPLATE } from "../../../src/lib/workshop-markdown";

/** Obsidian sync and custom exports: the pure parts (the routes are in api/workshop.ts). */

/** A note with one of these statuses makes its session without a click; any other needs "send" (the plugin's button). */
export const SYNCED_STATUSES: SessionStatus[] = ["ready", "production", "editing"];

export interface WorkshopExport {
  id: string;
  name: string;
  /** "download": the file comes back to the browser. "plugin": queued for the Obsidian plugin to write into the vault. */
  target: "download" | "plugin";
  /** Vault-relative folder ("" = the vault root). */
  folder: string;
  /** File name pattern, placeholders allowed; no folder in it. */
  filename: string;
  template: string;
}

/** The built-in download: the Obsidian note as it always was (obsidian.md). Always listed first, never stored. */
export const BUILTIN_EXPORT: WorkshopExport = { id: "obsidian", name: "Obsidian Markdown", target: "download", folder: "", filename: "{{title}}.md", template: OBSIDIAN_TEMPLATE };

export const MAX_EXPORTS = 20;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** What the account sees: the built-in, then its own. */
export const listExports = (stored: WorkshopExport[]): WorkshopExport[] => [BUILTIN_EXPORT, ...stored.filter((e) => e.id !== BUILTIN_EXPORT.id)];

/** The Settings list, checked. The built-in is never stored; a missing id gets a new one. */
export function parseExports(raw: unknown): WorkshopExport[] {
  if (!Array.isArray(raw)) throw new Error("Exports must be a list");
  const items = raw.filter((i) => !(i && typeof i === "object" && (i as Record<string, unknown>).id === BUILTIN_EXPORT.id));
  if (items.length > MAX_EXPORTS) throw new Error(`An account keeps at most ${MAX_EXPORTS} exports`);
  const ids = new Set<string>();
  return items.map((item) => {
    const r = item as Record<string, unknown>;
    const name = str(r.name, 80);
    if (!name) throw new Error("Name each export");
    if (r.target !== "download" && r.target !== "plugin") throw new Error("An export is a download or a plugin");
    const folder = str(r.folder, 200)
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (folder.some((s) => s === "." || s === "..")) throw new Error("A folder stays inside the vault");
    const filename = str(r.filename, 200) || "{{title}}.md";
    if (/[/\\]/.test(filename)) throw new Error("The file name cannot hold a folder: put the folder in Folder");
    let id = typeof r.id === "string" && okId(r.id) ? r.id : randomUUID();
    if (ids.has(id)) id = randomUUID();
    ids.add(id);
    const template = typeof r.template === "string" && r.template.trim() ? r.template.slice(0, 20_000) : OBSIDIAN_TEMPLATE;
    return { id, name, target: r.target, folder: folder.join("/"), filename, template };
  });
}

/** `{{name}}` filled from `vars`; a placeholder with no value stays as written, so a typo shows. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : all));
}

/** The file name an export gives a piece: its pattern filled in, `/ \ :` kept out, `.md` added. */
export function exportFile(exp: Pick<WorkshopExport, "filename">, vars: Record<string, string>): string {
  const name = renderTemplate(exp.filename, vars).replace(/[/\\:]/g, "-").trim() || vars.title || "Untitled";
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

/** A queued plugin file: where it goes in the vault and what it says. */
export interface PendingExport {
  id: string;
  exportId: string;
  path: string;
  markdown: string;
  sessionId: string;
}

/**
 * The Workshop piece a note becomes, from its text (frontmatter dropped) and its selector.Media: 🎞️ Reel is a reel (its
 * leading `// hook` lines are hooks, the rest the script), 🎪 Carousel a carousel (slides apart by `---`), anything else a
 * free piece (paragraphs). `blocks` are the texts as they go in.
 */
export function pieceFromNote(markdown: string, media: string): { kind: DraftKind; hooks: string[]; blocks: string[] } {
  const kind: DraftKind = /reel/i.test(media) ? "reel" : /carousel/i.test(media) ? "carousel" : "free";
  const body = markdown.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (kind === "carousel") return { kind, hooks: [], blocks: body.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean) };
  if (kind === "free") return { kind, hooks: [], blocks: blocksFromMarkdown(body) };
  const [first = "", ...rest] = body.split(/\n\s*\n/);
  const hooked = first.startsWith("// ") && first.split("\n").every((l) => l.startsWith("// "));
  const hooks = hooked ? first.split("\n").map((l) => l.slice(3).trim()).filter(Boolean) : [];
  const script = (hooked ? rest : [first, ...rest]).join("\n\n").trim();
  return { kind, hooks, blocks: script ? [script] : [] };
}
