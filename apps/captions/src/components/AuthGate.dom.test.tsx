// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A server that asks for a sign-in: the Mac app's window gets the form, a plain browser the way to the app.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AuthGate } = await import("./AuthGate");

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.startsWith("/api/auth/check")
          ? { required: true, authed: false, user: null, kind: "server", viewedBy: null, mustLink: null }
          : { apple: false, google: true, github: false, password: true },
      ),
    ),
  );
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.macThisMac;
  vi.unstubAllGlobals();
});

const open = async (path: string) => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthGate>
          <p>tool pages</p>
        </AuthGate>
      </MemoryRouter>,
    );
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  return host.textContent ?? "";
};

it("gives a plain browser the way to the app and no sign-in", async () => {
  const text = await open("/library");
  expect(text).toContain("Open in the app");
  expect(text).not.toContain("Continue with");
  expect(host.querySelector("input")).toBeNull();
  expect(text).not.toContain("tool pages");
  expect(host.querySelector("a")?.getAttribute("href")).toMatch(/^creatortoolset:\/\//);
});

it("gives the Mac app's window the sign-in form", async () => {
  document.documentElement.dataset.macThisMac = "1";
  const text = await open("/library");
  expect(text).toContain("Continue with Google");
  expect(text).not.toContain("Open in the app");
});

it("leaves a share link open to a plain browser", async () => {
  expect(await open("/r/11111111-2222-3333-4444-555555555555")).toContain("tool pages");
});
