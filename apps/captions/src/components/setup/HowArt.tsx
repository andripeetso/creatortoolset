/**
 * The pictures on setup's three "How do you want to work?" cards, drawn in the theme's own colours (the accent is the
 * project colour, `--tint`) so they sit right in light and dark. Each draws in a 200×120 box; Both places the other two.
 */

const TINT = "var(--tint)";

/** The app: a window with the tools on the left, a video in the middle and the assistant's chat on the right. */
function AppWindow() {
  return (
    <g>
      <rect x="0.5" y="0.5" width="199" height="119" rx="10" className="fill-background stroke-border" />
      <circle cx="12" cy="11" r="2.5" className="fill-muted-foreground/30" />
      <circle cx="20" cy="11" r="2.5" className="fill-muted-foreground/30" />
      <circle cx="28" cy="11" r="2.5" className="fill-muted-foreground/30" />
      <line x1="0.5" y1="21.5" x2="199.5" y2="21.5" className="stroke-border" />
      {/* tools */}
      {[30, 42, 54, 66].map((y, i) => (
        <rect key={y} x="9" y={y} width={i === 1 ? 26 : 20} height="6" rx="3" fill={i === 1 ? TINT : undefined} className={i === 1 ? undefined : "fill-muted"} />
      ))}
      {/* the video being worked on */}
      <rect x="46" y="30" width="86" height="50" rx="5" fill={TINT} fillOpacity="0.16" />
      <path d="M84 46 L96 55 L84 64 Z" fill={TINT} />
      <rect x="46" y="88" width="70" height="5" rx="2.5" className="fill-muted" />
      <rect x="46" y="99" width="52" height="5" rx="2.5" className="fill-muted" />
      {/* the assistant beside it */}
      <rect x="140" y="30" width="51" height="81" rx="6" className="fill-muted" />
      <rect x="146" y="38" width="32" height="9" rx="4.5" className="fill-background" />
      <rect x="153" y="53" width="32" height="9" rx="4.5" fill={TINT} />
      <rect x="146" y="68" width="26" height="9" rx="4.5" className="fill-background" />
      <rect x="146" y="98" width="39" height="7" rx="3.5" className="fill-background stroke-border" strokeWidth="0.75" />
    </g>
  );
}

/** Their own AI: a terminal where Claude Code or Codex calls Creator Toolset's tools. Always dark, like a terminal. */
function Terminal() {
  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 8.5 };
  return (
    <g>
      <rect x="0.5" y="0.5" width="199" height="119" rx="10" fill="#141416" stroke="#2a2a2e" />
      <circle cx="12" cy="11" r="2.5" fill="#3f3f46" />
      <circle cx="20" cy="11" r="2.5" fill="#3f3f46" />
      <circle cx="28" cy="11" r="2.5" fill="#3f3f46" />
      <text x="12" y="38" style={mono} fill="#a1a1aa">
        <tspan fill={TINT}>❯</tspan> plan three reels from
      </text>
      <text x="22" y="50" style={mono} fill="#a1a1aa">
        my last posts
      </text>
      <rect x="12" y="60" width="150" height="15" rx="4" fill={TINT} fillOpacity="0.22" />
      <circle cx="21" cy="67.5" r="2.5" fill={TINT} />
      <text x="28" y="70.5" style={mono} fill="#e4e4e7">
        creator-toolset · workshop
      </text>
      <text x="12" y="92" style={mono} fill="#4ade80">
        ✓ <tspan fill="#a1a1aa">3 drafts ready</tspan>
      </text>
      <rect x="12" y="102" width="5" height="9" fill="#e4e4e7" opacity="0.7" />
    </g>
  );
}

export function AppArt() {
  return (
    <svg viewBox="-4 -4 208 128" className="h-full w-full drop-shadow-sm" aria-hidden>
      <AppWindow />
    </svg>
  );
}

export function ChatArt() {
  return (
    <svg viewBox="-4 -4 208 128" className="h-full w-full drop-shadow-sm" aria-hidden>
      <Terminal />
    </svg>
  );
}

/** Both: the terminal in front, the app behind it, linked. */
export function BothArt() {
  return (
    <svg viewBox="-4 -4 208 128" className="h-full w-full drop-shadow-sm" aria-hidden>
      <g transform="translate(68 0) scale(0.66)">
        <AppWindow />
      </g>
      <g transform="translate(0 41) scale(0.66)">
        <Terminal />
      </g>
      {/* the link between them, in the corner where they meet */}
      <circle cx="140" cy="88" r="11" fill={TINT} className="stroke-background" strokeWidth="2.5" />
      <path d="M135.5 92.5 L144 84 M138.5 84 H144 V89.5" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
