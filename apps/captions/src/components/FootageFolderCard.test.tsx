// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FootageFolderCard } from "./FootageFolderCard";

// The empty Media Library's first screen: the owner gets Set up (which opens the setup sheet) and Upload files; a member
// gets Upload files only. No folder picker, no skip, no Copies card. The watch status is stubbed: only the owner gets one.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let watchStatus: number;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let where = "";

const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

beforeEach(() => {
  watchStatus = 200;
  where = "";
  localStorage.clear(); // the saved copy of the watch status would answer for the last test
  vi.stubGlobal("fetch", async () =>
    watchStatus === 200 ? new Response(JSON.stringify({ allowed: true, folders: [], missing: 0 }), { status: 200 }) : new Response("{}", { status: watchStatus }),
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}

async function render(props: { onUpload?: () => void; page?: boolean; needsSetup?: boolean } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={["/library"]}>
        <Where />
        <FootageFolderCard libraryId="lib_1" {...props} />
      </MemoryRouter>,
    );
  });
  await flush();
}

const buttons = () => [...host!.querySelectorAll("button")].map((b) => b.textContent?.trim());
const click = async (label: string) => {
  const b = [...host!.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  act(() => b.click());
  await flush();
};

describe("the empty Media Library", () => {
  it("the owner gets Set up and Upload files, and no folder picker or Copies card", async () => {
    await render({ page: true });
    expect(buttons()).toEqual(["Set up", "Upload files"]);
    expect(host!.textContent).toContain("No clips");
    expect(host!.textContent).not.toContain("Choose a folder");
    expect(host!.textContent).not.toContain("Copies");
  });

  it("Set up opens the setup sheet on /library?setup=1", async () => {
    await render({ page: true });
    await click("Set up");
    expect(where).toBe("/library?setup=1");
  });

  it("a member gets Upload files only, and Upload files calls the page's picker", async () => {
    watchStatus = 403; // only the owner gets the watch status
    const onUpload = vi.fn();
    await render({ page: true, onUpload });
    expect(buttons()).toEqual(["Upload files"]);
    await click("Upload files");
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("an owner whose library is already set up gets Upload files only: Set up is for a library not set up yet", async () => {
    await render({ page: true, needsSetup: false });
    expect(buttons()).toEqual(["Upload files"]);
  });

  it("draws nothing until the owner's status is known or refused", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {})); // never answers
    await render({ page: true });
    expect(host!.querySelector('[aria-label="Empty library"]')).toBeNull();
  });
});
