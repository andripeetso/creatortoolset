import {
  CLEANUP_LABELS,
  CLEANUP_PRESETS,
  cleanupPreset,
  type CleanupPolicy,
  type MetadataCategory,
} from "@contracts/clean-inspection";

export function CleanCleanupControls({
  policy,
  onChange,
}: {
  policy: CleanupPolicy;
  onChange: (policy: CleanupPolicy) => void;
}) {
  return (
    <div className="space-y-3 text-xs">
      <label className="block font-medium text-zinc-300">
        Cleanup preset
        <select
          aria-label="Cleanup preset"
          value={cleanupPreset(policy)}
          onChange={(e) => {
            const preset = CLEANUP_PRESETS.find((p) => p.id === e.target.value);
            if (preset) onChange({ ...preset.policy });
          }}
          className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-200"
        >
          {CLEANUP_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="custom" disabled>
            Custom selection
          </option>
        </select>
      </label>
      <details>
        <summary className="cursor-pointer text-violet-300">
          Choose what to remove
        </summary>
        <div className="mt-3 space-y-3">
          {(Object.keys(CLEANUP_LABELS) as MetadataCategory[]).map((key) => (
            <label key={key} className="flex items-start gap-2 text-zinc-300">
              <input
                type="checkbox"
                checked={policy[key]}
                onChange={(e) =>
                  onChange({ ...policy, [key]: e.target.checked })
                }
                className="mt-0.5 accent-violet-500"
              />
              Remove {CLEANUP_LABELS[key].toLowerCase()}
            </label>
          ))}
        </div>
      </details>
      <p className="leading-relaxed text-zinc-500">
        Unchecked categories keep native tags where MP4 supports them. Check the
        audit for the actual result.
      </p>
      <p className="leading-relaxed text-zinc-500">
        All presets remove embedded XMP, C2PA credentials, chapters, cover art
        and extra data tracks. Playback information stays. C2PA signatures are
        not validated or carried into edited files.
      </p>
    </div>
  );
}
