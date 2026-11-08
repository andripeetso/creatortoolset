import type { ReactNode } from "react";

/**
 * The pictures on setup's three "How do you want to work?" cards. All three are the same window, the same size and in
 * the theme's own colours (light in light, dark in dark); only what's inside changes: the app, your own AI's chat, or
 * the two side by side. The accent is the project colour (`--tint`). The window is drawn in a 200×120 box.
 */

const TINT = "var(--tint)";
const GREEN = "#10b981";
const MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

/** The window every picture uses: rounded, three dots, a title bar line. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="-4 -4 208 128" className="h-full w-full drop-shadow-sm" aria-hidden>
      <rect x="0.5" y="0.5" width="199" height="119" rx="10" className="fill-background stroke-border" />
      <circle cx="12" cy="11" r="2.5" className="fill-muted-foreground/30" />
      <circle cx="20" cy="11" r="2.5" className="fill-muted-foreground/30" />
      <circle cx="28" cy="11" r="2.5" className="fill-muted-foreground/30" />
      <line x1="0.5" y1="21.5" x2="199.5" y2="21.5" className="stroke-border" />
      {children}
    </svg>
  );
}

/** The app's inside, between x and x+w: a video being worked on, and (`full`) the tools and the assistant's chat. */
function AppInside({ x, w, full }: { x: number; w: number; full?: boolean }) {
  const left = full ? x + 37 : x + 12; // room for the tools column
  const chatW = 51;
  const chatX = x + w - chatW - 9;
  const videoW = (full ? chatX - 8 : x + w - 12) - left;
  return (
    <g>
      {full &&
        [30, 42, 54, 66].map((y, i) => (
          <rect key={y} x={x + 9} y={y} width={i === 1 ? 22 : 18} height="6" rx="3" fill={i === 1 ? TINT : undefined} className={i === 1 ? undefined : "fill-muted"} />
        ))}
      <rect x={left} y="30" width={videoW} height="50" rx="5" fill={TINT} fillOpacity="0.16" />
      <path d={`M${left + videoW / 2 - 5} 46 l11 9 l-11 9 Z`} fill={TINT} />
      <rect x={left} y="88" width={videoW * 0.8} height="5" rx="2.5" className="fill-muted" />
      <rect x={left} y="99" width={videoW * 0.6} height="5" rx="2.5" className="fill-muted" />
      {full && (
        <>
          <rect x={chatX} y="30" width={chatW} height="81" rx="6" className="fill-muted" />
          <rect x={chatX + 6} y="38" width="32" height="9" rx="4.5" className="fill-background" />
          <rect x={chatX + 13} y="53" width="32" height="9" rx="4.5" fill={TINT} />
          <rect x={chatX + 6} y="68" width="26" height="9" rx="4.5" className="fill-background" />
          <rect x={chatX + 6} y="98" width="39" height="7" rx="3.5" className="fill-background stroke-border" strokeWidth="0.75" />
        </>
      )}
    </g>
  );
}

/** Your own AI's chat, from x: you ask, it calls Creator Toolset, the work is done. `short` for half a window. */
function ChatInside({ x, short }: { x: number; short?: boolean }) {
  const size = short ? 7 : 8.5;
  return (
    <g style={{ ...MONO, fontSize: size }}>
      <text x={x + 10} y="38" className="fill-foreground">
        <tspan fill={TINT}>❯</tspan> {short ? "plan three reels" : "plan three reels from"}
      </text>
      {!short && (
        <text x={x + 20} y="50" className="fill-foreground">
          my last posts
        </text>
      )}
      <rect x={x + 10} y={short ? 47 : 60} width={short ? 74 : 150} height="15" rx="4" fill={TINT} fillOpacity="0.16" />
      <circle cx={x + 19} cy={short ? 54.5 : 67.5} r="2.5" fill={TINT} />
      <text x={x + 26} y={short ? 57 : 70.5} className="fill-foreground">
        {short ? "workshop" : "creator-toolset · workshop"}
      </text>
      <text x={x + 10} y={short ? 78 : 92} className="fill-muted-foreground">
        <tspan fill={GREEN}>✓</tspan> 3 drafts ready
      </text>
      <rect x={x + 10} y={short ? 87 : 102} width="5" height="9" className="fill-foreground" opacity="0.5" />
    </g>
  );
}

export function AppArt() {
  return (
    <Frame>
      <AppInside x={0} w={200} full />
    </Frame>
  );
}

export function ChatArt() {
  return (
    <Frame>
      <ChatInside x={0} />
    </Frame>
  );
}

/** Both: your AI's chat on the left, the app on the right, linked in the middle. */
export function BothArt() {
  return (
    <Frame>
      <ChatInside x={0} short />
      <line x1="96.5" y1="22" x2="96.5" y2="119.5" className="stroke-border" />
      <AppInside x={96} w={104} />
      <circle cx="96.5" cy="71" r="9" fill={TINT} className="stroke-background" strokeWidth="2.5" />
      <path d="M92 71 H101 M97.5 67.5 L101 71 L97.5 74.5" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Frame>
  );
}
