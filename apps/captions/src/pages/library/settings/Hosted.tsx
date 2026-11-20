import { useRef } from "react";
import { Switch } from "@/components/ui/switch";
import { Row } from "@/components/settings/ui";
import { HOSTED_DEFAULT, HOSTED_OFF, LIBRARY_WORDS, hostedOn, type HostedMix } from "@contracts/library";

const PARTS: { key: keyof HostedMix; label: string; tip: string }[] = [
  { key: "finals", label: LIBRARY_WORDS.finalExportsUpload.label, tip: LIBRARY_WORDS.finalExportsUpload.tip },
  { key: "proxies", label: LIBRARY_WORDS.proxies, tip: LIBRARY_WORDS.proxiesUpload.tip },
  { key: "originals", label: LIBRARY_WORDS.originals, tip: LIBRARY_WORDS.originalsUpload.tip },
];

/**
 * Hosted media (setup step 5 and the owner page): the Upload to server master first, and while it is on, Final exports,
 * Proxies and Originals in any mix. The master off sends nothing up; on again it brings back the mix it had (in this
 * view), else Final exports only. All three off is the master off. Rendered inside a Card.
 * Blur faces (owner only, shown with `onBlurFaces`): on, Proxies reads Blurred and Originals is not offered (the server
 * refuses them too); turning it on turns Originals off.
 */
export function HostedSwitches({ value, onChange, blurFaces, onBlurFaces }: { value: HostedMix; onChange: (m: HostedMix) => void; blurFaces?: boolean; onBlurFaces?: (on: boolean, m: HostedMix) => void }) {
  const last = useRef<HostedMix | null>(hostedOn(value) ? value : null);
  const on = hostedOn(value);
  const master = (v: boolean) => {
    if (!v) last.current = value;
    onChange(v ? (last.current ?? HOSTED_DEFAULT) : HOSTED_OFF);
  };
  return (
    <>
      {onBlurFaces && (
        <Row
          title={LIBRARY_WORDS.blurFaces.label}
          tip={LIBRARY_WORDS.blurFaces.tip}
          control={<Switch aria-label={LIBRARY_WORDS.blurFaces.label} checked={!!blurFaces} onCheckedChange={(v) => onBlurFaces(v, v ? { ...value, originals: false } : value)} />}
        />
      )}
      <Row title={LIBRARY_WORDS.uploadToServer} control={<Switch aria-label={LIBRARY_WORDS.uploadToServer} checked={on} onCheckedChange={master} />} />
      {on &&
        PARTS.filter((p) => !blurFaces || p.key !== "originals").map((p) => (
          <Row
            key={p.key}
            className="pl-8 sm:pl-10"
            title={blurFaces && p.key === "proxies" ? LIBRARY_WORDS.blurred : p.label}
            tip={blurFaces && p.key === "proxies" ? LIBRARY_WORDS.blurredUpload.tip : p.tip}
            control={<Switch aria-label={p.label} checked={value[p.key]} onCheckedChange={(v) => onChange({ ...value, [p.key]: v })} />}
          />
        ))}
    </>
  );
}
