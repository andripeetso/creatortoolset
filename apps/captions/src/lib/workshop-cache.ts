import type { ChatMessage, SessionRecord, SessionRow, WorkshopDocument, WorkshopFramework, WorkshopProject, WorkshopRule } from "@/lib/workshop";
import type { InstagramAccount } from "@/lib/instagram";

/**
 * What the Workshop already showed, kept in memory so going back to a session paints it at once and refreshes
 * underneath. Gone on reload.
 */
export const sessionCache = new Map<string, { session: SessionRecord; docs: WorkshopDocument[]; messages: ChatMessage[]; activeDocId: string | null }>();

export const listCache: {
  projects?: WorkshopProject[];
  accounts?: InstagramAccount[];
  sessions?: SessionRow[];
  frameworks?: WorkshopFramework[];
  rules?: WorkshopRule[];
} = {};
