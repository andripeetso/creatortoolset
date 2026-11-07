import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AccountStepView, type AccountState } from "./AccountStep";

const view = (account: AccountState) =>
  renderToStaticMarkup(<AccountStepView account={account} busy={false} onSignIn={() => {}} onDone={() => {}} />);

it("asks for Apple or Google and can't be passed until signed in", () => {
  for (const s of [{ state: "signedOut" }, { state: "cancelled" }, { state: "error", message: "Can't reach the server" }] as AccountState[]) {
    const html = view(s);
    expect(html).toContain("Continue with Apple");
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain(">Continue<");
  }
  expect(view({ state: "error", message: "Can't reach the server" })).toContain("Can&#x27;t reach the server");
  expect(view({ state: "checking" })).not.toContain(">Continue<");
});

it("goes on once signed in, while the server has no sign-in yet, or with no account step", () => {
  const signed = view({ state: "signedIn", name: "Sam Tiny", email: "sam@tinyacrobatics.com" });
  expect(signed).toContain("Signed in as Sam Tiny (sam@tinyacrobatics.com)");
  expect(signed).not.toContain("Continue with Apple");
  expect(signed).toContain(">Continue<");
  const notYet = view({ state: "notSetUp", server: "creatortoolset.com" });
  expect(notYet).toContain("Sign-in isn&#x27;t set up on creatortoolset.com yet");
  expect(notYet).toContain(">Continue<");
  expect(view({ state: "off" })).toContain(">Continue<");
});
