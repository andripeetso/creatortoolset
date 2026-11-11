import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AccountSetupView, AccountStepView, offersAccount, parseProviders, type AccountState, type Provider } from "./AccountStep";

const all: Provider[] = ["apple", "google", "github"];
const view = (account: AccountState, providers: Provider[] = all) =>
  renderToStaticMarkup(<AccountStepView account={account} busy={false} providers={providers} onSignIn={() => {}} onDone={() => {}} />);

it("asks for Apple, Google or GitHub and can't be passed until signed in", () => {
  for (const s of [{ state: "signedOut" }, { state: "cancelled" }, { state: "error", message: "Can't reach the server" }] as AccountState[]) {
    const html = view(s);
    expect(html).toContain("Continue with Apple");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain(">Continue<");
  }
  expect(view({ state: "error", message: "Can't reach the server" })).toContain("Can&#x27;t reach the server");
  expect(view({ state: "checking" })).not.toContain(">Continue<");
});

it("shows a button only for the providers the account server has keys for", () => {
  const html = view({ state: "signedOut" }, ["github"]);
  expect(html).toContain("Continue with GitHub");
  expect(html).not.toContain("Continue with Apple");
  expect(html).not.toContain("Continue with Google");
  expect(parseProviders("google,github,microsoft")).toEqual(["google", "github"]);
  expect(parseProviders("")).toEqual([]);
  expect(parseProviders("google,apple,google")).toEqual(["google", "apple"]); // the order the Mac app names them in
});

it("shows no sign-in button when the reply names no providers (an older Mac app)", () => {
  const html = view({ state: "signedOut" }, []);
  expect(html).not.toContain("Continue with");
  expect(html).toContain("Sign in to set up your account");
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
  // offline on the first run: never stuck on a step that can't be passed
  const offline = view({ state: "unreachable", server: "creatortoolset.com" });
  expect(offline).toContain("Can&#x27;t reach creatortoolset.com");
  expect(offline).toContain(">Continue<");
});


const setup = (account: AccountState, providers: Provider[] = ["google", "apple"], busy: Provider | "signout" | null = null) =>
  renderToStaticMarkup(<AccountSetupView account={account} providers={providers} busy={busy} onSignIn={() => {}} />).replaceAll("&#x27;", "'");
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, ""));

it("setup has an account screen only when the Mac app names a sign-in and nobody is signed in", () => {
  const offers = (account: AccountState, providers: Provider[]) => offersAccount({ account, providers });
  expect(offers({ state: "signedOut" }, ["google"])).toBe(true);
  expect(offers({ state: "cancelled" }, ["google"])).toBe(true); // the sheet was closed: the screen stays
  expect(offers({ state: "signedOut" }, [])).toBe(false); // nothing works yet: no screen, so it can never dead-end
  expect(offers({ state: "notSetUp" }, [])).toBe(false);
  expect(offers({ state: "signedIn", name: "Ana" }, ["google"])).toBe(false);
  expect(offers({ state: "off" }, ["google"])).toBe(false); // no Mac app, or one from before this screen
  expect(offers({ state: "checking" }, ["google"])).toBe(false);
});

it("the account screen is a sign-in screen: one button for each sign-in offered, with its mark, and no promise of anything", () => {
  const html = setup({ state: "signedOut" });
  expect(buttons(html)).toEqual(["Continue with Google", "Continue with Apple"]); // the order the Mac app named them in
  expect(html.match(/<svg/g)).toHaveLength(2); // each carries its provider's mark
  expect(html).toContain("#4285F4"); // Google's, in its own colours
  expect(html).not.toMatch(/GitHub|phone|settings|sync/i);
  // a sign-in card: its own title and one line, and only what a sign-in does today
  expect(html).toContain("Sign in to Creator Toolset");
  expect(html).toContain("Optional. Sign in and the app shows your name.");
  expect(html).toContain("Nothing else is read from that account.");
  // while the system's sheet is up: that button says so, and no second sign-in can be started
  const busy = setup({ state: "signedOut" }, ["google", "apple"], "google");
  expect(buttons(busy)).toEqual(["Signing in…", "Continue with Apple"]);
  expect(busy.match(/disabled=""/g)).toHaveLength(2);
});

it("the account screen after a press: signed in says who; a closed sheet says nothing; a failure says so and the buttons stay", () => {
  const done = setup({ state: "signedIn", name: "Ana", email: "ana@tinyacrobatics.example" });
  expect(done).toContain("Signed in as Ana");
  expect(done).toContain("ana@tinyacrobatics.example");
  expect(buttons(done)).toEqual([]);
  const closed = setup({ state: "cancelled" });
  expect(buttons(closed)).toEqual(["Continue with Google", "Continue with Apple"]);
  expect(closed).not.toContain("text-red-600");
  for (const [state, words] of [
    [{ state: "error", message: "That sign-in didn't go through." }, "That sign-in didn't go through."],
    [{ state: "notSetUp" }, "Sign-in is not available right now."],
    [{ state: "unreachable" }, "Couldn't reach the account server."],
  ] as [AccountState, string][]) {
    const html = setup(state);
    expect(html).toContain(words);
    expect(buttons(html)).toEqual(["Continue with Google", "Continue with Apple"]);
  }
  // opened with nothing to offer (an old link): one plain line, no button
  expect(setup({ state: "signedOut" }, [])).toContain("Sign-in is not available right now.");
});
