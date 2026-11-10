import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { ConnectAiRows, OtherComputerRows, type ConnectState } from "./OwnAiSection";

const row = (over: Partial<LocalAiRow> & Pick<LocalAiRow, "id" | "name">): LocalAiRow => ({
  kind: "cli", found: true, signedIn: true, connected: false, mcp: "off", ...over,
});

const idle: ConnectState = { busy: null, signing: null, failed: {}, signFailed: {} };
const render = (view: LocalAiView, state: Partial<ConnectState> = {}) =>
  renderToStaticMarkup(<ConnectAiRows view={view} state={{ ...idle, ...state }} onAdd={() => {}} onSignIn={() => {}} />);

it("a signed-in AI app offers Connect, never 'Sign in first' (the sign-in is already there)", () => {
  const html = render({ local: true, rows: [row({ id: "claude", name: "Claude Code" })] });
  expect(html).toContain("Connect");
  expect(html).not.toContain("Sign in to");
  expect(html).not.toContain("Not signed in");
});

it("a found AI app that is not signed in says so, with a Sign in button", () => {
  const html = render({ local: true, rows: [row({ id: "codex", name: "Codex", signedIn: false })] });
  expect(html).toContain("Not signed in");
  expect(html).toContain("Sign in</button>");
});

it("says Connected once the app is added, and shows Codex's update command as the line under it", () => {
  expect(render({ local: true, rows: [row({ id: "claude", name: "Claude Code", mcp: "added" })] })).toContain("Connected");
  const old = render({ local: true, rows: [row({ id: "codex", name: "Codex", mcp: "update", updateCommand: "npm install -g @openai/codex@latest" })] });
  expect(old).toContain("Needs an update first");
  expect(old).toContain("npm install -g @openai/codex@latest");
});

it("shows a failed add with Try again, and a failed sign-in with its reason", () => {
  const failed = render({ local: true, rows: [row({ id: "claude", name: "Claude Code" })] }, { failed: { claude: "the CLI said no" } });
  expect(failed).toContain("Couldn&#x27;t add it: the CLI said no");
  expect(failed).toContain("Try again");
  const signed = render({ local: true, rows: [row({ id: "codex", name: "Codex", signedIn: false })] }, { signFailed: { codex: "no browser" } });
  expect(signed).toContain("Couldn&#x27;t sign in: no browser");
});

it("on a hosted server lists the AI apps on the person's computers, signed in or not", () => {
  const html = renderToStaticMarkup(
    <OtherComputerRows
      others={[
        { id: "m1", name: "Jo's MacBook Air", online: true, drivers: [{ driver: "claude", installed: true, signedIn: true }, { driver: "codex", installed: true, signedIn: false }, { driver: "grok", installed: true }] },
      ]}
    />,
  );
  expect(html).toContain("Claude Code");
  expect(html).toContain("Connected");
  expect(html).toContain("Not signed in. Sign in on Jo&#x27;s MacBook Air.");
  expect(html).not.toContain("Grok");
});

it("leaves an offline computer out: its AI can't be reached, so it is not listed as connected", () => {
  const html = renderToStaticMarkup(
    <OtherComputerRows others={[{ id: "m2", name: "Office Mac mini", online: false, drivers: [{ driver: "codex", installed: true, signedIn: true }] }]} />,
  );
  expect(html).not.toContain("Office Mac mini");
  expect(html).not.toContain("Connected");
  expect(html).toContain("Connect your AI from the Mac app");
});

it("a hosted browser with no computer online says in one row what to do", () => {
  const html = renderToStaticMarkup(<OtherComputerRows others={[]} />);
  expect(html).toContain("Connect your AI from the Mac app");
});
