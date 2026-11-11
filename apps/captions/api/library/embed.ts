import type { DatabaseSync } from "node:sqlite";
import type { SearchHit } from "../../contracts/library";
import { DEVICE_EMBED_MODEL, deviceEmbedModelKept, embedOnDevice } from "../lib/device-embed";
import { deviceTranscribes } from "../lib/device-transcribe";
import { libraryDb, librarySetting } from "./db";
import { enqueueJob } from "./jobs";
import { CARD, toCard, type CardRow } from "./query";
import { keyFor } from "../my-keys";
import { NeedsKey, segmentsOf, type Segment } from "./transcribe";

/**
 * Optional semantic search (tasks/media-library-plan.md, section 6): the library's owner switches it on
 * (settings.embed); the `embed` job turns a version's title and shown description (chunk 0) and its transcript in
 * about 30 s windows (chunks 1…) into vectors, as its actor (embedRoute): their own OpenAI-compatible key (or the
 * server's for a platform admin), else this computer's own model when the server runs on it, else needs_key. A search
 * embeds the query the same way for the searcher, compares it only with vectors of the same model, takes the 50
 * closest chunks that are close enough (FLOOR) and merges them with the full-text hits by reciprocal rank fusion
 * (k = 60). No route or no vectors: the full-text hits alone.
 */

const WINDOW_S = 30;
const TOP = 50;
export const RRF_K = 60;
export const embedModel = () => process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

/** A chunk with fewer words says nothing to search by (a file name for a title, "I'm" heard over noise): it gets no vector. */
const MIN_WORDS = 3;
export const meaningful = (text: string) => (text.match(/\p{L}+/gu)?.length ?? 0) >= MIN_WORDS;

/**
 * How close (cosine) a chunk must be to the query to be listed for its meaning, by model: below it, a clip is listed
 * only when its words match.
 * ponytail: the key's model is not measured here; 0.3 is the usual line for it
 */
const FLOOR: Record<string, number> = { [DEVICE_EMBED_MODEL]: 0.35 };
export const floorOf = (model: string): number => FLOOR[model] ?? 0.3;

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

/** What makes the vectors: a key's endpoint or this computer, and the model, which is stored with them. */
export type EmbedRoute = { model: string; key: string } | { model: string; device: true };

/** What makes vectors for `actor`: their OpenAI key, else this computer when the server is on it. Throws NeedsKey when there is neither. */
export function embedRoute(actor: string | null): EmbedRoute {
  const k = keyFor(actor, "OPENAI_API_KEY");
  if (!k.missing) return { model: embedModel(), key: k.key };
  if (deviceTranscribes()) return { model: DEVICE_EMBED_MODEL, device: true };
  throw new NeedsKey(k.missing);
}

/** The model `actor`'s vectors are made with now, or null when they have no route. */
const modelFor = (actor: string | null): string | null => {
  try {
    return embedRoute(actor).model;
  } catch {
    return null;
  }
};
export const canEmbed = (actor: string | null): boolean => modelFor(actor) !== null;

/** Vectors for `texts`, in order, on the route's key or this computer (`job`: a clip's, see embedOnDevice; else a search's). */
export async function embedTexts(texts: string[], route: EmbedRoute, job?: { key: string }): Promise<Float32Array[]> {
  if ("device" in route) return embedOnDevice(texts, job);
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${route.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: route.model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Embeddings ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = (await r.json()) as { data?: { index: number; embedding: number[] }[] };
  const rows = (data.data ?? []).sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) throw new Error("Embeddings: the answer has the wrong number of vectors");
  return rows.map((x) => Float32Array.from(x.embedding));
}

