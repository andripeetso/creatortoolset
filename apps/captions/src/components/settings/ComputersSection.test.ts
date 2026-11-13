import { describe, expect, it } from "vitest";
import { linuxCommand, phoneLine } from "./ComputersSection";
import { searchSettings } from "./search";

describe("phoneLine", () => {
  it("a plain-http address is this computer's network address: the phone must be on the same Wi-Fi", () => {
    expect(phoneLine("http://studio.local:5471")).toEqual({ wifi: true, host: "studio.local:5471" });
  });

  it("an https address is a tunnel or the hosted site: the line names the address", () => {
    expect(phoneLine("https://sam.example.com")).toEqual({ wifi: false, host: "sam.example.com" });
  });
});

it("a Linux computer's one command fetches the helper from this server and pairs with the code", () => {
  expect(linuxCommand("https://sam.example.com", "ABCD-EFGH-JKLM")).toBe("curl -fsSL https://sam.example.com/helper/install.sh | sh -s -- https://sam.example.com ABCD-EFGH-JKLM");
});

describe("phone rows are searchable", () => {
  it("finds the phones by the words people type", () => {
    const sections = new Map([["devices", "Devices"]]);
    expect(searchSettings("qr", sections)[0]?.id).toBe("phones");
    expect(searchSettings("iphone", sections).map((h) => h.id)).toContain("add-phone");
  });
});
