import { describe, expect, it } from "vitest";
import { linuxCommand } from "./ComputersSection";
import { searchSettings } from "./search";

it("a Linux computer's one command fetches the helper from this server and pairs with the code", () => {
  expect(linuxCommand("https://sam.example.com", "ABCD-EFGH-JKLM")).toBe("curl -fsSL https://sam.example.com/helper/install.sh | sh -s -- https://sam.example.com ABCD-EFGH-JKLM");
});

describe("phone rows are searchable", () => {
  it("finds the phones by the words people type", () => {
    const sections = new Map([["devices", "Computers"]]);
    expect(searchSettings("qr", sections)[0]?.id).toBe("phones");
    expect(searchSettings("iphone", sections).map((h) => h.id)).toContain("create-link");
  });
});

describe("This Mac's own rows", () => {
  it("are found only with the server on this Mac in the Mac app's window: on another server there is no such card", () => {
    const sections = new Map([["devices", "Computers"]]);
    const found = (thisMac: boolean) => searchSettings("network access", sections, undefined, true, true, false, false, thisMac).map((h) => h.id);
    expect(found(true)).toContain("network-access");
    expect(found(false)).not.toContain("network-access");
    // the row's title is the card's, word for word
    expect(searchSettings("this mac", sections, undefined, true, true, false, false, true).find((h) => h.id === "connections")?.title).toBe("This Mac");
  });
});
