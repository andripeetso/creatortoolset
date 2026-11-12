// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoicesView } from "@contracts/editor";
import type { EditingStyle, EditingStylesView } from "@contracts/editor-styles";
import { NewEditSheet } from "./EditorPage";

// New edit and editing styles: an account with no style sees no Style select and sends what it always sent; with
// styles the sheet opens on the one used last, fills the fields it sets, and says which one the edit is made with.
// The server is stubbed: one library, one ready clip.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/setup", () => ({ confirmHeavy: async () => true, openToolSetup: () => {} }));
vi.mock("@/components/FootageFolderCard", () => ({ FootageFolderCard: () => null }));

let posted: Record<string, unknown>[];
let calls: { url: string; body: Record<string, unknown> }[];
let installed: { folders: object[]; steps: object[] };
/** The person's ElevenLabs voices as GET /api/editor/voice answers; null: no key yet. */
let voices: VoicesView | null;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

const style = (id: string, name: string, more: Partial<EditingStyle> = {}): EditingStyle => ({
  id, name, notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, grade: null, brollCollectionId: null, steps: null, createdAt: 0, updatedAt: 0, ...more,
});

beforeEach(() => {
  posted = [];
  calls = [];
  installed = { folders: [], steps: [] };
  voices = { voices: [{ id: "v_mine", name: "Jordan", own: true }, { id: "v_stock", name: "Sam", own: false, preview: "https://example.com/sam.mp3" }], last: null };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method === "POST" && url === "/api/editor") {
      posted.push(JSON.parse(init.body as string));
      return reply({ id: "edit_1" });
    }
    if (url === "/api/editor/voice") {
      if (voices === null) return new Response(JSON.stringify({ error: "Add your ElevenLabs key in Settings → API keys" }), { status: 400 });
      if (init?.method !== "POST") return reply(voices);
      calls.push({ url, body: JSON.parse(init.body as string) });
      return reply({ versionId: "ver_voice", assetId: "ast_voice", libraryId: "lib_1", name: "Voice", voice: { id: "v_mine", name: "Jordan" } });
    }
    if (init?.method === "POST") {
      calls.push({ url, body: JSON.parse((init.body as string) ?? "{}") });
      return reply({});
    }
    if (url === "/api/library") return reply({ libraries: [{ id: "lib_1", name: "Tiny Acrobatics" }] });
    if (url.includes("/collections")) return reply({ collections: installed.folders });
    if (url === "/api/edit-steps") return reply({ steps: installed.steps, canAdd: false });
    return reply({ items: [{ id: "ast_1", versionId: "ver_1", title: "Take one", state: "ready", thumbUrl: null }] });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

async function open(styles: EditingStylesView | null, onStyles?: () => Promise<unknown>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <NewEditSheet open onClose={() => {}} styles={styles} onStyles={onStyles} />
      </MemoryRouter>,
    );
  });
  await flush();
  await flush();
}

