import { TOOL_NEEDS, type Have, type Tool } from "@contracts/tools";
import { ToolNeeds } from "./ToolNeeds";

/**
 * The Setup checklist (`?setup=check`): every tool turned on that needs something, in Home's order (a row set up never moves), each with its
 * rows ticked or open and their forms in place (a key's row says what it is for and where to get one).
 */
export function SetupChecklist({ tools, have }: { tools: readonly Tool[]; have: readonly Have[] }) {
  const shown = tools.filter((t) => TOOL_NEEDS[t].length > 0);
  if (!shown.length) return <p className="text-sm text-muted-foreground">No tools that need setting up</p>;
  return (
    <div>
      {shown.map((t) => (
        <ToolNeeds key={t} tool={t} have={have} />
      ))}
    </div>
  );
}
