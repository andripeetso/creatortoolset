import { UpdateButton } from "@/components/NewVersionPill";
import { useAccountInCorner } from "@/components/UserMenu";

/** Bottom left on every page: Update after a deploy. The account menu is top right, beside the project switcher. */
export function CornerNav() {
  const shown = useAccountInCorner();
  if (!shown) return null;
  return (
    <nav
      aria-label="Updates"
      className="fixed bottom-2 left-2 z-40 flex items-center gap-2"
    >
      <UpdateButton />
    </nav>
  );
}
