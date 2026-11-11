import { analyzerTools } from "./analyzer";
import { captionsTools } from "./captions";
import { editorTools } from "./editor";
import { finalsTools } from "./finals";
import { libraryTools } from "./library";
import { notesTools } from "./notes";
import { reviewTools } from "./review";
import { skillsTools } from "./skills";
import type { ToolModule } from "./types";
import { workshopTools } from "./workshop";

/** The tools kept in their own files, in the order the AI lists them (after api/mcp.ts's own). */
export const MODULES: ToolModule[] = [workshopTools, analyzerTools, libraryTools, editorTools, reviewTools, finalsTools, captionsTools, notesTools, skillsTools];
