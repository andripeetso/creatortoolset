import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Knowledge in other shapes, turned into the text a source keeps: Word,
 * OpenDocument and EPUB files (zips: the server's unzip reads them), web pages by link. PDFs and videos are read in
 * the browser; scans are read by the user's own AI (sources OCR).
 */

const run = promisify(execFile);
const UNZIP_MAX = 64 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );

/** HTML or XML to plain text: block ends become line breaks, headings get "# ", the rest of the markup goes. */
export function markupToText(markup: string): string {
  const body = markup
    .replace(/<(script|style|head|nav|footer|noscript|svg)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<(br|w:br|text:line-break)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|w:p|text:p|text:h)>/gi, "\n")
    .replace(/<(li)\b[^>]*>/gi, "- ")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "");
  return decode(body)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function unzipText(file: string, entry: string): Promise<string> {
  const { stdout } = await run("unzip", ["-p", file, entry], { maxBuffer: UNZIP_MAX, encoding: "utf-8" });
  return stdout;
}

/** Word paragraphs one per line; "Heading"/"Title" styles become "# " lines, so a book's chapters can be found. */
function docxText(xml: string): string {
  return xml
    .split("</w:p>")
    .map((p) => {
      const h = /<w:pStyle w:val="(?:Heading|Title)(\d?)"/.exec(p);
      const t = markupToText(p);
      return t && h ? `${"#".repeat(Number(h[1] || 1))} ${t}` : t;
    })
    .filter(Boolean)
    .join("\n");
}

/** An EPUB's chapters in reading order (the OPF spine). */
async function epubText(file: string): Promise<string> {
  const container = await unzipText(file, "META-INF/container.xml");
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) throw new Error("This EPUB has no table of contents file");
  const opf = await unzipText(file, opfPath);
  const base = path.posix.dirname(opfPath);
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  const chapters: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]!);
    if (!href) continue;
    const text = markupToText(await unzipText(file, base === "." ? href : `${base}/${href}`).catch(() => ""));
    if (text) chapters.push(text);
  }
  return chapters.join("\n\n");
}

/** A dropped .docx / .odt / .epub → its text. */
export async function documentText(name: string, bytes: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (![".docx", ".odt", ".epub"].includes(ext)) throw new Error("Drop PDF, Word (.docx), OpenDocument (.odt), EPUB, Markdown or text");
  const dir = await mkdtemp(path.join(tmpdir(), "source-"));
  try {
    const file = path.join(dir, `in${ext}`);
    await writeFile(file, bytes);
    const text = ext === ".docx" ? docxText(await unzipText(file, "word/document.xml")) : ext === ".odt" ? markupToText(await unzipText(file, "content.xml")) : await epubText(file);
    if (!text.trim()) throw new Error(`${name} has no text in it`);
    return text;
  } catch (e) {
    if (e instanceof Error && /unzip|End-of-central|cannot find/i.test(e.message)) throw new Error(`${name} could not be opened (damaged, or not a real ${ext})`);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Loopback, private, link-local, CGNAT and the like: a link may never make the server reach inside. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function publicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links");
  if (url.username || url.password) throw new Error("Links with a login in them aren't read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateAddress)) throw new Error("That address isn't on the public internet");
  return url;
}

const PAGE_MAX = 8 * 1024 * 1024;

/**
 * A web page's title and text. Redirects are followed by hand so every hop is checked.
 * ponytail: DNS is checked before fetch, not pinned; a rebinding host could still slip through between the two.
 */
export async function webPageText(raw: string, fetchImpl: typeof fetch = fetch): Promise<{ title: string; text: string }> {
  let url = await publicUrl(raw);
  let res: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0 CreatorToolset", Accept: "text/html,text/plain;q=0.9" } });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) break;
    url = await publicUrl(new URL(next, url).toString());
  }
  if (!res?.ok) throw new Error(`The page answered ${res?.status ?? "nothing"}`);
  const type = res.headers.get("content-type") ?? "";
  if (/pdf/i.test(type)) throw new Error("That link is a PDF: download it and drop the file");
  if (!/html|text\/plain|xml/i.test(type)) throw new Error("That link isn't a web page");
  if (Number(res.headers.get("content-length") ?? 0) > PAGE_MAX) throw new Error("That page is too big");
  const body = (await res.text()).slice(0, PAGE_MAX);
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? "") || url.hostname;
  const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(body)?.[0] ?? body;
  const text = /html/i.test(type) ? markupToText(main) : body;
  if (text.length < 200) throw new Error("That page has almost no text (it may need a browser to show it)");
  return { title, text: `${title}\n${url.toString()}\n\n${text}` };
}
