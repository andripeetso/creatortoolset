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
const { chooseCredit, creditBack, creditChoice, creditGone, creditOut, creditRows, isOutOfCredits, outOfCreditsMessage } = await import("./credits");
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
      {
        id: "credit:DEEPGRAM_API_KEY",
        title: "Deepgram: out of credit",
        detail: "Captions and transcripts stopped · top up at console.deepgram.com",
        state: "ready",
        href: "/settings/keys",
        choices: [
          { label: "Top up", url: "https://console.deepgram.com" },
          { label: "Use another voice model", url: "/settings/voice" },
        ],
      },
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
      expect(creditRows("local")[0]).toMatchObject({ title: "Gemini API: out of credit", detail: "Media Library timelines wait · the rest carries on without Gemini" });
    } finally {
      delete process.env.GEMINI_API_KEY;
      creditBack("GEMINI_API_KEY", "gk-server");
    }
  });
});

describe("a choice while the credit is out", () => {
  const labels = (antigravity: boolean) => creditRows("local", antigravity)[0]?.choices?.map((c) => c.label);
  it("Gemini: Top up, Antigravity when it runs, or without; the pick is kept a day on and goes with the warning", () => {
    saveMyKey("local", "GEMINI_API_KEY", "gk-test");
    const t0 = Date.now();
    try {
      creditOut("GEMINI_API_KEY", "gk-test", "Media Library timelines", t0);
      expect(labels(false)).toEqual(["Top up", "Continue without"]);
      expect(labels(true)).toEqual(["Top up", "Use Antigravity until then", "Continue without"]);
      expect(creditRows("local")[0]!.choices![0]).toEqual({ label: "Top up", url: "https://aistudio.google.com/billing" });
      expect(chooseCredit("GEMINI_API_KEY", "someone", "without")).toEqual([]);
      expect(chooseCredit("GEMINI_API_KEY", "local", "antigravity")).toEqual(["local"]);
      expect(creditChoice("GEMINI_API_KEY", "gk-test")).toBe("antigravity");
      expect(creditRows("local", true)[0]).toMatchObject({ detail: "Timelines are made on Antigravity, picture only, until it is topped up" });
      expect(labels(true)).toEqual(["Top up", "Continue without"]);
      creditOut("GEMINI_API_KEY", "gk-test", "Media Library timelines", t0 + 25 * 3600_000);
      expect(creditChoice("GEMINI_API_KEY", "gk-test")).toBe("antigravity");
      // without: nothing waits on them any more
      chooseCredit("GEMINI_API_KEY", "local", "without");
      expect(creditRows("local", true)).toEqual([]);
      creditBack("GEMINI_API_KEY", "gk-test");
      expect(creditChoice("GEMINI_API_KEY", "gk-test")).toBeUndefined();
    } finally {
      creditBack("GEMINI_API_KEY", "gk-test");
      saveMyKey("local", "GEMINI_API_KEY", null);
    }
  });

  it("a service with no other way: only Top up", () => {
    saveMyKey("local", "ANTHROPIC_API_KEY", "sk-test");
    try {
      creditOut("ANTHROPIC_API_KEY", "sk-test", "AI on the Anthropic API key");
      expect(labels(true)).toEqual(["Top up"]);
    } finally {
      creditBack("ANTHROPIC_API_KEY", "sk-test");
      saveMyKey("local", "ANTHROPIC_API_KEY", null);
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
