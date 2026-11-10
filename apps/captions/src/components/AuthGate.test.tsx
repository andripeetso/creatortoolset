import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProviderButtons } from "./AuthGate";

it("shows a Sign in with button only for each provider this server has keys for", () => {
  const html = renderToStaticMarkup(<ProviderButtons providers={{ apple: false, google: true, github: true }} />);
  expect(html).toContain('href="/api/account/login/google?for=site"');
  expect(html).toContain("Sign in with Google");
  expect(html).toContain("Sign in with GitHub");
  expect(html).not.toContain("Apple");
});

it("shows no button when no provider has keys", () => {
  expect(renderToStaticMarkup(<ProviderButtons providers={{ apple: false, google: false, github: false }} />)).toBe("");
});
