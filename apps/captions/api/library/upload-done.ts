/**
 * Told each finished upload's id and the version it became (a duplicate's current version): an edit waiting on it starts,
 * and a chat's ask that waits on its files looks again. The same version is kept on the upload's row (uploads.version_id).
 * In a file of its own: its listeners (assistant.ts, editor/routes.ts) and the routes that call it import each other, and
 * a list made in one of them is not there yet when the other loads first.
 */
export const onUploadDone: ((uploadId: string, versionId: string) => void)[] = [];
