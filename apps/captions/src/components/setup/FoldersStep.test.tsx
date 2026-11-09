import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FoldersStepView } from "./FoldersStep";

it("explains the folders in plain words and shows the folders it is given", () => {
  const html = renderToStaticMarkup(<FoldersStepView><p>FOLDERS-HERE</p></FoldersStepView>);
  expect(html).toContain("footage, music and finished videos");
  expect(html).toContain("marker file");
  expect(html).toContain("FOLDERS-HERE");
});
