// The pure parts of the plugin: no Obsidian or Node APIs, so node:test can run them directly.

/** Statuses that go to the site on their own (the site creates a session for them). Others only once linked. */
export const SYNC_STATUSES = new Set(["🎥 Filming", "✂️ Editing", "👍 Ready"]);

export type NoteKeys = { status: string; media: string };

/** The status, media and details of a note, read from its frontmatter (the keys can be literal dotted names). */
export function readNote(fm: Record<string, unknown> | undefined, keys: NoteKeys) {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return {
    status: text(fm?.[keys.status]) || undefined,
    media: text(fm?.[keys.media]) || undefined,
    details: text(fm?.details) || undefined,
  };
}

/** Is the note inside the watched folder (any depth)? */
export function inFolder(path: string, folder: string): boolean {
  const dir = folder.replace(/^\/+|\/+$/g, "");
  return dir !== "" && path.startsWith(dir + "/");
}

/** Does this note go to the site: its status syncs by itself, or it is already linked to a session. */
export function isSynced(status: string | undefined, linked: boolean): boolean {
  return linked || (status !== undefined && SYNC_STATUSES.has(status));
}

/**
 * Last change wins: the site's status comes back to the note only when the site changed it after the note's
 * last edit. Otherwise the note stays as it is, and the next push sends the note's status to the site.
 */
export function shouldWriteBack(note: { status?: string; mtime: number }, remote: { status: string; statusAt: number }): boolean {
  return remote.status !== note.status && remote.statusAt > note.mtime;
}

/** Local calendar day as YYYY-MM-DD (the `change` property). */
export function ymd(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A vault path for a file the site sends: relative, no "..", no hidden folders (.obsidian, .trash), characters
 * the file systems refuse become "-", and it always ends in .md. Null = refuse to write it.
 */
export function safeVaultPath(input: string): string | null {
  const parts = input
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..") || parts[0].startsWith(".")) return null;
  const clean = parts.map((part) => part.replace(/[\u0000-\u001f*"\\/<>:|?]/g, "-"));
  const last = clean.length - 1;
  if (!/\.md$/i.test(clean[last])) clean[last] += ".md";
  return clean.join("/");
}

/** "Folder/Name.md" → "Folder/Name (2).md" for the second copy of a file that was changed by hand. */
export function copyName(path: string, n: number): string {
  return path.replace(/\.md$/, ` (${n}).md`);
}
