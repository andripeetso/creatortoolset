const OK_ID = /^[a-z0-9-]{6,40}$/;

/** Project that already stores this clip's proxy/original on disk. */
export function mediaOwnerProjectId(
  sourceProjectId: string,
  clip: { mediaProjectId?: string } | null | undefined,
): string {
  const home = clip?.mediaProjectId;
  return home && OK_ID.test(home) ? home : sourceProjectId;
}

/** Projects to check for an on-disk original (media owner first). */
export function originalProjectIds(
  projectId: string,
  clip: { mediaProjectId?: string } | null | undefined,
): string[] {
  const home = mediaOwnerProjectId(projectId, clip);
  return home === projectId ? [projectId] : [home, projectId];
}

export function sharedOriginalObjectKey(
  clip?: { originalObjectKey?: string } | null,
  ownerClip?: { originalObjectKey?: string } | null,
): string | null {
  return clip?.originalObjectKey || ownerClip?.originalObjectKey || null;
}
