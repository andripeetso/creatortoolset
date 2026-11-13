// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnimationStyle, EditingStyle } from "@contracts/editor-styles";
import { AnimationStyles, type OpenAnimation } from "./AnimationStyles";
import { EditingStyles } from "./EditingStyles";

// The Animation styles tab and its sheet, and the select an editing style picks one with. An empty tab is one button.
// A picture added to a style that is not saved yet waits, and goes up right after the style is made. Server stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sent: { method: string; url: string; body: unknown }[];
let mine: AnimationStyle[];
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

const blue: AnimationStyle = { id: "a_1", name: "Bold blue", brief: "Big white words on deep blue.", pictures: [{ id: "p_1", kind: "made", at: 1 }, { id: "p_2", kind: "inspiration", at: 2 }], createdAt: 0, updatedAt: 0 };
const cut: EditingStyle = { id: "s_a", name: "Fast and warm", notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, grade: null, brollCollectionId: null, steps: null, createdAt: 0, updatedAt: 0 };

beforeEach(() => {
  sent = [];
  mine = [blue];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method && init.method !== "GET") {
      const body = init.body instanceof FormData ? init.body.getAll("file").map((f) => (f as File).name) : JSON.parse((init.body as string) ?? "{}");
      sent.push({ method: init.method, url, body });
      return reply({ ...blue, id: "a_new", pictures: [], ...(init.body instanceof FormData ? {} : body) });
    }
    if (url === "/api/editor/animation-styles") return reply({ styles: mine });
    if (url === "/api/editor/defaults") return reply({ bundle: { designSystem: "plain", grade: "none", voiceMix: "level", sfxSet: "none" }, chosen: {}, items: { designSystem: [], grade: [], voiceMix: [], sfxSet: [] } });
    if (url === "/api/library") return reply({ libraries: [] });
    if (url === "/api/edit-steps") return reply({ steps: [], canAdd: false });
    return reply({});
  });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:waiting", revokeObjectURL: () => {} }));
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

const opened: OpenAnimation[] = [];
async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  await flush();
  await flush();
}
const tab = (styles: AnimationStyle[], open: OpenAnimation) => render(<AnimationStyles styles={styles} open={open} onOpen={(s) => opened.push(s)} onChanged={async () => {}} />);
async function type(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flush();
}
async function save(field: string) {
  act(() => void (document.getElementById(field) as HTMLInputElement).form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  await flush();
}

describe("Animation styles tab", () => {
  it("with no style it is the one button and nothing else", async () => {
    await tab([], null);
    expect(host!.textContent).toBe("New animation style");
    act(() => host!.querySelector("button")!.click());
    expect(opened.at(-1)).toBe("new");
  });

  it("each style is a card with its name, its brief and its pictures; a press opens it", async () => {
    await tab([blue], null);
    const card = host!.querySelector("li > button") as HTMLButtonElement;
    expect([...card.children].map((c) => c.textContent)).toEqual(["Bold blue", "Big white words on deep blue.", ""]);
    expect([...card.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/api/editor/animation-styles/a_1/pictures/p_1", "/api/editor/animation-styles/a_1/pictures/p_2"]);
    act(() => card.click());
    expect(opened.at(-1)).toEqual(blue);
  });
});

describe("The animation style sheet", () => {
  it("a saved style shows what was liked and what was added, each with its ×, and says nothing else", async () => {
    await tab([blue], blue);
    expect([...document.querySelectorAll("form h3")].map((h) => h.textContent)).toEqual(["Made & liked", "Inspirations"]);
    expect(document.querySelectorAll('form [aria-label="Take this picture out"]')).toHaveLength(2);
    expect(document.querySelector("form p")).toBeNull(); // no line of explanation
    act(() => (document.querySelector('[aria-label="Inspirations"] [aria-label="Take this picture out"]') as HTMLElement).click());
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: "DELETE", url: "/api/editor/animation-styles/a_1/pictures/p_2" });
  });

  it("a new style: a picture added before it is saved goes up right after the style is made", async () => {
    await tab([], "new");
    expect([...document.querySelectorAll("form h3")].map((h) => h.textContent)).toEqual(["Inspirations"]);
    await type("animation-name", "Paper");
    await type("animation-brief", "Torn paper, warm light.");
    const input = document.querySelector('[aria-label="Pictures from this computer"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "paper.png", { type: "image/png" }), new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(sent).toEqual([]); // nothing is sent before Save
    expect(document.querySelectorAll('form [aria-label="Take this picture out"]')).toHaveLength(1); // the text file is no picture
    await save("animation-name");
    expect(sent).toEqual([
      { method: "POST", url: "/api/editor/animation-styles", body: { name: "Paper", brief: "Torn paper, warm light." } },
      { method: "POST", url: "/api/editor/animation-styles/a_new/pictures", body: ["paper.png"] },
    ]);
    expect(opened.at(-1)).toBeNull(); // and the sheet closes
  });
});

describe("An editing style's Animation style", () => {
  const sheet = () => render(<EditingStyles styles={[cut]} open={cut} onOpen={() => {}} onChanged={async () => {}} />);

  it("is a select when the person has an animation style, and what is picked is sent", async () => {
    await sheet();
    const select = document.getElementById("style-animation") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["None", "Bold blue", "New animation style…"]);
    expect(select.value).toBe("");
    await type("style-animation", "a_1");
    await save("style-name");
    expect(sent.at(-1)).toMatchObject({ method: "PUT", url: "/api/editor/styles/s_a", body: { animation: "a_1" } });
  });

  it("a person with none: the select offers to make one, and nothing is sent about one until they do", async () => {
    mine = [];
    await sheet();
    const select = document.getElementById("style-animation") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["None", "New animation style…"]);
    await save("style-name");
    expect(sent.at(-1)!.body).not.toHaveProperty("animation");
  });

  it("New animation style… opens its sheet over this one; the style made there is the one picked and sent", async () => {
    mine = [];
    await sheet();
    await type("style-animation", "+new");
    await type("animation-name", "Paper");
    mine = [{ ...blue, id: "a_new", name: "Paper", pictures: [] }]; // what the list answers once it is made
    await save("animation-name");
    expect(sent.at(-1)).toMatchObject({ method: "POST", url: "/api/editor/animation-styles", body: { name: "Paper" } });
    expect(document.getElementById("animation-name")).toBeNull(); // its sheet closed
    expect((document.getElementById("style-animation") as HTMLSelectElement).value).toBe("a_new");
    await save("style-name");
    expect(sent.at(-1)).toMatchObject({ method: "PUT", url: "/api/editor/styles/s_a", body: { animation: "a_new" } });
  });
});
