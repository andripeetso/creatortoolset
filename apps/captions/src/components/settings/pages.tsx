import type { ComponentType } from "react";
import type { SettingsPageId } from "./nav";
import { AccountSection } from "./AccountSection";
import { AdminSection } from "./AdminSection";
import { AppearanceSection } from "./AppearanceSection";
import { AutomationsSection } from "./AutomationsSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { OwnAiMcpSection } from "./OwnAiMcpSection";
import { ProvidersSection } from "./ProvidersSection";
import { UsageSection } from "./UsageSection";
import { WorkspaceSection } from "./WorkspaceSection";
import { ComputersPage } from "./pages/ComputersPage";
import { GeneralPage } from "./pages/GeneralPage";
import { KeysPage } from "./pages/KeysPage";

/**
 * Which component draws each Settings page. One line per page: a screen builder changes only the component on their own
 * line (and their own files). `sub` is the path segment after the page id (Providers and Admin use it).
 */
type PageBody = ComponentType<{ sub?: string }>;

export const PAGE_BODIES: Record<SettingsPageId, PageBody> = {
  general: GeneralPage,
  appearance: AppearanceSection,
  folders: ComputersPage,
  providers: ProvidersSection,
  devices: ComputersPage,
  automations: AutomationsSection,
  // ponytail: UsageSection and ConnectorsSection still take back/compact props (the setup dialog's); their builders drop these casts
  usage: UsageSection as PageBody,
  connectors: ConnectorsSection as PageBody,
  keys: KeysPage,
  "own-ai": OwnAiMcpSection,
  servers: ComputersPage,
  team: WorkspaceSection,
  admin: AdminSection,
  account: AccountSection,
};
