import { analyzerTools } from "./analyzer";
import { captionsTools } from "./captions";
import { channelsTools } from "./channels";
import { chatsTools } from "./chats";
import { designTools } from "./designs";
import { editorTools } from "./editor";
import { finalsTools } from "./finals";
import { libraryTools } from "./library";
import { memoryTools } from "./memory";
import { notesTools } from "./notes";
import { reviewTools } from "./review";
import { skillsTools } from "./skills";
import type { ToolModule } from "./types";
import { workshopTools } from "./workshop";

/** The tools kept in their own files, in the order the AI lists them (after api/mcp.ts's own). */
export const MODULES: ToolModule[] = [workshopTools, analyzerTools, channelsTools, libraryTools, editorTools, designTools, reviewTools, finalsTools, captionsTools, notesTools, memoryTools, skillsTools, chatsTools];
