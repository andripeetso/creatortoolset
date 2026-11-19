import { expect, it } from "vitest";
import { appLink, pairingToken, withoutToken } from "./pairing";

const CODE = "ABCD2345EFGH"; // gitleaks:allow (a made-up pairing code)

it("reads a pairing code from the fragment or the query, and leaves the address with none", () => {
  const u = new URL(`https://tiny.example/#token=${CODE}`);
  expect(pairingToken(u)).toBe(CODE);
  expect(withoutToken(u).toString()).toBe("https://tiny.example/");
  expect(pairingToken(new URL("http://192.0.2.10:3773/?token=abcd2345efgh&x=1"))).toBe("abcd2345efgh");
  expect(withoutToken(new URL("http://192.0.2.10:3773/?token=abcd2345efgh&x=1")).toString()).toBe("http://192.0.2.10:3773/?x=1");
  expect(pairingToken(new URL("https://tiny.example/#token="))).toBeNull();
  expect(pairingToken(new URL(`https://tiny.example/settings#token=${CODE}`))).toBeNull();
  expect(pairingToken(new URL("https://tiny.example/review/abc"))).toBeNull();
});

it("hands the whole pairing link to the phone app", () => {
  const link = new URL(appLink("http://192.0.2.10:3773", CODE));
  expect(link.protocol).toBe("creatortoolset:");
  expect(link.host).toBe("pair");
  expect(link.searchParams.get("pairingUrl")).toBe(`http://192.0.2.10:3773/#token=${CODE}`);
});
