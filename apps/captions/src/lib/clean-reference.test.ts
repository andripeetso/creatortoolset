import { describe, expect, it } from "vitest";
import type { FingerprintReport } from "@contracts/clean-fingerprints";
import { assessReferenceRanges } from "@contracts/clean-reference";

const pdq = (distances: number[]): FingerprintReport["pdq"] => ({
  status: "ok",
  frames: distances.map((distance) => ({
    distance,
    reliable: true,
    qualityBefore: 50,
    qualityAfter: 50,
    before: "",
    after: "",
    seconds: 0,
  })),
  reliableFrames: distances.length,
  meanDistance: distances.length
    ? distances.reduce((a, b) => a + b, 0) / distances.length
    : null,
  maxDistance: distances.length ? Math.max(...distances) : null,
});
const tmk = (level1: number, level2: number): FingerprintReport["tmk"] => ({
  status: "ok",
  level1,
  level2,
  signatureIdentical: false,
  signatureSha256: { before: "", after: "" },
});
const vpdq = (
  before: number | null,
  after: number | null,
): NonNullable<FingerprintReport["vpdq"]> => ({
  status: "ok",
  implementation: "test",
  distanceLimit: 31,
  qualityMinimum: 50,
  before: {
    sampled: 10,
    unique: before == null ? 0 : 10,
    matched: before == null ? 0 : before / 10,
    percent: before,
    interval: 1,
  },
  after: {
    sampled: 10,
    unique: after == null ? 0 : 10,
    matched: after == null ? 0 : after / 10,
    percent: after,
    interval: 1,
  },
});
const report = () => ({
  pdq: pdq([32, 100]),
  tmk: tmk(0.69, 0.69),
  vpdq: vpdq(40, 70),
});

describe("public reference interpretation", () => {
  it("applies inclusive boundaries to individual PDQ pairs, not their mean", () => {
    const sample = assessReferenceRanges({ pdq: pdq([0, 80]) });
    expect(sample.checks[0].state).toBe("mixed");
    expect(sample.checks[0].value).toBe("1 / 2 reliable pairs match");
    expect(assessReferenceRanges({ pdq: pdq([31]) }).checks[0].state).toBe(
      "match",
    );
    expect(assessReferenceRanges({ pdq: pdq([32]) }).checks[0].state).toBe(
      "outside",
    );
  });
  it("requires both TMK cutoffs at full precision", () => {
    expect(assessReferenceRanges({ tmk: tmk(0.7, 0.7) }).checks[1].state).toBe(
      "match",
    );
    expect(
      assessReferenceRanges({ tmk: tmk(0.699999, 0.9) }).checks[1].state,
    ).toBe("outside");
    expect(
      assessReferenceRanges({ tmk: tmk(0.9, 0.699999) }).checks[1].state,
    ).toBe("outside");
    expect(assessReferenceRanges({ tmk: tmk(NaN, 0.9) }).checks[1].state).toBe(
      "insufficient",
    );
  });
  it("uses the published directional vPDQ example and preserves missing samples", () => {
    expect(assessReferenceRanges({ vpdq: vpdq(40, 80) }).checks[2].state).toBe(
      "match",
    );
    expect(assessReferenceRanges({ vpdq: vpdq(80, 40) }).checks[2].state).toBe(
      "outside",
    );
    expect(
      assessReferenceRanges({ vpdq: vpdq(null, null) }).checks[2].state,
    ).toBe("insufficient");
    const incompatible = vpdq(100, 100);
    if (incompatible.status === "ok") incompatible.distanceLimit = 47;
    expect(assessReferenceRanges({ vpdq: incompatible }).checks[2].state).toBe(
      "insufficient",
    );
  });
  it("does not produce a complete assessment from low-detail, missing, live or stale results", () => {
    const values = report();
    if (values.pdq.status === "ok") values.pdq.frames[1].qualityBefore = 49;
    expect(assessReferenceRanges(values).complete).toBe(false);
    expect(
      assessReferenceRanges({
        ...report(),
        tmk: { status: "error", message: "Failed" },
      }).state,
    ).toBe("incomplete");
    expect(assessReferenceRanges(report(), { mode: "live" }).complete).toBe(
      false,
    );
    const stale = assessReferenceRanges(report(), { fullStale: true });
    expect(stale.complete).toBe(false);
    expect(stale.checks[1].state).toBe("stale");
    expect(stale.checks[0].state).toBe("outside");
    expect(assessReferenceRanges({ pdq: pdq([]) }).checks[0].state).toBe(
      "insufficient",
    );
  });
  it("summarizes reference rules without producing a Meta pass or probability", () => {
    const outside = assessReferenceRanges(report());
    expect(outside.complete).toBe(true);
    expect(outside.state).toBe("outside");
    expect(outside.platformOutcome).toBe("unknown");
    expect(outside).not.toHaveProperty("passProbability");
    expect(
      assessReferenceRanges({ ...report(), tmk: tmk(0.9, 0.9) }).state,
    ).toBe("mixed");
    expect(
      assessReferenceRanges({
        pdq: pdq([0]),
        tmk: tmk(1, 1),
        vpdq: vpdq(100, 100),
      }).state,
    ).toBe("match");
  });
});
