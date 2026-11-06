import { describe, expect, it } from "vitest";
import { isOutOfCredits, outOfCreditsMessage } from "./credits";

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

describe("outOfCreditsMessage", () => {
  it("asks the user to tell the admin", () => {
    expect(outOfCreditsMessage("Cloud transcription")).toBe(
      "Cloud transcription is out of credits, so it can't run. Tell the admin so they can top it up."
    );
  });
});
