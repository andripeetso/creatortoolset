import { useRef } from "react";
import { Switch } from "@/components/ui/switch";
import { Row } from "@/components/settings/ui";
import { HOSTED_DEFAULT, HOSTED_OFF, LIBRARY_WORDS, hostedOn, type HostedMix } from "@contracts/library";

type Part = { key: keyof HostedMix; label: string; tip: string };
const FINALS: Part = { key: "finals", label: LIBRARY_WORDS.finalExportsUpload.label, tip: LIBRARY_WORDS.finalExportsUpload.tip };
const PROXIES: Part = { key: "proxies", label: LIBRARY_WORDS.proxies, tip: LIBRARY_WORDS.proxiesUpload.tip };
const ORIGINALS: Part = { key: "originals", label: LIBRARY_WORDS.originals, tip: LIBRARY_WORDS.originalsUpload.tip };
// under Blur faces, in the order of the chain (Original → Blurred copy → Proxy): the Originals part is the Blurred row
const BLURRED: Part = { key: "originals", label: LIBRARY_WORDS.blurred, tip: LIBRARY_WORDS.blurredUpload.tip };

/**
 * Hosted media (setup step 5 and the owner page): the Upload to server master first, and while it is on, Final exports,
 * Proxies and Originals in any mix. The master off sends nothing up; on again it brings back the mix it had (in this
 * view), else Final exports only. All three off is the master off. Rendered inside a Card.
 * Proxies shows only while proxies are made (`proxies`: Generate proxies on), in every library; turning Generate proxies
 * off turns that part off where the switch is (LibrarySettings setProxy, Setup).
 * Blur faces (its switch here only with `onBlurFaces`): on, the rows are Final exports, Blurred (the blurred copies
 * themselves, and a clip with no faces as filmed; an original waiting for its blur never goes up, the server refuses it) and Proxies.
 * Blurred is the Originals part of the mix, so switching Blur faces either way turns that part off.
 */
export function HostedSwitches({ value, onChange, blurFaces, onBlurFaces, proxies = true }: { value: HostedMix; onChange: (m: HostedMix) => void; blurFaces?: boolean; onBlurFaces?: (on: boolean, m: HostedMix) => void; proxies?: boolean }) {
  const last = useRef<HostedMix | null>(hostedOn(value) ? value : null);
  const on = hostedOn(value);
  const master = (v: boolean) => {
    if (!v) last.current = value;
    // the mix brought back never turns on Proxies while its row is not shown
    const back = last.current && { ...last.current, proxies: proxies && last.current.proxies };
    onChange(v ? (back && hostedOn(back) ? back : HOSTED_DEFAULT) : HOSTED_OFF);
  };
  return (
    <>
      {onBlurFaces && (
        <Row
          title={LIBRARY_WORDS.blurFaces.label}
          tip={LIBRARY_WORDS.blurFaces.tip}
          control={<Switch aria-label={LIBRARY_WORDS.blurFaces.label} checked={!!blurFaces} onCheckedChange={(v) => onBlurFaces(v, { ...value, originals: false })} />}
        />
      )}
      <Row title={LIBRARY_WORDS.uploadToServer} control={<Switch aria-label={LIBRARY_WORDS.uploadToServer} checked={on} onCheckedChange={master} />} />
      {on &&
        (blurFaces ? [FINALS, BLURRED, PROXIES] : [FINALS, PROXIES, ORIGINALS])
          // a Proxies part stored on from before (Generate proxies off) stays in sight, so it can be turned off
          .filter((p) => proxies || value.proxies || p !== PROXIES)
          .map((p) => (
          <Row
            key={p.key}
            className="pl-8 sm:pl-10"
            title={p.label}
            tip={p.tip}
            control={<Switch aria-label={p.label} checked={value[p.key]} onCheckedChange={(v) => onChange({ ...value, [p.key]: v })} />}
          />
        ))}
    </>
  );
}
