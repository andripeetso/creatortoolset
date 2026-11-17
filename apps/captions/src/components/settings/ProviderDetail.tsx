import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, Plus, X } from "lucide-react";
import { DRIVERS, driverFields, ENV_NAME_RE, EFFORTS, type Effort, type ProviderCheck, type ProviderInstance } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { effortLabel, modelChoices, modelName } from "@/lib/providers";
import { fmtAgo } from "./helpers";
import { cn } from "@/lib/utils";
import { DriverMark, PROVIDER_ROW, type ProviderStatus } from "./ProviderInstanceCard";
import { InstallHelp, SignInHelp } from "./AiSetup";
import { Advanced, RowMenu, Row, SettingsSelect, Status, TextField, saveFailed, type RowMenuItem } from "./ui";

/**
 * One AI provider's settings: the right half of the Providers panel from `lg`, its own page below it. Rows with a line
 * between them, no cards of their own: Status, Name, Model, Thinking, and Advanced with only the fields the Mac reads
 * for this tool (driverFields). Remove is in the header's menu and asks first; a provider that a job uses can't be
 * removed until that job has another.
 */
export function ProviderDetail({
  inst,
  status,
  check,
  checking,
  canTest,
  used,
  models,
  selection,
  computers,
  computerNote,
  backTo,
  onChange,
  onTest,
  onSignIn,
  install,
  onMove,
  onRemove,
  onDeleteProgram,
}: {
  inst: ProviderInstance;
  status: ProviderStatus;
  check?: ProviderCheck;
  checking: boolean;
  /** a test can run now: the computer is online and no test is running */
  canTest: boolean;
  /** what uses this provider ("Default", job names) */
  used: string[];
  /** the models this AI offers; empty = the tool's own default */
  models: string[];
  /** the model and thinking level it really runs with (effectiveSelection): the same values the Default row shows */
  selection: { model: string; effort: Effort };
  /** the computers this AI can move to (only when it runs on none, or on one that was removed) */
  computers?: Array<{ id: string; name: string }>;
  /** the state of its computer, when that needs saying: "Computer not found" */
  computerNote?: string;
  /** below `lg` this page is a sub-page: its back arrow goes here */
  backTo?: string;
  onChange: (patch: Partial<ProviderInstance>) => void;
  onTest: () => void;
  /** set only where the Mac app shows this page and the AI is on this Mac: opens the CLI's sign-in in Terminal */
  onSignIn?: () => void;
  /** the Install button, where the app can install this AI (this Mac); absent: the lines that say how */
  install?: ReactNode;
  onMove?: (deviceId: string) => void;
  onRemove: () => void;
  /** a program the app downloaded for this AI (Antigravity) on this computer: deletes it, the sign-in stays */
  onDeleteProgram?: () => void;
}) {
  const driver = DRIVERS.find((d) => d.id === inst.driver);
  const fields = driverFields(inst.driver);
  const testTitle = "Sends one short test question.";
  // what is true when it works: the last test, its model and how long it took
  const answered = check?.ok && !check.note
    ? `Tested ${fmtAgo(check.at)}${check.model ? ` · ${modelName(check.model)}` : ""}${check.ms > 0 ? ` · ${(check.ms / 1000).toFixed(1)} s` : ""}`
    : undefined;
  const menu: RowMenuItem[] = [
    {
      label: "Test",
      tooltip: testTitle,
      onSelect: () => {
        if (!canTest) throw new Error(checking ? "A test is running." : "Computer offline");
        onTest();
      },
    },
    ...(onDeleteProgram
      ? [{ label: "Delete program", destructive: true, onSelect: onDeleteProgram, confirm: { title: "Delete the Antigravity program?", body: "The downloaded program is deleted from this computer; the sign-in stays.", ok: "Delete" } }]
      : []),
    used.length
      ? { label: "Remove", destructive: true, onSelect: () => { throw new Error(`${inst.name} is in use by ${used.join(", ")}.`); } }
      : { label: "Remove", destructive: true, onSelect: onRemove, confirm: { title: `Remove ${inst.name}?`, body: "Its settings are removed.", ok: "Remove" } },
  ];
  // one line, always there, so nothing under it moves: what needs the person in its colour, else what is true. Laid out
  // as a flex row: set in a line of text, the status with its dot is a pixel taller than words alone, and a test
  // starting or ending moved every row under it by that pixel
  const statusLine = (
    <span className="flex min-w-0">
      {checking ? (
        "Testing…"
      ) : status.text && status.tone !== "neutral" ? (
        <Status tone={status.tone}>{status.text}</Status>
      ) : (
        [status.text, answered ?? (status.text ? "" : "Not tested")].filter(Boolean).join(" · ")
      )}
    </span>
  );
  return (
    <div className="min-w-0 [&>*+*]:border-t [&>*+*]:border-border/50">
      {/* as tall as a row of the list beside it, so the first line runs straight across the panel */}
      <div className={cn(PROVIDER_ROW, "flex items-center gap-2.5 px-3 sm:px-4")}>
        {backTo && (
          <Button asChild variant="ghost" size="icon-xs" className="lg:hidden" aria-label="Back to Providers">
            <Link to={backTo}>
              <ArrowLeft />
            </Link>
          </Button>
        )}
        <DriverMark driver={inst.driver} className="size-5" />
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{inst.name}</h3>
        <RowMenu label={`${inst.name} actions`} items={menu} />
      </div>

      <Row
        title="Status"
        description={statusLine}
        control={
          status.action === "test" ? (
            // only a failed test offers another here; a working provider shows no button ("Test" is in the menu)
            <Button size="sm" variant="outline" className="min-w-28 justify-center" disabled={!canTest || checking} title={testTitle} onClick={onTest}>
              {checking ? "Testing…" : "Test"}
            </Button>
          ) : status.action === "sign-in" && onSignIn ? (
            <Button size="sm" variant="outline" onClick={onSignIn}>
              Sign in
            </Button>
          ) : status.action === "install" ? (
            install
          ) : undefined
        }
      >
        {status.action === "install" && !install && <InstallHelp driver={inst.driver} />}
        {status.action === "sign-in" && !onSignIn && <SignInHelp driver={inst.driver} computer="its computer" />}
        {check && !check.ok && check.error && <p className="break-words text-xs text-muted-foreground">{check.error}</p>}
      </Row>

      {computers && onMove && (
        <Row
          title="Computer"
          description={computerNote ? <Status tone="attention">{computerNote}</Status> : undefined}
          control={
            <SettingsSelect
              label="Computer"
              value="choose"
              onValueChange={(id) => id !== "choose" && onMove(id)}
              options={[{ value: "choose", label: "Choose" }, ...computers.map((c) => ({ value: c.id, label: c.name }))]}
            />
          }
        />
      )}

      <Row
        title="Name"
        control={<TextField label="Name" value={inst.name} placeholder={driver?.label} onCommit={(v) => onChange({ name: v.trim() || inst.name })} />}
      />
      <Row
        title="Model"
        description="Used unless a job sets its own."
        control={
          selection.model ? (
            <SettingsSelect
              label="Model"
              value={selection.model}
              onValueChange={(m) => onChange({ model: m })}
              options={modelChoices(models, selection.model).map((m) => ({ value: m, label: modelName(m) }))}
            />
          ) : (
            <span className="text-sm text-muted-foreground">Tool default</span>
          )
        }
      />
      <Row
        title="Thinking"
        control={
          <SettingsSelect
            label="Thinking level"
            value={selection.effort}
            onValueChange={(e) => onChange({ effort: e as ProviderInstance["effort"] })}
            options={EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))}
          />
        }
      />

      {/* folded only with three rows or more: one or two are drawn open, as rows of the panel */}
      {(fields.home || fields.program || fields.args || fields.env) && (
        <Rare fold={[fields.home, fields.program, fields.args, fields.env].filter(Boolean).length >= 3}>
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
              description="Full path to the program, if not the installed one."
              control={
                <TextField label="Program" value={inst.binaryPath ?? ""} placeholder="/usr/local/bin/…" onCommit={(v) => onChange({ binaryPath: v.trim() || undefined })} />
              }
            />
          )}
          {fields.args && (
            <ListField title="Arguments" description="Passed to the program, in this order." add="Add argument" label="Argument" value={inst.launchArgs ?? []} onCommit={(list) => onChange({ launchArgs: list.length ? list : undefined })} />
          )}
          {fields.env && (
            <ListField
              title="Variables"
              description="Names only: the values come from the computer that runs it."
              add="Add variable"
              label="Variable name"
              placeholder="API_KEY"
              valid={ENV_NAME_RE}
              invalid="A variable name is letters, digits and _, not starting with a digit."
              value={inst.envNames ?? []}
              onCommit={(list) => onChange({ envNames: list.length ? list : undefined })}
            />
          )}
        </Rare>
      )}
    </div>
  );
}

