import { Check } from "lucide-react";
import type { MetadataItem } from "@contracts/clean-workspace";

export function MetadataList({ items }: { items: MetadataItem[] }) {
  if (!items.length)
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-zinc-800 p-3 text-xs text-emerald-400">
        <Check className="h-3.5 w-3.5" /> No reportable metadata
      </p>
    );
  return (
    <ul className="rounded-lg border border-zinc-800 text-xs">
      {items.map((item, index) => (
        <li
          key={index}
          className="border-b border-zinc-800/60 px-3 py-2 last:border-0"
        >
          <p className="break-all text-zinc-400">
            <span className="text-zinc-600">{item.where} · </span>
            {item.key}
          </p>
          <p className="mt-0.5 break-all text-zinc-300">{item.value}</p>
        </li>
      ))}
    </ul>
  );
}
