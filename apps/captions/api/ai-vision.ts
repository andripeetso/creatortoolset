import {
  AiProviderError,
  aiFor,
  anyAiConfigured,
  anthropicParams,
  apiUsage,
  classifyHttpError,
  completeWithFallback,
  contentFromAnthropic,
  readBody,
  requestSignal,
  wrapFetchError,
} from "./ai-complete";
import { recordUsage } from "./lib/mac-claude";
import { addSpend } from "./lib/workspaces";

/**
 * Reading pictures (the Analyzer's slides and video frames) on the Analyzer's AI provider: the pictures go to
 * the Mac as files in the run's folder, which the provider reads in order. Without a provider they go to the Anthropic API
 * key aiFor picked (the account's own, a budget member's server key, or a guest's or the demo's when switched on).
 */

export interface VisionImage {
  /** JPEG bytes, base64 without the data: prefix. */
  jpegBase64: string;
}

type Who = Parameters<typeof aiFor>[0];

export const anyVisionConfigured = (who: Who) => anyAiConfigured(who);

/** One answer about these pictures; `provider` names who read them (the provider instance, or "anthropic"). */
export async function completeVisionWithFallback<T>(
  system: string,
  userText: string,
  images: VisionImage[],
  cancelSignal: AbortSignal | undefined,
  parse: (text: string) => T,
  who: Who,
): Promise<{ value: T; provider: string }> {
  if (!images.length) throw new AiProviderError("No image to analyze", "FAILED", false);
  const route = aiFor(who, "analyzer", "Image reading");
  if (route.off) throw new AiProviderError(route.off, "FAILED", false);
  if (route.only?.includes("mac")) {
    const files = Object.fromEntries(images.map((im, i) => [`attached/${i + 1}.jpg`, `base64:${im.jpegBase64}`]));
    const value = await completeWithFallback(
      system,
      `${userText}\n\nThe pictures, in order: ${Object.keys(files).join(", ")}. Read each one before you answer.`,
      cancelSignal,
      parse,
      { ...route, mac: { ...route.mac, files } },
    );
    return { value, provider: route.mac?.provider?.instance ?? "mac" };
  }
  return { value: parse(await completeAnthropic(system, userText, images, cancelSignal, route.apiKey ?? "", route.model, route.effort, route.bill)), provider: "anthropic" };
}

async function completeAnthropic(
  system: string,
  userText: string,
  images: VisionImage[],
  cancelSignal: AbortSignal | undefined,
  apiKey: string,
  model: string | undefined,
  effort: Parameters<typeof anthropicParams>[0],
  bill?: string,
): Promise<string> {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const params = anthropicParams(effort, model);
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        ...params,
        // thinking counts toward max_tokens on Claude Opus 5.5
        max_tokens: 16000,
        system,
        messages: [
          {
            role: "user",
            content: [
              ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.jpegBase64 } })),
              { type: "text", text: userText },
            ],
          },
        ],
      }),
      signal: requestSignal(cancelSignal),
    });
  } catch (e: unknown) {
    wrapFetchError(e, cancelSignal);
  }
  const body = await readBody(resp);
  if (!resp.ok) throw classifyHttpError(resp.status, body, "Anthropic");
  // tallied like the other API answers: tokens and API-equivalent cost, under its own label
  return contentFromAnthropic(body, (u) => {
    const usage = apiUsage(u, params.model);
    void recordUsage("Image reading (API)", usage);
    if (bill) addSpend(bill, usage.costUsd);
  });
}
