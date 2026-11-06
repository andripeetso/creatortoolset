/** Word-level diff for "What changed": words and the spaces between them, keep / drop / add, by longest common subsequence. */
export type DiffPiece = { text: string; kind: "same" | "del" | "add" };

export function wordDiff(before: string, after: string): DiffPiece[] {
  const a = before.match(/\S+|\s+/g) ?? [];
  const b = after.match(/\S+|\s+/g) ?? [];
  // over the cap the table would be too big to hold (applyMaster's LCS gives up at the same size): the whole text reads as replaced
  if ((a.length + 1) * (b.length + 1) > 4_000_000) return [...(a.length ? [{ text: before, kind: "del" as const }] : []), ...(b.length ? [{ text: after, kind: "add" as const }] : [])];
  const w = b.length + 1;
  // lcs[i * w + j] = length of the common run of a[i..] and b[j..]
  const lcs = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);

  const out: DiffPiece[] = [];
  const push = (text: string, kind: DiffPiece["kind"]) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i]!, "same");
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      push(a[i++]!, "del");
    } else {
      push(b[j++]!, "add");
    }
  }
  while (i < a.length) push(a[i++]!, "del");
  while (j < b.length) push(b[j++]!, "add");
  return out;
}

/** The after text's new words as [start, end) ranges, spaces at the edges left out: what an AI edit wrote. */
export function addedSpans(before: string, after: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const p of wordDiff(before, after)) {
    if (p.kind === "del") continue;
    if (p.kind === "add" && p.text.trim()) {
      const start = at + p.text.length - p.text.trimStart().length;
      const end = at + p.text.trimEnd().length;
      const last = out[out.length - 1];
      // new words with only a space between them are one stretch
      if (last && !after.slice(last[1], start).trim()) last[1] = end;
      else out.push([start, end]);
    }
    at += p.text.length;
  }
  return out;
}
