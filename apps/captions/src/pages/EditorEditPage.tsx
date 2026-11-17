import { useParams } from "react-router";
import { EditProjectPage } from "./editor/ProjectView";
import { TimelinePage } from "./editor/TimelinePage";

export { stepLine } from "./editor/ProjectView";

/**
 * One edit (/editor/:id): its versions and tabs, the project page with one edit (pages/editor/ProjectView.tsx); one
 * version's timeline (/editor/:id/:draft), the editor itself (pages/editor/TimelinePage.tsx).
 */
export default function EditorEditPage() {
  const { id = "", draft } = useParams();
  return draft ? <TimelinePage key={`${id}/${draft}`} id={id} name={draft} /> : <EditProjectPage key={id} id={id} />;
}
