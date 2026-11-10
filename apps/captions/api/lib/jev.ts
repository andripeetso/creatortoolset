import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * TypeSafe Jev: a fast judge for closed questions over text — pick one of
 * a list (choice) or yes/no as a probability (noul). Many questions over
 * the same text go in one request. Jev never writes; the chat models do.
 *
 * Every feature that uses it keeps its old behaviour when the asker has no
 * key (my-keys.ts keyFor) or a request fails, so Jev only ever improves a result.
 */

export { choice, noul };

// ponytail: one client per key, never dropped; a small LRU if many accounts bring their own keys
const clients = new Map<string, TypeSafeClient>();
const jev = (apiKey: string): TypeSafeClient => {
  let c = clients.get(apiKey);
  if (!c) clients.set(apiKey, (c = new TypeSafeClient({ apiKey })));
  return c;
};

type Question = ReturnType<typeof choice> | ReturnType<typeof noul>;

export interface Answer {
  /** choice: the picked label. */
  choice?: string;
  /** choice: the model's confidence in that label. */
  confidence?: number;
  /** noul: probability of yes, 0–1. */
  noul?: number;
}

/** One request on `key` (the asker's, from keyFor): shared state, named questions, answers by name. */
export async function ask(
  key: string,
  state: Record<string, unknown> | string,
  questions: Record<string, Question>,
  signal?: AbortSignal,
): Promise<Record<string, Answer>> {
  if (!key) throw new Error("No TypeSafe Jev key");
  const result = await jev(key).systemOne(
    { state: state as never, questions },
    { signal, timeout: 30_000 },
  );
  return result.answers as unknown as Record<string, Answer>;
}

/** Probability of yes, 0 when the answer is missing. */
export const yes = (a: Answer | undefined): number =>
  typeof a?.noul === "number" ? Math.max(0, Math.min(1, a.noul)) : 0;
