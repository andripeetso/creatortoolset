import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canUseTile, useMe } from "@/lib/auth";
import { useSetup, useSetupLive } from "@/lib/setup";
import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import { HOME_TILES, HOME_TILE_LINES, HOME_TILE_NAMES, NEED_SHORT, readiness, type Have, type HomeTile, type Need } from "@contracts/tools";
import { PublishButton } from "@/components/community/PublishDialog";
import { Card, LoadingRow, Section, Status, saveFailed } from "./ui";

/** The hidden list after one tile's switch changes: on removes it from the list, off adds it. */
export function hiddenAfter(hidden: readonly HomeTile[], tile: HomeTile, on: boolean): HomeTile[] {
  return on ? hidden.filter((x) => x !== tile) : [...hidden.filter((x) => x !== tile), tile];
}

/**
 * What stops a tile from working: its required needs that are not set up (contracts TOOL_NEEDS). Empty for a tool that
 * works, and for the Screen Recorder, which is no tool of its own and needs nothing. What a tool has, and what is only
 * optional, is not listed anywhere on the page: a tool that works shows nothing.
 */
export function missingNeeds(tile: HomeTile, have: readonly Have[]): Need[] {
  return tile === "record" ? [] : readiness(tile, have).missing;
}

/** One missing need in the row's words: "Needs an Apify key". */
export const needLabel = (need: Need): string => `Needs ${NEED_SHORT[need.anyOf[0]]}`;

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
 * Settings → Tools: every tile Home can show, in Home's order (the tools, then the Screen Recorder), each with the
 * switch that shows it on Home. A tool that cannot work yet says why under its name, one amber line per thing it is
 * missing with the button that goes where it is fixed: the reason for its marker on Home. A tool that works shows only
 * its switch. A switch moves at once: the page keeps the list it was just given and saves it behind, and puts the saved
 * one back only when a save fails.
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
    <Section
      title="Shown on Home"
      action={view && <PublishButton item={{ kind: "home", hidden, defaultName: "" }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" />}
    >
      <Card>
        {!view ? (
          <LoadingRow />
        ) : (
          HOME_TILES.filter((t) => canUseTile(me, t)).map((t) => {
            const name = HOME_TILE_NAMES[t];
            return (
              <div key={t} data-settings-row={`home-tool-${t}`} className="px-3 py-3 sm:px-4">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="text-sm font-medium text-foreground">{name}</div>
                    <div className="text-xs text-muted-foreground">{HOME_TILE_LINES[t]}</div>
                  </div>
                  <Switch checked={!hidden.includes(t)} aria-label={`Show ${name} on Home`} onCheckedChange={(on) => set(t, on)} />
                </div>
                {missingNeeds(t, view.have).map((n) => {
                  const fix = needFix(n);
                  return (
                    <div key={n.what} className="flex min-h-8 items-center justify-between gap-6 pt-2">
                      <Status tone="attention">{needLabel(n)}</Status>
                      <Button asChild size="sm" variant="outline">
                        <Link to={fix.to}>{fix.label}</Link>
                      </Button>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </Card>
    </Section>
  );
}
