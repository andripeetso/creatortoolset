import { useState } from "react";
import { Link } from "react-router";
import { Instagram, Loader2, UserRoundPlus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtCount, type InstagramAccount } from "@/lib/instagram";

/** An account's picture, or the Instagram mark when it has none (or it no longer loads). */
export function AccountAvatar({ account, className }: { account: InstagramAccount; className: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 ${className}`}>
      {account.avatarUrl && !broken ? (
        <img
          src={`${account.avatarUrl}?t=${account.updatedAt}`}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <Instagram className="h-1/2 w-1/2 text-zinc-500" />
      )}
    </span>
  );
}

/** One account in the opened accounts list: who it is, how big, how many of its posts you saved. */
export function AccountCard({ account, to }: { account: InstagramAccount; to: string }) {
  const read = account.counts.fetchedAt > 0;
  return (
    <Link
      to={to}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-zinc-800 px-3 py-2.5 hover:border-zinc-700 hover:bg-zinc-900/60"
    >
      <span className="flex items-center gap-3">
        <AccountAvatar account={account} className="h-10 w-10" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-100">{account.fullName || `@${account.username}`}</span>
          <span className="block truncate text-[11px] text-zinc-500">@{account.username}</span>
        </span>
      </span>
      <span className="grid grid-cols-3 gap-2 border-t border-zinc-800/80 pt-2">
        <Stat value={read ? fmtCount(account.counts.followers) : "—"} label="followers" />
        <Stat value={read ? fmtCount(account.counts.posts) : "—"} label="posts" />
        <Stat value={String(account.libraryCount ?? 0)} label="saved" />
      </span>
    </Link>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-[13px] font-semibold tabular-nums text-zinc-100">{value}</span>
      <span className="block truncate text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
    </span>
  );
}

/** Beside the paste box while the app does not know which account is yours: type its handle once. */
export function AddMyAccount({
  busy,
  error,
  className,
  onAdd,
}: {
  busy: boolean;
  error?: string | null;
  className?: string;
  onAdd: (username: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={className}>
          <UserRoundPlus className="h-4 w-4 text-zinc-500" />
          Add your account
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 border-zinc-800 bg-zinc-925 p-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const handle = value.trim();
            if (handle && !busy) onAdd(handle);
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="@yourhandle"
            aria-label="Your Instagram username"
            disabled={busy}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Add
          </button>
        </form>
        {error ? <p className="mt-2 text-[11px] text-zinc-400">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
