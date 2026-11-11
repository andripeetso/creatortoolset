import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TOOLS, type Have } from "@contracts/tools";
import { JOBS, type Job } from "@contracts/work-prefs";
import { JobStep } from "./JobStep";

const fresh: Have[] = ["deviceTranscripts", "library"]; // a new account on the Mac app
const show = (job: Job | null, have: Have[] = fresh, mine = [...TOOLS]) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <JobStep mine={mine} have={have} job={job} onPick={() => {}} ai={<p>AI rows</p>} />
    </MemoryRouter>,
  ).replaceAll("&#x27;", "'");
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);

describe("setup's What do you want to do first?", () => {
  it("offers the five jobs as one choice, by their plain names, with nothing picked to start", () => {
    const html = show(null);
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(5);
    expect(html).not.toContain('aria-checked="true"');
    for (const name of ["Find ideas in posts I like", "Write scripts and posts", "Edit my videos", "Add captions to a video", "Just look around"]) expect(html).toContain(name);
    expect(html).not.toContain("Video Cleaner");
  });

  it("under a picked job: one row for each thing it still needs, each with its one button", () => {
    const write = show("write");
    expect(write).toContain("Your own AI");
    expect(buttons(write)).toEqual(["Set up"]);
    expect(buttons(show("ideas"))).toEqual(["Set up"]);
    expect(show("write", [...fresh, "ownAi"])).toContain("You're ready to write.");
    expect(show("captions")).toContain("You're ready to add captions.");
    expect(show("look")).not.toContain("ready");
  });

  it("never shows a form, a key box or a line to run before she presses a row's button", () => {
    for (const j of JOBS) {
      const html = show(j, []);
      expect(html).not.toMatch(/<input|<textarea|password|api key/i);
      expect(html).not.toMatch(/Terminal|(^|\s|>)(\$|npx|npm|curl|brew|sudo) \S/m);
    }
  });
});
