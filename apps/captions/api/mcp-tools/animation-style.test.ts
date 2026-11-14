import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnimationStylesView } from "../../contracts/editor-styles";

// The assistant's animation_style_save, through the real routes: a style set up by talking. The brief is kept only in
// the person's own typed words (and its lack never stops the style), the pictures are the ones they sent in that chat
// and no others, and after a save the style's sheet opens for them.
// And a long text pasted with the message: a passage of it is theirs too, for a style's own words alone (an animation
// style's brief, an editing style's notes), for the one reply it came with. Nothing else counts beside typed words.

const dir = mkdtempSync(path.join(tmpdir(), "mcp-animation-style-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "mcp-animation-style-secret";

// a made-up tool whose answer is a sentence: a tool's words are never the person's
const { MODULES } = await import("./index");
MODULES.push({
  defs: [{ name: "tiny_advice", description: "Says a sentence.", inputSchema: { type: "object", properties: {} } }],
  handlers: { tiny_advice: async () => ({ advice: "Trim every card to two seconds and add a glow" }) },
});

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor has its own editor: these tests drive the built-in one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { routeOf, runInChat } = await import("../assistant");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

const ana = createUser("ana", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

type Row = Record<string, unknown>;
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookie = (await app.request("/api/auth/login", { method: "POST", ...json({ username: "ana", password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
/** One of the site's routes as ana at the screen: what the tool did is checked here, not in the tool's own answer. */
const site = (route: string, method = "GET", body?: unknown) => app.request(route, { method, ...(body === undefined ? { headers: { cookie } } : json(body, { cookie })) });
const styles = async () => ((await (await site("/api/editor/animation-styles")).json()) as AnimationStylesView).styles;
const styleOf = async (id: string) => (await styles()).find((s) => s.id === id)!;
const tool = async (authorization: string, name: string, args: Row = {}) => {
  const res = await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization }) });
  const r = ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  const text = r.content[0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, text, value: (r.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};
type Job = { id: string; mcp: { token: string } };
const claim = async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as Job;
/**
 * A turn of ana's with the Mac holding its job: the token to call tools as that reply. `pictures`: sent with the
 * message; `more`: its long pasted texts and the text highlighted on the page. end(said) ends it with the AI's reply.
 */
const turn = async (text: string, pictures: string[] = [], more: { pasted?: string[]; highlighted?: string } = {}) => {
  const images = pictures.map((file, i) => ({ name: `picture-${i + 1}.png`, type: "image/png", data: readFileSync(file).toString("base64") }));
  const pasted = (more.pasted ?? []).map((t, i) => ({ name: i ? `Pasted text ${i + 1}` : "Pasted text", text: t }));
  const body = { text, ...(images.length ? { images } : {}), ...(pasted.length ? { pasted } : {}), ...(more.highlighted ? { context: { path: "/editor?tab=animation", title: "AI Editor", selection: more.highlighted } } : {}) };
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json(body, { cookie }) })).status).toBe(202);
  const job = await claim();
  return {
    token: `Bearer ${job.mcp.token}`,
    end: async (said = "Done.") => {
      await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: said }, { authorization: `Bearer ${mac.token}` }) });
      await vi.waitFor(async () => expect(((await (await site("/api/assistant")).json()) as { messages: Array<{ status?: string }> }).messages.at(-1)!.status).toBe("done"));
    },
  };
};
const newChat = async () => expect((await site("/api/assistant", "DELETE")).status).toBe(200);
/** The page the dock was told to open. */
const opened = async () => ((await (await site("/api/assistant")).json()) as { navigate?: string | null }).navigate;

