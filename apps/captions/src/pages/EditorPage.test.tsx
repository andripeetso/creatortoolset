// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingStyle, EditingStylesView } from "@contracts/editor-styles";
import { NewEditSheet } from "./EditorPage";

// New edit and editing styles: an account with no style sees no Style select and sends what it always sent; with
// styles the sheet opens on the one used last, fills the fields it sets, and says which one the edit is made with.
// The server is stubbed: one library, one ready clip.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/setup", () => ({ confirmHeavy: async () => true, openToolSetup: () => {} }));
vi.mock("@/components/FootageFolderCard", () => ({ FootageFolderCard: () => null }));

let posted: Record<string, unknown>[];
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

const style = (id: string, name: string, more: Partial<EditingStyle> = {}): EditingStyle => ({
  id, name, notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, grade: null, brollCollectionId: null, steps: null, createdAt: 0, updatedAt: 0, ...more,
});

beforeEach(() => {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method === "POST" && url === "/api/editor") {
      posted.push(JSON.parse(init.body as string));
      return reply({ id: "edit_1" });
    }
    if (init?.method === "POST") return reply({});
    if (url === "/api/library") return reply({ libraries: [{ id: "lib_1", name: "Tiny Acrobatics" }] });
    if (url.includes("/collections")) return reply({ collections: [] });
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

async function open(styles: EditingStylesView | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <NewEditSheet open onClose={() => {}} styles={styles} />
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
