/**
 * Limits per workspace, set by a hook. The public app caps nothing: every workspace is unlimited until a build
 * installs a hook with setLimitsHook(). A hosted build's plug-in does that at load, from its own billing data.
 * Nothing in this file knows about billing or any service.
 *
 * ponytail: the hook is synchronous and there is one. A billing lookup that needs a database or a network call
 * makes this async, and a second hook (for seats or AI budgets) becomes a list.
 */

export interface WorkspaceLimits {
  /** Bytes the workspace may keep in its metered libraries; null = no cap. */
  storageBytes: number | null;
}

export type LimitsHook = (workspace: string) => WorkspaceLimits;

let hook: LimitsHook = () => ({ storageBytes: null });

/** The limits for a workspace. With no hook installed, every field is null (no cap). */
export function limitsFor(workspace: string): WorkspaceLimits {
  return hook(workspace);
}

/** Installs a hook, or with null puts back the no-limit default. Tests use it to set a cap and clear it again. */
export function setLimitsHook(next: LimitsHook | null): void {
  hook = next ?? (() => ({ storageBytes: null }));
}
