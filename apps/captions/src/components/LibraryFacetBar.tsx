import { Button } from "@/components/ui/button";

/** One sidebar filter a plug-in adds (LibraryWebSlot.facets): its values are toggled on and off in the Media Library. */
export interface FacetChoice {
  key: string;
  label: string;
  values: { value: string; label: string }[];
}

/**
 * The plug-in filter groups under the Media Library's kind buttons: one group of toggles per facet, and the values
 * picked so far (key → values). Renders nothing when no plug-in adds a facet, so the default view is unchanged.
 */
export function LibraryFacetBar({
  facets,
  value,
  onChange,
}: {
  facets: FacetChoice[];
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}) {
  if (!facets.length) return null;
  const toggle = (key: string, v: string) => {
    const picked = value[key] ?? [];
    onChange({ ...value, [key]: picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v] });
  };
  return (
    <>
      {facets.map((f) => (
        <div key={f.key} role="group" aria-label={f.label} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500">{f.label}</span>
          {f.values.map((v) => {
            const on = (value[f.key] ?? []).includes(v.value);
            return (
              <Button key={v.value} size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={() => toggle(f.key, v.value)}>
                {v.label}
              </Button>
            );
          })}
        </div>
      ))}
    </>
  );
}
