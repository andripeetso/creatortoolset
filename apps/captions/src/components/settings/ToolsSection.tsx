import { useState, type ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canUseTile, useAuth, useMe } from "@/lib/auth";
import { useSetup, useSetupLive } from "@/lib/setup";
import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import { HOME_TILES, HOME_TILE_LINES, HOME_TILE_NAMES, isHomeTile, needsLine, readiness, type Have, type HomeTile, type Need } from "@contracts/tools";
import { SLOT_TOOL, slotSpot, type InstalledPack, type PackSkillSlot, type PackSlot } from "@contracts/packs";
import { SKILL_PLACES, type SkillPlace } from "@contracts/skills";
import type { StepsView } from "@contracts/editor-steps";
import { useCachedLoad } from "@/lib/local-cache";
import { listInstalled } from "@/components/community/packs-api";
import { PACK_TOOLS, containsOf, reachesTool } from "@/components/community/packs-helpers";
import { PackRow } from "@/components/community/PacksInstalled";
import { SkillsView } from "@/components/community/SkillsView";
import { ToolPlugins, stepsFor, useSteps, type Steps } from "@/components/community/PluginsCatalog";
import { hasThisMac, useMacRecorder } from "./ThisMacSection";
import { RecorderSettings } from "./RecorderSettings";
import { toolSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { PublishButton } from "@/components/community/PublishDialog";
import { Card, Folded, LoadingRow, Section, Status, saveFailed } from "./ui";

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
export const needLabel = (need: Need): string => needsLine([need]);

const isKey = (h: Have): h is MyKeyEnv => MY_KEYS.some((k) => k.env === h);
/** Where a need is set up, and what the button that goes there says: the Settings row that holds it, or the page that makes it. */
export function needFix(need: Need): { label: string; to: string } {
  if (need.form === "keys") {
    const env = need.anyOf.find(isKey);
    return { label: "Add key", to: `/settings/keys${env ? `#api-key-${env}` : ""}` };
  }
  if (need.form === "apify") return { label: "Add key", to: "/settings/keys#apify-key" };
  if (need.form === "library") return { label: "Open Media Library", to: "/library" };
  if (need.form === "project") return { label: "New workspace", to: "/projects" };
  return { label: "Add AI", to: "/settings/providers" };
}

/** Home's switches: the list the page was just given while it saves behind; the saved one back when a save fails. */
function useHomeSwitches() {
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
  return { view, hidden, set };
}

/** The skill places that are part of a tool (the assistant's are no tool's: Community → Skills has them). */
export const skillPlacesOf = (t: HomeTile): SkillPlace[] => SKILL_PLACES.filter((p): p is PackSkillSlot | "workshop.write" => p !== "assistant" && SLOT_TOOL[p] === t);

/** Community has something to add to a tool: packs and skills have a place in it, or a plug-in adds a step to it. */
export const canAddTo = (t: HomeTile, steps: StepsView | null): boolean => PACK_TOOLS.includes(t) || stepsFor(steps, t).length > 0;

/** One tile's Home switch, with one amber line per thing it is missing and the button that goes where it is fixed. */
function TileRow({ tile: t, have, shown, onChange, head }: { tile: HomeTile; have: readonly Have[]; shown: boolean; onChange: (on: boolean) => void; head: ReactNode }) {
  return (
    <div data-settings-row={`home-tool-${t}`} className="px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-6">
        {head}
        <Switch checked={shown} aria-label={`Show ${HOME_TILE_NAMES[t]} on Home`} onCheckedChange={onChange} />
      </div>
      {missingNeeds(t, have).map((n) => {
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
}

/**
 * Settings → Tools: every tile Home can show, in Home's order (the tools, then the Screen Recorder), each with the
 * switch that shows it on Home. A tool that cannot work yet says why under its name, one amber line per thing it is
 * missing with the button that goes where it is fixed: the reason for its marker on Home. A tool that works shows only
 * its switch. Every tool opens its own page (ToolPage, `/settings/tools/<tile>`), the one place for its settings: the
 * list says nothing about what is on it (owner, 2026-11-15, on "1 added": "very confusing… needs proper refiguring").
 */
export function ToolsSection({ sub }: { sub?: string }) {
  const steps = useSteps();
  const me = useMe();
  const recorder = useMacRecorder();
  if (sub) {
    // the Screen Recorder's page waits for the Mac app to say whether it has its settings
    if (sub === "record" && recorder === null) return <LoadingRow />;
    if (!isHomeTile(sub) || (me && !canUseTile(me, sub))) return <Navigate to="/settings/tools" replace />;
    return <ToolPage tile={sub} steps={steps} recorder={!!recorder} />;
  }
  return <ToolsList />;
}

function ToolsList() {
  const me = useMe();
  const { view, hidden, set } = useHomeSwitches();
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
            const text = (
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm font-medium text-foreground">{HOME_TILE_NAMES[t]}</div>
                <div className="text-xs text-muted-foreground">{HOME_TILE_LINES[t]}</div>
              </div>
            );
            const head = (
              <Link to={`/settings/tools/${t}`} replace className="group -my-1 flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {text}
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </Link>
            );
            return <TileRow key={t} tile={t} have={view.have} shown={!hidden.includes(t)} onChange={(on) => set(t, on)} head={head} />;
          })
        )}
      </Card>
    </Section>
  );
}

/**
 * Settings → Tools → <tool>: everything about one tool, folded so the page reads as a short list (owner, 2026-11-15: "way
 * too cluttered… hidden underneath trigger boxes… super unified"). On top its Home switch with what it is missing; then
 * one closed fold per settings section (the Screen Recorder's Recording, each plug-in section that names the tool, under
 * its title); last one fold for what Community adds to it: its plug-ins (an AI Editor step with its switch for new edits
 * and options, on the Mac app's own server), its installed packs, its skills by place and Get more.
 */
function ToolPage({ tile, steps, recorder }: { tile: HomeTile; steps: Steps; recorder: boolean }) {
  const me = useMe();
  const { view, hidden, set } = useHomeSwitches();
  const hosted = useAuth((s) => s.hosted);
  const packs = useCachedLoad<InstalledPack[]>("/api/packs", listInstalled, { topic: ["packs"], own: true });
  const name = HOME_TILE_NAMES[tile];
  const mine = (packs.data ?? []).filter((p) => reachesTool(containsOf(p), tile));
  const places = skillPlacesOf(tile);
  return (
    <div className="space-y-3">
      <Card>{view ? <TileRow tile={tile} have={view.have} shown={!hidden.includes(tile)} onChange={(on) => set(tile, on)} head={<div className="min-w-0 flex-1 text-sm font-medium text-foreground">Show on Home</div>} /> : <LoadingRow />}</Card>
      {tile === "record" && recorder && (
        <Folded title="Recording">
          <RecorderSettings />
        </Folded>
      )}
      {toolSectionsFor(me, webPlugins, tile).map((s) => (
        <Folded key={s.id} title={s.title}>
          {s.body}
        </Folded>
      ))}
      {canAddTo(tile, steps.view) && (
        <Folded title="Plug-ins, packs and skills">
          <ToolPlugins steps={steps} tool={tile} switches={tile === "editor" && hasThisMac() && !hosted} />
          {mine.length > 0 && (
            <Section title="Packs">
              <Card>
                {mine.map((p) => (
                  <PackRow key={p.id} pack={p} reload={() => packs.refresh().then(() => undefined)} />
                ))}
              </Card>
            </Section>
          )}
          {places.length > 0 && <SkillsView places={places} title={(p) => `Skills for ${slotSpot(p as PackSlot)}`} />}
          <div className="px-3 py-3 sm:px-4">
            <Button asChild size="sm" variant="outline">
              <Link to={`/community/tool/${tile}`}>Get more for {name}</Link>
            </Button>
          </div>
        </Folded>
      )}
    </div>
  );
}
