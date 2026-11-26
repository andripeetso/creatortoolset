import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProviderButtons, appLink, connectingApp, signsInHere } from "./AuthGate";

it("shows a Continue with button only for each provider this server has keys for, Google first", () => {
  const html = renderToStaticMarkup(<ProviderButtons providers={{ apple: true, google: true, github: true }} />);
  expect([...html.matchAll(/Continue with (\w+)/g)].map((m) => m[1])).toEqual(["Google", "Apple", "GitHub"]);
  expect(renderToStaticMarkup(<ProviderButtons providers={{ apple: false, google: true, github: true }} />)).not.toContain("Apple");
  // it carries the page it stands in for, to come back to after the provider
  expect(html).toMatch(/href="\/api\/account\/login\/google\?for=site&amp;next=%2F[^"]*"/);
});

it("shows no button when no provider has keys", () => {
  expect(renderToStaticMarkup(<ProviderButtons providers={{ apple: false, google: false, github: false }} />)).toBe("");
});

it("names the AI app a sign-in is for, from the Allow page it goes back to", () => {
  const id = btoa(JSON.stringify({ n: "ChatGPT", r: ["https://chatgpt.com/cb"], m: "none" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") + ".sig";
  const search = `?${new URLSearchParams({ next: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: id })}` })}`;
  expect(connectingApp(search)).toBe("ChatGPT");
  expect(connectingApp("?next=/oauth/authorize?client_id=garbage")).toBe("an AI app");
  expect(connectingApp("?next=/workshop")).toBeNull();
  expect(connectingApp("")).toBeNull();
});

it("shows the sign-in form in the Mac app and for an AI app's sign-in, never in a plain browser", () => {
  expect(signsInHere(true, "")).toBe(true);
  expect(signsInHere(false, "?next=/oauth/authorize?client_id=garbage")).toBe(true);
  expect(signsInHere(false, "")).toBe(false);
  expect(signsInHere(false, "?next=/workshop")).toBe(false);
});

it("links a page to the Mac app's window", () => {
  expect(appLink("/review/abc", "?v=2")).toBe("creatortoolset://review/abc?v=2");
  expect(appLink("/", "")).toBe("creatortoolset://");
});
