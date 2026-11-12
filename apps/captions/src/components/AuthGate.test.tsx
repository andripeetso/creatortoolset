import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProviderButtons, connectingApp } from "./AuthGate";

it("shows a Sign in with button only for each provider this server has keys for", () => {
  const html = renderToStaticMarkup(<ProviderButtons providers={{ apple: false, google: true, github: true }} />);
  // it carries the page it stands in for, to come back to after the provider
  expect(html).toMatch(/href="\/api\/account\/login\/google\?for=site&amp;next=%2F[^"]*"/);
  expect(html).toContain("Sign in with Google");
  expect(html).toContain("Sign in with GitHub");
  expect(html).not.toContain("Apple");
});

it("shows no button when no provider has keys", () => {
  expect(renderToStaticMarkup(<ProviderButtons providers={{ apple: false, google: false, github: false }} />)).toBe("");
});

it("names the AI app a sign-in is for, from the Allow page it goes back to", () => {
  const id = btoa(JSON.stringify({ n: "ChatGPT", r: ["https://chatgpt.com/cb"], m: "none" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") + ".sig";
  const search = `?${new URLSearchParams({ next: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: id })}` })}`;
  expect(connectingApp(search)).toBe("ChatGPT");
  expect(connectingApp("?next=/oauth/authorize?client_id=garbage")).toBe("your AI app");
  expect(connectingApp("?next=/workshop")).toBeNull();
  expect(connectingApp("")).toBeNull();
});
