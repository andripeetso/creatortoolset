import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeSource } from "../../../contracts/knowledge";
import { env } from "../env";
import { renderInstructions } from "./prompt";
import { asKnowledge } from "./sources";
import type { KnowledgeFile, Project } from "./types";
import { okId } from "./validate";
import { onFor } from "./workspace";

/**
 * A workspace's context, carried to every AI that works in it (the chat, the Media Library, the AI Editor, a connected
 * AI): its instructions and the context files added to it (the Workshop's Knowledge sources kept to it or to every
 * workspace, minus the ones it switched off), each read and filed once (fileSource, workshop.ts). One-shot calls get
 * workspaceContext: the instructions and what each file is, cut to what the call can carry. An AI with tools reads a
 * file's text itself (the workspace_files tool).
 */

const ROOT = path.join(env.dataDir, "workshop");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** A workspace by its id, whoever owns it; null when there is none. */
export const readWorkspace = (id: string | undefined): Promise<Project | null> =>
  id && okId(id) ? readJson<Project>(path.join(ROOT, "projects", `${id}.json`)) : Promise.resolve(null);

/**
 * The sources a workspace's AI reads: its owner's kept to it or to every workspace, minus the ones it switched off.
 * `all` is the owner's sources when the caller has them (the Workshop's list, which moves old project files in first).
 */
export async function workspaceSources(p: Project, all?: KnowledgeSource[]): Promise<KnowledgeSource[]> {
  if (!all) {
    const dir = path.join(ROOT, "sources");
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    all = (await Promise.all(names.map((n) => readJson<KnowledgeSource>(path.join(dir, n))))).filter((s): s is KnowledgeSource => !!s);
  }
  return onFor(
    all.filter((s) => s.owner === p.owner && (!s.projectId || s.projectId === p.id)).sort((a, b) => a.createdAt - b.createdAt),
    p,
  );
}

/** The workspace's context files with their text, as the Workshop's prompts read them. */
export async function workspaceKnowledge(p: Project, all?: KnowledgeSource[]): Promise<KnowledgeFile[]> {
  const sources = await workspaceSources(p, all);
  const text = (id: string) => readFile(path.join(ROOT, "sources", `${id}.txt`), "utf-8").catch(() => "");
  // a project's files from before Knowledge, not moved in yet (the Workshop moves them on its first list)
  return [...(p.knowledge ?? []), ...(await Promise.all(sources.map(async (s) => asKnowledge(s, await text(s.id)))))];
}

/** One line per context file: its id, what it is and what it answers. */
export function filesIndex(files: Array<Pick<KnowledgeFile, "id" | "name" | "title" | "kind" | "about" | "uses">>): string {
  return files
    .map((f) => {
      const head = `- ${f.title || f.name}${f.kind ? ` (${f.kind})` : ""} [${f.id}]`;
      const about = f.about ? `: ${f.about.replace(/\s+/g, " ").trim()}` : ": not read yet";
      const uses = f.uses?.length ? ` Answers: ${f.uses.join("; ")}` : "";
      return `${head}${about}${uses}`;
    })
    .join("\n");
}

/**
 * What a one-shot AI call is told of the workspace: its instructions, then what each context file is, in `max`
 * characters. The instructions take what they need up to two thirds; the files the rest, whole lines only.
 */
export function renderContext(p: Project, files: KnowledgeFile[], max: number): string {
  const LIST = "\n\nContext files added to the workspace:\n";
  const MARK = "\n…[shortened]";
  const head = renderInstructions(p);
  const room = max - Math.min(head.length, Math.floor((max * 2) / 3)) - LIST.length;
  const lines: string[] = [];
  let used = 0;
  for (const line of filesIndex(files).split("\n")) {
    if (!line || used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  const list = lines.length ? `${LIST}${lines.join("\n")}` : "";
  const cut = max - list.length;
  return `${head.length <= cut ? head : `${head.slice(0, cut - MARK.length).trimEnd()}${MARK}`}${list}`;
}

/** The workspace's context for a one-shot call (above); "" when there is no such workspace. */
export async function workspaceContext(projectId: string | undefined, max: number): Promise<string> {
  const p = await readWorkspace(projectId);
  return p ? renderContext(p, await workspaceKnowledge(p), max) : "";
}

/**
 * Which context a stored text was written under: a short hash of exactly what `workspaceContext(projectId, max)` gives
 * now, plus `salt` (the version of the prompt that wrote it). A library description or shot description keeps the stamp
 * it was written with; when the workspace's instructions or files change what that call reads, the stamp differs and
 * the text is written again the next time an edit or a search uses it (tasks/flywheel/PLAN.md, 6.1). A change past
 * what the call reads (beyond `max`) leaves the stamp alone.
 */
export async function contextStamp(projectId: string | undefined, max: number, salt = ""): Promise<string> {
  const text = await workspaceContext(projectId, max);
  return createHash("sha256").update(`${salt}\n${text}`).digest("hex").slice(0, 16);
}
