/** An id that names a file or folder of its own (a project, clip, document, export): safe to join into a path. */
export const okId = (id: string) => /^[a-z0-9-]{6,40}$/.test(id);

/** A row id a client sends back (Media Library): a non-empty string of at most 100 characters. */
export const isId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 100;
