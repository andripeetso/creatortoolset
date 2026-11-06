import type { WhatWorks, WhatWorksRow } from "@/lib/instagram";

const VERDICT_STYLE: Record<WhatWorksRow["verdict"], string> = {
  better: "text-emerald-300",
  worse: "text-amber-300",
  similar: "text-zinc-300",
  "too few": "text-zinc-600",
};

function Column({
  title,
  rows,
  urlOf,
}: {
  title: string;
  rows: WhatWorksRow[];
  urlOf: (shortcode: string) => string | undefined;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-zinc-200">{r.label}</span>
            <span className="shrink-0 text-[11px] text-zinc-500">{r.posts}</span>
            <span
              className={`w-12 shrink-0 text-right font-mono text-[11px] ${VERDICT_STYLE[r.verdict]}`}
              title={
                r.verdict === "too few"
                  ? "Fewer than 5 posts — not enough to say"
                  : `Median post gets ${r.lift}× the views of comparable posts`
              }
            >
              ×{r.lift.toFixed(2)}
            </span>
            <span className="flex shrink-0 gap-1">
              {r.top.slice(0, 3).map((code, i) => {
                const url = urlOf(code);
                return url ? (
                  <a
                    key={code}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-violet-300 hover:underline"
                    title="One of the best-performing posts with this label"
                  >
                    {i + 1}
                  </a>
                ) : null;
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * How each hook type, format and call to action performed on this account.
 * Jev labels each post from its caption; views are compared only with
 * posts of the same type and visibility (trial reels with trial reels).
 */
export function WhatWorksPane({
  data,
  urlOf,
}: {
  data: WhatWorks;
  urlOf: (shortcode: string) => string | undefined;
}) {
  return (
    <div className="mt-4">
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
        ×1.00 is typical for this account. Each post is compared with posts of the same type and
        visibility, so trial reels only count against trial reels. Labels come from captions ({data.labelled}{" "}
        posts). Numbers link to the best posts with that label.
      </p>
      <div className="flex flex-col gap-3 md:flex-row">
        <Column title="Hook" rows={data.hook} urlOf={urlOf} />
        <Column title="Format" rows={data.format} urlOf={urlOf} />
        <Column title="Call to action" rows={data.cta} urlOf={urlOf} />
      </div>
    </div>
  );
}
