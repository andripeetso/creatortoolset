import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { InUse } from "./kit-controls";

/** The header's action slot (SettingsPage sets the element). Null outside Settings. */
export const PageActionContext = createContext<HTMLElement | null>(null);

/** The title the header prints after "Settings ›" (SettingsPage sets it): a Section named the same prints no title. Null outside Settings. */
export const PageTitleContext = createContext<string | null>(null);

/**
 * An action for the page's header, right of the breadcrumb (e.g. a period picker on Usage). It draws into the header
 * while its page is open, and draws nothing where there is no header.
 */
export function PageAction({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionContext);
  return slot ? createPortal(children, slot) : null;
}

const useSaves = create<{ pending: number; saved: boolean }>(() => ({ pending: 0, saved: false }));

/**
 * A save on a page that saves each change at once: the header says "Saving", then "Saved" (owner, 2026-11-22: a change
 * should be seen to land). Hands the promise's result or error on unchanged.
 */
export function markSave<T>(p: Promise<T>): Promise<T> {
  useSaves.setState((s) => ({ pending: s.pending + 1, saved: false }));
  return p.then(
    (v) => {
      useSaves.setState((s) => ({ pending: s.pending - 1, saved: true }));
      return v;
    },
    (e: unknown) => {
      useSaves.setState((s) => ({ pending: s.pending - 1 }));
      throw e;
    },
  );
}

/** The header's save state (SettingsPage); a page opened afresh starts with none. */
export function SaveMark({ page }: { page: string }) {
  const { pending, saved } = useSaves();
  useEffect(() => () => useSaves.setState({ saved: false }), [page]);
  if (pending) return <span className="text-sm text-muted-foreground">Saving</span>;
  return saved ? <InUse>Saved</InUse> : null;
}
