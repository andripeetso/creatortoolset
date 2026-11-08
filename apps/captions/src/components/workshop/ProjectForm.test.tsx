import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectForm, setupProjectFields } from "./ProjectForm";

describe("setupProjectFields", () => {
  it("keeps the name, colour and handles that have text, trimmed, and never sends an account", () => {
    const out = setupProjectFields(
      { name: "  My brand  ", color: "violet" },
      { instagram: "  @tinyacrobatics ", tiktok: "   ", youtube: "" },
    );
    expect(out).toEqual({ name: "My brand", audience: "", voice: "", cta: "", notes: "", color: "violet", handles: { instagram: "@tinyacrobatics" } });
    expect(out).not.toHaveProperty("accountId");
  });

  it("sends empty handles when none are ticked", () => {
    expect(setupProjectFields({ name: "A" }, {}).handles).toEqual({});
  });
});

describe("ProjectForm variant setup", () => {
  const setupHtml = renderToStaticMarkup(<ProjectForm variant="setup" formId="setup-project" busy={false} onSave={() => {}} />);
  const fullHtml = renderToStaticMarkup(<ProjectForm busy={false} onSave={() => {}} />);

  it("shows the name, colour and where-you-post chips, with the helper line", () => {
    expect(setupHtml).toContain("Where do you post?");
    expect(setupHtml).toContain("Instagram");
    expect(setupHtml).toContain("Only the handle is saved. Nothing is fetched.");
    expect(setupHtml).toContain('placeholder="My brand"');
    expect(setupHtml).toContain('id="setup-project"');
  });

  it("hides Sync, My Instagram, Instructions and knowledge", () => {
    expect(setupHtml).not.toContain("Sync");
    expect(setupHtml).not.toContain("My Instagram");
    expect(setupHtml).not.toContain("Instructions");
    expect(setupHtml).not.toContain("Knowledge, frameworks and rules");
  });

  it("leaves the Workshop's own form as it was", () => {
    expect(fullHtml).toContain("My Instagram");
    expect(fullHtml).toContain("Sync");
    expect(fullHtml).toContain("Instructions");
    expect(fullHtml).not.toContain("Where do you post?");
    expect(fullHtml).toContain('placeholder="Tiny Acrobatics"');
  });
});
