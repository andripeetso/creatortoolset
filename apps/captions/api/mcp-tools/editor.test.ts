import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantView, AssistantWork } from "../../contracts/assistant";
import type { Edit } from "../../contracts/editor";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-editor-"));
process.env.APP_SECRET = "mcp-editor-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in editor) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { definePlugin, mountPlugins } = await import("../lib/plugin");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { NeedsKey } = await import("../library/transcribe");
const { STEPS, tick } = await import("../editor/worker");
const { readStep, saveDraft, saveStep } = await import("../editor/store");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

// ana has the footage and the assistant; nico is another account on the same server
const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");
libraryDb().exec(`
  INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ana', 'A', 'local', 0), ('lib_n', 'nico', 'N', 'local', 0);
  INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take 1', 'ana', 0);
  INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'ana', 0);
  INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_a', 'lib_a', 'Tiny B-roll', 'manual', 0), ('col_n', 'lib_n', 'Theirs', 'manual', 0);
`);

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", ...json({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const anaCookie = await cookieOf("ana");
/** One of the site's routes as ana at the screen: what a tool did is checked here, not in the tool's own answer. */
const site = (route: string, method = "GET", body?: unknown) => app.request(route, { method, ...(body === undefined ? { headers: { cookie: anaCookie } } : json(body, { cookie: anaCookie })) });
const editOf = async (id: string) => (await (await site(`/api/editor/${id}`)).json()) as Edit;
const rpc = async (authorization: string, method: string, params: unknown = {}) =>
  (await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method, params }, { authorization }) })).json()) as {
    result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
  };
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await rpc(authorization, "tools/call", { name, arguments: args })).result;
  const text = r.content![0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, text, value: (r.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};
/** A turn of ana's with the Mac holding its job: the token to call tools as that reply, what the AI was sent, and how to end it. */
const turn = async (text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie: anaCookie }) })).status).toBe(202);
  const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; user: string; mcp: { token: string } };
  return { token: `Bearer ${job.mcp.token}`, sent: job.user, end: () => app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) }) };
};
const chat = async () => ((await (await app.request("/api/assistant", { headers: { cookie: anaCookie } })).json()) as AssistantView).messages;
const cardOf = async (id: string) => (await chat()).flatMap((m) => m.work ?? []).find((w: AssistantWork) => w.id === id);
/** What the chat said by itself since `from` messages (the lines no reply wrote). */
const saidSince = async (from: number) => (await chat()).slice(from).filter((m) => m.role === "assistant" && m.text !== "Done.").map((m) => m.text);

/** Runs queued steps until the queue is empty: the clock is far ahead, so a step that failed is tried again at once. */
const drain = async () => {
  while (await tick(10 ** 13));
};
const real = { ...STEPS };
type Step = (typeof STEPS)[string];
/** Stand-ins for two of the worker's steps: a draft per planned version, and a preview "filed" in Review as the next version. */
const DRAFT: Step = async ({ edit, job, variant }) => {
  if (variant) return void (await saveDraft(edit.id, variant, { timeline: {} as never, notes: [] }));
  for (const p of readStep(edit.id, "plan")!.plans) enqueueJob(libraryDb(), edit.workspaceId, `${edit.id}:${p.name}`, "draft", job.actor, true, "edit_jobs");
};
const PREVIEW: Step = async ({ edit, variant }) => {
  const had = readStep(edit.id, "review") ?? {};
  await saveStep(edit.id, "review", { ...had, [variant]: { assetId: "11111111-2222-4333-8444-555555555555", n: (had[variant]?.n ?? 0) + 1 } });
};
/**
 * The worker's steps with no AI and no footage: the script plans `versions` versions, each gets a draft, and its
 * preview is "filed" in Review. B-roll is the real step (an edit with no B-roll folder: nothing to do). `over` swaps one.
 */
