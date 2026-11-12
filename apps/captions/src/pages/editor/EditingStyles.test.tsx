// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingStyle } from "@contracts/editor-styles";
import { duplicateStyle, EditingStyles, type OpenStyle } from "./EditingStyles";

// The Editing styles tab and its sheet. An empty tab is one button. The sheet draws a select only when there is
// something to choose (a second grade, a folder, a step this app has), and sends the grade and the steps only when
// they were changed here, so a style that says nothing about them follows the person's own defaults. Server stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let has: { grades: boolean; folders: boolean; steps: boolean; skills?: object[]; shared?: object[]; finished?: object[] };
let sent: { method: string; url: string; body: Record<string, unknown> }[];
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

const style: EditingStyle = { id: "s_a", name: "Fast and warm", notes: "Short lines.\nNo intro.", versions: 2, targetS: 30, pace: "natural", punch: 1.3, grade: null, brollCollectionId: null, steps: null, createdAt: 0, updatedAt: 0 };
const blur = {
  id: "blur", title: "Blur faces", about: "", state: "on", use: true, values: { who: "everyone except me", how: "blur" },
  options: [
    { id: "who", label: "What to blur", kind: "text", default: "everyone except me" },
    { id: "how", label: "How", kind: "choice", default: "blur", choices: [{ value: "blur", label: "Blur" }, { value: "pixels", label: "Pixels" }] },
  ],
};

beforeEach(() => {
  has = { grades: true, folders: true, steps: true };
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method && init.method !== "GET") {
      const body = JSON.parse((init.body as string) ?? "{}");
      sent.push({ method: init.method, url, body });
      return reply({ ...style, ...body });
    }
    const one = [{ id: "none", title: "No grade", from: null }];
    if (url === "/api/editor/defaults")
      return reply({ bundle: { designSystem: "plain", grade: "none", voiceMix: "level", sfxSet: "none" }, chosen: {}, items: { designSystem: [], grade: has.grades ? [...one, { id: "warm", title: "Warm", from: "Tiny looks" }] : one, voiceMix: [], sfxSet: [] } });
    if (url === "/api/library") return reply({ libraries: [{ id: "lib_1", name: "Tiny Acrobatics" }] });
    if (url.includes("/collections")) return reply({ collections: has.folders ? [{ id: "col_1", name: "B-roll", parentId: null, kind: "manual", createdBy: "me" }] : [] });
    if (url === "/api/edit-steps") return reply({ steps: has.steps ? [blur] : [], canAdd: false });
    if (url === "/api/skills") return reply({ skills: has.skills ?? [], shared: has.shared ?? [] });
    if (url.endsWith("/finished")) return reply(has.finished ?? []);
    return reply({});
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

const opened: OpenStyle[] = [];
async function render(styles: EditingStyle[], open: OpenStyle) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<EditingStyles styles={styles} open={open} onOpen={(s) => opened.push(s)} onChanged={async () => {}} />));
  await flush();
  await flush();
}
const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const labels = () => [...document.querySelectorAll("form label")].map((l) => l.textContent?.trim());
async function type(id: string, value: string) {
  const el = field<HTMLInputElement | HTMLSelectElement>(id)!;
  act(() => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flush();
}
async function save() {
  act(() => void field<HTMLInputElement>("style-name")!.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  await flush();
  return sent.at(-1)!;
}

describe("Editing styles tab", () => {
  it("with no style it is the one button and nothing else", async () => {
    await render([], null);
    expect(host!.textContent).toBe("New editing style");
    act(() => host!.querySelector("button")!.click());
    expect(opened.at(-1)).toBe("new");
  });

  it("each style is a card with its name, what it sets and its notes; a press opens it", async () => {
    await render([style], null);
    const card = host!.querySelector("li > button") as HTMLButtonElement;
    expect([...card.children].map((c) => c.textContent)).toEqual(["Fast and warm", "Natural · 2 versions · 30 s", "Short lines.\nNo intro."]);
    expect(host!.querySelector('[aria-label="More for Fast and warm"]')).not.toBeNull();
    act(() => card.click());
    expect(opened.at(-1)).toEqual(style);
  });
});

describe("Duplicate", () => {
  it("copies every choice under a new name, with no id of the old one", async () => {
    await duplicateStyle({ ...style, grade: "warm", steps: [{ id: "blur", values: { how: "pixels" } }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ name: "Fast and warm copy", notes: "Short lines.\nNo intro.", versions: 2, targetS: 30, pace: "natural", punch: 1.3, grade: "warm", brollCollectionId: null, steps: [{ id: "blur", values: { how: "pixels" } }] });
  });

  it("a style whose B-roll folder was deleted since is copied without the folder", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (init?.method === "POST" && body.brollCollectionId === "col_gone") {
        sent.push({ method: "POST", url, body });
        return new Response(JSON.stringify({ error: "No such folder in your Media Library" }), { status: 400 });
      }
      return real(url, init);
    });
    await duplicateStyle({ ...style, brollCollectionId: "col_gone" });
    expect(sent.map((x) => x.body.brollCollectionId)).toEqual(["col_gone", null]);
    expect(sent[1]!.body).toMatchObject({ name: "Fast and warm copy", pace: "natural" });
  });
});

