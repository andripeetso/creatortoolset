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
}

export interface ToolFolders {
  folders: ToolFolder[];
  /** item id → the folder it is in. An item missing here is at the top. */
  items: Record<string, string>;
}
