import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("./review", () => ({ notifyWorkshopOwner: vi.fn(async () => {}) }));
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "credits-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET;
const { creditBack, creditGone, creditOut, creditRows, isOutOfCredits, outOfCreditsMessage } = await import("./credits");
const { notifyWorkshopOwner } = await import("./review");
const { saveMyKey } = await import("./my-keys");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isOutOfCredits", () => {
  it("treats Deepgram credit exhaustion as out of credits", () => {
    expect(
      isOutOfCredits(
        402,
        JSON.stringify({ err_code: "INSUFFICIENT_CREDITS", err_msg: "Out of credits" })
      )
    ).toBe(true);
    expect(
      isOutOfCredits(400, JSON.stringify({ err_code: "INSUFFICIENT_FUNDS" }))
    ).toBe(true);
  });

  it("treats ElevenLabs quota_exceeded as out of credits", () => {
    expect(
      isOutOfCredits(
        401,
        JSON.stringify({
          detail: { status: "quota_exceeded", message: "You have exceeded your quota" },
        })
      )
    ).toBe(true);
  });

  it("does not treat a plain rate limit as out of credits", () => {
    expect(
      isOutOfCredits(429, JSON.stringify({ error: { message: "Rate limit reached" } }))
    ).toBe(false);
  });
});

describe("an empty Gemini prepay", () => {
  it("is out of credits, as a 402 and as the older 429", () => {
    const said = JSON.stringify({ error: { message: "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing." } });
    expect(isOutOfCredits(402, said)).toBe(true);
    expect(isOutOfCredits(429, said)).toBe(true);
  });
});

describe("the out-of-credit warning", () => {
  const told = () => vi.mocked(notifyWorkshopOwner).mock.calls.length;
  const settle = () => new Promise((go) => setTimeout(go, 50));

  it("tells the key's owner once a day, shows on their Activity, and goes when a call works", async () => {
    saveMyKey("local", "DEEPGRAM_API_KEY", "dg-test");
    const t0 = Date.now();
    creditOut("DEEPGRAM_API_KEY", "dg-test", "Captions and transcripts", t0);
    creditOut("DEEPGRAM_API_KEY", "dg-test", "Captions and transcripts", t0 + 3600_000);
    await settle();
    expect(told()).toBe(1);
    expect(vi.mocked(notifyWorkshopOwner).mock.calls[0]).toEqual([
      "local",
      { kind: "failed", by: "Deepgram", name: "Captions and transcripts", text: "Out of credit, so it stopped. Top it up at console.deepgram.com", href: "/settings/keys", ref: "credit:DEEPGRAM_API_KEY" },
    ]);
    expect(creditRows("local")).toEqual([
      { id: "credit:DEEPGRAM_API_KEY", title: "Deepgram: out of credit", detail: "Captions and transcripts stopped · top up at console.deepgram.com", state: "ready", href: "/settings/keys" },
    ]);
    expect(creditRows("someone")).toEqual([]);
    // a day on, still empty: told again
    creditOut("DEEPGRAM_API_KEY", "dg-test", "Captions and transcripts", t0 + 25 * 3600_000);
    await settle();
    expect(told()).toBe(2);
    // a call on another key changes nothing; one on this key clears it
    creditBack("DEEPGRAM_API_KEY", "dg-other");
    expect(creditRows("local")).toHaveLength(1);
    creditBack("DEEPGRAM_API_KEY", "dg-test");
    expect(creditRows("local")).toEqual([]);
    expect(creditGone.size).toBe(0);
  });

  it("the server's key goes to its admins", async () => {
    process.env.GEMINI_API_KEY = "gk-server";
    try {
      creditOut("GEMINI_API_KEY", "gk-server", "Media Library timelines");
      expect(creditRows("local")[0]).toMatchObject({ title: "Gemini API: out of credit", detail: "Media Library timelines stopped · top up at aistudio.google.com/billing" });
    } finally {
      delete process.env.GEMINI_API_KEY;
      creditBack("GEMINI_API_KEY", "gk-server");
    }
  });
});

describe("outOfCreditsMessage", () => {
  it("asks the user to tell the admin", () => {
    expect(outOfCreditsMessage("Cloud transcription")).toBe(
      "Cloud transcription is out of credits, so it can't run. Tell the admin so they can top it up."
    );
  });
});
