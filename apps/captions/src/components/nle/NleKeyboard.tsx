import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { COMMANDS } from "@/lib/nle/commands";
import { bind, chordLabel, chordOf, chordsOf, conflict, keymap, type KeyPreset } from "@/lib/nle/keys";
import { useWorkPrefs } from "@/lib/setup";
import { cn } from "@/lib/utils";

// Keyboard Customization (⌘⌥K, Resolve's window of the same name): a drawn Mac keyboard, every command with its keys,
// and the preset. A change is saved at once in the account's work prefs (api/work-prefs.ts), so the same keys follow
// the person to every computer and browser they sign in on.

/** What a key can run: every command that needs nothing but the key (Add Marker asks for the rest), and each video track's lock. */
export const KEYABLE: { id: string; title: string }[] = [
  ...Object.values(COMMANDS).filter((c) => c.id === "addMarker" || (c.id !== "select" && !Object.keys(c.params).length)).map(({ id, title }) => ({ id, title })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `lock:V${n}`, title: `Lock / unlock V${n}` })),
];
const titleOf = (id: string) => KEYABLE.find((c) => c.id === id)?.title ?? id;

/** The keys in force for this account: the preset with their own changes over it. */
export function useKeymap(): Record<string, string> {
  const prefs = useWorkPrefs((s) => s.prefs);
  useEffect(() => {
    if (!useWorkPrefs.getState().prefs) void useWorkPrefs.getState().load();
  }, []);
  return useMemo(() => keymap(prefs?.keyPreset, prefs?.keys), [prefs?.keyPreset, prefs?.keys]);
}

// A Mac keyboard: each key's name as chordOf writes it, its cap and its width in keys
type Cap = [name: string, cap?: string, w?: number];
const chars = (s: string): Cap[] => [...s].map((c) => [c]);
const ROWS: Cap[][] = [
  [["Escape", "esc", 1.5], ...Array.from({ length: 12 }, (_, i): Cap => [`F${i + 1}`]), ["Delete", "⌦"], ["Home", "home"], ["End", "end"]],
  [...chars("`1234567890-="), ["Backspace", "⌫", 1.5]],
  [["Tab", "⇥", 1.5], ...chars("QWERTYUIOP[]\\")],
  [...chars("ASDFGHJKL;'")],
  [...chars("ZXCVBNM,./")],
  [["Space", "space", 6], ["ArrowLeft", "←"], ["ArrowUp", "↑"], ["ArrowDown", "↓"], ["ArrowRight", "→"]],
];
// ⇧ changes what these keys type (e.key), so with ⇧ their chord carries the shifted character (⇧= is "⇧+")
const SHIFTED: Record<string, string> = { "`": "~", "-": "_", "=": "+", "\\": "|", ";": ":", "'": '"', "/": "?" };
const MODS = [["⌘", "Command"], ["⌥", "Option"], ["⇧", "Shift"]] as const;

