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

  it("the Projects form asks for no handle: accounts are connected once it's made, and the instructions can be written for you", () => {
    expect(fullHtml).not.toContain("My Instagram");
    expect(fullHtml).not.toContain("Sync");
    expect(fullHtml).not.toContain("@yourhandle");
    expect(fullHtml).toContain("Accounts");
    expect(fullHtml).toContain("Settings → Social accounts");
    expect(fullHtml).toContain("Instructions");
    expect(fullHtml).toContain("Write it for me");
    expect(fullHtml).not.toContain("Where do you post?");
    // no sample name in the box: the label says what goes there
    expect(fullHtml).not.toContain("Tiny Acrobatics");
  });

  it("no knowledge, framework or rule switches, for a new project or one already made", () => {
    expect(fullHtml).not.toContain("Knowledge, frameworks and rules");
    const made = { id: "p1", owner: "o", name: "Mine", audience: "", voice: "", cta: "", notes: "", off: ["k1"], createdAt: 0, updatedAt: 0 };
    expect(renderToStaticMarkup(<ProjectForm initial={made} busy={false} onSave={() => {}} />)).not.toContain("Knowledge, frameworks and rules");
  });

  it("the name and the button belong to the form, so Enter submits it and never another row's button", () => {
    const id = /<form id="([^"]+)"/.exec(fullHtml)?.[1];
    expect(id).toBeTruthy();
    expect(fullHtml).toMatch(new RegExp(`<input form="${id}"[^>]*required`));
    expect(fullHtml).toMatch(new RegExp(`type="submit" form="${id}"`));
  });
});
