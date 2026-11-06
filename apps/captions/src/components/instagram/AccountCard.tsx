import { useState } from "react";
import { Link } from "react-router";
import { Instagram, Loader2 } from "lucide-react";
import { fmtCount, type InstagramAccount } from "@/lib/instagram";

/**
 * Mini profile: avatar with two pull dots under it, name and handle, then
 * a stats strip — followers, posts, and library / catalog sizes.
 */
export function AccountCard({
  account,
  to,
  active,
}: {
  account: InstagramAccount;
  to: string;
  active?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const inLibrary = account.libraryCount ?? 0;
  const inCatalog = Math.max(account.catalogCount ?? 0, inLibrary);
  const profilePulled = account.counts.fetchedAt > 0;
  const catalogPulled = Boolean(account.lastCatalogAt);
  return (
    <Link
      to={to}
      className={`relative flex min-w-0 flex-col gap-2 rounded-xl border px-3 py-2.5 ${
        account.mine
          ? "border-violet-500/40 bg-violet-600/10"
          : active
            ? "border-violet-500/50 bg-violet-600/10"
            : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60"
      }`}
    >
      {account.mine ? (
        <span className="absolute right-2 top-2 rounded-md bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
          Mine
        </span>
      ) : null}
      <span className="flex items-center gap-3">
        <span className="flex shrink-0 flex-col items-center gap-1.5">
          <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-zinc-800">
            {account.avatarUrl && !broken ? (
              <img
                src={`${account.avatarUrl}?t=${account.updatedAt}`}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setBroken(true)}
              />
            ) : (
              <Instagram className="h-4 w-4 text-zinc-500" />
            )}
          </span>
          <span className="flex gap-1">
            <Dot on={profilePulled} label="Profile" />
            <Dot on={catalogPulled} label="Catalog" />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-100">
            {account.fullName || `@${account.username}`}
            {account.isVerified ? (
              <span className="ml-1.5 text-[10px] font-normal text-violet-300">verified</span>
            ) : null}
          </span>
          <span className="block truncate text-[11px] text-zinc-500">@{account.username}</span>
        </span>
      </span>
      <span className="grid grid-cols-3 gap-2 border-t border-zinc-800/80 pt-2">
        <Stat value={profilePulled ? fmtCount(account.counts.followers) : "—"} label="followers" />
        <Stat value={profilePulled ? fmtCount(account.counts.posts) : "—"} label="posts" />
        <Stat value={`${inLibrary} / ${inCatalog}`} label="library / catalog" />
      </span>
    </Link>
  );
}

function Dot({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      title={on ? `${label} pulled` : `${label} not pulled yet`}
      className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-400" : "bg-zinc-700"}`}
    />
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-[13px] font-semibold tabular-nums text-zinc-100">{value}</span>
      <span className="block truncate text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
    </span>
  );
}

/** Empty slot on Analyzer home: pull your own Instagram as live context. */
export function MyAccountSlot({
  busy,
  error,
  disabledReason,
  onAdd,
}: {
  busy: boolean;
  error?: string | null;
  disabledReason?: string | null;
  onAdd: (username: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-dashed border-violet-500/40 bg-violet-600/5 px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        const handle = value.trim();
        if (!handle || busy) return;
        onAdd(handle);
      }}
    >
      <p className="text-sm font-medium text-zinc-100">My account</p>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Pull your Instagram so Workshop always has where the account is now, and your own scripts to remake.
      </p>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="@yourhandle"
        disabled={busy}
        spellCheck={false}
        className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500 disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className="flex items-center justify-center gap-1.5 self-end rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Add and pull
      </button>
      {disabledReason ? <p className="text-[10px] text-amber-400/80">{disabledReason}</p> : null}
      {error ? <p className="text-[10px] text-red-400">{error}</p> : null}
    </form>
  );
}
