import { describe, expect, it } from "vitest";
import { signsIn, type Me } from "./auth";

const me = (more: Partial<Me> = {}): Me => ({ username: "admin", role: "admin", cloud: true, off: [], ...more });

// Who is shown a sign-in name, a password, its code and Sign out (Settings → Account, the account menus, the search).
describe("signsIn", () => {
  it("is someone the server asks to sign in, with a sign-in of their own", () => {
    expect(signsIn(true, me())).toBe(true);
  });

  it("is nobody on a server with no sign-in, and not the owner of a server on their Mac whose password the app made", () => {
    expect(signsIn(false, me())).toBe(false);
    // signing out there would leave a sign-in page asking for a password nobody was shown
    expect(signsIn(true, me({ noPassword: true }))).toBe(false);
  });
});
