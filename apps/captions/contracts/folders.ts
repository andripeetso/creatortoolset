/**
 * Folders a person makes in a tool that has none of its own (api/folders.ts). One small file per tool and person holds
 * the folders and which item is in which; the items themselves are not touched.
 */
export const FOLDER_TOOLS = ["editor", "captions", "stories", "guides", "notes"] as const;
export type FolderTool = (typeof FOLDER_TOOLS)[number];
export const isFolderTool = (t: unknown): t is FolderTool => FOLDER_TOOLS.includes(t as FolderTool);

export interface ToolFolder {
  id: string;
  name: string;
  /** The folder it is in; null at the top. */
  parentId: string | null;
  createdAt: number;
  /** Its share link's token (anyone with the link sees it and what is inside); only tools in SHAREABLE_TOOLS. */
  share?: string;
}

/** Tools whose items have a page anyone with a link can open, so a whole folder can be shared. */
export const SHAREABLE_TOOLS: readonly FolderTool[] = ["notes"];

/** A shared folder as someone with its link sees it (GET /api/clips/f/:token[?f=<folder inside>]). */
export interface SharedFolder {
  name: string;
  /** From the shared folder down to the one shown; the first is the shared folder. */
  trail: { id: string; name: string }[];
  /** `pictures`: up to four of its clips that have one (their ids), for the folder card. */
  folders: { id: string; name: string; count: number; pictures: string[] }[];
  items: { id: string; name: string; duration: number; createdAt: number; hasThumb: boolean }[];
}

export interface ToolFolders {
  folders: ToolFolder[];
  /** item id → the folder it is in. An item missing here is at the top. */
  items: Record<string, string>;
}
