import type { DatabaseSync } from "node:sqlite";
import type { SearchHit } from "../../contracts/library";
import { libraryDb, librarySetting } from "./db";
import { CARD, toCard, type CardRow } from "./query";
import { keyFor } from "../my-keys";
import { needKey, segmentsOf, type Segment } from "./transcribe";

/**
 * Optional semantic search (tasks/media-library-plan.md, section 6): the library's owner switches it on
 * (settings.embed); the `embed` job turns a version's title and shown description (chunk 0) and its transcript in
 * about 30 s windows (chunks 1…) into vectors with an OpenAI-compatible /embeddings endpoint, as its actor (their own
 * key, or the server's for a platform admin; otherwise needs_key). A search embeds the query the same way
 * for the searcher, takes the 50 closest chunks by cosine and merges them with the full-text hits by reciprocal rank
 * fusion (k = 60). No key or no vectors: the full-text hits alone.
 */

const WINDOW_S = 30;
const TOP = 50;
export const RRF_K = 60;
export const embedModel = () => process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

/** Chunk 0: title and description (the whole clip, no second). Then the transcript in windows of about 30 s. */
export function embedChunks(title: string, description: string | null, segments: Segment[]): { start: number; text: string }[] {
  const out = [{ start: 0, text: [title, description].filter(Boolean).join("\n") }];
  for (const s of segments) {
    const last = out[out.length - 1]!;
    if (out.length > 1 && s.start - last.start < WINDOW_S) last.text += ` ${s.text}`;
    else out.push({ start: s.start, text: s.text });
  }
  return out;
}

/** Vectors for `texts`, in order, on the OpenAI-compatible key from keyFor. */
export async function embedTexts(texts: string[], { key }: { key: string }): Promise<Float32Array[]> {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: embedModel(), input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Embeddings ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = (await r.json()) as { data?: { index: number; embedding: number[] }[] };
  const rows = (data.data ?? []).sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) throw new Error("Embeddings: the answer has the wrong number of vectors");
  return rows.map((x) => Float32Array.from(x.embedding));
}

/** Embeds one version's chunks as its job's actor and replaces its rows for this model. */
export async function embedVersion(db: DatabaseSync, versionId: string, actor: string | null): Promise<void> {
  const route = needKey(actor, "OPENAI_API_KEY");
  const row = db
    .prepare(
      `SELECT a.title, (SELECT text FROM descriptions d WHERE d.version_id = v.id ORDER BY d.source = 'user' DESC LIMIT 1) AS description
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(versionId) as { title: string; description: string | null };
  // ponytail: one request per version; a very long transcript would need batches under the endpoint's input limit
  const chunks = embedChunks(row.title, row.description, segmentsOf(db, versionId));
  const vecs = await embedTexts(chunks.map((c) => c.text), route);
  const model = embedModel();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM embeddings WHERE version_id = ? AND model = ?").run(versionId, model);
    const add = db.prepare("INSERT INTO embeddings (version_id, chunk, start_s, model, dims, vec) VALUES (?, ?, ?, ?, ?, ?)");
    chunks.forEach((c, i) => add.run(versionId, i, c.start, model, vecs[i]!.length, new Uint8Array(vecs[i]!.buffer)));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The `n` rows closest to `q`, best first. Rows of another length (another model's) never match. */
export function cosineTop<T extends { vec: Float32Array }>(q: Float32Array, rows: T[], n = TOP): T[] {
  return rows
    .filter((r) => r.vec.length === q.length)
    .map((r) => ({ r, s: cosine(q, r.vec) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.r);
}

/** Reciprocal rank fusion: each item scores Σ 1/(k + rank) over the lists it is in; the first copy of an item is kept. */
export function rrf<T>(lists: T[][], key: (t: T) => string, k = RRF_K): T[] {
  const score = new Map<string, { item: T; s: number }>();
  for (const list of lists)
    list.forEach((item, i) => {
      const id = key(item);
      const cur = score.get(id) ?? { item, s: 0 };
      cur.s += 1 / (k + i + 1);
      score.set(id, cur);
    });
  return [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.item);
}

export const hitKey = (h: SearchHit) => `${h.asset.id}@${h.seconds ?? ""}`;

/**
 * The 50 chunks closest to `q` in the library, as search hits (chunk 0 = the asset, later chunks = the second they
 * start at), with the searcher paying for the query. Null when semantic search is off, has no vectors yet, or the
 * searcher has no key route: the caller then shows the full-text hits alone.
 */
export async function semanticHits(libraryId: string, q: string, username: string): Promise<SearchHit[] | null> {
  if (!librarySetting(libraryId, "embed")) return null;
  const route = keyFor(username, "OPENAI_API_KEY");
  if (route.missing) return null;
  const db = libraryDb();
  // ponytail: every chunk of the library read and scanned in memory per search; fine to about 100k chunks, then sqlite-vec
  const rows = (
    db
      .prepare(
        `SELECT e.version_id, e.chunk, e.start_s, e.vec FROM embeddings e JOIN assets a ON a.current_version_id = e.version_id
         WHERE a.library_id = ? AND a.trashed_at IS NULL AND e.model = ? ORDER BY e.version_id, e.chunk`,
      )
      .all(libraryId, embedModel()) as { version_id: string; chunk: number; start_s: number; vec: Uint8Array }[]
  ).map((r) => ({ ...r, vec: new Float32Array(Uint8Array.from(r.vec).buffer) }));
  if (!rows.length) return null;
  const [qv] = await embedTexts([q], route).catch(() => [undefined]);
  if (!qv) return null;
  const top = cosineTop(qv, rows);
  const ids = [...new Set(top.map((r) => r.version_id))];
  const cards = new Map(
    (
      db
        .prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE v.id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as unknown as CardRow[]
    ).map((r) => [r.version_id, toCard(r)]),
  );
  const segs = new Map<string, Segment[]>();
  return top.flatMap((r): SearchHit[] => {
    const asset = cards.get(r.version_id);
    if (!asset) return [];
    if (r.chunk === 0) return [{ asset }];
    if (!segs.has(r.version_id)) segs.set(r.version_id, segmentsOf(db, r.version_id));
    const said = segs.get(r.version_id)!.find((s) => s.start >= r.start_s);
    return [{ asset, seconds: r.start_s, ...(said ? { snippet: said.text } : {}) }];
  });
}
