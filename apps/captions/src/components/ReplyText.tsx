import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useInRouterContext, useNavigate } from "react-router";
import remarkGfm from "remark-gfm";

/** A path of this app ("/review/…"), not another site's address. */
const inApp = (href?: string) => !!href && /^\/(?!\/)/.test(href);

/** A file this server hands out ("/api/exports/…/file"): it is saved, not a page to move to. */
const isFile = (href?: string) => !!href && href.startsWith("/api/");

/** A link in a reply: a page of this app opens here, with the chat still there; a file of this server downloads; anything else opens in a new tab. */
function ReplyLink({ href, children }: { href?: string; children?: ReactNode }) {
  const look = "select-text text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-200";
  const routed = useInRouterContext();
  if (isFile(href)) {
    return (
      <a href={href} download className={look}>
        {children}
      </a>
    );
  }
  return inApp(href) && routed ? (
    <AppLink href={href!} className={look}>
      {children}
    </AppLink>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className={look}>
      {children}
    </a>
  );
}

function AppLink({ href, className, children }: { href: string; className: string; children?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        // a modified click still opens a tab, as any link does
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** The AI's reply as formatted text, not markdown source; a single line break stays a break. */
const REPLY: Components = {
  p: ({ children }) => <p className="my-2 whitespace-pre-line first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 [&>p]:my-0">{children}</li>,
  h1: ({ children }) => <p className="mb-1 mt-3 font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mb-1 mt-3 font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mb-1 mt-3 font-semibold first:mt-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => <ReplyLink href={href}>{children}</ReplyLink>,
  // A picture from another site is never loaded: the request itself would hand that site whatever the address
  // carries, and an AI can be talked into writing one (a pasted source, a page it read). It shows as a link.
  img: ({ src, alt }) => (inApp(src) ? <img src={src} alt={alt ?? ""} className="my-2 max-w-full rounded-md" /> : <ReplyLink href={src}>{alt || src}</ReplyLink>),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{children}</code>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="my-3 border-border" />,
};

export function ReplyText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={REPLY}>
      {text}
    </ReactMarkdown>
  );
}
