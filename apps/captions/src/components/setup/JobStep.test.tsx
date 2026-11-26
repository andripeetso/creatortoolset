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

  it("a picked job lists what it uses as things to do: Connect your AI first in every job, then required, then optional ones saying so, each with its one button; no heading", () => {
    expect(rows(show("write"))).toEqual(["Connect your AI | ChatGPT, Claude or another AI plan you already have.", "Add a Perplexity key | Optional | Accuracy checks and deep research."]);
    expect(buttons(show("write"))).toEqual(["Connect", "Add key"]);
    // Caption Studio needs nothing, and still says what it can use: this computer makes the transcripts by itself
    // an optional row carries the Optional badge beside its name, and what it adds under it
    expect(rows(show("captions"))).toEqual(["Connect your AI | Optional | Match cadence.", "Add a Deepgram key | Optional | Faster transcripts than this computer makes by itself."]);
    expect(rows(show("ideas")).slice(0, 2)).toEqual(["Connect your AI | Optional | Reads posts and slides.", "Connect Instagram | A sign-in lets the app read your posts and numbers."]);
    // a required row has no badge
    for (const j of JOBS) for (const r of rows(show(j, []))) if (/^(Set up the Media Library|Connect Instagram|Add a transcription key)/.test(r)) expect(r).not.toContain("Optional");
    // (Edit my videos waits for the Media Library to be read before it lists anything: its order is jobRows' test)
    for (const j of JOBS.filter((x) => x !== "look" && x !== "edit")) expect(rows(show(j, []))[0], j).toMatch(/^Connect your AI/);
    expect(rows(show("look"))).toEqual([]);
    for (const j of JOBS) expect(show(j)).not.toContain("Still to set up");
  });

  it("a row done already is ticked, with no button and no line: a sign-in from the screen before, an AI connected", () => {
    expect(rows(show("ideas", [...fresh, "instagram"]))[1]).toBe("Connect Instagram");
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
