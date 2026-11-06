/**
 * Client for Documents (api/documents.ts). A document is markdown plus
 * ordered media sources; publishing makes /documents/<id> unlisted-public.
 * kind "guide" stores a structured walkthrough (guide.json + stills).
 */

import type { DocKind, GuideDoc } from "@/lib/guide";

export type { DocKind };
export type DocSourceType = "clip" | "caption";

export interface DocSource {
  type: DocSourceType;
  id: string;
  name: string;
  note?: string;
}

export interface DocumentMeta {
  id: string;
  name: string;
  owner?: string;
  kind?: DocKind;
  prompt: string;
  sources: DocSource[];
  published: boolean;
  status: "ready" | "error";
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentRecord extends DocumentMeta {
  body: string;
  guide?: GuideDoc;
}

export interface MediaClip {
  id: string;
  name: string;
  duration: number;
  hasTranscript: boolean;
  hasThumb: boolean;
  createdAt: number;
}

export interface MediaCaption {
  id: string;
  name: string;
  duration: number;
  clipCount: number;
  hasText: boolean;
  thumbClipId: string | null;
  updatedAt: number;
}

async function json<T>(res: Response): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

export const getDocumentsAvailability = () =>
  fetch("/api/documents/availability").then((r) => json<{ ai: boolean }>(r));

export const listDocumentMedia = () =>
  fetch("/api/documents/media").then((r) =>
    json<{ clips: MediaClip[]; captions: MediaCaption[] }>(r),
  );

export const listDocuments = () =>
  fetch("/api/documents").then((r) => json<DocumentMeta[]>(r));

export const getDocument = (id: string) =>
  fetch(`/api/documents/${id}`).then((r) => json<DocumentRecord>(r));

export const createDocument = (
  prompt: string,
  sources: DocSource[],
  kind: DocKind = "brief",
) =>
  fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, sources, kind }),
  }).then((r) => json<DocumentRecord>(r));

export const patchDocument = (
  id: string,
  patch: {
    name?: string;
    body?: string;
    prompt?: string;
    sources?: DocSource[];
    published?: boolean;
    kind?: DocKind;
    guide?: GuideDoc;
  },
) =>
  fetch(`/api/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => json<DocumentRecord>(r));

export const generateDocument = (id: string) =>
  fetch(`/api/documents/${id}/generate`, { method: "POST" }).then((r) =>
    json<DocumentRecord>(r),
  );

export const deleteDocument = (id: string) =>
  fetch(`/api/documents/${id}`, { method: "DELETE" }).then(() => undefined);
