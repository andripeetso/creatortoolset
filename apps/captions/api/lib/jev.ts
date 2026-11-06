import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * TypeSafe Jev: a fast judge for closed questions over text — pick one of
 * a list (choice) or yes/no as a probability (noul). Many questions over
 * the same text go in one request. Jev never writes; the chat models do.
 *
 * Every feature that uses it keeps its old behaviour when TYPESAFE_API_KEY
 * is missing or a request fails, so Jev only ever improves a result.
 */

export { choice, noul };

export function typesafeConfigured(): boolean {
  return !!(process.env.TYPESAFE_API_KEY || "").trim();
}

let client: TypeSafeClient | null = null;
export function jev(): TypeSafeClient {
  return (client ??= new TypeSafeClient());
}

type Question = ReturnType<typeof choice> | ReturnType<typeof noul>;

export interface Answer {
  /** choice: the picked label. */
  choice?: string;
  /** choice: the model's confidence in that label. */
  confidence?: number;
  /** noul: probability of yes, 0–1. */
  noul?: number;
}

/** One request: shared state, named questions, answers by name. */
export async function ask(
  state: Record<string, unknown> | string,
  questions: Record<string, Question>,
  signal?: AbortSignal,
): Promise<Record<string, Answer>> {
  const result = await jev().systemOne(
    { state: state as never, questions },
    { signal, timeout: 30_000 },
  );
  return result.answers as unknown as Record<string, Answer>;
}

/** Probability of yes, 0 when the answer is missing. */
export const yes = (a: Answer | undefined): number =>
  typeof a?.noul === "number" ? Math.max(0, Math.min(1, a.noul)) : 0;
