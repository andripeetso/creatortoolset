/** A row of Home's Activity list and the Mac menu bar panel (GET /api/activity, api/activity.ts). */

export type ActivityState = "working" | "ready";

// What a row's button does on the Mac the app runs on: start, stop or restart (kickstart) a LaunchAgent. Only a label the
// plug-in declares in `launchAgents` passes (pluginActivity drops the rest). The Mac runs it (apps/mac LaunchAgent.swift).
export type AgentRun = "start" | "stop" | "restart";
export interface ActivityAction {
  id: string;
  title: string;
  run: AgentRun;
  label: string;
}

export interface ActivityRow {
  id: string;
  title: string;
  detail: string;
  state: ActivityState;
  // An app path such as "/editor". Never a full URL, never a protocol-relative "//" one.
  href: string;
  // Buttons on the row (the Mac's pill). Optional; a row with none has no buttons.
  actions?: ActivityAction[];
  /** How far it is, 0 to 1. */
  progress?: number;
  /** Why the work waits and when it carries on by itself (an AI plan's limit). A row with a reason is not moving. */
  reason?: string;
}
