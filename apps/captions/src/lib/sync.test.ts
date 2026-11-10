import { describe, expect, it } from "vitest";
import { topicOf } from "./sync";

describe("sync topicOf", () => {
  it("names the same topic as the server (api/lib/sync.ts) for an address, and for a saved list's key", () => {
    expect(topicOf("/api/review/abc")).toBe("review");
    expect(topicOf("/api/x/tiny/editor/1")).toBe("x/tiny");
    expect(topicOf("/api/workshop")).toBe("workshop");
    expect(topicOf("workshop/sessions?p=1")).toBe("workshop");
    expect(topicOf("instagram/posts?{}|p=")).toBe("instagram");
  });
});
