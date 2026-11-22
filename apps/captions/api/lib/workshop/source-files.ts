import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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

/** IPv6 as eight 16-bit words; a dotted IPv4 tail (::ffff:1.2.3.4) becomes two of them. */
function ipv6Words(ip: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const s = m ? `${ip.slice(0, m.index)}${((Number(m[1]) << 8) | Number(m[2])).toString(16)}:${((Number(m[3]) << 8) | Number(m[4])).toString(16)}` : ip;
  const [head = "", rest] = s.split("::");
  const words = (x: string) => (x ? x.split(":") : []);
  const h = words(head);
  const t = rest === undefined ? [] : words(rest);
  return [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((x) => parseInt(x, 16));
}

/** Loopback, private, link-local, CGNAT and the like: a link may never make the server reach inside. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const w = ipv6Words(ip);
    const zeros = (n: number) => w.slice(0, n).every((x) => x === 0);
    // ::/96 (loopback, unspecified, IPv4-compatible), ::ffff:0:0/96 (every IPv4-mapped address, hex or dotted), 64:ff9b::/96 (NAT64)
    if (zeros(6) || (zeros(5) && w[5] === 0xffff) || (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0))) return true;
    const first = w[0] ?? 0;
    // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

// social platforms are read only through their official APIs or the user's own Apify key, never as web pages
const SOCIAL_HOST = /(^|\.)(instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.watch|threads\.net|threads\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|youtu\.be)$/i;

/** The link and the addresses it was checked at; the fetch connects to one of those, never a second lookup. */
async function publicUrl(raw: string): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links");
  if (url.username || url.password) throw new Error("Links with a login in them aren't read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (SOCIAL_HOST.test(host)) throw new Error("Social posts go in the Content Analyzer, which reads them through the official logins and your own Apify key");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateAddress)) throw new Error("That address isn't on the public internet");
  return { url, addresses: ips };
}

/**
 * GET that connects only to the given addresses: the ones publicUrl checked. All of them are offered, so a host whose
 * first address is IPv6 still answers on a network without IPv6. Redirects are returned, not followed.
 */
export function pinnedFetch(url: URL, init: { headers: Record<string, string>; signal: AbortSignal }, addresses: string[]): Promise<Response> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const all = addresses.map((address) => ({ address, family: isIP(address) }));
  const first = all.find((a) => a.family === 4) ?? all[0]!;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: "GET", headers: init.headers, signal: init.signal, lookup: (_host, opts, cb) => (opts.all ? cb(null, all) : cb(null, first.address, first.family)) }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) res.resume();
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
      resolve(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const PAGE_MAX = 8 * 1024 * 1024;

/** A web page's title and text. Redirects are followed by hand so every hop is checked and pinned. */
export async function webPageText(raw: string, fetchImpl: typeof pinnedFetch = pinnedFetch): Promise<{ title: string; text: string }> {
  let { url, addresses } = await publicUrl(raw);
  let res: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0 CreatorToolset", Accept: "text/html,text/plain;q=0.9" } }, addresses);
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) break;
    ({ url, addresses } = await publicUrl(new URL(next, url).toString()));
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
