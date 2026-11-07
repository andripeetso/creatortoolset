import type { MetadataInspection } from "./clean-inspection";
import type { FingerprintReport } from "./clean-fingerprints";

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
}
export interface UploadedComparison {
  beforeId: string;
  afterId: string;
  measuredAt: number;
  fingerprints: FingerprintReport;
}
