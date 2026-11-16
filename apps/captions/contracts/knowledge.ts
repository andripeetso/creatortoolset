/** The account's knowledge (api/lib/workshop/sources.ts): shared by the API and the browser. */

/** What a piece of knowledge is: the AI that reads it picks one, the author can change it. */
export type SourceKind = "book" | "study" | "article" | "course" | "script" | "transcript" | "examples" | "brand" | "notes" | "other";

/** A part of a source by its lines in the text (1-based, inclusive). */
export interface SourceSection {
  title: string;
  from: number;
  to: number;
  about: string;
}

/**
 * One thing in the account's knowledge. Every project reads it unless `projectId` keeps it to one or the project switches it off
 * (`Project.off`). The AI reads it once and files it (kind, what it is, the questions it answers, where its sections
 * are) so a turn pulls the right part when it needs it; the author sees and edits that filing. The text is beside it
 * in sources/<id>.txt.
 */
export interface KnowledgeSource {
  id: string;
  owner: string;
  name: string;
  /** Only this project reads it; missing = every project. */
  projectId?: string;
  chars: number;
  /** queued: waits its turn (one read at a time per account), or for the AI's usage limit to reset (`waitUntil`) */
  status: "new" | "queued" | "reading" | "read" | "failed";
  error?: string;
  /** a usage limit stopped the reads: this one goes on by itself then */
  waitUntil?: number;
  startedAt?: number;
  readAt?: number;
  /** What reading it cost, API-equivalent. */
  readCost?: number;
  kind?: SourceKind;
  title?: string;
  about?: string;
  uses?: string[];
  sections?: SourceSection[];
  createdAt: number;
  updatedAt: number;
}

export const SOURCE_KINDS: Array<{ id: SourceKind; label: string }> = [
  { id: "book", label: "Book" },
  { id: "study", label: "Study / research" },
  { id: "article", label: "Article" },
  { id: "course", label: "Course" },
  { id: "script", label: "Script" },
  { id: "transcript", label: "Transcript" },
  { id: "examples", label: "Examples" },
  { id: "brand", label: "About the brand" },
  { id: "notes", label: "Notes" },
  { id: "other", label: "Other" },
];

/**
 * How much text one workspace's context files may hold: about 1M tokens (4 characters a token), the window of the
 * current Claude models, so everything a workspace knows can still be read in one go. Each file is read once to
 * file it; a turn carries only one line per file and reads the parts it needs.
 */
export const CONTEXT_CAPACITY_CHARS = 4_000_000;
