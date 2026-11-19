import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { sendFile, servedType } from "./send-file";

const dir = mkdtempSync(path.join(tmpdir(), "send-file-"));

it("sends footage, sound and raster pictures as themselves, anything else as a download", () => {
  expect(servedType("video/webm;codecs=vp9,opus")).toBe("video/webm");
  expect(servedType("video/quicktime")).toBe("video/quicktime");
  expect(servedType("audio/mpeg")).toBe("audio/mpeg");
  expect(servedType("image/jpeg")).toBe("image/jpeg");
  for (const bad of ["text/html", "image/svg+xml", "application/xhtml+xml", "video/mp4x<script>", "", "text/html; video/mp4"]) {
    expect(servedType(bad)).toBe("application/octet-stream");
  }
});

it("a stored file is never sniffed or run as a page, and an empty one is an empty answer", async () => {
  const page = path.join(dir, "page");
  writeFileSync(page, "<script>alert(1)</script>");
  const empty = path.join(dir, "empty");
  writeFileSync(empty, "");
  const app = new Hono();
  app.get("/page", (c) => sendFile(c, page, "text/html"));
  app.get("/empty", (c) => sendFile(c, empty, "video/mp4"));
  const res = await app.request("/page");
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe("sandbox");
  const none = await app.request("/empty");
  expect(none.status).toBe(200);
  expect(await none.text()).toBe("");
});
