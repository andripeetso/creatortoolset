/**
 * Phone tools that only do a slice of the desktop app — paste, read,
 * watch — say so once, then get out of the way.
 */
export function DesktopHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3.5 py-3 text-sm leading-5 text-zinc-400">
      {children}
    </p>
  );
}
