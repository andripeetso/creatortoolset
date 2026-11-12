// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_PLACES, placeLabel } from "@contracts/skills";
import { SkillsView } from "./SkillsView";

// Community → Skills: one section per place a skill acts, headed with the tool's words, each with its Add button; the
// person's own skills with their switch and menu, the shared ones with where they come from. Server stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

const own = (id: string, name: string, extra: object = {}) => ({ id, name, when: "", body: "Text.", on: true, createdAt: 0, updatedAt: 0, ...extra });
async function render(list: { skills: object[]; shared: object[] }) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SkillsView />));
  await flush();
  await flush();
}
const section = (title: string) => [...host!.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === title)!;
const rows = (title: string) => [...section(title).querySelectorAll("[data-slot=switch], [aria-label^='Actions for']")].map((el) => el.getAttribute("aria-label"));

describe("Community → Skills", () => {
  it("with no skill it is the places' headings, each with Add, and nothing else", async () => {
    await render({ skills: [], shared: [] });
    expect([...host!.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(SKILL_PLACES.map(placeLabel));
    expect([...host!.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(SKILL_PLACES.map(() => "Add"));
    expect(host!.querySelectorAll("p")).toHaveLength(0);
  });

  it("files each skill under its place: a skill from before places under Assistant, shared ones with their source, and a script skill with no switch", async () => {
    await render({
      skills: [own("old", "Old hooks", { when: "When writing a hook" }), own("lines", "Own lines", { place: "captions.lines" }), own("script", "Own script", { place: "editor.script" })],
      shared: [
        { id: "pack:tiny-hooks:breaks", source: "community", from: "Tiny Hooks", place: "captions.lines", name: "Line breaks", text: "Text.", on: true },
        { id: "plugin:tiny-studio:endings", source: "plugin", from: "Tiny Studio", place: "editor.script", name: "Endings", text: "Text.", on: true },
      ],
    });
    expect(section("Assistant").textContent).toContain("Old hooksWhen writing a hook");
    const lines = section(placeLabel("captions.lines")).textContent!;
    expect(lines).toContain("Own lines");
    expect(lines).toContain("Line breaksCommunity: Tiny Hooks");
    expect(rows(placeLabel("captions.lines"))).toEqual(["Turn Own lines on or off", "Actions for Own lines", "Turn Line breaks on or off"]);
    expect(section(placeLabel("editor.script")).textContent).toContain("EndingsPlug-in: Tiny Studio");
    expect(rows(placeLabel("editor.script"))).toEqual(["Actions for Own script"]);
    // the caption lines and the script step have no project to tick
    expect(section(placeLabel("captions.lines")).querySelector('[aria-label="Used in"]')).toBeNull();
    expect(section("Assistant").querySelector('[aria-label="Used in"]')).not.toBeNull();
  });
});
