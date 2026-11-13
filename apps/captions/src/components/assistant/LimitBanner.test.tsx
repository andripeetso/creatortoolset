import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LimitBanner, limitLineOf, upcoming } from "./LimitBanner";

const now = new Date(2026, 10, 13, 16, 53).getTime();
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((x) => x[1]);

describe("the usage limit banner", () => {
  it("says when: today, tomorrow, or a date", () => {
    expect(upcoming(at(13, 17, 30), now)).toMatch(/17:30|5:30/);
    expect(upcoming(at(14, 9, 0), now)).toMatch(/^tomorrow at /);
    expect(upcoming(at(20, 9, 0), now)).toMatch(/20/);
  });

  it("Resumes when the chat carries on by itself, Resets when it doesn't, and says so when the time is unknown", () => {
    expect(limitLineOf({ until: at(13, 17, 30), resume: true }, undefined, now)).toMatch(/^Resumes /);
    expect(limitLineOf({ until: at(13, 17, 30) }, undefined, now)).toMatch(/^Resets /);
    // a snooze past the reset is when it carries on
    expect(limitLineOf({ until: at(13, 17, 30), resume: true }, at(14, 9, 0), now)).toMatch(/^Resumes tomorrow/);
    expect(limitLineOf({}, undefined, now)).toBe("Reset time unavailable; retry manually");
  });

  it("has the two actions, each the other way round once on", () => {
    const until = Date.now() + 3600_000;
    expect(buttons(renderToStaticMarkup(<LimitBanner chat="c" limit={{ until, resume: true }} />))).toEqual(["Cancel auto-resume", "Snooze until reset"]);
    expect(buttons(renderToStaticMarkup(<LimitBanner chat="c" limit={{ until }} snoozed={until} />))).toEqual(["Resume at reset", "Wake now"]);
    expect(buttons(renderToStaticMarkup(<LimitBanner chat="c" limit={{}} />))).toEqual([]);
  });
});
