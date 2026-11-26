// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A server that asks for a sign-in: a plain browser gets the sign-in form too, and a share link needs none (AGENTS.md,
// "The browser is for viewing").

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

it("gives a plain browser the sign-in form", async () => {
  const text = await open("/library");
  expect(text).toContain("Continue with Google");
  expect(text).toContain("Use a password instead");
  expect(text).not.toContain("tool pages");
});

it("leaves a share link open to a plain browser", async () => {
  expect(await open("/r/11111111-2222-3333-4444-555555555555")).toContain("tool pages");
});
