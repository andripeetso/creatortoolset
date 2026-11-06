import { Copy, ShieldCheck } from "lucide-react";

/** Viewport-edge border that sits above page chrome without eating clicks. */
export function AdminViewBorder() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[100] border-[3px] border-amber-400"
    />
  );
}

export function AdminViewBanner({
  owner,
  noun,
  editsTheirAccount,
  layout = "panel",
  onBack,
  backLabel,
  busy,
  onCopy,
  copying,
  copyError,
}: {
  owner: string;
  noun: string;
  editsTheirAccount?: boolean;
  layout?: "page" | "panel";
  onBack?: () => void;
  backLabel?: string;
  busy?: boolean;
  onCopy?: () => void;
  copying?: boolean;
  copyError?: string | null;
}) {
  return (
    <div
      role="status"
      className={
        layout === "page"
          ? "flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-amber-400/60 bg-amber-500/15 px-4 py-2 text-xs text-amber-100"
          : "mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-100"
      }
    >
      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
      <span>
        Admin view — you’re {editsTheirAccount ? "editing" : "viewing"}{" "}
        <strong>{owner}</strong>’s {noun}.
        {editsTheirAccount ? " Changes save to their account." : ""}
      </span>
      {copyError ? <span className="text-red-400">{copyError}</span> : null}
      <div className="ml-auto flex items-center gap-2">
        {onCopy ? (
          <button
            type="button"
            onClick={onCopy}
            disabled={busy || copying}
            className="flex items-center gap-1.5 rounded-md bg-amber-400 px-2.5 py-1 font-semibold text-amber-950 hover:bg-amber-300 disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" />
            {copying ? "Copying…" : "Copy to my projects"}
          </button>
        ) : null}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={busy || copying}
            className="rounded-md border border-amber-500/40 px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-500/15 disabled:opacity-50 dark:text-amber-100"
          >
            {backLabel ?? "Back"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
