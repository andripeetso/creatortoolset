import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { canUseTile, useMe } from "@/lib/auth";
import { useSetup, useSetupLive } from "@/lib/setup";
import { HOME_TILES, HOME_TILE_LINES, HOME_TILE_NAMES, type HomeTile } from "@contracts/tools";
import { Card, LoadingRow, Row, Section, saveFailed } from "./ui";

/** The hidden list after one tile's switch changes: on removes it from the list, off adds it. */
export function hiddenAfter(hidden: readonly HomeTile[], tile: HomeTile, on: boolean): HomeTile[] {
  return on ? hidden.filter((x) => x !== tile) : [...hidden.filter((x) => x !== tile), tile];
}

/**
 * Settings → Tools: one switch per tile Home can show, in Home's order (every tool, then the Screen Recorder). Every
 * switch starts on, so Home is what it was until one is turned off. A switch moves at once: the page keeps the list it
 * was just given and saves it behind, and puts the saved one back only when a save fails.
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
          HOME_TILES.filter((t) => canUseTile(me, t)).map((t) => (
            <Row
              key={t}
              id={`home-tool-${t}`}
              title={HOME_TILE_NAMES[t]}
              description={HOME_TILE_LINES[t]}
              control={<Switch checked={!hidden.includes(t)} aria-label={`Show ${HOME_TILE_NAMES[t]} on Home`} onCheckedChange={(on) => set(t, on)} />}
            />
          ))
        )}
      </Card>
    </Section>
  );
}
