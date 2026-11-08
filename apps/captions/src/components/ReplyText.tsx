import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="select-text text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-200">
      {children}
    </a>
  ),
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
