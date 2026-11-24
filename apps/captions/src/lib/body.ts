/**
 * A response's JSON, for the helpers that also read an error answer's `{ error }`. A body cut off on the way (the
 * connection dropped half-way) rejects, and so does a successful answer that is not JSON: read as `{}`, either was a
 * list with nothing in it, saved and drawn, and the Media Library broke on it (StaleBuild.tsx). An empty body is `{}`,
 * and so is an error answer that is not JSON (a proxy's error page): the caller's own message says the status.
 */
export async function bodyOf<T>(r: Response): Promise<T> {
  const text = await r.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    if (r.ok) throw e;
    return {} as T;
  }
}
