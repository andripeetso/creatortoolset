import { parseEditOp, parseNewDocument, type TurnPlan } from "./chat-plans";
import type { EditOp } from "./doc";

/**
 * Reads the model's JSON answer while it is still being written: the reply
 * so far, and every edit whose object is already complete. Edits count only
 * once newDocument and revertTo have been seen before them, so nothing is
 * applied to the wrong document. Pure.
 */
export interface PartialTurn {
  reply: string;
  replyDone: boolean;
  /** undefined = not seen yet; null = seen as null. */
  newDocument?: TurnPlan["newDocument"] | null;
  revertTo?: string | null;
  /** The edits key came after complete newDocument and revertTo values. */
  editsReady: boolean;
  edits: EditOp[];
}

const EMPTY: PartialTurn = { reply: "", replyDone: false, editsReady: false, edits: [] };

/** Decode a JSON string body that may be cut off anywhere. */
function decodePartialString(body: string): string {
  let s = body;
  // a trailing incomplete escape (\ or \u12) cannot be parsed yet
  const m = /\\(u[0-9a-fA-F]{0,3})?$/.exec(s);
  if (m) s = s.slice(0, m.index);
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

/** Where a JSON string starting at `at` (the opening quote) ends, or -1 when the buffer stops inside it. */
function stringEnd(buf: string, at: number): number {
  for (let i = at + 1; i < buf.length; i++) {
    const c = buf[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') return i;
  }
  return -1;
}

/** Where the value starting at `at` ends (inclusive), or -1 when incomplete. */
function valueEnd(buf: string, at: number): number {
  const c = buf[at];
  if (c === '"') return stringEnd(buf, at);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let i = at; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === '"') {
        const e = stringEnd(buf, i);
        if (e < 0) return -1;
        i = e;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
  // null / true / false / number
  const m = /^[^,}\]\s]+/.exec(buf.slice(at));
  if (!m) return -1;
  const end = at + m[0].length;
  return end < buf.length ? end - 1 : -1;
}

export function partialTurn(raw: string): PartialTurn {
  let buf = raw.replace(/^\s*```(?:json)?\s*/i, "");
  const start = buf.indexOf("{");
  if (start < 0) return EMPTY;
  buf = buf.slice(start);
  const out: PartialTurn = { ...EMPTY, edits: [] };
  let i = 1;
  let editsAt = -1;
  let newDocAt = -1;
  let revertAt = -1;
  while (i < buf.length) {
    // find the next key
    const q = buf.indexOf('"', i);
    if (q < 0) break;
    const qe = stringEnd(buf, q);
    if (qe < 0) break;
    const key = buf.slice(q + 1, qe);
    const colon = buf.indexOf(":", qe);
    if (colon < 0) break;
    let v = colon + 1;
    while (v < buf.length && /\s/.test(buf[v]!)) v++;
    if (v >= buf.length) break;
    const end = valueEnd(buf, v);
    if (key === "reply" && buf[v] === '"') {
      out.reply = decodePartialString(buf.slice(v + 1, end < 0 ? undefined : end));
      out.replyDone = end >= 0;
    } else if (key === "newDocument") {
      newDocAt = v;
      if (end >= 0) {
        const text = buf.slice(v, end + 1);
        if (text === "null") out.newDocument = null;
        else {
          try {
            out.newDocument = parseNewDocument(JSON.parse(text)) ?? null;
          } catch {
            out.newDocument = null;
          }
        }
      }
    } else if (key === "revertTo") {
      revertAt = v;
      if (end >= 0) {
        const text = buf.slice(v, end + 1);
        out.revertTo = text === "null" ? null : /^"v\d{1,5}"$/.test(text) ? text.slice(1, -1) : null;
      }
    } else if (key === "edits" && buf[v] === "[") {
      editsAt = v;
      // complete objects inside the array, in order
      let j = v + 1;
      while (j < buf.length) {
        while (j < buf.length && /[\s,]/.test(buf[j]!)) j++;
        if (j >= buf.length || buf[j] === "]") break;
        const oe = valueEnd(buf, j);
        if (oe < 0) break;
        try {
          const op = parseEditOp(JSON.parse(buf.slice(j, oe + 1)));
          if (op) out.edits.push(op);
        } catch {
          /* a malformed element is skipped, like in parseTurn */
        }
        j = oe + 1;
      }
    }
    if (end < 0) break;
    i = end + 1;
  }
  out.editsReady =
    editsAt >= 0 &&
    newDocAt >= 0 &&
    newDocAt < editsAt &&
    out.newDocument !== undefined &&
    revertAt >= 0 &&
    revertAt < editsAt &&
    out.revertTo !== undefined;
  if (!out.editsReady) out.edits = [];
  return out;
}
