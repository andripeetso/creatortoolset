/** A plain page for a browser that is not signed in to the app (a sign-in finished in the system browser). */
export const plainPage = (title: string, line: string, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:420px;padding:32px 24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.7}form{margin-top:20px}button{font:inherit;font-weight:600;padding:8px 18px;border-radius:8px;border:1px solid #8884;background:#7c3aed;color:#fff;cursor:pointer}</style></head><body><main><h1>${title}</h1><p>${line}</p>${extra}</main></body></html>`;

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