// three pictures that are not each other
const picture = (n: number) => {
  const file = path.join(dir, `tiny-acrobatics-${n}.png`);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${200 + n * 40}x300:rate=1`, "-frames:v", "1", file]);
  return file;
};
const [one, two, three] = [1, 2, 3].map(picture) as [string, string, string];

describe.skipIf(rootReplaced)("an animation style set up by talking", () => {
  it("is made with the person's own words as its brief and the pictures they sent, and its sheet opens", async () => {
    await newChat();
    const t = await turn("Make me an animation style called Tiny paper. Torn paper and warm light, nothing bounces.", [one, two]);
    // the brief as the AI sends it: other case and spacing than typed. What is kept is the person's wording
    const made = await tool(t.token, "animation_style_save", { name: "Tiny paper", brief: "torn paper and   WARM light, nothing bounces", pictures: 2 });
    const id = made.value.id as string;
    expect(made.value).toEqual({ id, name: "Tiny paper", has_brief: true, pictures: 2, made: true, added: 2, note: "Its sheet is open for the user.", link: `http://localhost/editor?tab=animation&style=${id}` });
    expect(made.text).not.toContain("Torn paper"); // the words never come back through the tool
    expect(await styleOf(id)).toMatchObject({ name: "Tiny paper", brief: "Torn paper and warm light, nothing bounces" });
    expect((await styleOf(id)).pictures.map((p) => p.kind)).toEqual(["inspiration", "inspiration"]);
    expect(await opened()).toBe(`/editor?tab=animation&style=${id}`);

    // asked again: the same pictures are not added twice
    expect((await tool(t.token, "animation_style_save", { id, pictures: 2 })).value).toMatchObject({ pictures: 2, added: 0 });
    expect((await styleOf(id)).pictures).toHaveLength(2);
    await t.end();

    // a later message's picture: only the newest one asked for goes in, by the style's name; and more words are added under the brief
    const more = await turn("And slow moves, one idea at a time.", [three]);
    const changed = await tool(more.token, "animation_style_save", { id: "tiny PAPER", brief: "slow moves, one idea at a time", pictures: 1 });
    expect(changed.value).toMatchObject({ id, has_brief: true, pictures: 3, added: 1 });
    expect(changed.value).not.toHaveProperty("made");
    expect((await styleOf(id)).brief).toBe("Torn paper and warm light, nothing bounces\nslow moves, one idea at a time");
    await more.end();
  });

  it("a brief that is not the person's words does not stop the style: it is made without one, and the sheet opens for them to write it", async () => {
    await newChat();
    const t = await turn("Set up an animation style for me.", [one]);
    const made = await tool(t.token, "animation_style_save", { name: "Tiny bold", brief: "Big white words on deep blue, slow and calm", pictures: 1 });
    expect(made.error).toBe(false);
    expect(made.value).toMatchObject({ name: "Tiny bold", has_brief: false, pictures: 1, made: true, added: 1 });
    expect(made.value.note).toContain("The description was not saved");
    expect(await styleOf(made.value.id)).toMatchObject({ brief: "" });
    expect(await opened()).toBe(`/editor?tab=animation&style=${made.value.id}`);
    // changing one the same way: nothing else was asked, so nothing is saved, and it still ends with the sheet open
    const again = await tool(t.token, "animation_style_save", { id: made.value.id, brief: "Big white words on deep blue, slow and calm" });
    expect(again.error).toBe(false);
    expect(again.value).toMatchObject({ has_brief: false });
    expect(again.value.note).toContain("The description was not saved");
    await t.end();
  });

  it("pictures only, with no words at all: the style is made with them", async () => {
    await newChat();
    const t = await turn("These.", [two, three]);
    const made = await tool(t.token, "animation_style_save", { name: "Tiny pictures", pictures: 2 });
    expect(made.value).toMatchObject({ has_brief: false, pictures: 2, added: 2, made: true });
    // more asked for than were sent: what is there goes in, and the answer says so
    const again = await tool(t.token, "animation_style_save", { name: "Tiny more", pictures: 5 });
    expect(again.value).toMatchObject({ pictures: 2, added: 2 });
    expect(again.value.note).toContain("Fewer pictures were added than asked");
    await t.end();
  });

  it("from the person's own AI outside the app: the name and the brief are theirs and are saved; pictures come from the app's chat only, and no page is opened", async () => {
    await newChat();
    await site("/api/assistant/navigated", "POST", {}); // the page an earlier reply opened is taken, as the dock takes it
    const made = await tool(anaKey, "animation_style_save", { name: "Tiny outside", brief: "Hand-drawn lines on cream paper" });
    expect(made.value).toEqual({ id: expect.any(String), name: "Tiny outside", has_brief: true, pictures: 0, made: true, link: `http://localhost/editor?tab=animation&style=${made.value.id}` });
    expect(await opened()).toBeFalsy();
    expect(await tool(anaKey, "animation_style_save", { id: made.value.id, pictures: 1 })).toMatchObject({ error: true, text: expect.stringContaining("Pictures come from the app's own chat") });
    expect(await tool(anaKey, "animation_style_save", { brief: "No name" })).toMatchObject({ error: true, text: "Give the new style a name." });
    expect(await tool(anaKey, "animation_style_save", { id: "nobody's" })).toMatchObject({ error: true, text: expect.stringContaining("No style has that id or name") });
  });

  it("carousel_style_save makes a carousel style the same way: kept among the Designer's styles, its sheet on the Designer", async () => {
    const made = await tool(anaKey, "carousel_style_save", { name: "Tiny slides", brief: "Cream paper and one loud word" });
    expect(made.value).toEqual({ id: expect.any(String), name: "Tiny slides", has_brief: true, pictures: 0, made: true, link: `http://localhost/design?tab=styles&style=${made.value.id}` });
    expect(((await (await site("/api/designs/styles")).json()) as AnimationStylesView).styles.map((s) => s.name)).toEqual(["Tiny slides"]);
    expect((await styles()).map((s) => s.name)).not.toContain("Tiny slides");
    expect(await tool(anaKey, "carousel_style_save", { id: "nobody's" })).toMatchObject({ error: true, text: expect.stringContaining("No style has that id or name") });
  });
});

