/**
 * Breakpoints follow the room a page has, not the window. In chat mode the chats take part of the window and
 * <html data-pane="lt-xl lt-lg"> (src/lib/chat-mode.ts) names the breakpoints the page is narrower than. For what is
 * inside <main> (the page) those turn off here, and their max-* twins turn on, so a page beside the chats lays out as
 * it does in a window that wide: every screen's narrow layout is the one it already has. What is outside <main> (the
 * chats themselves, a dialog over the whole window) keeps following the window. Without data-pane nothing changes, and
 * :is() / :where() leave every rule's weight as it was.
 *
 * Only the theme's own breakpoints (sm, md, lg, xl, 2xl) are followed. A rule written for the document itself (html,
 * :root, body) stays on the window.
 */
const NAMES = { "640px": "sm", "768px": "md", "1024px": "lg", "1280px": "xl", "1536px": "2xl" };
const DOCUMENT = /^(html|:root|body)(?![\w-])/;
const PAGE = ":is(main, main *)";

/** A selector as [what it selects, its pseudo-elements onward]: `.a::before:hover` → [".a", "::before:hover"]. */
function split(s) {
  let depth = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ":" && s[i + 1] === ":" && depth === 0) return [s.slice(0, i), s.slice(i)];
  }
  return [s, ""];
}

/** Every rule under `at` also needs its element to match `cond` (a pseudo-element cannot stand inside :is(), so it stays outside). */
const scoped = (at, cond) =>
  at.walkRules((rule) => {
    // a keyframe's steps are not selectors
    if (rule.parent && rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map((s) => {
      if (DOCUMENT.test(s)) return s;
      const [head, tail] = split(s);
      return `:is(${head || "*"}):where(${cond})${tail}`;
    });
  });

const plugin = () => ({
  postcssPlugin: "pane-breakpoints",
  OnceExit(root) {
    root.walkAtRules("media", (at) => {
      const min = /^\(min-width:\s*(\d+px)\)$/.exec(at.params);
      const max = /^not all and \(min-width:\s*(\d+px)\)$/.exec(at.params);
      const name = NAMES[(min || max || [])[1]];
      if (!name) return;
      // off for the page while it is narrower than this breakpoint
      if (min) return scoped(at, `:not(html[data-pane~=lt-${name}] ${PAGE})`);
      // max-*: as it was for the window, and also on for the page while it is narrower
      const twin = at.clone();
      scoped(twin, `html[data-pane~=lt-${name}] ${PAGE}`);
      at.after(twin.nodes);
    });
  },
});
plugin.postcss = true;
module.exports = plugin;
