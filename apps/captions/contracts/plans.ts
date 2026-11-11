/**
 * The subscription plans a person's own Claude Code or Codex runs on, what a heavy feature usually costs, and the
 * plain words for a closed usage window. Shared by the server (the relay's limit error) and the browser (setup's
 * plan question, the warning before a heavy run).
 *
 * Costs are API-equivalent dollars (what the same tokens would cost on the API: the CLI's own `total_cost_usd`,
 * tallied per job in Settings → Usage), so a cost and a plan's 5-hour window compare in one unit.
 */

export const PLANS = [
  { id: "claude_pro", label: "Claude Pro", small: true },
  { id: "claude_max5", label: "Claude Max 5x", small: false },
  { id: "claude_max20", label: "Claude Max 20x", small: false },
  { id: "chatgpt_plus", label: "ChatGPT Plus", small: true },
  { id: "chatgpt_pro", label: "ChatGPT Pro", small: false },
] as const;
export type PlanId = (typeof PLANS)[number]["id"];
export const isPlan = (p: unknown): p is PlanId => PLANS.some((x) => x.id === p);

/**
 * About how much API-equivalent work one 5-hour window holds. ESTIMATES: neither company publishes a dollar figure.
 * The Pro and Plus anchors are our estimate; the multiples are the published ones (Max 5x and 20x are 5 and 20 times
 * Pro; ChatGPT Pro is described as many times Plus, 10x taken here).
 */
export const WINDOW_USD: Record<PlanId, number> = {
  claude_pro: 8,
  claude_max5: 40,
  claude_max20: 160,
  chatgpt_plus: 8,
  chatgpt_pro: 80,
};

/** A heavy feature's typical cost, and where the number comes from. `per`: the cost is per item (posts), times the count. */
export const FEATURE_COST = {
  editor: { label: "An AI Editor run", usd: 4, source: "measured on the editor pipeline this one was ported from: a full run with six versions (analyze, script, drafts), 2026-10; not yet measured on this code" },
  research: { label: "Deep research", usd: 1.5, source: "estimate: a few minutes of Claude reading sources (timed 2026-10, cost not measured)" },
  analyzer: { label: "Reading posts in the Analyzer", usd: 0.05, per: "post", source: "estimate: one post's caption, slides and transcript" },
} as const;
export type Feature = keyof typeof FEATURE_COST;

/** A run that takes at least this share of a small plan's window gets a warning first. */
export const WARN_SHARE = 0.2;

export const shareOfWindow = (plan: PlanId, feature: Feature, count = 1) =>
  (FEATURE_COST[feature].usd * ("per" in FEATURE_COST[feature] ? count : 1)) / WINDOW_USD[plan];

const words = (share: number) =>
  share >= 1 ? "more than a whole" : share >= 0.85 ? "nearly all of a" : share >= 0.4 ? "about half of a" : share >= 0.28 ? "about a third of a" : "about a quarter of a";

/** The warning before a heavy run on Pro or Plus, or null (no plan given, a bigger plan, or a light run). */
export function planWarning(plan: PlanId | null | undefined, feature: Feature, count = 1): string | null {
  const p = PLANS.find((x) => x.id === plan);
  if (!p?.small) return null;
  const share = shareOfWindow(p.id, feature, count);
  if (share < WARN_SHARE) return null;
  const what = "per" in FEATURE_COST[feature] ? `${FEATURE_COST[feature].label} (${count} ${FEATURE_COST[feature].per}s)` : FEATURE_COST[feature].label;
  return `${what} usually uses ${words(share)} ${p.label} plan's 5-hour limit (an estimate). When the limit is reached, AI work stops until it resets.`;
}

/**
 * What the CLI said about its plan (`claude auth status --json`: subscriptionType and planTier, sent by the Mac app),
 * as a plan, or null when it doesn't say. Codex says only "ChatGPT", never the plan.
 */
export function planFromCli(text: string | null | undefined): PlanId | null {
  const t = (text ?? "").toLowerCase();
  if (/max/.test(t)) return /20/.test(t) ? "claude_max20" : "claude_max5";
  if (/\bpro\b/.test(t)) return "claude_pro";
  return null;
}

/**
 * A closed usage window in plain words, from the CLI's own: "You've hit your limit · resets 2pm (Europe/Tallinn)" →
 * "Your Claude plan's limit is reached; it resets 2pm (Europe/Tallinn)." The CLI's words follow, as it said them.
 */
/** A limit message's own sentence, as a row shows it: no "X said: …" tail and no time zone name. */
export const limitLine = (message: string): string =>
  `${message.split(/\. [^.]+? said: /)[0]!.replace(/ \([A-Za-z_]+\/[A-Za-z_/]+\)/, "").replace(/\.$/, "")}.`;

export function limitMessage(cli: string, tool = "Claude"): string {
  const window = /weekly/i.test(cli) ? "weekly limit" : /session|5-hour/i.test(cli) ? "5-hour limit" : "limit";
  const reset = /resets\s+(?:at\s+)?([^·\n]+?)\s*\.?$/i.exec(cli.trim())?.[1];
  return `Your ${tool} plan's ${window} is reached${reset ? `; it resets ${reset}` : ""}. ${tool} said: ${cli.trim()}`;
}
