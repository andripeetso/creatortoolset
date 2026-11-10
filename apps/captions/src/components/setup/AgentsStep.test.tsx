import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentsStepView } from "./AgentsStep";
import { HERE } from "./ConnectStep";

const mine = <p>MINE-PANEL</p>;
const others = [
  { id: "a", name: "Workshop PC", online: true, drivers: [{ driver: "claude", installed: true, signedIn: true }, { driver: "codex", installed: false }] },
  { id: "b", name: "ARCHIVE", online: false, drivers: [] },
];
const render = (over: Partial<Parameters<typeof AgentsStepView>[0]> = {}) =>
  renderToStaticMarkup(<AgentsStepView here="Studio Mac" mine={mine} others={others} picked={new Set([HERE, "a", "b"])} {...over} />);

it("shows one section per picked computer: this computer's panel first, then the others it reports", () => {
  const html = render();
  expect(html.indexOf("Studio Mac")).toBeLessThan(html.indexOf("MINE-PANEL"));
  expect(html.indexOf("MINE-PANEL")).toBeLessThan(html.indexOf("Workshop PC"));
  expect(html).toContain("Claude Code");
  expect(html).toContain("Nothing reported yet.");
});

it("leaves out any computer that is not picked on the Connect step", () => {
  const html = render({ picked: new Set([HERE]) });
  expect(html).toContain("MINE-PANEL");
  expect(html).not.toContain("Workshop PC");
  expect(html).not.toContain("ARCHIVE");
});

it("says nothing is picked when no computer is", () => {
  expect(render({ picked: new Set() })).toContain("No computer is picked");
});

it("leaves this server's own section out on a hosted server, and shows the person's computers only", () => {
  const html = render({ hosted: true });
  expect(html).not.toContain("MINE-PANEL");
  expect(html).toContain("Workshop PC");
});

it("gives a computer that has no agent the vendor's line to paste there, and nothing for one where Claude is ready", () => {
  const html = render({
    others: [
      { id: "a", name: "Workshop PC", online: true, drivers: [{ driver: "claude", installed: false }] },
      { id: "b", name: "Mac Studio", online: true, drivers: [{ driver: "claude", installed: true, signedIn: true }] },
    ],
    picked: new Set(["a", "b"]),
  });
  expect(html).toContain("paste this line into a Terminal there");
  expect(html).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(html).toContain('aria-label="Claude Code is ready on Mac Studio"');
});

it("never shows an API key on this step", () => {
  expect(render()).not.toMatch(/api key/i);
});
