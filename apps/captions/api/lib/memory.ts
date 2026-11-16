import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env";
import { getWorkspace } from "./workshop/workspace";
import type { SessionUser } from "../users";
import { MEMORY_CAP, MEMORY_QUOTE_MAX, MEMORY_RULE_MAX, MEMORY_QUOTE_MIN, even, foundIn, tidy, type MemoryFact } from "../../contracts/memory";

/**
 * What the assistant keeps from one chat to the next: one file per account, $DATA_DIR/memory/<user>.json (0600).
 *
 * ONLY THE ASSISTANT'S DOCK READS THIS. memoryBlock() is for api/assistant.ts's turn and nothing else: never the
 * Workshop's writer, the AI Editor, captions, a scheduled run or any other job (memory.test.ts checks who imports
 * this file). Those jobs' prompts are not this feature's to change.
 *
 * A fact gets in one way, keep(): its quote must stand in something the person typed themselves in that chat. What
 * is kept is the rule the assistant writes from it (one plain sentence: what the prompt and Settings show), with
 * their wording beside it (`said`). A fact kept before rules were written has only their wording. The store has a fixed size
 * (MEMORY_CAP): when it is full keep() refuses, and nothing is dropped to make room.
 */

interface Kept {
  id: string;
  /** The rule: what the prompt gets. */
  text: string;
  /** The person's own words it was written from; none = `text` is their words. */
  said?: string;
  at: number;
  /** The Workshop project it was said for; none = about the person. */
  project?: string;
  /** The message it was said in. */
  from: string;
}
/** A removed fact: its wording (evened), the message it came from, and when it went. */
interface Removed {
  text: string;
  from: string;
  at: number;
}
interface Store {
  facts: Kept[];
  removed: Removed[];
}

/** Something the person typed in a chat (api/assistant.ts saidInChat). */
export interface Said {
  id: string;
  text: string;
  at: number;
}

// ponytail: the newest 100 removals are remembered; past that the oldest could be kept again from its old message,
// which by then sits far outside the 20 messages a chat's prompt carries
const REMOVED_KEPT = 100;

const fileOf = (username: string) => path.join(env.dataDir, "memory", `${username}.json`);

function read(username: string): Store {
  try {
    const s = JSON.parse(readFileSync(fileOf(username), "utf-8")) as Partial<Store>;
    return { facts: s.facts ?? [], removed: s.removed ?? [] };
  } catch {
    return { facts: [], removed: [] };
  }
}

function write(username: string, store: Store): void {
  const file = fileOf(username);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  renameSync(tmp, file);
}

/** A fact as its line in the prompt, and what it counts toward the cap (the line and its line end). */
const lineOf = (f: Pick<Kept, "text">) => `- ${f.text}`;
const sizeOf = (facts: Array<Pick<Kept, "text">>) => facts.reduce((n, f) => n + lineOf(f).length + 1, 0);

export { foundIn };

const FULL = "Memory is full, so this was not kept. Tell the user: they can remove something in Settings, Memory, and then say it again.";

export type KeepResult = { fact: Kept; added: boolean } | { error: string };

/**
 * Keep what the person said. `said` is what they typed in this chat, newest first: the quote must stand in one of
 * those, and their wording is what is kept. A fact they removed is not kept again from a message they had already
 * sent by then, and never from the message it came from. The same wording twice is kept once.
 */
