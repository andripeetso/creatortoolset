import { describe, expect, it } from "vitest";
import { spokenLanguage } from "./spoken-language";

/** A stand-in for the speech pipeline: its model answers the start token with `next`. */
const pipe = (config: object | undefined, next = 0) => ({
  processor: async (pcm: Float32Array) => ({ input_features: pcm.length }),
  model: {
    generation_config: config,
    generate: async (o: { decoder_input_ids: number[][] }) => ({ data: [BigInt(o.decoder_input_ids[0][0]), BigInt(next)] }),
  },
});
const multilingual = { is_multilingual: true, decoder_start_token_id: 50258, lang_to_id: { "<|en|>": 50259, "<|de|>": 50261, "<|es|>": 50262 } };
const pcm = new Float32Array(16000);

describe("spokenLanguage", () => {
  it("is the language the model itself hears", async () => {
    expect(await spokenLanguage(pipe(multilingual, 50261), pcm)).toBe("de");
    expect(await spokenLanguage(pipe(multilingual, 50262), pcm)).toBe("es");
  });

  it("is null for an English-only model, which refuses a language", async () => {
    expect(await spokenLanguage(pipe({ is_multilingual: false }), pcm)).toBeNull();
    expect(await spokenLanguage(pipe(undefined), pcm)).toBeNull();
  });

  it("is null when the model's first word isn't a language", async () => {
    expect(await spokenLanguage(pipe(multilingual, 123), pcm)).toBeNull();
  });
});
