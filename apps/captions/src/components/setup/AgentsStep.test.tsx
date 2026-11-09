import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentsStepView } from "./AgentsStep";

const mine = <p>MINE-PANEL</p>;

it("puts this computer's panel first, then one section per other computer", () => {
  const html = renderToStaticMarkup(
    <AgentsStepView
      here="Studio Mac"
      mine={mine}
      others={[
        { id: "a", name: "Workshop PC", online: true, drivers: [{ driver: "claude", installed: true, signedIn: true }, { driver: "codex", installed: false }] },
        { id: "b", name: "ARCHIVE", online: false, drivers: [] },
      ]}
    />,
  );
  expect(html.indexOf("Studio Mac")).toBeLessThan(html.indexOf("MINE-PANEL"));
  expect(html.indexOf("MINE-PANEL")).toBeLessThan(html.indexOf("Workshop PC"));
  expect(html).toContain("Claude");
  expect(html).toContain("Ready");
  expect(html).toContain("Not found");
  expect(html).toContain("Nothing reported yet");
});

it("shows only this computer's panel when there are no other computers", () => {
  const html = renderToStaticMarkup(<AgentsStepView here="Studio Mac" mine={mine} others={[]} />);
  expect(html).toContain("MINE-PANEL");
  expect(html).not.toContain("Install and sign-in");
});