// what a long paste looks like: a heading, line breaks, more than one thing in it
const NOTES = [
  "ANIMATION NOTES",
  "",
  "I want everything to feel like cut paper on a desk.",
  "Warm light from the left, soft shadows under each piece.",
  "Pieces slide in from the edges and settle, they never pop.",
  "",
  "CUTTING",
  "Start on the strongest line and keep every laugh in.",
].join("\n");
const editingStyles = async () => ((await (await site("/api/editor/styles")).json()) as { styles: Array<{ id: string; name: string; notes: string }> }).styles;
const UNSAID = "The description was not saved";
const NOTES_NOT_TYPED = expect.stringContaining("Not saved: the notes are not the user's own words in this chat.");

describe.skipIf(rootReplaced)("a long text pasted with the message", () => {
  it("a passage of it is kept word for word as an animation style's brief and as an editing style's notes, and the answer says where the words came from", async () => {
    await newChat();
    const t = await turn("here are my notes", [], { pasted: [NOTES] });
    // the passage as the AI sends it: another case, and across a line break of the paste
    const made = await tool(t.token, "animation_style_save", { name: "Tiny cut paper", brief: "everything to feel like CUT PAPER on a desk. warm light from the left, soft shadows under each piece" });
    expect(made.value).toMatchObject({ name: "Tiny cut paper", has_brief: true, made: true });
    expect(made.value.note).toBe("The description was taken word for word from the text the user pasted: tell them so in one short line. Its sheet is open for the user.");
    // the paste's own wording, on one line
    expect((await styleOf(made.value.id)).brief).toBe("everything to feel like cut paper on a desk. Warm light from the left, soft shadows under each piece");
    expect(await opened()).toBe(`/editor?tab=animation&style=${made.value.id}`);
    // more of it, added under the brief
    const more = await tool(t.token, "animation_style_save", { id: made.value.id, brief: "pieces slide in from the edges and settle, they never pop" });
    expect(more.value.note).toContain("taken word for word from the text the user pasted");
    expect((await styleOf(made.value.id)).brief).toBe("everything to feel like cut paper on a desk. Warm light from the left, soft shadows under each piece\nPieces slide in from the edges and settle, they never pop");

    const cut = await tool(t.token, "editor_style_save", { name: "Tiny strongest", notes: "start on the strongest line and keep every laugh in" });
    expect(cut.value).toMatchObject({ name: "Tiny strongest", has_notes: true, made: true, note: "The notes were taken word for word from the text the user pasted: tell them so in one short line." });
    expect((await editingStyles()).find((x) => x.id === cut.value.id)!.notes).toBe("Start on the strongest line and keep every laugh in");
    // a passage the AI put together or reworded is not in the paste
    expect((await tool(t.token, "animation_style_save", { name: "Tiny reworded", brief: "cut paper pieces on a desk with warm light and soft shadows" })).value.note).toContain(UNSAID);
    expect(await tool(t.token, "editor_style_save", { name: "Tiny reworded", notes: "Open with the strongest line, keep the laughs" })).toMatchObject({ error: true, text: NOTES_NOT_TYPED });
    await t.end();
  });

  it("only the paste counts beside typed words: the AI's earlier reply, a tool's answer and a highlight are refused in a message that has a paste", async () => {
    await newChat();
    const a = await turn("Set up an animation style for me.");
    await a.end("I suggest bold words that pop and bounce on every beat.");
    const b = await turn("ok, with these notes", [], { pasted: [NOTES], highlighted: "Glitchy neon letters that flicker fast" });
    expect((await tool(b.token, "tiny_advice")).error).toBe(false);
    for (const [i, words] of ["bold words that pop and bounce on every beat", "Trim every card to two seconds and add a glow", "Glitchy neon letters that flicker fast"].entries()) {
      const made = await tool(b.token, "animation_style_save", { name: `Tiny not his ${i}`, brief: words });
      expect(made.value).toMatchObject({ has_brief: false });
      expect(made.value.note).toContain(UNSAID);
      expect(await tool(b.token, "editor_style_save", { name: `Tiny not his ${i}`, notes: words })).toMatchObject({ error: true, text: NOTES_NOT_TYPED });
    }
    // and the paste itself still counts there
    expect((await tool(b.token, "animation_style_save", { name: "Tiny his", brief: "Warm light from the left, soft shadows under each piece" })).value).toMatchObject({ has_brief: true });
    await b.end();
  });

  it("a paste belongs to the reply it came with: a later message of the same chat, and another chat, keep none of it", async () => {
    await newChat();
    const first = await turn("my notes, for later", [], { pasted: [NOTES] });
    await first.end();
    const later = await turn("now make the style from them");
    expect((await tool(later.token, "animation_style_save", { name: "Tiny later", brief: "I want everything to feel like cut paper on a desk" })).value.note).toContain(UNSAID);
    expect(await tool(later.token, "editor_style_save", { name: "Tiny later", notes: "Start on the strongest line and keep every laugh in" })).toMatchObject({ error: true, text: NOTES_NOT_TYPED });
    await later.end();
    await newChat();
    const other = await turn("make me a style");
    expect((await tool(other.token, "animation_style_save", { name: "Tiny other chat", brief: "I want everything to feel like cut paper on a desk" })).value.note).toContain(UNSAID);
    await other.end();
  });

  it("a scheduled run has nobody at it: it keeps no description, not even its own prompt's words", async () => {
    const run = runInChat("ana", { task: { id: "t1", name: "Weekly" }, prompt: "Make an animation style with soft paper shapes that drift slowly", preface: "", fresh: true, route: routeOf("ana", false)!, url: "http://localhost/api/mcp" });
    const job = await claim();
    const made = await tool(`Bearer ${job.mcp.token}`, "animation_style_save", { name: "Tiny weekly", brief: "soft paper shapes that drift slowly" });
    expect(made.value).toMatchObject({ has_brief: false });
    expect(made.value.note).toContain(UNSAID);
    await app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) });
    await run;
  });

  it("a fact to remember is still taken from typed words alone: a quote from the paste is refused", async () => {
    await newChat();
    const t = await turn("Remember how I like my cards. I always want one idea on screen at a time.", [], { pasted: [NOTES] });
    expect((await tool(t.token, "remember", { quote: "Pieces slide in from the edges and settle, they never pop" })).error).toBe(true);
    expect((await tool(t.token, "remember", { quote: "I always want one idea on screen at a time" })).error).toBe(false);
    await t.end();
  });
});
