import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { useWorkspace } from "@/lib/workspace";

/**
 * Setup's social accounts screen (`?setup=social`, opened from Settings → Social accounts): what each platform asks of
 * the account before its sign-in works, then the workspace's rows with their Add and Sign in. A sign-in comes back here.
 */
export function SocialStep() {
  const projectId = useWorkspace((s) => s.currentProjectId);
  return (
    <div className="space-y-5 text-sm">
      <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
        <li>In Instagram, switch the account to a Creator or Business account (Settings → Account type and tools).</li>
        <li>Link it to a Facebook Page (Edit profile → Page).</li>
        <li>Press Add or Sign in on Instagram below, sign in with Facebook and pick that Page.</li>
        <li>TikTok and YouTube: press Add and sign in with the account.</li>
      </ol>
      <p className="text-muted-foreground">Without a sign-in, the Content Analyzer reads only public posts: no trial reels, reach or saves.</p>
      {projectId && <ConnectorsSection projectId={projectId} back="/?setup=social" />}
    </div>
  );
}