function standIn(versions = 1, over: Record<string, Step> = {}): void {
  Object.assign(STEPS, {
    analyze: async () => {},
    script: async ({ edit }) =>
      void (await saveStep(edit.id, "plan", { lines: [], plans: Array.from({ length: versions }, (_, i) => ({ name: `v${i + 1}`, title: `Version ${i + 1}`, lines: [] })), notes: [] })),
    draft: DRAFT,
    preview: PREVIEW,
    file: async () => {},
    ...over,
  } satisfies Record<string, Step>);
}
afterEach(() => void Object.assign(STEPS, real));

/** An edit the assistant makes and starts in a reply of its own, which then ends: the edit's id and how long the chat was. */
const started = async (name: string, more: Record<string, unknown> = {}) => {
  const t = await turn(`Edit ${name}`);
  const made = (await tool(t.token, "editor_create", { sources: ["ver_a"], name, ...more })).value as { id: string };
  await t.end();
  expect(await cardOf(`edit:${made.id}:new`)).toMatchObject({ status: "running" });
  return { id: made.id, from: (await chat()).length };
};
const failing = (why: string): Step => async () => {
  throw new Error(why);
};

describe.skipIf(rootReplaced)("an edit the assistant started ends in the chat", () => {
  it("its last step done: the card ends and the chat says the first draft is ready, once, with the two answers; the same edit run from its page later says nothing", async () => {
    standIn();
    const { id, from } = await started("Tiny tumbles");
    await drain();
    expect((await editOf(id)).jobs.map((j) => `${j.kind}:${j.variant} ${j.state}`)).toEqual(["analyze: done", "script: done", "draft: done", "draft:v1 done", "broll:v1 done", "post:v1 done", "preview:v1 done", "file:v1 done"]);
    expect(await cardOf(`edit:${id}:new`)).toEqual({ id: `edit:${id}:new`, kind: "edit", title: "Tiny tumbles", href: `/editor/${id}`, status: "done", detail: "Done" });
    const last = (await chat()).at(-1)!;
    expect(last).toMatchObject({ role: "assistant", status: "done", text: "The first draft of “Tiny tumbles” is ready.", choices: ["Show me", "Open in Review"] });
    expect(await saidSince(from)).toEqual(["The first draft of “Tiny tumbles” is ready."]);

    // a press on "Show me" is the person's next message: the AI gets the line and the edit's page with it
    const next = await turn("Show me");
    expect(next.sent).toContain("Assistant: The first draft of “Tiny tumbles” is ready.");
    expect(next.sent).toContain(`[made: Tiny tumbles → /editor/${id}]`);
    await next.end();

    // Run again on the edit's own page: no card is running, so nobody is told
    const before = (await chat()).length;
    expect((await site(`/api/editor/${id}/run`, "POST", {})).status).toBe(200);
    await drain();
    expect((await chat()).length).toBe(before);
  });

  it("an edit made and run on its own page tells nobody in the chat", async () => {
    standIn();
    const before = (await chat()).length;
    const { id } = (await (await site("/api/editor", "POST", { name: "Tiny page", sources: ["ver_a"] })).json()) as { id: string };
    await site(`/api/editor/${id}/run`, "POST", {});
    await drain();
    expect((await editOf(id)).jobs.at(-1)).toMatchObject({ kind: "file", state: "done" });
    expect((await chat()).length).toBe(before);
  });

  it("several versions: it says how many are ready; one that failed on the way is left out of the count", async () => {
    standIn(2);
    const both = await started("Tiny rolls", { versions: 2 });
    await drain();
    expect(await saidSince(both.from)).toEqual(["2 versions of “Tiny rolls” are ready."]);
    expect(await cardOf(`edit:${both.id}:new`)).toMatchObject({ status: "done", detail: "Done" });

    // v2's draft fails for good while v1 goes on: the run ends when v1 is filed
    standIn(2, { draft: async (c) => (c.variant === "v2" ? failing("No speech found in Version 2's takes")(c) : DRAFT(c)) });
    const one = await started("Tiny spins", { versions: 2 });
    await drain();
    expect((await editOf(one.id)).jobs.filter((j) => j.variant === "v2").map((j) => `${j.kind} ${j.state}`)).toEqual(["draft failed"]);
    expect(await saidSince(one.from)).toEqual(["1 of 2 versions of “Tiny spins” is ready."]);
    expect((await chat()).at(-1)!.choices).toEqual(["Show me", "Open in Review"]);
    expect(await cardOf(`edit:${one.id}:new`)).toMatchObject({ status: "done", detail: "1 of 2 versions done" });
  });

  it("a step that failed for good: nothing while it is still tried again, then the card fails with the reason and the chat says it in one line", async () => {
    standIn(1, { script: failing("The AI's answer has no lines") });
    const { id, from } = await started("Tiny falls");
    await tick(10 ** 13); // analyze
    await tick(10 ** 13); // script, first try: queued again
    expect((await editOf(id)).jobs.map((j) => `${j.kind} ${j.state} ${j.attempts}`)).toEqual(["analyze done 1", "script queued 1"]);
    expect(await cardOf(`edit:${id}:new`)).toMatchObject({ status: "running" });
    expect(await saidSince(from)).toEqual([]);
    await drain();
    expect((await editOf(id)).jobs.at(-1)).toMatchObject({ kind: "script", state: "failed", attempts: 3 });
    expect(await cardOf(`edit:${id}:new`)).toMatchObject({ status: "failed", detail: "The AI's answer has no lines" });
    expect(await saidSince(from)).toEqual(["“Tiny falls” did not finish: The AI's answer has no lines"]);
    expect((await chat()).at(-1)!.choices).toEqual(["Show me"]);
    // nothing more is said for an ending already said
    await drain();
    expect(await saidSince(from)).toHaveLength(1);
  });

  it("one version's last step fails after the other is ready: the line names that version", async () => {
    standIn(2, { file: async (c) => (c.variant === "v2" ? failing("The preview is gone from Review")(c) : undefined) });
    const { id, from } = await started("Tiny jumps", { versions: 2 });
    await drain();
    expect((await editOf(id)).jobs.filter((j) => j.kind === "file").map((j) => `${j.variant} ${j.state}`)).toEqual(["v1 done", "v2 failed"]);
    expect(await saidSince(from)).toEqual(["“Tiny jumps v2” did not finish: The preview is gone from Review"]);
    expect(await cardOf(`edit:${id}:new`)).toMatchObject({ status: "failed", detail: "The preview is gone from Review" });
  });

  it("a step that needs setup ends the run at once, in the page's words; editor_retry as the assistant carries on, with its own card, and that run's end is said too", async () => {
    standIn(1, { script: async () => Promise.reject(new NeedsKey("Add your Anthropic key in Settings → API keys")) });
    const { id, from } = await started("Tiny keys");
    await drain();
    expect(await cardOf(`edit:${id}:new`)).toMatchObject({ status: "failed", detail: "Add your Anthropic key in Settings → API keys" });
    expect(await saidSince(from)).toEqual(["“Tiny keys” needs setup: Add your Anthropic key in Settings → API keys"]);
    expect((await chat()).at(-1)!.choices).toEqual(["Show me"]);

    standIn();
    const t = await turn("I added the key, try again");
    const again = (await tool(t.token, "editor_retry", { edit: id })).value;
    expect(again).toMatchObject({ id, name: "Tiny keys", retried: [{ kind: "script", state: "queued" }], link: `http://localhost/editor/${id}` });
    const reply = (await chat()).at(-1)!;
    expect(reply.steps).toEqual(["Running the failed step again"]);
    expect(reply.work).toEqual([{ id: `edit:${id}:retry`, kind: "edit", title: "Tiny keys", href: `/editor/${id}`, status: "running", detail: "The AI Editor is working on it" }]);
    await t.end();
    const mark = (await chat()).length;
    await drain();
    expect(await cardOf(`edit:${id}:retry`)).toMatchObject({ status: "done", detail: "Done" });
    expect(await saidSince(mark)).toEqual(["The first draft of “Tiny keys” is ready."]);
  });

  it("Stop: editor_stop ends the waiting steps and the card, and nothing is said; a Stop on the page while a step runs is as quiet", async () => {
    standIn();
    const waiting = await started("Tiny stop");
    const t = await turn("Stop that edit");
    expect((await tool(t.token, "editor_stop", { edit: waiting.id })).value).toEqual({ id: waiting.id, name: "Tiny stop", stopped: 1, note: "editor_retry runs the stopped steps again.", link: `http://localhost/editor/${waiting.id}` });
    expect((await chat()).at(-1)!.steps).toEqual(["Stopping the edit"]);
    await t.end();
    expect((await editOf(waiting.id)).jobs).toMatchObject([{ kind: "analyze", state: "failed", error: "Stopped" }]);
    expect(await cardOf(`edit:${waiting.id}:new`)).toMatchObject({ status: "failed", detail: "Stopped" });
    await drain();
    expect(await saidSince(waiting.from)).toEqual([]);
    // stopped again with nothing running: the answer says so
    expect((await tool(anaKey, "editor_stop", { edit: waiting.id })).value).toMatchObject({ stopped: 0, note: "Nothing was running." });

    // the person presses Stop on the page while analyze runs: the step is aborted, and its end says nothing
    let running!: () => void;
    const isRunning = new Promise<void>((r) => (running = r));
    standIn(1, { analyze: ({ signal }) => new Promise<void>((done) => (running(), signal.addEventListener("abort", () => done()))) });
    const live = await started("Tiny halt");
    const step = tick(10 ** 13);
    await isRunning;
    expect((await site(`/api/editor/${live.id}/stop`, "POST")).status).toBe(200);
    await step;
    await drain();
    expect((await editOf(live.id)).jobs).toMatchObject([{ kind: "analyze", state: "failed", error: "Stopped" }]);
    expect(await cardOf(`edit:${live.id}:new`)).toMatchObject({ status: "failed", detail: "Stopped" });
    expect(await saidSince(live.from)).toEqual([]);
  });

  it("a draft sent to Review: its card ends when the preview is filed, and the chat says so once", async () => {
    standIn();
    const { id } = (await (await site("/api/editor", "POST", { name: "Tiny cartwheel", sources: ["ver_a"] })).json()) as { id: string };
    await site(`/api/editor/${id}/run`, "POST", {});
    await drain();
    expect((await editOf(id)).previews.v1!.n).toBe(1);

    const t = await turn("Send v1 to Review");
    expect((await tool(t.token, "editor_run", { edit: id, kind: "send_to_review", draft: "v1" })).value).toEqual({ status: "queued", draft: "v1" });
    await t.end();
    const from = (await chat()).length;
    expect(await cardOf(`edit:${id}:review:v1`)).toMatchObject({ title: "v1 to Review", status: "running" });
    await drain();
    expect((await editOf(id)).previews.v1!.n).toBe(2);
    expect(await cardOf(`edit:${id}:review:v1`)).toMatchObject({ status: "done", detail: "In Review" });
    expect(await saidSince(from)).toEqual(["“Tiny cartwheel v1” is in Review."]);
    expect((await chat()).at(-1)!.choices).toEqual(["Show me", "Open in Review"]);
  });
});

