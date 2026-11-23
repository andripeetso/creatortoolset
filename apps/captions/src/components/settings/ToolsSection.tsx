import { useState, type ReactNode } from "react";
import { Link, Navigate } from "react-router";
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
import { EditorDefaultsSection } from "./EditorDefaultsDialog";
import { toolSectionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { PublishButton } from "@/components/community/PublishDialog";
import { Card, LoadingRow, Section, Status, saveFailed, markSave } from "./ui";

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
  return { label: "Add provider", to: "/settings/providers" };
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
    markSave(save({ hidden: next })).catch(() => {
      setMine(null);
      saveFailed("Home tools not saved. Try again.");
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
 * A tool has a settings page when there is something on it: the Screen Recorder's settings in a Mac app that has them
 * (`recorder`), what Community adds to a tool (canAddTo), or a plug-in's section that names it (for this account).
 */
export const hasToolPage = (t: HomeTile, steps: StepsView | null, me: { role: string } | null, recorder = false): boolean =>
  (t === "record" && recorder) || canAddTo(t, steps) || toolSectionsFor(me, webPlugins, t).length > 0;

/** The tools that have a settings page, in Home's order: the sidebar lists one entry each (SettingsPage, nav.ts withToolPages). */
export function useToolPages(): HomeTile[] {
  const me = useMe();
  const steps = useSteps();
  const recorder = useMacRecorder();
  return HOME_TILES.filter((t) => canUseTile(me, t) && hasToolPage(t, steps.view, me, !!recorder));
}

/**
 * Settings → Tools: every tile Home can show, in Home's order (the tools, then the Screen Recorder), each with the
 * switch that shows it on Home and nothing else to press: a row does one thing (owner, 2026-11-16, on a row that also
 * opened a page: "unexpectedly takes me to another page which I didn't know it's gonna do"). A tool that cannot work yet
 * says why under its name, one amber line per thing it is missing with the button that goes where it is fixed: the
 * reason for its marker on Home. A tool's own settings are a page of their own in the sidebar (`/settings/tools/<tile>`).
 */
export function ToolsSection({ sub }: { sub?: string }) {
  const steps = useSteps();
  const me = useMe();
  const recorder = useMacRecorder();
  if (sub) {
    // the Screen Recorder's page waits for the Mac app to say whether it has its settings
    if (sub === "record" && recorder === null) return <LoadingRow />;
    if (!isHomeTile(sub) || (me && !canUseTile(me, sub)) || (steps.view && !hasToolPage(sub, steps.view, me, !!recorder))) return <Navigate to="/settings/tools" replace />;
    return <ToolPage tile={sub} steps={steps} recorder={!!recorder} />;
  }
  return <ToolsList />;
}

function ToolsList() {
  const me = useMe();
  const { view, hidden, set } = useHomeSwitches();
  return (
    <Section
      title="Home tools"
      action={view && <PublishButton item={{ kind: "home", hidden, defaultName: "" }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" />}
    >
      <Card>
        {!view ? (
          <LoadingRow />
        ) : (
          HOME_TILES.filter((t) => canUseTile(me, t)).map((t) => (
            <TileRow
              key={t}
              tile={t}
              have={view.have}
              shown={!hidden.includes(t)}
              onChange={(on) => set(t, on)}
              head={
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-sm font-medium text-foreground">{HOME_TILE_NAMES[t]}</div>
                  <div className="text-xs text-muted-foreground">{HOME_TILE_LINES[t]}</div>
                </div>
              }
            />
          ))
        )}
      </Card>
    </Section>
  );
}

/**
 * Settings → <tool> (`/settings/tools/<tile>`, an entry in the sidebar's Tool settings block): one tool's settings, every
 * section open on the page as on any other Settings page (owner, 2026-11-16, on folds and a repeated Home switch: "I
 * have to do more clicks… more trigger tools to go deeper"). The Screen Recorder's Recording, the AI Editor's defaults
 * for new edits (each workspace has its own: the section draws the workspace selector), each plug-in section that names
 * the tool under its title, its plug-ins (an AI Editor step with its switch for new edits and options, on the Mac app's
 * own server), its installed packs, its skills by place, and the way to Community's section for it.
 */
function ToolPage({ tile, steps, recorder }: { tile: HomeTile; steps: Steps; recorder: boolean }) {
  const me = useMe();
  const cloud = useAuth((s) => s.kind === "cloud");
  const packs = useCachedLoad<InstalledPack[]>("/api/packs", listInstalled, { topic: ["packs"], own: true });
  const mine = (packs.data ?? []).filter((p) => reachesTool(containsOf(p), tile));
  const places = skillPlacesOf(tile);
  return (
    <>
      {tile === "record" && recorder && (
        <Section title="Recording">
          <RecorderSettings />
        </Section>
      )}
      {/* the grade is the one slot this editor reads (as its own Defaults button, EditorPage) */}
      {tile === "editor" && <EditorDefaultsSection slots={["grade"]} />}
      {toolSectionsFor(me, webPlugins, tile).map((s) => (
        <Section key={s.id} title={s.title}>
          {s.body}
        </Section>
      ))}
      <ToolPlugins steps={steps} tool={tile} switches={tile === "editor" && hasThisMac() && !cloud} />
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
      {canAddTo(tile, steps.view) && (
        <div>
          <Button asChild size="sm" variant="outline">
            <Link to={`/community/tool/${tile}`}>Browse Community</Link>
          </Button>
        </div>
      )}
    </>
  );
}