describe("The style sheet", () => {
  it("a new style: the grade, the folder and the steps are drawn when there is a choice, and an untouched grade and steps are not sent", async () => {
    await render([], "new");
    expect(labels()).toEqual(["Name", "How should it be cut?", "Versions", "Target length (s)", "Pace", "Punch-in", "Working size", "Grade", "B-roll folder", "What to blur", "How"]);
    expect(field<HTMLSelectElement>("style-size")!.value).toBe("1080x1920"); // a new style works in vertical HD
    expect(document.querySelector('[aria-label="Post-processing"]')).not.toBeNull();
    expect(field<HTMLSelectElement>("style-grade")!.value).toBe("none"); // the person's default grade is shown
    expect((document.querySelector('[role="switch"]') as HTMLElement).getAttribute("aria-checked")).toBe("true"); // and the steps in use
    await type("style-name", "Fast and warm");
    const made = await save();
    expect([made.method, made.url]).toEqual(["POST", "/api/editor/styles"]);
    expect(made.body).toEqual({ name: "Fast and warm", notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, size: { w: 1080, h: 1920 }, brollCollectionId: null });
  });

  it("what is changed here is sent: the grade, the folder, a step's value, a step switched off", async () => {
    await render([style], style);
    expect(field<HTMLInputElement>("style-name")!.value).toBe("Fast and warm");
    await type("style-grade", "warm");
    await type("style-broll", "col_1");
    await type("style-step-blur-how", "pixels");
    let put = await save();
    expect([put.method, put.url]).toEqual(["PUT", "/api/editor/styles/s_a"]);
    expect(put.body).toMatchObject({ name: "Fast and warm", pace: "natural", punch: 1.3, grade: "warm", brollCollectionId: "col_1", steps: [{ id: "blur", values: { who: "everyone except me", how: "pixels" } }] });
    act(() => (document.querySelector('[role="switch"]') as HTMLElement).click());
    await flush();
    expect(field("style-step-blur-how")).toBeNull(); // a step that is off shows no options
    put = await save();
    expect(put.body.steps).toEqual([]);
  });

  it("a step the style has that this app does not is kept when another one changes", async () => {
    const withGone = { ...style, steps: [{ id: "voice-since-removed", values: { level: "-16" } }] };
    await render([withGone], withGone);
    expect((document.querySelector('[role="switch"]') as HTMLElement).getAttribute("aria-checked")).toBe("false");
    act(() => (document.querySelector('[role="switch"]') as HTMLElement).click());
    await flush();
    expect((await save()).body.steps).toEqual([{ id: "voice-since-removed", values: { level: "-16" } }, { id: "blur", values: { who: "everyone except me", how: "blur" } }]);
  });

  it("with one grade, no folder and no step in this app, none of the three is drawn or sent", async () => {
    has = { grades: false, folders: false, steps: false };
    await render([style], style);
    expect(labels()).toEqual(["Name", "How should it be cut?", "Versions", "Target length (s)", "Pace", "Punch-in", "Working size"]);
    expect(document.querySelector('[aria-label="Post-processing"]')).toBeNull();
    expect(Object.keys((await save()).body).sort()).toEqual(["name", "notes", "pace", "punch", "size", "targetS", "versions"]);
  });

  it("the working size: a style with none shows From the footage and sends null; a size picked is sent as it is", async () => {
    await render([style], style);
    const sel = field<HTMLSelectElement>("style-size")!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["1080×1920 (vertical HD)", "2160×3840 (vertical 4K)", "From the footage"]);
    expect(sel.value).toBe("footage");
    expect((await save()).body.size).toBeNull();
    await type("style-size", "2160x3840");
    expect((await save()).body.size).toEqual({ w: 2160, h: 3840 });
  });
});

