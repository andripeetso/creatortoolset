import { expect, it } from "vitest";
import { signInItems } from "./ConnectorsSection";

it("offers only the sign-ins this server has an app for", () => {
  expect(signInItems({ meta: false, google: true, tiktok: false })).toEqual([{ id: "google", label: "Sign in with YouTube" }]);
  expect(signInItems({ meta: false, google: false, tiktok: false })).toEqual([]);
});
