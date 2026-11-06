import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { documentText, markupToText, privateAddress, webPageText } from "./source-files";

function zip(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "zip-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  execFileSync("zip", ["-qr", "out.zip", ...Object.keys(files)], { cwd: dir });
  return readFileSync(path.join(dir, "out.zip"));
}

describe("knowledge files and links", () => {
  it("reads Word headings and paragraphs, and an EPUB in spine order", async () => {
    const docx = zip({ "word/document.xml": '<w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Pricing</w:t></w:r></w:p><w:p><w:r><w:t>Anchor &amp; stack.</w:t></w:r></w:p></w:body>' });
    expect(await documentText("book.docx", docx)).toBe("## Pricing\nAnchor & stack.");
    const epub = zip({
      "META-INF/container.xml": '<rootfile full-path="OEBPS/c.opf"/>',
      "OEBPS/c.opf": '<item id="b" href="two.xhtml"/><item id="a" href="one.xhtml"/><itemref idref="a"/><itemref idref="b"/>',
      "OEBPS/one.xhtml": "<html><body><h1>One</h1><p>First.</p></body></html>",
      "OEBPS/two.xhtml": "<html><body><h1>Two</h1><p>Second.</p></body></html>",
    });
    expect(await documentText("b.epub", epub)).toBe("# One\nFirst.\n\n# Two\nSecond.");
    await expect(documentText("x.pages", Buffer.from("x"))).rejects.toThrow(/Drop PDF/);
  });

  it("never fetches inside addresses, follows redirects only to public ones", async () => {
    expect(["127.0.0.1", "10.1.2.3", "172.16.5.4", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fd00::1"].every(privateAddress)).toBe(true);
    expect(privateAddress("203.0.113.7")).toBe(false);
    await expect(webPageText("http://127.0.0.1:3005/api")).rejects.toThrow(/public internet/);
    const hops = [new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })];
    await expect(webPageText("https://93.184.216.34/", (async () => hops.shift()!) as typeof fetch)).rejects.toThrow(/public internet/);
    const page = `<html><title>Offers</title><nav>menu</nav><article><h2>Price</h2><p>${"word ".repeat(60)}</p></article></html>`;
    const got = await webPageText("https://93.184.216.34/a", (async () => new Response(page, { headers: { "content-type": "text/html" } })) as typeof fetch);
    expect(got.title).toBe("Offers");
    expect(got.text).toContain("## Price");
    expect(got.text).not.toContain("menu");
    expect(markupToText("<p>a&nbsp;b &#8212; c</p>")).toBe("a b — c");
  });
});
