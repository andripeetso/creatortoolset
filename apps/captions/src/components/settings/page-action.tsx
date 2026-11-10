import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The header's action slot (SettingsPage sets the element). Null outside Settings. */
export const PageActionContext = createContext<HTMLElement | null>(null);

/**
 * An action for the page's header, right of the breadcrumb (e.g. a period picker on Usage). It draws into the header
 * while its page is open, and draws nothing where there is no header.
 */
export function PageAction({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionContext);
  return slot ? createPortal(children, slot) : null;
}
