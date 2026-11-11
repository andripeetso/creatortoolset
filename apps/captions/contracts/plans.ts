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
 * What Claude Code said about its plan (`claude auth status --json`: subscriptionType and planTier, sent by the Mac app),
 * as a plan, or null when it doesn't say. Claude's words only: another AI's plan names go through their own mapping.
 */
export function planFromCli(text: string | null | undefined): PlanId | null {
  const t = (text ?? "").toLowerCase();
  if (/max/.test(t)) return /20/.test(t) ? "claude_max20" : "claude_max5";
  if (/\bpro\b/.test(t)) return "claude_pro";
  return null;
}

/**
 * The plan Codex's usage page names (its `plan_type`, read by the Mac app with the limits), as a plan: only the two
 * PLANS has. Every other value ("free", "go", "prolite", "team", "edu_pro"…) is null, never the nearest guess.
 */
export const codexPlan = (planType: string | null | undefined): PlanId | null =>
  planType === "plus" ? "chatgpt_plus" : planType === "pro" ? "chatgpt_pro" : null;

/**
 * An AI turning the account itself away, as one plain sentence naming what it needs, or null. Trying again never helps
 * with these, so the row says this in place of "Try again". Each pattern is the AI's own words, from:
 * - Codex: "To use Codex with your ChatGPT plan, upgrade to Plus" (its UsageNotIncluded error, codex-rs/protocol/src/
 *   error.rs; in the codex-cli 0.39 and 0.163 programs too).
 * - Google: a free Google account (Gemini CLI 0.68, tier free-tier, a real run 2026-11-10): "This client is no longer
 *   supported for Gemini Code Assist for individuals… migrate to the Antigravity suite".
 * - Claude Code 2.1: "Your account is on hold and can't use Claude Code" (its OAuthAccountOnHoldError).
 * - Grok Build 1.0.4: "Grok Build is not yet available for this account."
 * - Muse Code 1.4.15: "No subscription allowance" (a Meta account with no Muse Code plan).
 * None of these was seen in a live run except Google's: they are the programs' own texts.
 */
export function noPlanLine(raw: string): string | null {
  if (/To use Codex with your ChatGPT plan/i.test(raw)) return "Codex needs ChatGPT Plus or higher, which this account doesn't have.";
  if (/no longer supported for Gemini Code Assist|migrate to the Antigravity/i.test(raw)) return "Google turned this account away: it no longer takes free Google accounts here.";
  if (/account is on hold and can.t use Claude Code/i.test(raw)) return "Claude put this account on hold, so it can't use Claude Code.";
  if (/Grok Build is not yet available for this account/i.test(raw)) return "Grok Build isn't available for this Grok account yet.";
  if (/No subscription allowance/i.test(raw)) return "Muse Code needs a Meta plan (Everyday or higher), which this account doesn't have.";
  return null;
}

/**
 * A closed usage window in plain words, from the CLI's own: "You've hit your limit · resets 2pm (Europe/Tallinn)" →
 * "Your Claude plan's limit is reached; it resets 2pm." One sentence, as the assistant, a row or a card says it; the
 * CLI's own words go to the server log (mac-claude.ts).
 */
/** A limit message's own sentence, as a row shows it: no "X said: …" tail and no time zone name. */
export const limitLine = (message: string): string =>
  `${message.split(/\. [^.]+? said: /)[0]!.replace(/ \([A-Za-z_]+\/[A-Za-z_/]+\)/, "").replace(/\.$/, "")}.`;

/** The sentence limitMessage makes: the plan's usage is used up, which is a wait, not a failure. */
export const isLimitLine = (text: string): boolean => /plan's (?:[\w-]+ )?limit is reached/.test(text);

export function limitMessage(cli: string, tool = "Claude"): string {
  const window = /weekly/i.test(cli) ? "weekly limit" : /session|5-hour/i.test(cli) ? "5-hour limit" : "limit";
  // Claude says "resets 5pm", Codex "Try again at 5:00 PM." (codex-rs/protocol/src/error.rs retry_suffix)
  const reset = /(?:resets|try again at)\s+(?:at\s+)?([^·\n]+?)\s*\.?$/i.exec(cli.trim())?.[1];
  return limitLine(`Your ${tool} plan's ${window} is reached${reset ? `; it resets ${reset}` : ""}.`);
}
