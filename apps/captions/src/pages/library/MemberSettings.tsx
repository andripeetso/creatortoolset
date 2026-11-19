import type { LibrarySummary } from "@contracts/library";
import { Card, EmptyRow } from "@/components/settings/ui";

/**
 * Placeholder until the member page is built (UNIFIED-PRD §3.2, task t10): a viewer who is not the owner gets this. Until
 * then it shows the same "No library" row the page showed before, not a blank section.
 */
export function MemberSettings(_: { library: LibrarySummary }) {
  return (
    <Card>
      <EmptyRow title="No library" />
    </Card>
  );
}
