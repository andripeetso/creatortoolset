// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { useImportQueue, resetImportQueue, type QueueItem } from "@/lib/import-queue";
import { ImportIndicator } from "./ImportIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (key: number, status: QueueItem["status"]): QueueItem => ({ key, libraryId: "lib", mac: false, file: new File(["x"], `Tiny ${key}.mp4`), sent: 0, status });
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = "";
  resetImportQueue();
});
const at = (path: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter initialEntries={[path]}><ImportIndicator /></MemoryRouter>));
  return host;
};

describe("the top bar's import line", () => {
  it("shows anywhere but the Library while an import goes in, and is gone when it is done", () => {
    useImportQueue.setState({ items: [item(1, "uploading"), item(2, "added")], startedAt: Date.now(), usd: null });
    expect(at("/editor").textContent).toContain("Adding 2 clips · 1 done");
    act(() => useImportQueue.setState({ items: [item(1, "added"), item(2, "added")] }));
    expect(document.body.textContent).toBe("");
  });
  it("says nothing on the Library page, which has its own line", () => {
    useImportQueue.setState({ items: [item(1, "uploading")], startedAt: Date.now(), usd: null });
    expect(at("/library").textContent).toBe("");
  });
});
