import type { SharedSkill, Skill, SkillDraft, SkillPlace } from "@contracts/skills";

/** Community → Skills: the page's calls to /api/skills (api/skills.ts). A refusal's own words are the error. */
async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/skills${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!r) throw new Error("Can't reach the server");
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Failed (${r.status})`);
  return data;
}

/** The person's own skills, and the ones their packs and the server's plug-ins bring. */
export const listSkills = () => call<{ skills: Skill[]; shared?: SharedSkill[] }>("");
export const addSkill = (draft: SkillDraft & { place: SkillPlace }) => call<Skill>("", "POST", draft);
/** `projectIds: null` = every project. */
export const updateSkill = (id: string, patch: Partial<SkillDraft> & { on?: boolean; projectIds?: string[] | null }) => call<Skill>(`/${encodeURIComponent(id)}`, "PATCH", patch);
export const removeSkill = (id: string) => call<{ ok: true }>(`/${encodeURIComponent(id)}`, "DELETE");
export const setSharedOn = (id: string, on: boolean) => call<SharedSkill>(`/shared/${encodeURIComponent(id)}`, "PATCH", { on });

/** A dropped item as the browser hands it over: a file, or a folder to look through. */
type Entry = { isFile: boolean; isDirectory: boolean; fullPath: string; file?: (ok: (f: File) => void, no: (e: unknown) => void) => void; createReader?: () => { readEntries: (ok: (list: Entry[]) => void, no: (e: unknown) => void) => void } };

/** Every file under a dropped folder, by path. Only names are read here: at most 500, and no file is opened. */
async function filesUnder(root: Entry): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const queue = [root];
  while (queue.length && out.size < 500) {
    const dir = queue.shift()!;
    const reader = dir.createReader!();
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) break;
      for (const e of batch) {
        if (e.isDirectory) queue.push(e);
        else if (e.isFile) out.set(e.fullPath.replace(/^\//, ""), e);
      }
    }
  }
  return out;
}

/**
 * The one file a drop means, or null when it holds no skill: a dropped file is itself; of a dropped folder only the
 * skill's own text file (`pick`, contracts/skills.ts pickSkillFile) is opened, and nothing else in it is read.
 */
export async function droppedSkillFile(data: DataTransfer, pick: (paths: string[]) => string | null): Promise<File | null> {
  const item = data.items?.[0];
  const entry = (item as unknown as { webkitGetAsEntry?: () => Entry | null } | undefined)?.webkitGetAsEntry?.() ?? null;
  if (!entry?.isDirectory) return data.files[0] ?? null;
  const files = await filesUnder(entry);
  const picked = pick([...files.keys()]);
  const chosen = picked ? files.get(picked) : undefined;
  return chosen?.file ? new Promise<File>((ok, no) => chosen.file!(ok, no)) : null;
}
