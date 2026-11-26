import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TOOLS } from "@contracts/tools";
import { JOBS, type Job } from "@contracts/work-prefs";
import { JobStep } from "./JobStep";

const show = (job: Job | null, mine = [...TOOLS]) => renderToStaticMarkup(<JobStep mine={mine} job={job} onPick={() => {}} />).replaceAll("&#x27;", "'");

describe("setup's What do you want to do first?", () => {
  it("offers the five jobs as one choice, by their plain names, with nothing picked to start", () => {
    const html = show(null);
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(5);
    expect(html).not.toContain('aria-checked="true"');
    for (const name of ["Find ideas in posts I like", "Write scripts and posts", "Edit my videos", "Add captions to a video", "Just look around"]) expect(html).toContain(name);
  });

  it("a picked job adds nothing under the choices: no list of what it needs, no button to another screen", () => {
    for (const j of JOBS) {
      const html = show(j);
      expect([...html.matchAll(/<button/g)]).toHaveLength(5); // the five answers and nothing else
      expect(html).not.toMatch(/Set up|Connect|Add key|API key|AI provider|Footage folder|A Media Library|ready/);
      expect(html).not.toMatch(/<input|<textarea|<ul|<li/);
    }
  });
});
