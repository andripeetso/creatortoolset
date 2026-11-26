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
/** Each row as "title | line", in order. */
const rows = (html: string) => [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!.replace(/<button.*?<\/button>/g, "").replace(/<svg.*?<\/svg>/g, "").replace(/<[^>]+>/g, "|").split("|").filter(Boolean).join(" | "));

describe("setup's What do you want to do first?", () => {
  it("offers the five jobs as one choice, by their plain names, with nothing picked and no list to start", () => {
    const html = show(null);
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(5);
    expect(html).not.toContain('aria-checked="true"');
    expect(rows(html)).toEqual([]);
    for (const name of ["Find ideas in posts I like", "Write scripts and posts", "Edit my videos", "Add captions to a video", "Just look around"]) expect(html).toContain(name);
  });

  it("a picked job lists what it uses as things to do: required first, then optional ones saying so, each with its one button; no heading", () => {
    expect(rows(show("write"))).toEqual(["Connect your AI | ChatGPT, Claude or another AI plan you already have.", "Add a Perplexity key | Optional: accuracy checks and deep research."]);
    expect(buttons(show("write"))).toEqual(["Connect", "Add key"]);
    // Caption Studio needs nothing, and still says what it can use: this computer makes the transcripts by itself
    expect(rows(show("captions"))).toEqual(["Add a Deepgram key | Optional: faster transcripts than this computer makes by itself.", "Connect your AI | Optional: Match cadence."]);
    expect(rows(show("ideas"))[0]).toBe("Connect Instagram | A sign-in lets the app read your posts and numbers.");
    expect(rows(show("look"))).toEqual([]);
    for (const j of JOBS) expect(show(j)).not.toContain("Still to set up");
  });

  it("a row done already is ticked, with no button and no line: a sign-in from the screen before, an AI connected", () => {
    expect(rows(show("ideas", [...fresh, "instagram"]))[0]).toBe("Connect Instagram");
    expect(buttons(show("ideas", [...fresh, "instagram"]))).not.toContain("Connect Instagram");
    const write = show("write", [...fresh, "ownAi"]);
    expect(rows(write)[0]).toBe("Connect your AI");
    expect(buttons(write)).toEqual(["Add key"]); // only the optional one is left to press
  });

  it("names every row as the thing to do: never an article, a bare API key or a second row for the footage folder", () => {
    for (const j of JOBS) {
      const html = show(j, []);
      for (const r of rows(html)) expect(r).toMatch(/^(Connect|Set up|Add|Create) /);
      expect(html).not.toMatch(/>(An )?API key</);
      expect(html).not.toContain("Footage folder");
    }
  });

  it("never shows a form, a key box or a line to run before she presses a row's button", () => {
    for (const j of JOBS) {
      const html = show(j, []);
      expect(html).not.toMatch(/<input|<textarea|password|api key/i);
      expect(html).not.toMatch(/Terminal|(^|\s|>)(\$|npx|npm|curl|brew|sudo) \S/m);
    }
  });
});
