const OK_ID = /^[a-z0-9-]{6,40}$/;
const COPY_SUFFIX = " (copy)";
const NAME_MAX = 120;

/** Display name for a project copied into the current user's library. */
export function copyProjectName(name: string): string {
  const base = (name.trim() || "untitled").slice(0, NAME_MAX);
  if (base.length + COPY_SUFFIX.length <= NAME_MAX) return `${base}${COPY_SUFFIX}`;
  return `${base.slice(0, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
}

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
