// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingStyle } from "@contracts/editor-styles";
import { EditingStyles, type OpenStyle } from "./EditingStyles";

// The Editing styles tab and its sheet. An empty tab is one button. The sheet draws a select only when there is
// something to choose (a second grade, a folder, a step this app has), and sends the grade and the steps only when
// they were changed here, so a style that says nothing about them follows the person's own defaults. Server stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let has: { grades: boolean; folders: boolean; steps: boolean };
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

describe("The style sheet", () => {
  it("a new style: the grade, the folder and the steps are drawn when there is a choice, and an untouched grade and steps are not sent", async () => {
    await render([], "new");
    expect(labels()).toEqual(["Name", "How should it be cut?", "Versions", "Target length (s)", "Pace", "Punch-in", "Grade", "B-roll folder", "What to blur", "How"]);
    expect(document.querySelector('[aria-label="Post-processing"]')).not.toBeNull();
    expect(field<HTMLSelectElement>("style-grade")!.value).toBe("none"); // the person's default grade is shown
    expect((document.querySelector('[role="switch"]') as HTMLElement).getAttribute("aria-checked")).toBe("true"); // and the steps in use
    await type("style-name", "Fast and warm");
    const made = await save();
    expect([made.method, made.url]).toEqual(["POST", "/api/editor/styles"]);
    expect(made.body).toEqual({ name: "Fast and warm", notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, brollCollectionId: null });
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
    expect(labels()).toEqual(["Name", "How should it be cut?", "Versions", "Target length (s)", "Pace", "Punch-in"]);
    expect(document.querySelector('[aria-label="Post-processing"]')).toBeNull();
    expect(Object.keys((await save()).body).sort()).toEqual(["name", "notes", "pace", "punch", "targetS", "versions"]);
  });
});