const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
async function choose(id: string, value: string) {
  const el = field<HTMLSelectElement>(id)!;
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}
/** Picks the clip and presses Create and run; gives back what was sent to POST /api/editor. */
async function create() {
  const clip = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Take one"))!;
  act(() => clip.click());
  await flush();
  act(() => void field<HTMLInputElement>("edit-name")!.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  await flush();
  return posted.at(-1)!;
}

describe("New edit: the Style select", () => {
  it("an account with no style has no select, and its edit is sent as before: no style key at all", async () => {
    for (const none of [null, { styles: [], last: null }]) {
      await open(none);
      expect(field("edit-style")).toBeNull();
      expect(field("edit-versions")).not.toBeNull();
      expect(await create()).toEqual({ sources: ["ver_1"], brief: "", script: "", versions: 1, targetS: 0 });
      act(() => root!.unmount());
      root = undefined;
    }
  });

  it("with styles: None first, then each style; picking one fills versions and target length, which stay editable", async () => {
    const a = style("s_a", "Fast and warm", { versions: 3, targetS: 40 });
    await open({ styles: [a, style("s_b", "Slow")], last: null });
    const sel = field<HTMLSelectElement>("edit-style")!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["None", "Fast and warm", "Slow"]);
    expect(sel.value).toBe("");
    await choose("edit-style", "s_a");
    expect(field<HTMLSelectElement>("edit-versions")!.value).toBe("3");
    expect(field<HTMLInputElement>("edit-target")!.value).toBe("40");
    await choose("edit-versions", "2");
    expect(await create()).toMatchObject({ style: "s_a", versions: 2, targetS: 40 });
  });

  it("opens on the style used last, with its fields filled; None sends null so the next one opens on None", async () => {
    const a = style("s_a", "Fast and warm", { versions: 3, targetS: 40 });
    await open({ styles: [a, style("s_b", "Slow")], last: "s_a" });
    expect(field<HTMLSelectElement>("edit-style")!.value).toBe("s_a");
    expect(field<HTMLSelectElement>("edit-versions")!.value).toBe("3");
    expect(field<HTMLInputElement>("edit-target")!.value).toBe("40");
    await choose("edit-style", "");
    expect(field<HTMLSelectElement>("edit-versions")!.value).toBe("3"); // what is in the fields stays
    expect(await create()).toMatchObject({ style: null, versions: 3 });
  });
});