/** Embeds one version's chunks as its job's actor and replaces all its rows: a version's vectors are of one model. */
export async function embedVersion(db: DatabaseSync, versionId: string, actor: string | null): Promise<void> {
  const route = embedRoute(actor);
  const row = db
    .prepare(
      `SELECT a.title, (SELECT text FROM descriptions d WHERE d.version_id = v.id ORDER BY d.source = 'user' DESC LIMIT 1) AS description
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(versionId) as { title: string; description: string | null };
  // ponytail: one request per version; a very long transcript would need batches under the endpoint's input limit
  const chunks = embedChunks(row.title, row.description, segmentsOf(db, versionId));
  // a chunk with nothing to search by keeps an empty row, so the catch-up sees the version as made with this model
  const kept = chunks.filter((c) => meaningful(c.text));
  const made = kept.length ? await embedTexts(kept.map((c) => c.text), route, { key: versionId }) : [];
  const vecs = chunks.map((c) => (meaningful(c.text) ? made.shift()! : null));
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM embeddings WHERE version_id = ?").run(versionId);
    const add = db.prepare("INSERT INTO embeddings (version_id, chunk, start_s, model, dims, vec) VALUES (?, ?, ?, ?, ?, ?)");
    const none = db.prepare("INSERT INTO embeddings (version_id, chunk, start_s, model, dims, vec) VALUES (?, ?, ?, ?, 0, x'')");
    chunks.forEach((c, i) => {
      const v = vecs[i];
      if (v) add.run(versionId, i, c.start, route.model, v.length, new Uint8Array(v.buffer));
      else none.run(versionId, i, c.start, route.model);
    });
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

/** The `n` rows closest to `q` and at least `floor` close, best first. Rows of another length (another model's, or empty) never match. */
export function cosineTop<T extends { vec: Float32Array }>(q: Float32Array, rows: T[], n = TOP, floor = -1): T[] {
  return rows
    .filter((r) => r.vec.length === q.length)
    .map((r) => ({ r, s: cosine(q, r.vec) }))
    .filter((x) => x.s >= floor)
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
 * The 50 chunks closest to `q` in the library above the model's floor, as search hits (chunk 0 = the asset, later
 * chunks = the second they start at), with the query made on the searcher's route, against the vectors of that route's
 * model only, narrowed by `where` (clauses on the asset `a`, as the search's own). Null when semantic search is off, has
 * no vectors of that model yet, its model is not on this computer yet (a search never waits for the download), or the
 * searcher has no route: the caller then shows the full-text hits alone.
 */
export async function semanticHits(
  libraryId: string,
  q: string,
  username: string,
  where: { sql: string; params: (string | number)[] }[] = [],
): Promise<SearchHit[] | null> {
  if (!librarySetting(libraryId, "embed")) return null;
  let route: EmbedRoute;
  try {
    route = embedRoute(username);
  } catch {
    return null;
  }
  if ("device" in route && !deviceEmbedModelKept()) return null;
  const db = libraryDb();
  // ponytail: every chunk of the library read and scanned in memory per search; fine to about 100k chunks, then sqlite-vec
  const rows = (
    db
      .prepare(
        `SELECT e.version_id, e.chunk, e.start_s, e.vec FROM embeddings e JOIN assets a ON a.current_version_id = e.version_id
         WHERE a.library_id = ? AND a.trashed_at IS NULL AND e.model = ? AND e.dims > 0${where.map((w) => ` AND ${w.sql}`).join("")}
         ORDER BY e.version_id, e.chunk`,
      )
      .all(libraryId, route.model, ...where.flatMap((w) => w.params)) as { version_id: string; chunk: number; start_s: number; vec: Uint8Array }[]
  ).map((r) => ({ ...r, vec: new Float32Array(Uint8Array.from(r.vec).buffer) }));
  if (!rows.length) return null;
  const [qv] = await embedTexts([q], route).catch(() => [undefined]);
  if (!qv) return null;
  const top = cosineTop(qv, rows, TOP, floorOf(route.model));
  if (!top.length) return [];
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

/**
 * Whether search by meaning is on for `username` here but not ready yet: entries are being made and none of the route's
 * model is here yet, or this computer's model is still to be fetched. Searches go by words alone until then.
 */
export function meaningGettingReady(libraryId: string, username: string): boolean {
  const model = librarySetting(libraryId, "embed") ? modelFor(username) : null;
  const db = libraryDb();
  if (!model || !db.prepare("SELECT 1 FROM jobs WHERE library_id = ? AND kind = 'embed' AND state IN ('queued', 'running') LIMIT 1").get(libraryId)) return false;
  if (model === DEVICE_EMBED_MODEL && !deviceEmbedModelKept()) return true;
  return !db
    .prepare("SELECT 1 FROM embeddings e JOIN assets a ON a.current_version_id = e.version_id WHERE a.library_id = ? AND e.model = ? LIMIT 1")
    .get(libraryId, model);
}

/**
 * Queues `embed` for the current versions whose vectors are missing or of another model than their actor's route makes
 * now, and the ones parked for a key once there is a route: clips from before search by meaning ran without a key, and
 * the whole library after a key is added or removed (until each is done, a search compares only the vectors of its own
 * model). Only versions with a transcript or a description: the worker queues the others when they get one. A failed
 * job waits for its Retry. Returns how many.
 * ponytail: every current version of every library is read once a minute; a changed flag on key and setting writes if that shows up
 */
export function catchUpEmbeds(db = libraryDb()): number {
  const rows = db
    .prepare(
      `SELECT a.library_id, v.id AS version_id, j.state,
         COALESCE(j.actor, (SELECT t.actor FROM jobs t WHERE t.version_id = v.id AND t.kind = 'transcribe'), a.created_by) AS actor,
         (SELECT e.model FROM embeddings e WHERE e.version_id = v.id LIMIT 1) AS model
       FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       LEFT JOIN jobs j ON j.version_id = v.id AND j.kind = 'embed'
       WHERE a.trashed_at IS NULL AND (j.state IS NULL OR j.state IN ('done', 'needs_key'))
         AND (EXISTS (SELECT 1 FROM transcripts t WHERE t.version_id = v.id) OR EXISTS (SELECT 1 FROM descriptions d WHERE d.version_id = v.id))`,
    )
    .all() as { library_id: string; version_id: string; state: string | null; actor: string | null; model: string | null }[];
  const on = new Map<string, boolean>();
  const models = new Map<string | null, string | null>();
  let n = 0;
  for (const r of rows) {
    if (!on.has(r.library_id)) on.set(r.library_id, librarySetting(r.library_id, "embed"));
    if (!models.has(r.actor)) models.set(r.actor, modelFor(r.actor));
    const model = models.get(r.actor);
    if (!on.get(r.library_id) || !model || (model === r.model && r.state !== "needs_key")) continue;
    enqueueJob(db, r.library_id, r.version_id, "embed", r.actor, true);
    n++;
  }
  return n;
}

/** catchUpEmbeds now and every minute; the returned function stops it. */
export function startEmbedCatchUp(): () => void {
  const run = () => {
    try {
      catchUpEmbeds();
    } catch (e) {
      console.error("[library] search by meaning catch-up:", e);
    }
  };
  run();
  const t = setInterval(run, 60_000);
  t.unref();
  return () => clearInterval(t);
}
