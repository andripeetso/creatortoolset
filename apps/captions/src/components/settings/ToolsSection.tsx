import { useState } from "react";
import { Link } from "react-router";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canUseTile, useMe } from "@/lib/auth";
import { useSetup, useSetupLive } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import { HOME_TILES, HOME_TILE_LINES, HOME_TILE_NAMES, NEED_SHORT, readiness, TOOL_NEEDS, type Have, type HomeTile, type Need } from "@contracts/tools";
import { Card, LoadingRow, Section, Status, StatusDot, saveFailed } from "./ui";

/** The hidden list after one tile's switch changes: on removes it from the list, off adds it. */
export function hiddenAfter(hidden: readonly HomeTile[], tile: HomeTile, on: boolean): HomeTile[] {
  return on ? hidden.filter((x) => x !== tile) : [...hidden.filter((x) => x !== tile), tile];
}

/** What a tile needs (contracts TOOL_NEEDS). The Screen Recorder is no tool of its own and needs nothing. */
export const needsOf = (tile: HomeTile): readonly Need[] => (tile === "record" ? [] : TOOL_NEEDS[tile]);

/** The needs of a tile that are not set up yet: the required ones (they stop the tool) and the optional ones. */
export function openNeeds(tile: HomeTile, have: readonly Have[]): { missing: Need[]; extra: Need[] } {
  if (tile === "record") return { missing: [], extra: [] };
  const r = readiness(tile, have);
  return { missing: r.missing, extra: r.extra };
}

/** The row's amber line: "Needs a project, an Apify key". Empty when nothing required is missing. */
export function needsLine(tile: HomeTile, have: readonly Have[]): string {
  const { missing } = openNeeds(tile, have);
  return missing.length ? `Needs ${missing.map((n) => NEED_SHORT[n.anyOf[0]]).join(", ")}` : "";
}

const isKey = (h: Have): h is MyKeyEnv => MY_KEYS.some((k) => k.env === h);
/** Where a need is set up, and what the button that goes there says: the Settings row that holds it, or the page that makes it. */
export function needFix(need: Need): { label: string; to: string } {
  if (need.form === "keys") {
    const env = need.anyOf.find(isKey);
    return { label: "Add key", to: `/settings/keys${env ? `#api-key-${env}` : ""}` };
  }
  if (need.form === "apify") return { label: "Add key", to: "/settings/keys#apify-key" };
  if (need.form === "library") return { label: "Open Media Library", to: "/library" };
  if (need.form === "project") return { label: "New project", to: "/projects" };
  return { label: "Add AI", to: "/settings/providers" };
}

/**
 * Settings → Tools: every tile Home can show, in Home's order (the tools, then the Screen Recorder). Each row has the
 * switch that shows it on Home, and opens to what the tool needs: what is set up, what is missing and the button that
 * goes where it is fixed. A tool with something required missing says so in amber and starts open, so the reason for
 * its marker on Home is on the screen. A switch moves at once: the page keeps the list it was just given and saves it
 * behind, and puts the saved one back only when a save fails.
 */
export function ToolsSection() {
  const me = useMe();
  const view = useSetup((s) => s.view);
  const save = useSetup((s) => s.save);
  useSetupLive(true);
  const [mine, setMine] = useState<HomeTile[] | null>(null);
  const hidden = mine ?? view?.hidden ?? [];
  const set = (tile: HomeTile, on: boolean) => {
    const next = hiddenAfter(hidden, tile, on);
    setMine(next);
    save({ hidden: next }).catch(() => {
      setMine(null);
      saveFailed("The tools did not save. Try again.");
    });
  };
  return (
    <Section title="Shown on Home">
      <Card>
        {!view ? (
          <LoadingRow />
        ) : (
          HOME_TILES.filter((t) => canUseTile(me, t)).map((t) => <ToolRow key={t} tile={t} have={view.have} shown={!hidden.includes(t)} onShown={(on) => set(t, on)} />)
        )}
      </Card>
    </Section>
  );
}

/** One tool: its name and line, the amber line when something required is missing, the Home switch, and its needs under it. */
function ToolRow({ tile, have, shown, onShown }: { tile: HomeTile; have: readonly Have[]; shown: boolean; onShown: (on: boolean) => void }) {
  const needs = needsOf(tile);
  const { missing, extra } = openNeeds(tile, have);
  // a tool that cannot work yet starts open: its reason and the way to fix it are on the screen without a click
  const [open, setOpen] = useState(missing.length > 0);
  const name = HOME_TILE_NAMES[tile];
  const amber = needsLine(tile, have);
  return (
    <div data-settings-row={`home-tool-${tile}`} className="px-3 py-3 sm:px-4">
      {/* the arrow and the switch sit on the name's line, whatever the lines under the name */}
      <div className="flex items-start gap-3">
        {needs.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`What ${name} needs`}
            onClick={() => setOpen((o) => !o)}
            className="-mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight aria-hidden className={cn("size-4 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
          </button>
        ) : (
          // nothing to open: the name still lines up with the rows that have the arrow
          <span aria-hidden className="size-6 shrink-0" />
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-sm font-medium text-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">{HOME_TILE_LINES[tile]}</div>
          {amber && (
            <div className="pt-0.5">
              <Status tone="attention">{amber}</Status>
            </div>
          )}
        </div>
        <Switch checked={shown} aria-label={`Show ${name} on Home`} onCheckedChange={onShown} className="mt-0.5" />
      </div>
      {open && needs.length > 0 && (
        <ul className="ml-9 mt-2 [&>*+*]:border-t [&>*+*]:border-border/50">
          {needs.map((n) => {
            const todo = missing.includes(n) || extra.includes(n);
            const fix = needFix(n);
            return (
              <li key={n.what} className="flex min-h-11 items-center gap-2.5 py-1.5 text-sm">
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                  {!todo ? <Check className="size-4 text-muted-foreground" /> : !n.optional ? <StatusDot tone="attention" /> : null}
                </span>
                <span className={cn("min-w-0 flex-1", !todo && "text-muted-foreground")}>
                  {n.what}
                  {todo && n.optional && <span className="text-muted-foreground"> · optional</span>}
                </span>
                {todo && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={fix.to}>{fix.label}</Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