describe("New edit: How do you like to work?", () => {
  const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
  const press = async (text: string) => {
    act(() => button(text).click());
    await flush();
    await flush();
  };
  const blur = { id: "blur", title: "Blur faces", about: "", state: "on", use: true, values: { who: "everyone" } };

  it("comes first for someone with no style who has not answered it; once answered, or with a style, New edit is as it was", async () => {
    await open({ styles: [], last: null }, async () => {});
    expect(document.body.textContent).toContain("How do you like to work?");
    expect(field("edit-name")).toBeNull();
    for (const answered of [{ styles: [], last: null, asked: true as const }, { styles: [style("s_a", "Mine")], last: null }]) {
      act(() => root!.unmount());
      await open(answered, async () => {});
      expect(document.body.textContent).not.toContain("How do you like to work?");
      expect(field("edit-name")).not.toBeNull();
    }
  });

  it("Full edit: the B-roll folder and the post-processing steps switched on, 2 versions at 1080x1920, saved as My way; then the styles are read again", async () => {
    installed = { folders: [{ id: "col_1", name: "B-roll", parentId: null, kind: "manual", createdBy: "me" }], steps: [blur, { ...blur, id: "voice", title: "Voice", use: false }] };
    const done = vi.fn(async () => {});
    await open({ styles: [], last: null }, done);
    expect(button("Full edit").getAttribute("aria-pressed")).toBe("true");
    expect([...document.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]); // as Settings has them in use
    await press("Continue");
    expect(calls).toEqual([{ url: "/api/editor/styles", body: { name: "My way", first: true, versions: 2, size: { w: 1080, h: 1920 }, brollCollectionId: "col_1", steps: [{ id: "blur", values: { who: "everyone" } }] } }]);
    expect(done).toHaveBeenCalledOnce();
  });

  it("Rough cut only: no B-roll and no steps; with none installed, Full edit has one way to the plug-ins", async () => {
    await open({ styles: [], last: null }, async () => {});
    expect(document.querySelector('a[href="/community/tool/editor"]')).not.toBeNull();
    await press("Rough cut only");
    expect(document.querySelector('a[href="/community/tool/editor"]')).toBeNull();
    await press("Continue");
    expect(calls.at(-1)!.body).toEqual({ name: "My way", first: true, versions: 2, size: { w: 1080, h: 1920 }, brollCollectionId: null, steps: [] });
  });

  it("Edit in passes: what Full edit saves, with passes on", async () => {
    installed = { folders: [{ id: "col_1", name: "B-roll", parentId: null, kind: "manual", createdBy: "me" }], steps: [blur] };
    await open({ styles: [], last: null }, async () => {});
    await press("Edit in passes");
    await press("Continue");
    expect(calls.at(-1)!.body).toEqual({ name: "My way", first: true, versions: 2, size: { w: 1080, h: 1920 }, passes: true, brollCollectionId: "col_1", steps: [{ id: "blur", values: { who: "everyone" } }] });
  });

  it("Not now answers it without a style", async () => {
    const done = vi.fn(async () => {});
    await open({ styles: [], last: null }, done);
    await press("Not now");
    expect(calls).toEqual([{ url: "/api/editor/styles/asked", body: {} }]);
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("New edit: a script, nothing filmed", () => {
  const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  async function scriptMode() {
    await open(null);
    act(() => button("A script, nothing filmed").click());
    await flush();
    await flush();
  }
  async function type(id: string, value: string) {
    const el = field<HTMLTextAreaElement>(id)!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
  }
  const submit = async () => {
    act(() => void field<HTMLInputElement>("edit-name")!.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    await flush();
  };

  it("My footage is as it was; the script start has no clip picker, no optional script box and no versions", async () => {
    await open(null);
    expect(field("edit-spoken")).toBeNull();
    expect(document.querySelector('[aria-label="Footage"]')).not.toBeNull();
    act(() => button("A script, nothing filmed").click());
    await flush();
    expect(document.querySelector('[aria-label="Footage"]')).toBeNull();
    expect(field("edit-script")).toBeNull();
    expect(field("edit-versions")!.closest(".hidden")).not.toBeNull();
    act(() => button("My footage").click());
    await flush();
    expect(document.querySelector('[aria-label="Footage"]')).not.toBeNull();
    expect(field("edit-versions")!.closest(".hidden")).toBeNull();
  });

  it("opens on their own voice, waits for a script, speaks it first, and makes the edit from that recording with all their B-roll", async () => {
    await scriptMode();
    expect(field<HTMLSelectElement>("edit-voice")!.value).toBe("v_mine");
    expect([...document.querySelectorAll("#edit-voice optgroup")].map((g) => g.getAttribute("label"))).toEqual(["Your voices", "ElevenLabs voices"]);
    expect(button("Create and run").disabled).toBe(true);
    await type("edit-spoken", "Roll the mat out.");
    expect(button("Create and run").disabled).toBe(false);
    await submit();
    expect(calls.find((c) => c.url === "/api/editor/voice")!.body).toEqual({ text: "Roll the mat out.", voice: "v_mine" });
    expect(posted.at(-1)).toEqual({ sources: ["ver_voice"], brief: "", script: "Roll the mat out.", brollCollectionId: null });
    expect(calls.at(-1)!.url).toBe("/api/editor/edit_1/run");
  });

  it("opens on the voice used last; a voice with a sample can be listened to; a folder chosen is the edit's B-roll folder", async () => {
    voices = { ...voices!, last: "v_stock" };
    installed.folders = [{ id: "col_1", name: "Tumbling", kind: "manual" }];
    await scriptMode();
    expect(field<HTMLSelectElement>("edit-voice")!.value).toBe("v_stock");
    expect(document.querySelector("audio")!.getAttribute("src")).toBe("https://example.com/sam.mp3");
    await choose("edit-voice", "v_mine");
    expect(document.querySelector("audio")).toBeNull();
    await choose("edit-broll", "col_1");
    await type("edit-spoken", "Try it today.");
    await submit();
    expect(posted.at(-1)).toMatchObject({ sources: ["ver_voice"], brollCollectionId: "col_1" });
  });

  it("with no ElevenLabs key it says where to add one, and nothing can be made", async () => {
    voices = null;
    await scriptMode();
    expect(field("edit-voice")).toBeNull();
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "Add key")!;
    expect(link.getAttribute("href")).toBe("/settings/keys#api-key-ELEVENLABS_API_KEY");
    expect(link.parentElement!.textContent).toContain("Add your ElevenLabs key in Settings → API keys");
    await type("edit-spoken", "Roll the mat out.");
    expect(button("Create and run").disabled).toBe(true);
  });
});
