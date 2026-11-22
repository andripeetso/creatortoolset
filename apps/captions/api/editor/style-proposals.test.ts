import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnimationStylesView, EditingStyle, EditingStylesView, StyleProposal } from "../../contracts/editor-styles";

// Style suggestions through the real routes: the AI reads stills or finished edits and proposes; a proposal is never a
// style until the person keeps it on its sheet (an AI's key is refused), and keeping makes the style and its cards' look.
// Also a workspace's default style. The AI's answer is stood in for; everything else is the app's own.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "style-proposals-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "style-proposals-test-secret";

const ai = vi.hoisted(() => ({ reply: "", images: [] as number[] }));
vi.mock("./cards/step", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cards/step")>()),
  answer: async (_actor: string, _prompt: unknown, images: unknown[], parse: (t: string) => unknown) => {
    ai.images.push(images.length);
    return parse(ai.reply);
  },
}));

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { parseProposal } = await import("./style-proposals");
const { listedIn } = await import("./styles");

const ana = createUser("ana", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookie = (await app.request("/api/auth/login", { method: "POST", ...json({ username: "ana", password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
const site = (route: string, method = "GET", body?: unknown) => app.request(route, { method, ...(body === undefined ? { headers: { cookie } } : json(body, { cookie })) });
const view = async () => (await (await site("/api/editor/styles")).json()) as EditingStylesView;
const picture = (n: number) => {
  const file = path.join(dir, `tiny-acrobatics-${n}.png`);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${200 + n * 40}x300:rate=1`, "-frames:v", "1", file]);
  return file;
};
const answerWith = (o: object) => (ai.reply = `Here it is: ${JSON.stringify(o)}`);

describe("parseProposal", () => {
  it("keeps every setting inside what a style takes, and refuses an answer that saw nothing", () => {
    const p = parseProposal(`{"name": "${"x".repeat(200)}", "seen": "Fast cuts.", "pace": "frantic", "punch": 1.27, "versions": 9, "target_s": -4, "notes": "Cut on every breath", "cards": "Bold yellow words"}`);
    expect(p.style).toMatchObject({ pace: "tight", punch: 1.3, versions: 5, targetS: 0, notes: "Cut on every breath" });
    expect(p.style.name.length).toBe(60);
    expect(p.cards).toBe("Bold yellow words");
    expect(parseProposal(`{"seen": "Calm."}`).style).toMatchObject({ name: "Proposed style", pace: "tight", punch: 1.15, versions: 1 });
    expect(() => parseProposal(`{"name": "x"}`)).toThrow();
    expect(() => parseProposal("no json here")).toThrow();
  });

  it("lists a style of a workspace there only, and one with none everywhere", () => {
    expect([{ projectId: "a" }, { projectId: "b" }, {}].filter(listedIn("a"))).toEqual([{ projectId: "a" }, {}]);
    expect([{ projectId: "a" }, {}].filter(listedIn(undefined))).toHaveLength(2);
  });
});

describe.skipIf(rootReplaced)("a style suggested from a reference", () => {
  it("is a suggestion until the person keeps it: then a style and its cards' look of the stills", async () => {
    answerWith({ name: "Tiny bold", seen: "Quick cuts on every line, big white captions, a pop on each title.", pace: "tight", punch: 1.3, versions: 2, target_s: 30, notes: "Cut every pause. Captions big and white.", cards: "White words on deep blue, a quick pop in" });
    const form = new FormData();
    for (const f of [picture(1), picture(2)]) form.append("file", new File([readFileSync(f)], path.basename(f)));
    const res = await app.request("/api/editor/styles/propose", { method: "POST", headers: { cookie }, body: form });
    expect(res.status).toBe(200);
    const p = (await res.json()) as StyleProposal;
    expect(ai.images.at(-1)).toBe(2);
    expect(p).toMatchObject({ from: "pictures", fromLabel: "2 pictures", style: { name: "Tiny bold", punch: 1.3, versions: 2, targetS: 30 }, animation: { brief: "White words on deep blue, a quick pop in", stills: 2 } });
    // nothing is a style yet: the suggestion is listed apart, its stills readable
    expect((await view()).styles).toHaveLength(0);
    expect((await view()).proposals?.map((x) => x.id)).toEqual([p.id]);
    expect((await site(`/api/editor/styles/proposals/${p.id}/stills/1`)).headers.get("content-type")).toBe("image/jpeg");
    expect((await site(`/api/editor/styles/proposals/${p.id}/stills/2`)).status).toBe(404);

    // an AI's key cannot keep it
    const byKey = await app.request(`/api/editor/styles/proposals/${p.id}/keep`, { method: "POST", ...json({}, { authorization: key }) });
    expect(byKey.status).toBe(403);
    expect((await view()).styles).toHaveLength(0);

    // a Keep that is refused leaves nothing behind and the suggestion where it was
    expect((await site(`/api/editor/styles/proposals/${p.id}/keep`, "POST", { name: " ", animationBrief: "x" })).status).toBe(400);
    expect(((await (await site("/api/editor/animation-styles")).json()) as AnimationStylesView).styles).toHaveLength(0);
    expect((await view()).proposals?.map((x) => x.id)).toEqual([p.id]);

    // the person keeps it, edited first
    const kept = (await (await site(`/api/editor/styles/proposals/${p.id}/keep`, "POST", { name: "Tiny bold mine", notes: "Cut every pause.", pace: "natural", animationBrief: "White words, slow fade" })).json()) as EditingStyle;
    expect(kept).toMatchObject({ name: "Tiny bold mine", notes: "Cut every pause.", pace: "natural", punch: 1.3, versions: 2, targetS: 30 });
    const anim = ((await (await site("/api/editor/animation-styles")).json()) as AnimationStylesView).styles.find((s) => s.id === kept.animation)!;
    expect(anim).toMatchObject({ name: "Tiny bold mine", brief: "White words, slow fade" });
    expect(anim.pictures.map((x) => x.kind)).toEqual(["inspiration", "inspiration"]);
    expect((await view()).proposals).toBeUndefined();
    expect((await site(`/api/editor/styles/proposals/${p.id}/stills/0`)).status).toBe(404);
    // a second Keep (a retry, another tab) makes nothing more
    expect((await site(`/api/editor/styles/proposals/${p.id}/keep`, "POST", {})).status).toBe(404);
    expect((await view()).styles).toHaveLength(1);
  });

  it("reads the person's finished edits, and a suggestion can be deleted", async () => {
    expect((await site("/api/editor/styles/propose", "POST", { finished: true })).status).toBe(409);
    const style = (await view()).styles[0]!;
    const finished = path.join(dir, "editor-styles", "ana", `${style.id}.finished.json`);
    writeFileSync(finished, JSON.stringify([{ editId: "e1", variant: "v1", name: "Tiny tip", at: 1, brief: "A quick tip", targetS: 20, seconds: 22, said: "Hold the handstand.\nBreathe.", cut: [] }]));
    answerWith({ name: "Calm tips", seen: "Short calm videos, about 20 seconds.", pace: "natural", target_s: 22, notes: "Let it breathe", cards: "" });
    const p = (await (await site("/api/editor/styles/propose", "POST", { finished: true })).json()) as StyleProposal;
    expect(ai.images.at(-1)).toBe(0);
    expect(p).toMatchObject({ from: "finished", fromLabel: "1 finished edit", style: { name: "Calm tips", pace: "natural", targetS: 22 } });
    expect(p.animation).toBeUndefined();
    expect((await site(`/api/editor/styles/proposals/${p.id}`, "DELETE")).status).toBe(200);
    expect((await view()).proposals).toBeUndefined();
    expect((await site(`/api/editor/styles/proposals/${p.id}/keep`, "POST", {})).status).toBe(404);
  });

  it("the assistant suggests one and is told only the person keeps it", async () => {
    answerWith({ name: "Calm tips", seen: "Short calm videos.", pace: "natural" });
    const res = await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "editor_style_propose", arguments: { from_finished: true } } }, { authorization: key }) });
    const r = ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text) as { proposal: string; seen: string; would_use: { pace: string }; note: string };
    expect(out).toMatchObject({ seen: "Short calm videos.", would_use: { pace: "natural" } });
    expect(out.note).toMatch(/you cannot keep it/);
    expect((await view()).proposals?.map((x) => x.id)).toEqual([out.proposal]);
  });

  it("a workspace's default is what New edit opens on, and goes with its style", async () => {
    const id = (await view()).styles[0]!.id;
    expect((await site("/api/editor/styles/default", "PUT", { id: "nope" })).status).toBe(404);
    expect((await site("/api/editor/styles/default", "PUT", { id })).status).toBe(200);
    expect((await view()).default).toBe(id);
    expect((await site("/api/editor/styles/default", "PUT", { id: null })).status).toBe(200);
    expect((await view()).default).toBeUndefined();
    await site("/api/editor/styles/default", "PUT", { id });
    await site(`/api/editor/styles/${id}`, "DELETE");
    expect((await view()).default).toBeUndefined();
  });
});
