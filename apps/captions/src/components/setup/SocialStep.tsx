import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { useWorkspace } from "@/lib/workspace";

/**
 * Setup's social accounts screen (`?setup=social`, opened from Settings → Social accounts): the workspace's rows with
 * their Add and Sign in, under the screen's one line. No steps and no second paragraph (owner, 2026-11-26): what a
 * platform asks of the account is in its Add dialog's info marks. A sign-in comes back here.
 */
export function SocialStep() {
  const projectId = useWorkspace((s) => s.currentProjectId);
  return projectId ? <ConnectorsSection projectId={projectId} back="/?setup=social" /> : null;
}
