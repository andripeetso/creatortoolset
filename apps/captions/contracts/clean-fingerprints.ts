import type { ComparisonTimeline } from "./clean-comparison";
export interface PdqFrame {
  seconds: number;
  originalSeconds?: number;
  before: string;
  after: string;
  qualityBefore: number;
  qualityAfter: number;
  distance: number;
  reliable: boolean;
}

export type Measurement<T> =
  | ({ status: "ok" } & T)
  | {
      status: "unavailable" | "error";
      message: string;
    };

export interface VisualStats {
  pairs: number;
  colorDeltaE: number;
  contrastBefore: number;
  contrastAfter: number;
  brightnessBefore: number;
  brightnessAfter: number;
}
export interface SscdStats {
  model: string;
  modelSha256: string;
  pairs: number;
  meanSimilarity: number;
  minSimilarity: number;
}
export interface VpdqStats {
  implementation: string;
  distanceLimit: number;
  qualityMinimum: number;
  before: {
    sampled: number;
    unique: number;
    matched: number;
    percent: number | null;
    interval: number;
  };
  after: {
    sampled: number;
    unique: number;
    matched: number;
    percent: number | null;
    interval: number;
  };
}
export interface MotionStats {
  fps: number;
  analysisSize: number;
  before: {
    jitter: number | null;
    validTriples: number;
    rejectedPairs: number;
  };
  after: { jitter: number | null; validTriples: number; rejectedPairs: number };
}
export interface ExtendedScores {
  comparison?: Measurement<ComparisonTimeline>;
  visual?: Measurement<VisualStats>;
  sscd?: Measurement<SscdStats>;
  vpdq?: Measurement<VpdqStats>;
  motion?: Measurement<MotionStats>;
}

export interface FingerprintReport extends ExtendedScores {
  implementation: string;
  revision: string | null;
  ffmpeg: string | null;
  scope: string;
  pdq: Measurement<{
    frames: PdqFrame[];
    reliableFrames: number;
    meanDistance: number | null;
    maxDistance: number | null;
  }>;
  tmk: Measurement<{
    level1: number;
    level2: number;
    signatureIdentical: boolean;
    signatureSha256: { before: string; after: string };
  }>;
}

/** Sampled pre-encode visual feedback, explicitly separate from full-file verification. */
export interface QuickScore {
  measuredAt: number;
  elapsedMs: number;
  cachedFrames: number;
  pdq: FingerprintReport["pdq"];
  visual?: Measurement<VisualStats>;
  sscd?: Measurement<SscdStats>;
  outputDuration: number;
  scenes: number;
}
