/**
 * Perplexity Sonar: chat completions with live web search and citations.
 * Used by the Workshop's accuracy audit. Quick checks run on the fast
 * model, deep research on the slow one that reads dozens of sources. The caller passes the key that serves the asker
 * (my-keys.ts keyFor).
 */

const API_URL = process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai/chat/completions";


export const RESEARCH_MODELS = {
  quick: process.env.RESEARCH_QUICK_MODEL || "sonar-pro",
  deep: process.env.RESEARCH_MODEL || "sonar-deep-research",
} as const;
export type ResearchDepth = keyof typeof RESEARCH_MODELS;

/** How long one research call may take: deep research reads many pages. */
export const RESEARCH_TIMEOUT_MS: Record<ResearchDepth, number> = {
  quick: 4 * 60_000,
  deep: 15 * 60_000,
};

export interface SearchResult {
  title?: string;
  url: string;
  date?: string;
}

export interface ResearchAnswer {
  /** The model's answer with any <think> reasoning removed. */
  content: string;
  /** Every page the answer drew on, in citation order ([1] = first). */
  citations: string[];
  searchResults: SearchResult[];
  model: string;
  tokens: number;
}

export async function perplexityComplete(
  system: string,
  user: string,
  opts: { key: string; depth?: ResearchDepth; model?: string; signal?: AbortSignal; jsonSchema?: Record<string, unknown> },
): Promise<ResearchAnswer> {
  const key = opts.key;
  const depth = opts.depth ?? "quick";
  const model = opts.model || RESEARCH_MODELS[depth];
  // a Stop (opts.signal) ends the call; the timeout still bounds it either way
  const timeout = AbortSignal.timeout(RESEARCH_TIMEOUT_MS[depth]);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (opts.jsonSchema) body.response_format = { type: "json_schema", json_schema: { schema: opts.jsonSchema } };
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!resp.ok) {
    const detail = raw && typeof raw.error === "object" && raw.error ? (raw.error as { message?: string }).message : (raw as { error?: string } | null)?.error;
    throw new Error(`Perplexity ${resp.status}: ${detail || "request failed"}`);
  }
  const choice = Array.isArray(raw?.choices) ? (raw!.choices as Array<{ message?: { content?: string } }>)[0] : undefined;
  const content = (choice?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const citations = Array.isArray(raw?.citations) ? (raw!.citations as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const searchResults = Array.isArray(raw?.search_results)
    ? (raw!.search_results as Array<Record<string, unknown>>).flatMap((r) => (typeof r.url === "string" ? [{ url: r.url, title: typeof r.title === "string" ? r.title : undefined, date: typeof r.date === "string" ? r.date : undefined }] : []))
    : [];
  const usage = raw?.usage as { total_tokens?: number } | undefined;
  return { content, citations, searchResults, model, tokens: usage?.total_tokens ?? 0 };
}
