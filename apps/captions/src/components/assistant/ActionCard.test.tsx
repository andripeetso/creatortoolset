import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LIBRARY_WORDS, type ActionNeeded } from "@contracts/library";
import { ActionCard, resumesOn } from "./ActionCard";

const setup = (owner: boolean): ActionNeeded => ({ kind: "setup", workspace: "ws_p", workspaceName: "Tiny Acrobatics", owner, href: "/library?setup=1" });
const render = (action?: ActionNeeded) => renderToStaticMarkup(<MemoryRouter><ActionCard action={action} ask="make a reel" /></MemoryRouter>);

describe("ActionCard", () => {
  it("the owner's setup card says the exact words and has a Set up button", () => {
    const html = render(setup(true));
    expect(html).toContain(LIBRARY_WORDS.setupCard("Tiny Acrobatics"));
    expect(html).toContain(LIBRARY_WORDS.setupButton);
  });

  it("a member's setup card says it isn't set up, with no button", () => {
    const html = render(setup(false));
    expect(html).toContain(LIBRARY_WORDS.setupCardMember);
    expect(html).not.toContain(LIBRARY_WORDS.setupButton);
  });

  it("the downloads card asks with the words and a Turn on button", () => {
    const html = render({ kind: "downloads", libraryId: "lib_p", workspace: "ws_p" });
    expect(html).toContain(LIBRARY_WORDS.downloadsCard);
    expect(html).toContain(LIBRARY_WORDS.downloadsButton);
  });

  it("shows nothing without an action", () => {
    expect(render(undefined)).toBe("");
  });

  it("resumes only on the setup done of its own workspace", () => {
    expect(resumesOn(setup(true), "ws_p")).toBe(true);
    expect(resumesOn(setup(true), "ws_other")).toBe(false);
    expect(resumesOn({ kind: "downloads", libraryId: "lib_p", workspace: "ws_p" }, "ws_p")).toBe(false);
  });
});
