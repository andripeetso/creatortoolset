// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { entryOf, macUpdateLevel, UpdateButton } from "./NewVersionPill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  delete document.documentElement.dataset.macUpdate;
  vi.unstubAllGlobals();
});

it("reads the built entry script from index.html", () => {
  expect(entryOf('<script>x</script><script type="module" crossorigin src="./assets/app-0jKjV6-u.js"></script>')).toBe("app-0jKjV6-u.js");
  expect(entryOf("<html></html>")).toBeNull();
});

it("offers a held Mac update in the corner, and as a card once it waited a day or is critical", () => {
  const u = { version: "1.2.0", critical: false, since: 0, waiting: false };
  expect(macUpdateLevel(null, 0)).toBe("none");
  expect(macUpdateLevel(u, 23 * 3600_000)).toBe("button");
  expect(macUpdateLevel(u, 24 * 3600_000)).toBe("card");
  expect(macUpdateLevel({ ...u, critical: true }, 0)).toBe("card");
});

it("asks the Mac app to restart onto the update it holds, and shows the update the app reports later", () => {
  const sent: string[] = [];
  vi.stubGlobal("webkit", { messageHandlers: { window: { postMessage: (m: string) => sent.push(m) } } });
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(UpdateButton)));
  expect(host.textContent).toBe(""); // nothing held, no deploy
  document.documentElement.dataset.macUpdate = JSON.stringify({ version: "1.2.0", critical: false, since: Date.now(), waiting: false });
  act(() => void window.dispatchEvent(new Event("mac-update")));
  expect(host.textContent).toBe("Restart to update");
  act(() => host.querySelector("button")!.click());
  expect(sent).toEqual(["update-install"]);
  act(() => root.unmount());
});