export function NleKeyboard({ onClose }: { onClose: () => void }) {
  const prefs = useWorkPrefs((s) => s.prefs);
  const preset: KeyPreset = prefs?.keyPreset ?? "default";
  const over = useMemo(() => prefs?.keys ?? {}, [prefs?.keys]);
  const map = useMemo(() => keymap(preset, over), [preset, over]);
  const [mods, setMods] = useState({ "⌘": false, "⌥": false, "⇧": false });
  const [find, setFind] = useState("");
  /** the command a chord is being given to; `taken`: the chord pressed, which runs another command */
  const [pick, setPick] = useState<{ id: string; taken?: string } | null>(null);
  const save = (keys: Record<string, string>) => void useWorkPrefs.getState().put({ keys });
  const give = (id: string, chord: string) => {
    save(bind(preset, over, chord, id));
    setPick(null);
  };

  // a row picked: the next key pressed (with its modifiers) is its new chord; Esc lets go
  useEffect(() => {
    if (!pick || pick.taken) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setPick(null);
      const chord = chordOf(e);
      const other = conflict(map, chord, pick.id);
      if (other) setPick({ id: pick.id, taken: chord });
      else give(pick.id, chord);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const held = `${mods["⌘"] ? "⌘" : ""}${mods["⌥"] ? "⌥" : ""}${mods["⇧"] ? "⇧" : ""}`;
  const chordAt = (name: string) => (mods["⇧"] && SHIFTED[name] && map[held + SHIFTED[name]] ? held + SHIFTED[name] : held + name);
  const q = find.trim().toLowerCase();
  const rows = KEYABLE.filter((c) => !q || c.title.toLowerCase().includes(q) || chordsOf(map, c.id).some((k) => chordLabel(k).toLowerCase().includes(q)));
  const picked = pick ? chordsOf(map, pick.id) : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl" onEscapeKeyDown={(e) => { if (pick) (e.preventDefault(), setPick(null)); }}>
        <DialogHeader>
          <DialogTitle>Keyboard Customization</DialogTitle>
          <DialogDescription>Pick a command, then press its new keys. Changes are saved to your account.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <RadioGroup value={preset} onValueChange={(v) => void useWorkPrefs.getState().put({ keyPreset: v as KeyPreset })} aria-label="Preset" className="gap-1.5">
            <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="default" />Default: Q W E, 1 2 3 and Tab over Resolve's keys</Label>
            <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="resolve" />DaVinci Resolve: Resolve's own keys</Label>
          </RadioGroup>
          <Button variant="outline" size="sm" disabled={!Object.keys(over).length} onClick={() => save({})}>Reset to preset</Button>
        </div>

        <div className="overflow-x-auto">
          <div className="mb-2 flex gap-1" role="group" aria-label="Modifiers">
            {MODS.map(([m, name]) => (
              <button key={m} type="button" aria-pressed={mods[m]} aria-label={name} title={name} onClick={() => setMods((o) => ({ ...o, [m]: !o[m] }))}
                className={cn("h-7 w-10 rounded border text-sm", mods[m] ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted")}>{m}</button>
            ))}
          </div>
          <div className="grid w-max gap-1" aria-label="Keyboard">
            {ROWS.map((row, r) => (
              <div key={r} className={cn("flex gap-1", r === 3 && "pl-[2.1rem]", r === 4 && "pl-[3.3rem]")}>
                {row.map(([name, cap, w = 1]) => {
                  const chord = chordAt(name);
                  const id = map[chord];
                  return (
                    <div key={name} title={id ? `${chordLabel(chord)}: ${titleOf(id)}` : chordLabel(chord)} data-chord={chord}
                      style={{ width: `${w * 3.25 + (w - 1) * 0.25}rem` }}
                      className={cn("flex h-12 shrink-0 select-none flex-col overflow-hidden rounded border px-1 py-0.5 text-left",
                        pick?.taken === chord ? "border-destructive bg-destructive/15"
                          : picked.includes(chord) ? "border-primary bg-primary/15"
                          : id ? "border-border bg-muted" : "border-border/60 text-muted-foreground")}>
                      <span className="text-[11px] font-medium leading-tight">{cap ?? name}</span>
                      {id && <span className="line-clamp-2 text-[9px] leading-tight text-muted-foreground">{titleOf(id)}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search commands" aria-label="Search commands" />
        <div className="h-72 overflow-y-auto rounded border" role="list" aria-label="Commands">
          {rows.map((c) => {
            const on = pick?.id === c.id;
            return (
              <div key={c.id} role="listitem" aria-label={c.title} className={cn("grid h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-2 text-sm last:border-b-0", on && "bg-muted")}>
                <button type="button" className="truncate text-left" title={c.title} onClick={() => setPick(on ? null : { id: c.id })}>{c.title}</button>
                <div className="flex items-center gap-1">
                  {on && pick.taken ? (
                    <>
                      <span data-conflict className="max-w-[26rem] truncate text-[12px] text-red-500 dark:text-red-400" title={titleOf(map[pick.taken])}>{chordLabel(pick.taken)} is {titleOf(map[pick.taken])}</span>
                      <Button size="sm" variant="destructive" className="h-6 px-2" onClick={() => give(c.id, pick.taken!)}>Assign</Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setPick(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      {chordsOf(map, c.id).map((k) => (
                        <span key={k} className="inline-flex h-6 items-center gap-0.5 rounded border bg-muted pl-1.5 font-mono text-[12px]">
                          {chordLabel(k)}
                          <button type="button" aria-label={`Remove ${chordLabel(k)}`} title="Remove" className="px-1 text-muted-foreground hover:text-foreground" onClick={() => save(bind(preset, over, k, ""))}>
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                      {on
                        ? <span className="text-[12px] text-muted-foreground">Press keys</span>
                        : <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setPick({ id: c.id })}>Add</button>}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
