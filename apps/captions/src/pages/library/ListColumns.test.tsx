// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssetCard, LibrarySort } from "@contracts/library";
import type { LibraryFilters } from "@/lib/library";
import { AssetRow } from "./ClipCards";
import { WhenPicker } from "./Filters";
import { ListHeader, SortControls } from "./SortControls";

// The list view's columns (11-19, Andri): a header sorts with the same one stored sort as Sort by, and the From/To days
// say "Any date" until one is picked (an empty WebKit date field shows today's).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (b: HTMLElement) => act(() => b.click());

describe("the list's headers", () => {
  const stored: LibrarySort[] = [];
  function Page() {
    const [sort, setSort] = useState<LibrarySort>("filmed");
    const onSort = (s: LibrarySort) => (stored.push(s), setSort(s));
    return (
      <>
        <SortControls sort={sort} onSort={onSort} />
        <ListHeader sort={sort} onSort={onSort} />
      </>
    );
  }

  it("a header sets the one stored sort, as Sort by shows it; a second click turns the order, as the order button does", () => {
    act(() => root.render(<Page />));
    click(button("Sort by Name"));
    expect(stored.at(-1)).toBe("name");
    expect(button("Sort by Name").textContent).toContain("Name"); // the menu's button: the same key
    expect(button("Name, A → Z")).toBeTruthy(); // the header: sorted, its arrow
    click(button("Name, A → Z"));
    expect(stored.at(-1)).toBe("name-za");
    expect(button("Z → A")).toBeTruthy(); // the order button agrees
    click(button("Sort by Size"));
    expect(stored.at(-1)).toBe("biggest");
    expect(host.querySelector('[aria-sort="descending"]')?.textContent).toBe("Size");
    // Roll has no order on the server: a label, not a button
    expect(button("Sort by Roll")).toBeNull();
  });

  it("a row fills the columns: dates, length, size, kind and roll", () => {
    const clip: AssetCard = {
      id: "a1", libraryId: "lib", kind: "video", title: "Tiny Acrobatics take 1", versionId: "v1", versionN: 1, durationS: 64,
      capturedAt: new Date(2026, 10, 2).getTime(), addedAt: new Date(2026, 10, 19).getTime(), bytes: 52_400_000, roll: "b", tags: [], aiTags: [], state: "ready",
    };
    act(() => root.render(<AssetRow asset={clip} onOpen={() => {}} />));
    const text = host.textContent!;
    expect(text).toContain("1:04");
    expect(text).toContain("52 MB");
    expect(text).toContain("Video");
    expect(text).toContain("B-roll");
    expect(text).toContain("2026");
  });
});

describe("From and To", () => {
  function When() {
    const [value, setValue] = useState<LibraryFilters>({});
    return (
      <>
        <WhenPicker value={value} onChange={(w) => setValue({ ...value, ...w })} />
        <output>{JSON.stringify(value)}</output>
      </>
    );
  }
  const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label} date"]`)!;
  const pick = (label: string, v: string) =>
    act(() => {
      const input = field(label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("empty, each says Any date and no day; a picked day shows, and × clears it and the filter", () => {
    act(() => root.render(<When />));
    expect(host.textContent!.match(/Any date/g)).toHaveLength(2);
    expect(host.textContent).not.toContain(String(new Date().getFullYear()));
    expect(button("Clear From date")).toBeNull();
    pick("From", "2026-11-02");
    expect(host.textContent!.match(/Any date/g)).toHaveLength(1);
    expect(host.textContent).toContain("2026");
    expect(JSON.parse(host.querySelector("output")!.textContent!).filmedFrom).toBe(new Date(2026, 10, 2).getTime());
    click(button("Clear From date"));
    expect(host.textContent!.match(/Any date/g)).toHaveLength(2);
    expect(JSON.parse(host.querySelector("output")!.textContent!).filmedFrom).toBeUndefined();
  });
});
