import type { ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/**
 * Right-click on the library's empty space (LibraryPage.tsx): the page's own menu (New folder, Upload…). A card, a
 * folder or a tab inside opens its own menu instead (it handles the click first).
 */
export function SpaceMenu({ items, className, children }: { items: ReactNode; className?: string; children: ReactNode }) {
  if (!items) return <div className={className}>{children}</div>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-space-menu className={cn(className)}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">{items}</ContextMenuContent>
    </ContextMenu>
  );
}

/** The browser's own menu (Back, Reload) never shows in the library; a text field keeps its own (cut, copy, paste). */
export const noBrowserMenu = (e: React.MouseEvent) => {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.("input, textarea, [contenteditable=true]")) e.preventDefault();
};
