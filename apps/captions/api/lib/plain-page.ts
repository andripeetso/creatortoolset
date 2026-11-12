/** The Creator Toolset mark (src/components/HomeLink.tsx ToolsetLogo), as markup for a page the server writes itself. */
const LOGO =
  '<svg viewBox="0 0 1024 1024" width="40" height="40" aria-hidden="true"><defs><radialGradient id="ctg" cy=".46"><stop offset="0" stop-color="#4A28D0"/><stop offset="1" stop-color="#0C0818"/></radialGradient>' +
  '<linearGradient id="ctw" gradientUnits="userSpaceOnUse" x1="0" y1="200" x2="0" y2="840"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4DCFF"/></linearGradient></defs>' +
  '<rect width="1024" height="1024" rx="230" fill="url(#ctg)"/><g fill="url(#ctw)" transform="translate(-28 0)"><path d="M440 285A235 235 0 1 0 610 682" fill="none" stroke="url(#ctw)" stroke-width="130"/>' +
  '<rect x="438" y="220" width="500" height="130"/><rect x="690" y="220" width="128" height="600"/></g></svg>';

const CSS =
  ":root{color-scheme:dark;--bg:#09090b;--card:#111114;--line:#27272a;--text:#fafafa;--muted:#a1a1aa;--tint:#7c3aed;--tint-hover:#8b5cf6}" +
  "@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f4f5;--card:#fff;--line:#e4e4e7;--text:#18181b;--muted:#52525b}}" +
  "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased}" +
  "main{width:100%;max-width:400px}.brand{display:flex;align-items:center;gap:12px;margin:0 0 20px 4px}.brand svg{flex:none;border-radius:10px}" +
  ".brand b{display:block;font-size:17px;font-weight:600;letter-spacing:-.01em}.brand span{display:block;font-size:13px;color:var(--muted)}" +
  ".card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}h1{font-size:19px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}" +
  "p{margin:0;color:var(--muted)}p b{color:var(--text);font-weight:600}.actions,form{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}" +
  ".go,button{display:inline-flex;align-items:center;justify-content:center;height:38px;padding:0 18px;border-radius:9px;border:0;background:var(--tint);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}" +
  ".go:hover,button:hover{background:var(--tint-hover)}.no{display:inline-flex;align-items:center;height:38px;padding:0 14px;border-radius:9px;color:var(--muted);text-decoration:none}.no:hover{color:var(--text)}";

/**
 * A page for a browser that is not signed in to the app (a sign-in finished in the computer's browser, a platform's
 * confirm step): the Creator Toolset mark and name on top, so a person landing on it knows what it is, then a card with
 * the title, one line and its buttons (`extra`: `<a class="go">`, `<a class="no">`, a `<form>` with a `<button>`).
 * `title` is text; `line` and `extra` are markup, escaped by the caller.
 */
export const plainPage = (title: string, line: string, extra = "", what = "Sign-in") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)} · Creator Toolset</title><style>${CSS}</style></head>` +
  `<body><main><div class="brand">${LOGO}<div><b>Creator Toolset</b><span>${escHtml(what)}</span></div></div>` +
  `<div class="card"><h1>${escHtml(title)}</h1><p>${line}</p>${extra}</div></main></body></html>`;

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
