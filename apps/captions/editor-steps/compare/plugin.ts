import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { DRIVERS, TOOL_NAMES, type Selection } from "../../contracts/providers";
import type { DraftKind, DraftMeta, SessionMeta } from "../../api/lib/workshop/types";
import type { ProviderOpts } from "../../api/ai-complete";
import { env } from "../../api/lib/env";
import { definePlugin, requireGate } from "../../api/lib/plugin";
import { deviceOf } from "../../api/lib/devices";
import { instanceIn } from "../../api/lib/providers";
import { announce } from "../../api/lib/sync";
import { inJob } from "../../api/lib/workshop/job";
import { writeJsonAtomic } from "../../api/library/media/run";
import { bumpUsage, type SessionUser } from "../../api/users";
import { addDraft, draftFrom, draftRequest, ownedSession, workshopAi, type DraftAnswer } from "../../api/workshop";

// Compare: Generate draft's own request (draftRequest in api/workshop.ts) sent to two of the person's AIs at once, shown
// as A and B in a random order with no AI named, until they pick one (it becomes the session's draft: addDraft) or
// neither. Each account's compares and picks are one file under the plug-in's data folder.

/** The picks kept per account, newest first: the counts in Settings are theirs. */
export const PICKS_MAX = 500;
/** The compares kept per account, one per session (a new one replaces that session's last). */
export const COMPARES_MAX = 10;

type Status = "writing" | "ready" | "error";
interface Side {
  ai: Selection;
  name: string;
  /** the name of the Mac it runs on: hidden too, since two AIs may run on two Macs */
  mac?: string;
  status: Status;
  out?: DraftAnswer;
  error?: string;
}
interface Compare {
  id: string;
  sessionId: string;
  draft: DraftMeta;
  projectId?: string;
  /** [A, B]: the order the two AIs were drawn in */
  sides: Side[];
  picked?: "A" | "B" | "neither";
  at: number;
}
interface Pick {
  at: number;
  kind: DraftKind;
  instance: string;
  model: string;
  name: string;
}
interface Store {
  compares: Compare[];
  picks: Pick[];
}

const fileOf = (user: string) => path.join(env.dataDir, "plugins", "compare", `${user}.json`);

async function read(user: string): Promise<Store> {
  try {
    return JSON.parse(await readFile(fileOf(user), "utf8")) as Store;
  } catch {
    return { compares: [], picks: [] };
  }
}

const chains = new Map<string, Promise<unknown>>();
/** One read-change-write of an account's file at a time; a change that throws writes nothing. Its open pages hear of it. */
function update<T>(user: string, fn: (s: Store) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const s = await read(user);
    const out = await fn(s);
    s.compares = s.compares.slice(0, COMPARES_MAX);
    s.picks = s.picks.slice(0, PICKS_MAX);
    await mkdir(path.dirname(fileOf(user)), { recursive: true });
    await writeJsonAtomic(fileOf(user), s);
    announce(user, "x/compare");
    return out;
  };
  const next = (chains.get(user) ?? Promise.resolve()).then(run, run);
  chains.set(user, next.catch(() => undefined));
  return next;
}

/** Compares running in this process (`<user>:<session>`): a "writing" side of any other was cut off by a restart. */
const running = new Set<string>();

/** The chosen AI as the Workshop routes it for this person, or why it can't be used. It answers alone (`fixed`). */
function routeOf(user: SessionUser, sel: unknown): { ai: ProviderOpts; sel: Selection; name: string; mac?: string } | string {
  const s = sel as Partial<Selection> | null;
  if (!s || typeof s.instance !== "string" || typeof s.model !== "string" || typeof s.effort !== "string") return "Pick two AIs";
  const ai = workshopAi(user, { instance: s.instance, model: s.model, effort: s.effort });
  const p = ai.mac?.provider;
  // the Workshop moves to another AI when the chosen one can't run: a compare must not
  if (ai.off || !p || p.instance !== s.instance || p.model !== s.model) return "One of these AIs can't run now: check it in Settings → Providers";
  return { ai: { ...ai, fixed: true }, sel: { instance: s.instance, model: s.model, effort: s.effort }, name: instanceIn(p.scope ?? "workspace", p.instance)?.name ?? p.instance, mac: p.device ? deviceOf(p.device)?.name : undefined };
}

