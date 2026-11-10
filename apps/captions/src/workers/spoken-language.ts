/**
 * The language a multilingual model hears: its own first guess from the opening 30 s. Left alone the library assumes
 * English, so another language comes out as English-sounding nonsense. Null for an English-only model.
 * ponytail: one guess per run; a few-second range re-transcribe guesses from that slice alone, so keep the clip's
 * language on the project if short slices of other languages ever come out wrong.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function spokenLanguage(t: any, pcm: Float32Array): Promise<string | null> {
  const config = t.model.generation_config;
  const ids: Record<string, number> | undefined = config?.lang_to_id;
  if (!config?.is_multilingual || !ids) return null;
  const { input_features } = await t.processor(pcm.subarray(0, 30 * 16000));
  const out = await t.model.generate({
    inputs: input_features,
    decoder_input_ids: [[config.decoder_start_token_id]],
    max_new_tokens: 1,
  });
  const token = Number(out.data[out.data.length - 1]);
  const tag = Object.keys(ids).find((k) => ids[k] === token); // "<|de|>"
  return tag ? tag.slice(2, -2) : null;
}
