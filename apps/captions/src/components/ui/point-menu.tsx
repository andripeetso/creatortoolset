import * as React from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu";

/**
 * A menu opened at a point (a right-click on a row, a clip, a gap): the app's one menu look, the same as every
 * ContextMenu and DropdownMenu. Fill it with DropdownMenuItem, DropdownMenuSub and DropdownMenuSeparator.
 * Never build a menu of plain buttons (`point-menu.test.ts`).
 */
export function PointMenu({
  at,
  onClose,
  label,
  className,
  children,
}: {
  at: { x: number; y: number };
  onClose: () => void;
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // not modal, keyed by the point: a right-click elsewhere while it is open opens the next one there at once
    <DropdownMenu key={`${at.x},${at.y}`} open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={0}
        aria-label={label}
        className={className}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** On an item that is off and says why in its title: keeps the pointer, so the reason still shows on hover. */
export const WHY = "data-[disabled]:pointer-events-auto";
