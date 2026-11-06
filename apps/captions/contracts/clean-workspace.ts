import type { MetadataInspection } from "./clean-inspection";
import type { FingerprintReport, QuickScore } from "./clean-fingerprints";
import type { EditMeasurement, EditOptions } from "./clean-edit";

export interface MetadataItem {
  where: string;
  key: string;
  value: string;
}
export interface CleanOptions {
  stripMetadata: boolean;
  unique: boolean;
}
export interface CleanVersion {
  id: string;
  number: number;
  createdAt: number;
  options: CleanOptions;
  bytes: number;
  metadata: MetadataItem[];
  md5: string;
  fingerprints?: FingerprintReport;
}
export interface CleanSource {
  inspection?: MetadataInspection;
  id: string;
  name: string;
  ext: string;
  bytes: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  metadata: MetadataItem[];
  md5: string;
  expiresAt: number;
  versions: CleanVersion[];
  captionOrigin?: { projectId: string; clipId: string; revision: number };
  /** "See the demo": the run's stored results (showcase.json beside it). */
  showcase?: CleanShowcase;
}
/** A finished run, one entry per preset: its settings and what each measure answered. */
export interface CleanShowcase {
  runs: {
    preset: string;
    options: EditOptions;
    score: QuickScore;
    sscd: QuickScore;
    measurement: EditMeasurement;
  }[];
}

export interface UploadedComparison {
  beforeId: string;
  afterId: string;
  measuredAt: number;
  fingerprints: FingerprintReport;
}
