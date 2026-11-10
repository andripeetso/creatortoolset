import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StorageFolder, StorageView } from "@contracts/storage";
import { Storage, type Computer } from "./StorageRows";

const mac = { id: "dev_1", name: "Sam's Mac Studio", owner: "sam", online: true } as unknown as Computer;
const library: StorageFolder = {
  id: "lib_1", role: "library", name: "Creator Toolset", origin: { host: "dev_1", path: "/Volumes/Footage SSD/Creator Toolset" },
  make: true, createdAt: 0, reach: {},
};
const view = (folders: StorageFolder[]): StorageView => ({ folders, serverDisks: [] });
const page = (folders: StorageFolder[]) => renderToStaticMarkup(<Storage devices={[mac]} storage={view(folders)} onChanged={() => {}} />);

describe("Storage rows", () => {
  it("with nothing set, one row says what the folders are for and each row only offers its button", () => {
    const html = page([]);
    expect(html).toContain("Where the Media Library and the AI Editor read and save files.");
    expect(html.match(/>Set folder</g)).toHaveLength(3);
    expect(html).not.toContain("Not set");
  });

  it("a set row shows its full path on its computer and says Change", () => {
    const html = page([library]);
    expect(html).not.toContain("Where the Media Library");
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset");
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset/Footage");
    expect(html).toContain(">Change<");
    expect(html).not.toContain("Library/Footage");
  });
});
