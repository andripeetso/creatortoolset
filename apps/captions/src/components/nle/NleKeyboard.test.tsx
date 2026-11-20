// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORK_PREFS } from "@contracts/work-prefs";
import { useWorkPrefs } from "@/lib/setup";
import { NleKeyboard } from "./NleKeyboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const puts: unknown[] = [];
beforeEach(() => {
  puts.length = 0;
  useWorkPrefs.setState({ prefs: { ...DEFAULT_WORK_PREFS } });
  // the server's answer is left out: what shows is the change made on the page
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => (puts.push(JSON.parse(String(init?.body))), new Response(null, { status: 500 }))));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const press = (key: string, code: string, more: KeyboardEventInit = {}) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, ...more })));
const click = (el: Element | null | undefined) => act(() => void (el as HTMLElement).click());
const row = (name: string) => document.querySelector(`[role="listitem"][aria-label="${name}"]`)!;
const chips = (name: string) => [...row(name).querySelectorAll("span.font-mono")].map((s) => s.textContent);
const keyCap = (chord: string) => document.querySelector(`[data-chord="${chord}"]`)!;
const keys = () => useWorkPrefs.getState().prefs!.keys ?? {};

async function open() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<NleKeyboard onClose={() => {}} />));
  await flush();
  return () => act(() => root.unmount());
}

const search = async (text: string) => {
  const input = document.querySelector('input[aria-label="Search commands"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Keyboard Customization", () => {
  it("searches the commands, gives one a key, and takes it off again", async () => {
    const done = await open();
    await search("close gap");
    expect([...document.querySelectorAll('[role="listitem"]')].map((r) => r.getAttribute("aria-label"))).toEqual(["Close Gap"]);
    await search("⌘T");
    expect([...document.querySelectorAll('[role="listitem"]')].map((r) => r.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Add a 1 s cross dissolve/)]);

    await search("close gap");
    await click(row("Close Gap").querySelector("button"));
    expect(row("Close Gap").textContent).toContain("Press keys");
    await press("g", "KeyG");
    expect(keys()).toEqual({ G: "closeGap" });
    expect(puts.at(-1)).toEqual({ keys: { G: "closeGap" } });
    expect(chips("Close Gap")).toEqual(["G"]);
    expect(keyCap("G").textContent).toContain("Close Gap");

    await click(document.querySelector('[aria-label="Remove G"]'));
    expect(keys()).toEqual({});
    expect(chips("Close Gap")).toEqual([]);
    done();
  });

  it("a key another command has shows red with that command's name; Assign moves it, Cancel leaves it", async () => {
    const done = await open();
    await search("close gap");
    await click([...row("Close Gap").querySelectorAll("button")].find((b) => b.textContent === "Add"));
    await press("t", "KeyT", { metaKey: true });
    expect(row("Close Gap").querySelector("[data-conflict]")?.textContent).toMatch(/^⌘T is Add a 1 s cross dissolve/);
    expect(keys()).toEqual({});
    await click([...row("Close Gap").querySelectorAll("button")].find((b) => b.textContent === "Assign"));
    expect(keys()).toEqual({ "⌘T": "closeGap" });
    await search("⌘T");
    expect([...document.querySelectorAll('[role="listitem"]')].map((r) => r.getAttribute("aria-label"))).toEqual(["Close Gap"]);

    // with ⌘ held on the drawn keyboard, T shows what it runs now
    await click(document.querySelector('[aria-label="Modifiers"] [title="Command"]'));
    expect(keyCap("⌘T").textContent).toContain("Close Gap");
    done();
  });

  it("the DaVinci Resolve preset: Q runs nothing, ⇧⌘[ ripples the start; Reset to preset drops the person's own", async () => {
    useWorkPrefs.setState({ prefs: { ...DEFAULT_WORK_PREFS, keys: { G: "closeGap" } } });
    const done = await open();
    expect(keyCap("Q").textContent).toContain("Ripple trim start");
    await click(document.querySelector('[role="radio"][value="resolve"]'));
    expect(useWorkPrefs.getState().prefs!.keyPreset).toBe("resolve");
    expect(puts.at(-1)).toEqual({ keyPreset: "resolve" });
    expect(keyCap("Q").textContent).toBe("Q");
    await search("ripple trim start");
    expect(chips("Ripple trim start to playhead")).toEqual(["⇧⌘["]);
    expect(keyCap("G").textContent).toContain("Close Gap");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Reset to preset"));
    expect(keys()).toEqual({});
    done();
  });
});
