import type { ReviewActionEntry, ReviewPanelEntry, ReviewSlotContext } from "@/lib/plugin";

/** What every Review slot gets for the version on screen; the composer and history parts are bound per plug-in. */
export type ReviewBaseContext = Omit<ReviewSlotContext, "composer" | "history" | "preview" | "sent">;
export type ReviewBind = (pluginId: string) => Pick<ReviewSlotContext, "composer" | "history" | "preview" | "sent">;

/** Plug-in Review slots show only to managers, and only on a ready version that is not removed. */
export function reviewSlotShown(ctx: Pick<ReviewBaseContext, "manage" | "version">): boolean {
  return ctx.manage && ctx.version.status === "ready" && !ctx.version.removed;
}

/** The panels a plug-in puts under the Review header (ReviewAssetPage mounts this). */
export function ReviewPanelSlots({ slots, ctx, bind }: { slots: ReviewPanelEntry[]; ctx: ReviewBaseContext; bind: ReviewBind }) {
  if (!reviewSlotShown(ctx)) return null;
  return (
    <>
      {slots.map((s) => (
        <s.panel key={s.key} {...ctx} {...bind(s.pluginId)} />
      ))}
    </>
  );
}

/** The toolbar buttons plug-ins add next to Share (the Review header mounts this). */
export function ReviewActionButtons({ actions, ctx, bind }: { actions: ReviewActionEntry[]; ctx: ReviewBaseContext; bind: ReviewBind }) {
  if (!reviewSlotShown(ctx)) return null;
  return (
    <>
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          title={a.label}
          aria-label={a.label}
          onClick={() => void a.onRun({ ...ctx, ...bind(a.pluginId) })}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
        >
          {a.icon ? <a.icon className="h-4 w-4" /> : <span className="text-xs">{a.label}</span>}
        </button>
      ))}
    </>
  );
}
