import type { ProvidersView } from "@contracts/providers";
import { cn } from "@/lib/utils";
import { selectCls } from "./helpers";

/**
 * The page's first line: "Applying settings for All projects on <Mac>". The Mac is a picker
 * (its providers are listed below); members see that the workspace's Macs answer them instead.
 */
export function ScopeSentence({
  devices,
  device,
  readOnly,
  onPick,
}: {
  devices: ProvidersView["devices"];
  device: ProvidersView["devices"][number] | null;
  readOnly: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm text-muted-foreground">
      <span>Applying settings for</span>
      <span className="font-medium text-foreground">All projects</span>
      <span>on</span>
      {readOnly ? (
        <span className="font-medium text-foreground">the workspace's Macs</span>
      ) : devices.length > 0 ? (
        <select
          aria-label="Mac"
          value={device?.id ?? ""}
          onChange={(e) => onPick(e.target.value)}
          className={cn(selectCls, "h-7 max-w-full font-medium")}
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.owner === "workspace" ? " (workspace)" : ""}
              {d.online ? "" : " (offline)"}
            </option>
          ))}
        </select>
      ) : (
        <span className="font-medium text-foreground">no Mac yet</span>
      )}
    </p>
  );
}
