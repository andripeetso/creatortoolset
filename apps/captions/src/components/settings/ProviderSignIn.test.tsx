import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "@contracts/providers";
import { ProviderDetail } from "./ProviderDetail";

const inst: ProviderInstance = { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" };
const base = {
  inst,
  status: { tone: "warning" as const, text: "Not signed in" },
  checking: false,
  canCheck: true,
  used: [],
  onChange: () => {},
  onCheck: () => {},
  onRemove: () => {},
};

describe("ProviderDetail sign-in button", () => {
  it("shows Sign in next to Check only when the page is given a sign-in action", () => {
    expect(renderToStaticMarkup(<ProviderDetail {...base} onSignIn={() => {}} />)).toContain(">Sign in<");
    expect(renderToStaticMarkup(<ProviderDetail {...base} />)).not.toContain(">Sign in<");
  });
});
