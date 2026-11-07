import { Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** A heading's id: `<prefix><slug>`, so a page's own links can jump to it. */
export const headingId = (title: string, prefix = "") =>
  prefix +
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A checked-in Markdown guide as an article (its own # title dropped); h2s get ids `<idPrefix><slug>`. */
export function GuideArticle({ source, idPrefix }: { source: string; idPrefix?: string }) {
  return (
    <article className="min-w-0 break-words text-sm leading-7 text-zinc-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => (
            <h2
              id={headingId(Children.toArray(children).join(""), idPrefix)}
              tabIndex={-1}
              className="mb-3 mt-8 scroll-mt-3 text-lg font-semibold text-zinc-100 outline-none"
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-6 text-base font-semibold text-zinc-200">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="my-3">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-100">
              {children}
            </strong>
          ),
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel="noopener noreferrer"
              className="text-violet-300 underline decoration-violet-500/50 underline-offset-2 hover:text-violet-200"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <table className="my-4 w-full table-fixed border-collapse text-left text-xs leading-6">
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th className="border border-zinc-700 bg-zinc-900 px-3 py-2 font-semibold text-zinc-200">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-zinc-800 px-3 py-2 align-top">
              {children}
            </td>
          ),
          pre: ({ children }) => (
            <pre className="my-4 whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs leading-6">
              {children}
            </pre>
          ),
          code: ({ children }) => (
            <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[.9em] text-zinc-200">
              {children}
            </code>
          ),
        }}
      >
        {source.replace(/^# .+\n/, "")}
      </ReactMarkdown>
    </article>
  );
}
