import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { EditStepChoice, StepInfo, StepRow, StepsView } from "../../contracts/editor-steps";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { folderPluginsEnabled, pluginsFolder } from "../lib/folder-plugins";
import { pluginEditorSteps } from "../lib/plugin";
import { writeJsonAtomic } from "../library/media/run";

/**
 * The AI Editor's post-processing steps per account (contracts/editor-steps.ts): which ones new edits use, and with
 * which values. One file per account, $DATA_DIR/edit-steps/<user>.json. The steps that come with the app are plug-in
 * folders in editor-steps/ (in the Mac app: Resources/server/source/editor-steps); Turn on copies one into the
 * person's plug-ins folder, and the Mac app's own alert switches it on. Nothing in a folder runs before that.
 */

type Saved = Record<string, { use?: boolean; values?: Record<string, string> }>;
const fileOf = (user: string) => path.join(env.dataDir, "edit-steps", `${user}.json`);

function readSaved(user: string): Saved {
  try {
    return JSON.parse(readFileSync(fileOf(user), "utf8")) as Saved;
  } catch {
    return {};
  }
}

const valuesOf = (st: StepInfo, saved?: Record<string, string>): Record<string, string> =>
  Object.fromEntries((st.options ?? []).map((o) => [o.id, saved?.[o.id] ?? o.default]));

/** The folder the bundled steps are in: beside the app's source in the Mac app, editor-steps/ in a checkout. */
const bundledDir = () => process.env.CT_EDITOR_STEPS ?? [path.resolve("source/editor-steps"), path.resolve("editor-steps")].find((d) => existsSync(d)) ?? "";

/** The steps that come with the app, read as text from each folder's plugin.ts (nothing in them runs): its plug-in id, name and line. */
export function bundledSteps(): { folder: string; pluginId: string; title: string; about: string }[] {
  const root = bundledDir();
  if (!root) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((d) => {
    const file = path.join(root, d.name, "plugin.ts");
    if (!d.isDirectory() || !existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    const at = text.search(/\bid:\s*"/);
    const near = (key: string) => new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(text.slice(at, at + 600))?.[1];
    const pluginId = at < 0 ? undefined : near("id");
    return pluginId ? [{ folder: d.name, pluginId, title: near("name") ?? pluginId, about: near("about") ?? "" }] : [];
  });
}

/** What Settings → AI Editor shows this account: the loaded steps, then the ones that come with the app and are not loaded. */
export function stepsView(user: string): StepsView {
  const saved = readSaved(user);
  const loaded = pluginEditorSteps();
  const canAdd = folderPluginsEnabled();
  const rows: StepRow[] = loaded.map(({ run: _run, pluginId: _p, ...info }) => ({
    ...info,
    state: "on" as const,
    use: saved[info.id]?.use ?? true,
    values: valuesOf(info, saved[info.id]?.values),
  }));
  if (canAdd) {
    const running = new Set(loaded.map((s) => s.pluginId));
    for (const b of bundledSteps()) {
      if (running.has(b.pluginId)) continue;
      const there = existsSync(path.join(pluginsFolder(), b.folder));
      rows.push({ id: b.pluginId, title: b.title, about: b.about, state: there ? "off" : "add", folder: b.folder, use: false, values: {} });
    }
  }
  return { steps: rows, canAdd };
}

/** The steps a new edit of this account uses: loaded, in use, with their values (lowest order first). */
export function chosenSteps(user: string): EditStepChoice[] {
  const saved = readSaved(user);
  return pluginEditorSteps()
    .filter((s) => saved[s.id]?.use ?? true)
    .map((s) => ({ id: s.id, values: valuesOf(s, saved[s.id]?.values) }));
}

/** A change to one loaded step's use or values, or what is wrong with it. */
export async function changeStep(user: string, id: string, body: Record<string, unknown>): Promise<string | null> {
  const st = pluginEditorSteps().find((s) => s.id === id);
  if (!st) return "No such step in this app";
  const saved = readSaved(user);
  const next = { ...saved[id] };
  if (body.use !== undefined) {
    if (typeof body.use !== "boolean") return "use is true or false";
    next.use = body.use;
  }
  if (body.values !== undefined) {
    const given = body.values as Record<string, unknown>;
    if (!given || typeof given !== "object" || Array.isArray(given)) return "values is an object";
    const values = { ...next.values };
    for (const [k, v] of Object.entries(given)) {
      const o = st.options?.find((x) => x.id === k);
      if (!o) return `${st.title} has no option "${k}"`;
      if (typeof v !== "string" || v.length > 2000) return `${o.label}: a text of at most 2000 characters`;
      if (o.kind === "choice" && !o.choices?.some((c) => c.value === v)) return `${o.label} is one of ${o.choices?.map((c) => c.value).join(", ")}`;
      values[k] = v;
    }
    next.values = values;
  }
  await mkdir(path.dirname(fileOf(user)), { recursive: true });
  await writeJsonAtomic(fileOf(user), { ...saved, [id]: next });
  return null;
}

export const editStepsApp = new Hono<{ Variables: AuthVars }>();

editStepsApp.get("/", (c) => c.json(stepsView(c.get("user").username)));

editStepsApp.put("/:id", async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const user = c.get("user").username;
  const why = await changeStep(user, c.req.param("id"), body);
  if (why) return c.json({ error: why, code: "invalid" }, 400);
  return c.json(stepsView(user));
});

/** Turn on: the step's folder goes into the plug-ins folder (once). Switching it on is the Mac app's, in its own alert. */
editStepsApp.post("/add/:folder", async (c) => {
  if (!folderPluginsEnabled() || c.get("user").role !== "admin") return c.json({ error: "Not found" }, 404);
  const b = bundledSteps().find((x) => x.folder === c.req.param("folder"));
  if (!b) return c.json({ error: "No such step", code: "invalid" }, 400);
  const dest = path.join(pluginsFolder(), b.folder);
  if (!existsSync(dest)) await cp(path.join(bundledDir(), b.folder), dest, { recursive: true });
  return c.json({ folder: b.folder });
});
