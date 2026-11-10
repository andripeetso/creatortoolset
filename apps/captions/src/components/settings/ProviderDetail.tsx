import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { DRIVERS, driverFields, EFFORTS, type ProviderCheck, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { effortLabel, modelName } from "@/lib/providers";
import { fmtAgo } from "./helpers";
import { DriverMark, type ProviderStatus } from "./ProviderInstanceCard";
import { InstallHelp } from "./AiSetup";
import { Advanced, Card, RowMenu, Row, Section, SettingsSelect, Status, TextField, type RowMenuItem } from "./ui";

/**
 * One AI's settings, beside the list from `lg` and as its own page below it. Sections: Status (with Test), Name, Model
 * (its model and thinking level), and Advanced: only the fields the Mac reads for this tool (driverFields). Remove is in
 * the header's menu and asks first; a tool that a job uses can't be removed until that job picks another.
 */
export function ProviderDetail({
  inst,
  status,
  check,
  checking,
  canTest,
  used,
  models,
  computers,
  computerNote,
  backTo,
  onChange,
  onTest,
  onSignIn,
  onMove,
  onRemove,
}: {
  inst: ProviderInstance;
  status: ProviderStatus;
  check?: ProviderCheck;
  checking: boolean;
  /** a test can run now: the computer is online and no test is running */
  canTest: boolean;
  /** what uses this AI ("the default", job names) */
  used: string[];
  /** the models this AI offers; empty = the tool's own default */
  models: string[];
  /** the computers this AI can move to (only when it runs on none, or on one that was removed) */
  computers?: Array<{ id: string; name: string }>;
  /** the sentence about its computer: "Its computer was removed: pick another." */
  computerNote?: string;
  /** below `lg` this page is a sub-page: its back arrow goes here */
  backTo?: string;
  onChange: (patch: Partial<ProviderInstance>) => void;
  onTest: () => void;
  /** set only where the Mac app shows this page and the AI is on this Mac: opens the CLI's sign-in in Terminal */
  onSignIn?: () => void;
  onMove?: (deviceId: string) => void;
  onRemove: () => void;
}) {
  const driver = DRIVERS.find((d) => d.id === inst.driver);
  const fields = driverFields(inst.driver);
  const testTitle = "Sends one short prompt to check that it answers";
  // what is true when it works: the last answer, its model and how long it took
  const answered = check?.ok
    ? `Answered ${fmtAgo(check.at)}${check.model ? ` · ${modelName(check.model)}` : ""}${check.ms > 0 ? ` · ${(check.ms / 1000).toFixed(1)} s` : ""}`
    : undefined;
  const menu: RowMenuItem[] = [
    {
      label: "Test now",
      tooltip: testTitle,
      onSelect: () => {
        if (!canTest) throw new Error(checking ? "It is being tested now." : "The computer is offline, so it can't be tested now.");
        onTest();
      },
    },
    used.length
      ? { label: "Remove", destructive: true, onSelect: () => { throw new Error(`${inst.name} is used by ${used.join(", ")}. Pick another there first.`); } }
      : { label: "Remove", destructive: true, onSelect: onRemove, confirm: { title: `Remove ${inst.name}?`, body: "Its settings are removed from this account.", ok: "Remove" } },
  ];
  return (
    <div className="min-w-0 space-y-8">
      <div className="flex items-center gap-2">
        {backTo && (
          <Button asChild variant="ghost" size="icon-xs" className="lg:hidden" aria-label="Back to the AI list">
            <Link to={backTo}>
              <ArrowLeft />
            </Link>
          </Button>
        )}
        <DriverMark driver={inst.driver} className="size-5" />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{inst.name}</h2>
        <RowMenu label={`More for ${inst.name}`} items={menu} />
      </div>

      <Section title="Status">
        <Card>
          <Row
            title={
              status.text ? (
                <Status tone={status.tone === "neutral" ? undefined : status.tone}>{status.text}</Status>
              ) : (
                <span className="text-muted-foreground">{checking ? "Checking…" : answered ?? "Not tested yet"}</span>
              )
            }
            status={status.text && answered ? answered : undefined}
            control={
              status.action === "sign-in" && onSignIn ? (
                <Button size="sm" variant="outline" onClick={onSignIn}>
                  Sign in
                </Button>
              ) : undefined
            }
          >
            {status.action === "install" && <InstallHelp driver={inst.driver} />}
            {check && !check.ok && check.error && <p className="break-words text-xs text-muted-foreground">{check.error}</p>}
          </Row>
        </Card>
      </Section>

      {computers && onMove && (
        <Section title="Computer">
          <Card>
            <Row
              title="Computer"
              status={computerNote ? <Status tone="attention">{computerNote}</Status> : undefined}
              control={
                <SettingsSelect
                  label="Computer"
                  value="choose"
                  onValueChange={(id) => id !== "choose" && onMove(id)}
                  options={[{ value: "choose", label: "Choose" }, ...computers.map((c) => ({ value: c.id, label: c.name }))]}
                />
              }
            />
          </Card>
        </Section>
      )}

      <Section title="Name">
        <Card>
          <Row
            title="Name"
            control={<TextField label="Name" value={inst.name} placeholder={driver?.label} onCommit={(v) => onChange({ name: v.trim() || inst.name })} />}
          />
        </Card>
      </Section>

      <Section title="Model">
        <Card>
          <Row
            title="Model"
            description="Used for the Default, or a job that picks this AI."
            control={
              models.length ? (
                <SettingsSelect
                  label="Model"
                  value={models.includes(inst.model ?? "") ? (inst.model as string) : models[0]!}
                  onValueChange={(m) => onChange({ model: m })}
                  options={models.map((m) => ({ value: m, label: modelName(m) }))}
                />
              ) : (
                <span className="text-sm text-muted-foreground">Uses the tool's own default</span>
              )
            }
          />
          <Row
            title="Thinking"
            control={
              <SettingsSelect
                label="Thinking level"
                value={inst.effort ?? "xhigh"}
                onValueChange={(e) => onChange({ effort: e as ProviderInstance["effort"] })}
                options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
              />
            }
          />
        </Card>
      </Section>

      {(fields.home || fields.program || fields.args || fields.env) && (
        <Card>
          <Advanced summary="Advanced">
            {fields.home && (
              <Row
                title="Account folder"
                description="Empty uses the tool's default folder."
                control={
                  <TextField label="Account folder" value={inst.home ?? ""} placeholder="Default folder" onCommit={(v) => onChange({ home: v.trim() || undefined })} />
                }
              />
            )}
            {fields.program && (
              <Row
                title="Program"
                description="Full path to the program on this computer. Empty uses the one on its PATH."
                control={
                  <TextField label="Program" value={inst.binaryPath ?? ""} placeholder="/usr/local/bin/…" onCommit={(v) => onChange({ binaryPath: v.trim() || undefined })} />
                }
              />
            )}
            {fields.args && (
              <Row title="Arguments" description="One per line, in order.">
                <LinesField label="Arguments" value={inst.launchArgs ?? []} onCommit={(list) => onChange({ launchArgs: list.length ? list : undefined })} />
              </Row>
            )}
            {fields.env && (
              <Row title="Variable names" description="Names only: their values stay on this computer.">
                <LinesField label="Variable names" value={inst.envNames ?? []} onCommit={(list) => onChange({ envNames: list.length ? list : undefined })} />
              </Row>
            )}
          </Advanced>
        </Card>
      )}
    </div>
  );
}

/** A list of short lines (arguments, variable names): saved when the box loses focus, blank lines dropped. */
function LinesField({ label, value, onCommit }: { label: string; value: string[]; onCommit: (list: string[]) => void }) {
  const text = value.join("\n");
  const [draft, setDraft] = useState(text);
  const [edited, setEdited] = useState(false);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <Textarea
      aria-label={label}
      rows={2}
      value={edited ? draft : text}
      spellCheck={false}
      className="w-full font-mono text-xs sm:w-72"
      onChange={(e) => {
        setEdited(true);
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (edited && lines(draft).join("\n") !== text) onCommit(lines(draft));
        setEdited(false);
      }}
    />
  );
}
