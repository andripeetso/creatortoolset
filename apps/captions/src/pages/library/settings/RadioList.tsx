import type { ReactNode } from "react";
import { Row } from "@/components/settings/ui";

/**
 * A plain pick-one: a radio list, one row per option, its ⓘ tip after the label (his rule: pick-one is a radio list).
 * Rendered inside a Card. A disabled option keeps its row and its status, so the person sees why it can't be picked.
 */
export function RadioList<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: readonly { value: T; label: string; tip?: string; disabled?: boolean; status?: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <>
      {options.map((o) => (
        <Row
          key={o.value}
          title={o.label}
          tip={o.tip}
          status={o.status}
          control={
            <input
              type="radio"
              name={name}
              aria-label={o.label}
              className="size-4 accent-primary disabled:opacity-50"
              disabled={o.disabled}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
          }
        />
      ))}
    </>
  );
}
