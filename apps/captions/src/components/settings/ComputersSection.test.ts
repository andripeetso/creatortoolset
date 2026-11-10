import { describe, expect, it } from "vitest";
import { phoneLine } from "./ComputersSection";
import { searchSettings } from "./search";

describe("phoneLine", () => {
  it("a plain-http address is this computer's network address: the phone must be on the same Wi-Fi", () => {
    expect(phoneLine("http://studio.local:5471")).toEqual({ wifi: true, host: "studio.local:5471" });
  });

  it("an https address is a tunnel or the hosted site: the line names the address", () => {
    expect(phoneLine("https://sam.example.com")).toEqual({ wifi: false, host: "sam.example.com" });
  });
});

describe("phone rows are searchable", () => {
  it("finds the phones by the words people type", () => {
    const sections = new Map([["devices", "Devices"]]);
    expect(searchSettings("qr", sections)[0]?.id).toBe("phones");
    expect(searchSettings("iphone", sections).map((h) => h.id)).toContain("add-phone");
  });
});