const Rare = ({ fold, children }: { fold: boolean; children: ReactNode }) => (fold ? <Advanced summary="Advanced">{children}</Advanced> : <>{children}</>);

/** A list of short values (arguments, variable names): one field each with its remove button, and Add for one more. Saved as each field is left. */
function ListField({ title, description, add, label, placeholder, valid, invalid, value, onCommit }: {
  title: string;
  description: string;
  add: string;
  label: string;
  placeholder?: string;
  /** what an item must match; a field that does not keeps its text, marked, and nothing is saved */
  valid?: RegExp;
  invalid?: string;
  value: string[];
  onCommit: (list: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const wrong = (v: string) => !!valid && !!v.trim() && !valid.test(v.trim());
  const save = (list: string[]) => onCommit(list.map((x) => x.trim()).filter(Boolean));
  return (
    <Row
      title={title}
      description={description}
      control={
        // the server keeps 32 at most
        <Button size="sm" variant="outline" disabled={value.length >= 32} onClick={() => setAdding(true)}>
          <Plus /> {add}
        </Button>
      }
    >
      {(value.length > 0 || adding) && (
        <div className="space-y-1.5">
          {value.map((v, i) => (
            // keyed by place: a save never remounts a row, so a remove clicked right after an edit still lands
            <div key={i} className="flex items-center gap-1.5">
              <TextField
                label={label}
                value={v}
                className="font-mono text-xs"
                onCommit={(next) => {
                  if (wrong(next)) throw new Error(invalid);
                  save(value.map((x, j) => (j === i ? next : x)));
                }}
              />
              {/* the field keeps focus, so its blur doesn't save and re-render the list under the click */}
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${v}`} onMouseDown={(e) => e.preventDefault()} onClick={() => save(value.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </div>
          ))}
          {adding && (
            <input
              autoFocus
              aria-label={label}
              placeholder={placeholder}
              spellCheck={false}
              className="h-8 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive sm:w-64"
              onBlur={(e) => {
                // a wrong name stays in the box, marked, until it is fixed or Escape drops it
                if (wrong(e.target.value)) {
                  e.target.setAttribute("aria-invalid", "true");
                  return saveFailed(invalid ?? "That can't be saved.");
                }
                if (e.target.value.trim()) save([...value, e.target.value]);
                setAdding(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = ""; // a blur as the box goes away then saves nothing
                  setAdding(false);
                }
              }}
            />
          )}
        </div>
      )}
    </Row>
  );
}
