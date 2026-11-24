import { AllowedFolders } from "./StorageRows";
import { Card, Section } from "./ui";

/**
 * Settings → You → Folder access (Mac app): the folders the app may read on this Mac, the same in every workspace and
 * tool (owner, 2026-11-23). Added here, from a clip's Allow folder, or when a drop is used where it is; each with Remove.
 * A workspace's own Media, Projects and Exports are Settings → Folders.
 */
export function FolderAccessSection() {
  return (
    <Section title="Folder access">
      <Card className="empty:hidden">
        <AllowedFolders rows={[]} />
      </Card>
    </Section>
  );
}
