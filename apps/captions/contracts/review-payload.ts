/** The most JSON one plug-in may attach to one Review comment. */
export const PLUGIN_PAYLOAD_MAX = 64 * 1024;

/** Why a comment's `plugins` field is refused, or undefined when it may be kept: a plain object of at most 8 short plug-in ids. */
export function payloadError(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "plugins must be an object";
  const keys = Object.keys(raw);
  if (keys.length > 8) return "too many plug-ins on one comment";
  for (const k of keys) if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(k)) return "bad plug-in id";
  try {
    if (JSON.stringify(raw).length > PLUGIN_PAYLOAD_MAX) return "The plug-in data is too big";
  } catch {
    return "plugins must be JSON";
  }
  return undefined;
}
