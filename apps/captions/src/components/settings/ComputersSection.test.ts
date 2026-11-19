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
