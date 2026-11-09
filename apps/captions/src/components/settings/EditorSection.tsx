import { useEffect, useState } from "react";
import { Link } from "react-router";
import { EDIT_SLOT_NAME, EDIT_SLOTS, type EditorDefaults, type EditSlot } from "@contracts/editor";
import { Button } from "@/components/ui/button";
import { getEditorDefaults, setEditorDefault } from "@/lib/editor";
import { Loading, Notice } from "./ui";
import { msg, selectCls } from "./helpers";

/**
 * Settings → Editor: the default set every new AI Editor edit starts with, one row per slot (design, grade, voice mix,
 * sound effects). Each row shows what the next edit gets and where it comes from, changes it, or goes back to the
 * built-in one. An edit keeps the set it was made with, so a change here never changes an edit that exists.
 */
export function EditorSection() {
  const [data, setData] = useState<EditorDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getEditorDefaults().then(setData, (e) => setError(msg(e)));
  }, []);

  const change = (slot: EditSlot, id: string | null) => {
    setBusy(true);
    setEditorDefault(slot, id)
      .then((next) => {
        setData(next);
        setError(null);
      }, (e) => setError(msg(e)))
      .finally(() => setBusy(false));
  };

  if (!data) return error ? <Notice tone="error">Could not load the editor defaults: {error}</Notice> : <Loading />;

  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {EDIT_SLOTS.map((slot) => {
          const current = data.items[slot].find((i) => i.id === data.bundle[slot]);
          const source = data.chosen[slot] === data.bundle[slot] ? "Your choice" : current?.from ? `From ${current.from}` : "Built in";
          return (
            <li key={slot} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{EDIT_SLOT_NAME[slot]}</p>
                <p className="text-xs text-muted-foreground">
                  {current?.title ?? data.bundle[slot]} · {source}
                </p>
              </div>
              {/* a slot with one item (design: packs do not install design systems yet) has nothing to choose */}
              {data.items[slot].length > 1 && (
                <select
                  aria-label={`${EDIT_SLOT_NAME[slot]} for new edits`}
                  className={selectCls}
                  value={data.bundle[slot]}
                  disabled={busy}
                  onChange={(e) => change(slot, e.target.value)}
                >
                  {data.items[slot].map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.from ? `${i.title} (${i.from})` : i.title}
                    </option>
                  ))}
                </select>
              )}
              {data.chosen[slot] !== undefined && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(slot, null)}>
                  Reset
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        More sets come in packs: download one, or make your own, in <Link to="/community/installed" className="underline">Community</Link>.
      </p>
    </div>
  );
}
