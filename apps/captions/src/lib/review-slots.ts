import type { ReviewComposerSlot, ReviewHistorySlot, ReviewPlayPlan, ReviewPreviewSlot, ReviewSlotContext } from "./plugin";

/**
 * What the Review page keeps for its plug-in slots: each plug-in's pending chips, its payload for the next
 * comment, its ⌘Z handlers and its sent callbacks. ReviewAssetPage holds one for the page and calls `onChange`
 * to re-render when a plug-in changes the composer; the slot functions are stable, so a panel may register once.
 */
export class ReviewSlotBridge {
  private payloads = new Map<string, unknown>();
  private pending = new Map<string, string[]>();
  private histories: { plugin: string; handlers: { undo: () => void; redo: () => void } }[] = [];
  private sentHandlers: { plugin: string; fn: () => void }[] = [];
  private needs = new Map<string, string>();
  private plans = new Map<string, ReviewPlayPlan>();
  private text = "";
  private textHandlers: { fn: (text: string) => void }[] = [];

  private onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange;
  }

  /** The slot functions bound to one plug-in (its id keys the payload, the pending chips and the handlers). */
  bind = (pluginId: string): Pick<ReviewSlotContext, "composer" | "history" | "preview"> => {
    const composer: ReviewComposerSlot = {
      setPending: (labels) => {
        if (labels.length) this.pending.set(pluginId, labels.map((l) => String(l).slice(0, 200)));
        else this.pending.delete(pluginId);
        this.onChange();
      },
      setPayload: (data) => {
        if (data === null || data === undefined) this.payloads.delete(pluginId);
        else this.payloads.set(pluginId, data);
        this.onChange();
      },
      setNeedsText: (why) => {
        if (why) this.needs.set(pluginId, why);
        else this.needs.delete(pluginId);
        this.onChange();
      },
      onSent: (fn) => {
        const entry = { plugin: pluginId, fn };
        this.sentHandlers.push(entry);
        return () => {
          this.sentHandlers = this.sentHandlers.filter((e) => e !== entry);
        };
      },
      onText: (fn) => {
        const entry = { fn };
        this.textHandlers.push(entry);
        fn(this.text);
        return () => {
          this.textHandlers = this.textHandlers.filter((e) => e !== entry);
        };
      },
    };
    const history: ReviewHistorySlot = {
      register: (handlers) => {
        const entry = { plugin: pluginId, handlers };
        this.histories.push(entry);
        return () => {
          this.histories = this.histories.filter((e) => e !== entry);
        };
      },
    };
    // a plan is compared with the one it replaces: a panel may set the same plan on every render without a loop
    const preview: ReviewPreviewSlot = {
      setPlan: (plan) => {
        const before = JSON.stringify(this.plans.get(pluginId) ?? null);
        if (plan) this.plans.set(pluginId, plan);
        else this.plans.delete(pluginId);
        if (JSON.stringify(plan ?? null) !== before) this.onChange();
      },
    };
    return { composer, history, preview };
  };

  /** The play plan the player follows: every plug-in's spans together (the first plug-in's fps); null when none. */
  plan(): ReviewPlayPlan | null {
    const all = [...this.plans.values()];
    if (!all.length) return null;
    return {
      fps: all[0].fps,
      skips: all.flatMap((p) => p.skips),
      mutes: all.flatMap((p) => p.mutes),
      holds: all.flatMap((p) => p.holds),
      cards: all.flatMap((p) => p.cards),
      frames: all.flatMap((p) => p.frames),
      looks: all.flatMap((p) => p.looks ?? []),
      // one sound for the whole edit: the first plan that plays it from the originals
      ...(all.find((p) => p.sound) ? { sound: all.find((p) => p.sound)!.sound } : {}),
      ...(all.find((p) => p.picture) ? { picture: all.find((p) => p.picture)!.picture } : {}),
    };
  }

  /** The page's comment box text, for the plug-ins that read it (see ReviewComposerSlot.onText). */
  setComposerText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    for (const h of this.textHandlers) h.fn(text);
  }

  /** The chips above the comment box, all plug-ins' labels in order. */
  pendingLabels(): string[] {
    return [...this.pending.values()].flat();
  }

  /** The `plugins` field of the next comment: each plug-in's payload under its id; undefined when none. */
  payload(): Record<string, unknown> | undefined {
    if (!this.payloads.size) return undefined;
    return Object.fromEntries(this.payloads);
  }

  /** Why the next comment needs written words (a plug-in's placeholder, say), or null. */
  textNeeded(): string | null {
    return [...this.needs.values()][0] ?? null;
  }

  /** A comment went out: its payloads and chips clear, and each plug-in's sent callback runs. */
  sent(): void {
    const ids = [...this.payloads.keys(), ...this.pending.keys()];
    this.payloads.clear();
    this.pending.clear();
    this.needs.clear();
    for (const e of this.sentHandlers) if (ids.includes(e.plugin)) e.fn();
    this.onChange();
  }

  /** ⌘Z (`redo` false) or ⇧⌘Z: the newest registered plug-in gets it. False when no plug-in listens. */
  history(redo: boolean): boolean {
    const top = this.histories.at(-1);
    if (!top) return false;
    if (redo) top.handlers.redo();
    else top.handlers.undo();
    return true;
  }
}