export function keep(username: string, quote: unknown, said: Said[], project?: string, rule?: unknown): KeepResult {
  const q = typeof quote === "string" ? tidy(quote) : "";
  if (q.length < MEMORY_QUOTE_MIN) return { error: "Give the user's own words as the quote: a whole sentence of theirs, or nothing." };
  if (q.length > MEMORY_QUOTE_MAX) return { error: `Keep one short thing: a quote of up to ${MEMORY_QUOTE_MAX} characters.` };
  const r = typeof rule === "string" && rule.trim() ? tidy(rule) : undefined;
  if (r && (r.length < MEMORY_QUOTE_MIN || r.length > MEMORY_RULE_MAX)) return { error: `Write the rule as one sentence of up to ${MEMORY_RULE_MAX} characters.` };
  const store = read(username);
  // rewording a kept fact: the quote stands in the words it was kept from (checked when it was kept)
  const old = r && store.facts.find((f) => (!f.project || f.project === project) && foundIn(q, f.said ?? f.text));
  if (old) {
    const next = { ...old, text: r, said: old.said ?? old.text };
    if (sizeOf(store.facts.map((f) => (f === old ? next : f))) > MEMORY_CAP) return { error: FULL };
    store.facts = store.facts.map((f) => (f === old ? next : f));
    write(username, store);
    return { fact: next, added: false };
  }
  let wasRemoved = false;
  for (const msg of said) {
    const text = foundIn(q, msg.text);
    if (!text) continue;
    const key = even(text);
    if (store.removed.some((r) => r.from === msg.id || (msg.at <= r.at && (key.includes(r.text) || r.text.includes(key))))) {
      wasRemoved = true;
      continue;
    }
    const same = store.facts.find((f) => even(f.said ?? f.text) === key && (!f.project || f.project === project));
    if (same) return { fact: same, added: false };
    const fact: Kept = { id: randomUUID(), text: r ?? text, ...(r ? { said: text } : {}), at: Date.now(), ...(project ? { project } : {}), from: msg.id };
    if (sizeOf(store.facts) + sizeOf([fact]) > MEMORY_CAP) return { error: FULL };
    store.facts.push(fact);
    write(username, store);
    return { fact, added: true };
  }
  return {
    error: wasRemoved
      ? "The user removed that from memory. It is kept again only when they say it again."
      : "Not kept: those are not the user's own words in this chat. Quote what they wrote themselves, or keep nothing.",
  };
}

/** Remove a fact for good; false when the account has none by that id. */
export function remove(username: string, id: string): boolean {
  const store = read(username);
  const gone = store.facts.find((f) => f.id === id);
  if (!gone) return false;
  store.facts = store.facts.filter((f) => f !== gone);
  store.removed = [...store.removed, { text: even(gone.said ?? gone.text), from: gone.from, at: Date.now() }].slice(-REMOVED_KEPT);
  write(username, store);
  return true;
}

/**
 * Everything the account has kept, newest first, each with its project's name (Settings → Memory). `here`: only what
 * a chat's prompt holds now, the facts about the person and the current project's (the assistant's forget tool).
 */
export async function listMemory(user: SessionUser, here = false): Promise<MemoryFact[]> {
  const { facts } = read(user.username);
  const ws = facts.some((f) => f.project) ? await getWorkspace(user) : null;
  const projects = ws?.projects ?? [];
  // Settings → Memory: the facts about the person and this workspace's (one kept for a deleted workspace is the first brand's)
  // imported when used: project-of.ts reads the Analyzer, which this small store must not load with it
  const inWs = ws && !here ? await (await import("./workspace-scope")).inCurrentWorkspace(user) : null;
  return facts
    .filter((f) => !f.project || (here ? f.project === ws?.currentProjectId : !inWs || inWs(f.project)))
    .map(({ id, text, said, at, project }) => ({ id, text, ...(said ? { said } : {}), at, ...(project ? { project: { id: project, name: projects.find((p) => p.id === project)?.name ?? "A workspace that is gone" } } : {}) }))
    .reverse();
}

/** The project the app is in for this account, or none. */
export const currentProject = async (user: SessionUser) => {
  const ws = await getWorkspace(user);
  return ws.projects.find((p) => p.id === ws.currentProjectId);
};

const HEAD = "Standing rules from the user's earlier chats; follow them (their list: Settings, Memory):";
const forProject = (name: string) => `Only for their current workspace, ${JSON.stringify(name.replace(/\s+/g, " ").trim().slice(0, 60))}:`;
/** The longest the block can ever be: its two headings and a full store. */
export const MEMORY_BLOCK_MAX = 2 + HEAD.length + 1 + forProject("x".repeat(60)).length + 1 + MEMORY_CAP;

/**
 * What a dock turn's prompt gets (see the top of this file: the dock only): the facts about the person, then the
 * current project's; never another project's. "" when there is nothing to say, and then the prompt is exactly what
 * it was before this feature. Never throws: a turn runs without it rather than not at all.
 */
export async function memoryBlock(user: SessionUser): Promise<string> {
  try {
    const { facts } = read(user.username);
    if (!facts.length) return "";
    const project = facts.some((f) => f.project) ? await currentProject(user) : undefined;
    const mine = facts.filter((f) => !f.project);
    const here = project ? facts.filter((f) => f.project === project.id) : [];
    if (!mine.length && !here.length) return "";
    return `\n\n${[HEAD, ...mine.map(lineOf), ...(here.length ? [forProject(project!.name), ...here.map(lineOf)] : [])].join("\n")}`;
  } catch {
    return "";
  }
}
