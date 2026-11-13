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
import { SKILL_PLACES, placeOf, type SharedSkill, type Skill, type SkillPlace } from "@contracts/skills";
import type { StepsView } from "@contracts/editor-steps";
import { useCachedLoad } from "@/lib/local-cache";
import { listSkills } from "@/lib/skills";
import { listInstalled } from "@/components/community/packs-api";
import { PACK_TOOLS, containsOf, reachesTool } from "@/components/community/packs-helpers";
import { PackRow } from "@/components/community/PacksInstalled";
import { SkillsView } from "@/components/community/SkillsView";
import { ToolPlugins, stepsFor, useSteps, type Steps } from "@/components/community/PluginsCatalog";
import { hasThisMac } from "./ThisMacSection";
import { RecorderSettings } from "./RecorderSettings";
import { toolSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
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
  if (need.form === "project") return { label: "New project", to: "/projects" };
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

/** A tool has a page when something can be added to it: packs and skills have a place in it, or a plug-in names it. */
export const hasToolPage = (t: HomeTile, steps: StepsView | null): boolean => (t === "record" && hasThisMac()) || PACK_TOOLS.includes(t) || stepsFor(steps, t).length > 0 || toolSectionsFor(null, webPlugins, t).length > 0;

/**
 * What the person has added to each tool and is using: installed packs that reach it and are on (not off everywhere, not
 * pulled), skills at its places that are on (their own and the ones packs and plug-ins bring), plug-ins that are in.
 * Best effort: a list that did not load counts nothing.
 */
function useAdded(steps: StepsView | null) {
  const packs = useCachedLoad<InstalledPack[]>("/api/packs", listInstalled, { topic: ["packs"] });
  const skills = useCachedLoad<{ skills: Skill[]; shared?: SharedSkill[] }>("/api/skills", listSkills, { topic: ["skills", "packs"] });
  return (t: HomeTile): number => {
    const places = skillPlacesOf(t) as string[];
    return (
      (packs.data ?? []).filter((p) => !p.off.includes("*") && !p.delisted && reachesTool(containsOf(p), t)).length +
      (skills.data?.skills ?? []).filter((s) => s.on && places.includes(placeOf(s))).length +
      (skills.data?.shared ?? []).filter((s) => s.on && places.includes(s.place)).length +
      stepsFor(steps, t).filter((r) => r.state === "on" || r.state === "loaded").length
    );
  };
}

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
 * its switch. A tool something can be added to opens its own page (ToolPage), and says how many things are added to it.
 * `/settings/tools/<tile>` is that page.
 */
export function ToolsSection({ sub }: { sub?: string }) {
  const steps = useSteps();
  const me = useMe();
  if (sub) {
    if (!isHomeTile(sub) || (me && !canUseTile(me, sub)) || (steps.view && !hasToolPage(sub, steps.view))) return <Navigate to="/settings/tools" replace />;
    return <ToolPage tile={sub} steps={steps} />;
  }
  return <ToolsList steps={steps.view} />;
}

function ToolsList({ steps }: { steps: StepsView | null }) {
  const me = useMe();
  const { view, hidden, set } = useHomeSwitches();
  const added = useAdded(steps);
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
            const n = added(t);
            const head = hasToolPage(t, steps) ? (
              <Link to={`/settings/tools/${t}`} replace className="group -my-1 flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {text}
                {n > 0 && <span className="shrink-0 text-xs text-muted-foreground">{n} added</span>}
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </Link>
            ) : (
              text
            );
            return <TileRow key={t} tile={t} have={view.have} shown={!hidden.includes(t)} onChange={(on) => set(t, on)} head={head} />;
          })
        )}
      </Card>
    </Section>
  );
}

/**
 * Settings → Tools → <tool>: everything added to one tool, in one place. Its Home switch, the plug-ins that add to it (an
 * AI Editor step with its switch for new edits and options, on the Mac app's own server) and their own sections (a
 * plug-in section with `tool`), the installed packs that reach it, its skills by place, and the way to Community's
 * section for it.
 */
function ToolPage({ tile, steps }: { tile: HomeTile; steps: Steps }) {
  const me = useMe();
  const { view, hidden, set } = useHomeSwitches();
  const hosted = useAuth((s) => s.hosted);
  const packs = useCachedLoad<InstalledPack[]>("/api/packs", listInstalled, { topic: ["packs"], own: true });
  const name = HOME_TILE_NAMES[tile];
  const mine = (packs.data ?? []).filter((p) => reachesTool(containsOf(p), tile));
  const places = skillPlacesOf(tile);
  return (
    <>
      <Section title="Shown on Home">
        <Card>{view ? <TileRow tile={tile} have={view.have} shown={!hidden.includes(tile)} onChange={(on) => set(tile, on)} head={<div className="min-w-0 flex-1 text-sm text-muted-foreground">{HOME_TILE_LINES[tile]}</div>} /> : <LoadingRow />}</Card>
      </Section>
      {tile === "record" && hasThisMac() && (
        <Section title="Recording">
          <RecorderSettings />
        </Section>
      )}
      <ToolPlugins steps={steps} tool={tile} inSettings switches={tile === "editor" && hasThisMac() && !hosted} />
      {toolSectionsFor(me, webPlugins, tile).map((s) => (
        <Section key={s.id} title={s.title}>
          {s.body}
        </Section>
      ))}
      {mine.length > 0 && (
        <Section title="Packs">
          <Card>
            {mine.map((p) => (
              <div key={p.id} className="[&>*+*]:border-t [&>*+*]:border-border/50">
                <PackRow pack={p} reload={() => packs.refresh().then(() => undefined)} />
              </div>
            ))}
          </Card>
        </Section>
      )}
      {places.length > 0 && <SkillsView places={places} title={(p) => `Skills for ${slotSpot(p as PackSlot)}`} />}
      <div>
        <Button asChild size="sm" variant="outline">
          <Link to={`/community/tool/${tile}`}>Get more for {name}</Link>
        </Button>
      </div>
    </>
  );
}