describe.skipIf(rootReplaced)("the AI Editor's page buttons as tools", () => {
  /** An edit of ana's made on the page, not started. */
  const edit = async (name: string) => ((await (await site("/api/editor", "POST", { name, sources: ["ver_a"] })).json()) as { id: string }).id;

  it("any AI key gets the four; another account's edit is not found, and a call without an edit says what to give", async () => {
    const names = (await rpc(nicoKey, "tools/list")).result.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["editor_stop", "editor_retry", "editor_update", "editor_delete"]));
    const id = await edit("Tiny own");
    for (const name of ["editor_stop", "editor_retry", "editor_update", "editor_delete"]) {
      expect(await tool(nicoKey, name, { edit: id, name: "Mine now" }), name).toMatchObject({ error: true, text: "Not found, or not this account's." });
      expect(await tool(anaKey, name), name).toMatchObject({ error: true, text: "Give the edit's id: editor_list lists them." });
    }
    expect((await editOf(id)).name).toBe("Tiny own");
  });

  it("editor_retry runs one failed step by its id or every failed one, and refuses a step that did not fail", async () => {
    standIn(2, { preview: failing("The draft has no speaker shots") });
    const id = await edit("Tiny retry");
    await site(`/api/editor/${id}/run`, "POST", {});
    await drain();
    const jobs = (await editOf(id)).jobs;
    const [p1, p2] = jobs.filter((j) => j.kind === "preview");
    expect([p1!.state, p2!.state]).toEqual(["failed", "failed"]);

    expect(await tool(anaKey, "editor_retry", { edit: id, job: jobs[0]!.id })).toMatchObject({ error: true, text: "That step is done: only one that failed, was stopped or needs setup runs again." });
    expect(await tool(anaKey, "editor_retry", { edit: id, job: 999_999 })).toMatchObject({ error: true, text: "This edit has no step with that id: editor_get lists them." });
    expect((await tool(anaKey, "editor_retry", { edit: id, job: p1!.id })).value.retried).toEqual([{ id: p1!.id, kind: "preview", variant: "v1", state: "queued" }]);
    expect((await editOf(id)).jobs.filter((j) => j.kind === "preview").map((j) => j.state)).toEqual(["queued", "failed"]);
    await site(`/api/editor/${id}/stop`, "POST");
    // with no job: every step that failed or was stopped
    expect((await tool(anaKey, "editor_retry", { edit: id })).value.retried.map((j: { variant: string; state: string }) => `${j.variant} ${j.state}`)).toEqual(["v1 queued", "v2 queued"]);
    standIn(2);
    await drain();
    expect((await editOf(id)).jobs.every((j) => j.state === "done")).toBe(true);
    expect(await tool(anaKey, "editor_retry", { edit: id })).toMatchObject({ error: true, text: "No step of this edit failed: editor_run runs it again from a step." });
  });

  it("editor_update changes what the edit was asked for and answers with what the route kept", async () => {
    const id = await edit("Tiny update");
    const first = (await tool(anaKey, "editor_update", { edit: id, name: "Tiny tumbles, take two", brief: "Warm and quick", script: "We roll. Join us.", versions: 9, target_s: 30, broll_folder: "col_a" })).value;
    expect(first).toEqual({ id, name: "Tiny tumbles, take two", changed: ["name", "brief", "script", "versions", "target_s", "broll_folder"], versions: 5, target_s: 30, broll_folder: "col_a", link: `http://localhost/editor/${id}` });
    expect(await editOf(id)).toMatchObject({ name: "Tiny tumbles, take two", brief: "Warm and quick", script: "We roll. Join us.", versions: 5, targetS: 30, brollCollectionId: "col_a" });

    // the same again, and a name that can't be used: nothing changed, and it says so
    expect((await tool(anaKey, "editor_update", { edit: id, versions: 5, name: " " })).value).toMatchObject({ name: "Tiny tumbles, take two", changed: [], note: "Nothing changed: it was so already, or the value could not be used (a name can't be empty)." });
    expect((await tool(anaKey, "editor_update", { edit: id, broll_folder: "none" })).value).toMatchObject({ changed: ["broll_folder"], broll_folder: "none" });
    expect((await editOf(id)).brollCollectionId).toBeNull();
    // a folder that is someone else's, and a call that changes nothing
    expect(await tool(anaKey, "editor_update", { edit: id, broll_folder: "col_n" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
    expect(await tool(anaKey, "editor_update", { edit: id })).toMatchObject({ error: true, text: "Nothing to change: give name, brief, script, versions, target_s, broll_folder or flags." });

    // once drafts are cut, a new brief says how it gets used
    standIn();
    await site(`/api/editor/${id}/run`, "POST", {});
    await drain();
    expect((await tool(anaKey, "editor_update", { edit: id, brief: "Calm and slow" })).value.note).toBe("The drafts are as they were: editor_run from script cuts them again with this.");
    expect((await tool(anaKey, "editor_update", { edit: id, broll_folder: "col_a" })).value.note).toBe("The drafts are as they were: editor_run from draft cuts them again with this.");
    expect((await tool(anaKey, "editor_update", { edit: id, name: "Tiny tumbles" })).value.note).toBeUndefined();
  });

  it("editor_update sets the flags an install's plug-ins declare, and refuses one it does not have with the list", async () => {
    const id = await edit("Tiny flags");
    expect(await tool(anaKey, "editor_update", { edit: id, flags: { "tiny-off": true } })).toMatchObject({ error: true, text: "This edit has no flags." });
    mountPlugins(app, [definePlugin({ id: "tiny-flags", editFlags: [{ id: "tiny-on", label: "Tiny on", default: true }, { id: "tiny-off", label: "Tiny off" }] })]);
    const list = "flags is {id: true or false}. This edit's flags: tiny-on (Tiny on), tiny-off (Tiny off).";
    expect(await tool(anaKey, "editor_update", { edit: id, flags: { "tiny-nope": true } })).toMatchObject({ error: true, text: list });
    expect(await tool(anaKey, "editor_update", { edit: id, flags: { "tiny-off": "yes" } })).toMatchObject({ error: true, text: list });
    expect((await tool(anaKey, "editor_update", { edit: id, flags: { "tiny-off": true } })).value).toMatchObject({ changed: ["flags"], flags: { "tiny-on": true, "tiny-off": true } });
    expect((await editOf(id)).flags).toEqual({ "tiny-on": true, "tiny-off": true });
  });

  it("editor_delete asks first in the dock, with the edit's name: nothing goes until Yes; an AI key from outside goes straight through", async () => {
    standIn();
    const id = await edit("Tiny goodbye");
    await site(`/api/editor/${id}/run`, "POST", {});
    const t = await turn("Delete that edit");
    const asked = await tool(t.token, "editor_delete", { edit: id });
    expect(asked.error).toBe(false);
    expect(asked.text).toContain('Asked the user: "Move the edit "Tiny goodbye" to the trash? It is still running and will stop." Nothing has been changed.');
    await t.end();
    const reply = (await chat()).at(-1)!;
    expect(reply.steps).toEqual(["Asking before the edit goes to the trash"]);
    expect(reply.confirms!.map((q) => [q.question, q.status])).toEqual([['Move the edit "Tiny goodbye" to the trash? It is still running and will stop.', "waiting"]]);
    expect((await site(`/api/editor/${id}`)).status).toBe(200);
    expect((await editOf(id)).jobs).toMatchObject([{ kind: "analyze", state: "queued" }]);

    expect((await app.request(`/api/assistant/confirms/${reply.confirms![0]!.id}`, { method: "POST", ...json({ yes: true }, { cookie: anaCookie }) })).status).toBe(200);
    expect((await site(`/api/editor/${id}`)).status).toBe(404);
    expect(((await (await site("/api/editor")).json()) as Array<{ id: string }>).map((e) => e.id)).not.toContain(id);
    await drain();

    const other = await edit("Tiny farewell");
    expect((await tool(anaKey, "editor_delete", { edit: other })).value).toEqual({ id: other, name: "Tiny farewell", trashed: true });
    expect((await site(`/api/editor/${other}`)).status).toBe(404);
  });
});