/** Every word that could say which AI wrote a side, longest first: what a failure sentence may not show before the pick. */
function namesOf(c: Compare): string[] {
  const words = [...DRIVERS.flatMap((d) => [d.id, d.label]), ...Object.values(TOOL_NAMES), ...c.sides.flatMap((s) => [s.name, s.mac, s.ai.instance, s.ai.model])];
  return [...new Set(words.filter((w): w is string => !!w && w.length > 1))].sort((a, b) => b.length - a.length);
}

function hideNames(text: string, names: string[]): string {
  let out = text;
  for (const n of names) out = out.replace(new RegExp(`(?<!\\w)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "gi"), "the AI");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** What the browser gets: no AI named anywhere until the pick (or Neither). */
export function view(c: Compare, live: boolean) {
  const decided = !!c.picked;
  const names = namesOf(c);
  return {
    id: c.id,
    sessionId: c.sessionId,
    kind: c.draft.kind,
    prompt: c.draft.prompt,
    picked: c.picked ?? null,
    sides: c.sides.map((s, i) => {
      const cut = s.status === "writing" && !live;
      const error = cut ? "Stopped when the server restarted" : s.error;
      return {
        label: i ? "B" : "A",
        status: cut ? ("error" as const) : s.status,
        ...(s.out ? { markdown: s.out.markdown } : {}),
        ...(error ? { error: decided ? error : hideNames(error, names) } : {}),
        ...(decided ? { ai: { name: s.name, model: s.ai.model, effort: s.ai.effort } } : {}),
      };
    }),
  };
}
export type CompareView = ReturnType<typeof view>;

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Builds Generate draft's request once and asks both AIs at the same time; each side is saved as it ends. */
async function run(user: SessionUser, meta: SessionMeta, c: Compare, ais: ProviderOpts[]): Promise<void> {
  const save = (i: number, patch: Partial<Side>) =>
    update(user.username, (s) => {
      const side = s.compares.find((x) => x.id === c.id)?.sides[i];
      if (side) Object.assign(side, patch);
    });
  let ask;
  try {
    ask = (await draftRequest(meta, c.draft, user, ais)).ask;
  } catch (e) {
    await Promise.all(c.sides.map((_, i) => save(i, { status: "error", error: errorOf(e) })));
    return;
  }
  await Promise.all(
    ais.map(async (ai, i) => {
      try {
        const out = await ask(ai);
        bumpUsage(user.username, { aiRuns: 1 });
        await save(i, { status: "ready", out });
      } catch (e) {
        await save(i, { status: "error", error: errorOf(e) });
      }
    }),
  );
}

const app = new Hono<{ Variables: { user: SessionUser } }>();
app.use("*", requireGate("compare"));

app.get("/sessions/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  // A compare can end while the file is being read: the read then holds its "writing" sides, but by the time it lands
  // the compare is no longer running, and those sides would show as cut off by a restart. So it counts as running if it
  // was running when the read began or is running when it ends.
  const key = `${user.username}:${meta.id}`;
  const wasRunning = running.has(key);
  const found = (await read(user.username)).compares.find((x) => x.sessionId === meta.id);
  c.header("Cache-Control", "no-store");
  return c.json({ compare: found ? view(found, wasRunning || running.has(key)) : null });
});

/** Body: { a, b } (two of the person's AIs, as Selection) and what Generate draft takes (kind, prompt, sourceIds…). */
app.post("/sessions/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const picked = [routeOf(user, body?.a), routeOf(user, body?.b)];
  const bad = picked.find((p): p is string => typeof p === "string");
  if (bad) return c.json({ error: bad }, 400);
  const [one, two] = picked as Exclude<(typeof picked)[number], string>[];
  if (one!.sel.instance === two!.sel.instance && one!.sel.model === two!.sel.model && one!.sel.effort === two!.sel.effort) return c.json({ error: "Pick two different AIs" }, 400);
  const made = draftFrom(meta, body);
  if ("error" in made) return c.json({ error: made.error }, 400);
  const key = `${user.username}:${meta.id}`;
  if (running.has(key)) return c.json({ error: "A compare is already running in this session: wait for it" }, 409);
  running.add(key);
  const drawn = Math.random() < 0.5 ? [one!, two!] : [two!, one!];
  const cmp: Compare = { id: randomUUID(), sessionId: meta.id, draft: made.draft, projectId: made.input.projectId, sides: drawn.map((d) => ({ ai: d.sel, name: d.name, mac: d.mac, status: "writing" })), at: Date.now() };
  try {
    await update(user.username, (s) => {
      s.compares = [cmp, ...s.compares.filter((x) => x.sessionId !== meta.id)];
    });
  } catch (e) {
    running.delete(key);
    throw e;
  }
  void inJob([user.username], () => run(user, meta, cmp, drawn.map((d) => d.ai)), meta.id).finally(() => running.delete(key));
  return c.json({ compare: view(cmp, true) }, 202);
});

/** Body: { side: "A" | "B" | null }. A side's draft goes into the session as a generated draft does; null keeps neither. */
app.post("/sessions/:id/pick", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { side?: unknown } | null;
  const side = body?.side === "A" || body?.side === "B" ? body.side : body?.side === null ? null : undefined;
  if (side === undefined) return c.json({ error: "Pick A, B or neither" }, 400);
  const live = running.has(`${user.username}:${meta.id}`);
  const out = await update(user.username, async (s) => {
    const cmp = s.compares.find((x) => x.sessionId === meta.id);
    if (!cmp) return { error: "Not found", status: 404 as const };
    if (cmp.picked) return { error: "This compare is already decided", status: 409 as const };
    if (live) return { error: "Still writing", status: 409 as const };
    const chosen = side ? cmp.sides[side === "A" ? 0 : 1]! : null;
    if (chosen && !chosen.out) return { error: "That one has no draft", status: 400 as const };
    if (chosen) {
      // as Generate draft's own save: the session's open pages hear of it
      await inJob([meta.owner, user.username], () => addDraft(meta, cmp.draft, chosen.out!, cmp.projectId), meta.id);
      s.picks.unshift({ at: Date.now(), kind: cmp.draft.kind, instance: chosen.ai.instance, model: chosen.ai.model, name: chosen.name });
    }
    cmp.picked = side ?? "neither";
    // the picked draft is in the session now; the other is thrown away
    for (const x of cmp.sides) delete x.out;
    return { compare: view(cmp, false) };
  });
  return "error" in out ? c.json({ error: out.error }, out.status) : c.json(out);
});

/** Settings: how many times each AI was picked, per kind of writing, over the picks kept. */
app.get("/tally", async (c) => {
  const rows = new Map<string, { name: string; model: string; counts: Partial<Record<DraftKind, number>> }>();
  for (const p of [...(await read(c.get("user").username)).picks].reverse()) {
    const key = `${p.instance}\n${p.model}`;
    const row = rows.get(key) ?? { name: p.name, model: p.model, counts: {} };
    row.name = p.name; // its newest name
    row.counts[p.kind] = (row.counts[p.kind] ?? 0) + 1;
    rows.set(key, row);
  }
  return c.json({ rows: [...rows.values()] });
});

export default definePlugin({
  id: "compare",
  name: "Compare",
  about: "Two of your AIs write the same draft, names hidden until you pick one.",
  kind: "workshop",
  gates: { ids: ["compare"], defaultOff: ["compare"] },
  routes: app,
});
