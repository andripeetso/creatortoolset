import type { AssistantWork } from "../../contracts/assistant";
import type { SessionUser } from "../users";

// The assistant's tools, one file per part of the app (index.ts lists them; api/mcp.ts serves them beside its own).
// A tool is a thin client of the site's own routes, called as the account it runs for, so each route's checks stay
// the only checks. A private plug-in's tools have this same shape (ServerPlugin.tools: defs, handlers, steps, work).

export type Args = Record<string, unknown>;

/**
 * A tool as the AI reads it. The description is sent on every turn: one or two short sentences.
 * dockOnly: only the in-app assistant gets it (it needs the dock: a card, a page to open, a file dropped in the chat).
 */
export type ToolDef = { name: string; description: string; inputSchema: Args; dockOnly?: boolean };

/** A tool's refusal in words the AI can act on ("Give the session's id."): it goes back as the call's error. */
export class ToolError extends Error {}

export type ToolContext = {
  /** The account the call runs as. */
  user: SessionUser;
  /** This server's address, to start the links a tool hands back. */
  origin: string;
  /** One of the site's own routes as the caller. A refusal throws a ToolError with the route's own words; a 404 says "Not found, or not this account's." */
  api: (path: string, method?: string, body?: unknown) => Promise<Response>;
  /** api(), read as JSON. */
  json: <T = Args>(path: string, method?: string, body?: unknown) => Promise<T>;
  /**
   * Call it before a write that deletes, trashes, publishes or sends something to other people, with the question as
   * the person reads it ("Delete the session "Tiny tumbles"?"). In the dock the question becomes a Yes / No card and
   * this throws: the AI is told it was asked, and the same call runs again as the person when they press Yes (then
   * sure() returns). A caller with its own way of asking (an AI key from outside the app) goes straight through.
   * Everything before sure() runs twice on a Yes, so only read before it.
   */
  sure: (question: string) => Promise<void>;
};

export type ToolHandler = (args: Args, ctx: ToolContext) => Promise<unknown>;

/** The card a call leaves under the assistant's reply: the same id updates its card; only = never add one. */
export type WorkCard = { card: AssistantWork; only?: boolean };

export type ToolModule = {
  defs: ToolDef[];
  handlers: Record<string, ToolHandler>;
  /** What each call looks like to the person watching, by tool name ("Reading the comments"). */
  steps?: Record<string, string>;
  /** When a call started or opened something the person can look at: its card (args and the call's answer in). */
  work?: (name: string, args: Args, result: Args) => WorkCard | null;
};

/** The named fields of a row that hold something (no null, "", or empty list). */
export const pick = (row: Args, keys: string[]): Args =>
  Object.fromEntries(keys.filter((k) => row[k] != null && row[k] !== "" && !(Array.isArray(row[k]) && !(row[k] as unknown[]).length)).map((k) => [k, row[k]]));
/** Epoch ms as "2026-11-11 09:30" (UTC), or undefined. */
export const when = (ms: unknown): string | undefined => (typeof ms === "number" && ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : undefined);
/** Seconds as "1:05.00". */
export const clock = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A date the AI gives (ISO, with or without a time) as epoch ms. */
export const dateMs = (v: unknown): number => {
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  if (Number.isNaN(ms)) throw new ToolError(`${String(v)} is not a date: give one like 2026-11-10T00:00:00+02:00.`);
  return ms;
};
export const str = { type: "string" } as const;
