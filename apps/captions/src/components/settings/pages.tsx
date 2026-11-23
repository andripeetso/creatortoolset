import type { ComponentType } from "react";
import type { SettingsPageId } from "./nav";
import { AccountSection } from "./AccountSection";
import { AdminSection } from "./AdminSection";
import { AppearanceSection } from "./AppearanceSection";
import { AutomationsSection } from "./AutomationsSection";
import { ApiKeysSection } from "./ApiKeysSection";
import { ConnectorsSection } from "./ConnectorsSection";
import { MemorySection } from "./MemorySection";
import { OwnAiSection } from "./OwnAiSection";
import { ProvidersSection } from "./ProvidersSection";
import { UsageSection } from "./UsageSection";
import { WorkspaceSection } from "./WorkspaceSection";
import { ComputersSection } from "./ComputersSection";
import { FoldersSection, StorageSection } from "./FoldersSection";
import { WorkspacePoliciesSection } from "./WorkspacePoliciesSection";
import { WorkspaceDetailsSection } from "./WorkspaceDetailsSection";
import { MediaLibrarySection } from "./MediaLibrarySection";
import { SoundEffectsSection } from "./SoundEffectsSection";
import { ServersSection } from "./ServersSection";
import { GeneralSection } from "./GeneralSection";
import { ToolsSection } from "./ToolsSection";
import { VoiceSection } from "./VoiceSection";
import { DictationSection } from "./DictationSettings";
import { PluginSettingsPage } from "./PluginWorkspaces";

/**
 * Which component draws each Settings page. One line per page: a screen builder changes only the component on their own
 * line (and their own files). `sub` is the path segment after the page id (Providers and Admin use it).
 */
type PageBody = ComponentType<{ sub?: string }>;

export const PAGE_BODIES: Record<SettingsPageId, PageBody> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  tools: ToolsSection,
  folders: FoldersSection,
  storage: StorageSection,
  workspace: WorkspaceDetailsSection,
  library: MediaLibrarySection,
  "sound-effects": SoundEffectsSection,
  providers: ProvidersSection,
  voice: VoiceSection,
  dictation: DictationSection,
  devices: ComputersSection,
  automations: AutomationsSection,
  memory: MemorySection,
  usage: UsageSection,
  connectors: ConnectorsSection,
  keys: ApiKeysSection,
  "own-ai": OwnAiSection,
  servers: ServersSection,
  policies: WorkspacePoliciesSection,
  team: WorkspaceSection,
  admin: AdminSection,
  account: AccountSection,
  plugin: PluginSettingsPage,
};