describe("The style sheet: a skill, and the edits finished with the style", () => {
  const skill = (id: string, name: string, extra: object = {}) => ({ id, name, when: "When it fits.", body: "Text.", on: true, createdAt: 0, updatedAt: 0, ...extra });
  const section = () => document.querySelector('[aria-label="Finished with this style"]');

  const script = { place: "editor.script", when: "" };
  it("the Skill select lists the AI Editor script skills, the person's own and the ones from Community and plug-ins; the one picked is sent, None sends null", async () => {
    has.skills = [skill("sk_hooks", "Hooks", script), skill("sk_dock", "For the assistant"), skill("sk_lines", "Caption lines", { place: "captions.lines" }), skill("sk_ends", "Endings", script)];
    has.shared = [
      { id: "pack:tiny-hooks:openers", source: "community", from: "Tiny Hooks", place: "editor.script", name: "Openers", text: "Text.", on: true },
      { id: "plugin:tiny-studio:lines", source: "plugin", from: "Tiny Studio", place: "captions.lines", name: "Short lines", text: "Text.", on: true },
    ];
    const named = { ...style, skill: "sk_ends" };
    await render([named], named);
    expect(labels()).toContain("Skill");
    const sel = field<HTMLSelectElement>("style-skill")!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["None", "Hooks", "Endings", "Openers"]);
    expect(sel.value).toBe("sk_ends");
    await type("style-skill", "pack:tiny-hooks:openers");
    expect((await save()).body.skill).toBe("pack:tiny-hooks:openers");
    await type("style-skill", "sk_hooks");
    expect((await save()).body.skill).toBe("sk_hooks");
    await type("style-skill", "");
    expect((await save()).body.skill).toBeNull();
  });

  it("with no AI Editor script skill there is no Skill select, and the style's skill is left as it is", async () => {
    has.skills = [skill("sk_dock", "For the assistant"), skill("sk_off", "Switched off", { ...script, on: false })];
    const named = { ...style, skill: "sk_off" };
    await render([named], named);
    expect(labels()).not.toContain("Skill");
    expect("skill" in (await save()).body).toBe(false);
  });

  it("a style that names a skill from before skills had a place (now the assistant's) shows it with None, so it can be taken off", async () => {
    has.skills = [skill("sk_old", "Old hooks"), skill("sk_dock", "For the assistant")];
    const named = { ...style, skill: "sk_old" };
    await render([named], named);
    const sel = field<HTMLSelectElement>("style-skill")!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["None", "Old hooks"]);
    expect(sel.value).toBe("sk_old");
    await type("style-skill", "");
    expect((await save()).body.skill).toBeNull();
  });

  it("a style that names a skill switched off for now keeps it through a Save that does not touch the select", async () => {
    has.skills = [skill("sk_hooks", "Hooks", script), skill("sk_off", "Switched off", { ...script, on: false })];
    const named = { ...style, skill: "sk_off" };
    await render([named], named);
    expect(field<HTMLSelectElement>("style-skill")!.value).toBe(""); // shown as None: an edit made now would get none
    await type("style-name", "Renamed");
    const put = await save();
    expect(put.body.name).toBe("Renamed");
    expect("skill" in put.body).toBe(false);
  });

  it("the finished edits are listed under Save, each with an ×; a press takes one off at once", async () => {
    has.finished = [
      { editId: "e_two", variant: "v1", name: "Tiny Acrobatics hook", at: Date.UTC(2026, 10, 11, 12), brief: "", targetS: 45, seconds: 41, said: "Said.", cut: [] },
      { editId: "e_one", variant: "v2", name: "", at: Date.UTC(2026, 10, 9, 12), brief: "", targetS: 0, seconds: 0, said: "Said.", cut: [] },
    ];
    await render([style], style);
    const day = (ms: number) => new Date(ms).toLocaleDateString();
    expect(section()!.querySelector("h3")!.textContent).toBe("Finished with this style");
    // a name, how long it came out and the day; one with no name of the person's own shows its day
    expect([...section()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([`Tiny Acrobatics hook41 s · ${day(Date.UTC(2026, 10, 11, 12))}`, day(Date.UTC(2026, 10, 9, 12))]);
    // it is below the Save button, and nothing explains it
    const save = [...document.querySelectorAll("form button")].find((b) => b.textContent?.trim() === "Save")!;
    expect(save.compareDocumentPosition(section()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section()!.querySelector("p")).toBeNull();

    act(() => (section()!.querySelector('[aria-label="Remove Tiny Acrobatics hook from the finished edits"]') as HTMLElement).click());
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: "/api/editor/styles/s_a/finished/e_two" });
    expect(section()!.querySelectorAll("li")).toHaveLength(1);
    act(() => (section()!.querySelector("li button") as HTMLElement).click());
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: "/api/editor/styles/s_a/finished/e_one" });
    expect(section()).toBeNull(); // an empty list is not shown
  });

  it("a style with no finished edit, and a new style, show no such list", async () => {
    await render([style], style);
    expect(section()).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    has.finished = [{ editId: "e", variant: "v1", name: "Of another style", at: 0, brief: "", targetS: 0, seconds: 1, said: "x", cut: [] }];
    await render([], "new");
    expect(section()).toBeNull();
  });
});
