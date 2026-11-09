import { describe, expect, it } from "vitest";
import { siteFrameFor, type WebPlugin } from "./plugin";

// A plug-in's product site on its own host: shown for the pages it claims, and for no other host or page.
const site: WebPlugin = {
  id: "site-test",
  site: { hosts: ["site.example.test"], claims: (pathname) => pathname === "/", element: "SITE" as never },
};

describe("siteFrameFor", () => {
  it("returns the site for a claimed page on its host", () => {
    expect(siteFrameFor("site.example.test", "/", "", [site])).toEqual({ element: "SITE" });
  });

  it("leaves other pages and other hosts to the app", () => {
    expect(siteFrameFor("site.example.test", "/library", "", [site])).toBeNull();
    expect(siteFrameFor("studio.example.test", "/", "", [site])).toBeNull();
    expect(siteFrameFor("site.example.test", "/", "", [{ id: "none-test" }])).toBeNull();
  });
});
