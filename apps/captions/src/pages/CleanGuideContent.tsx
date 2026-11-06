import { Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import source from "../../docs/video-cleaner/README.md?raw";

const headingId = (title: string) =>
  "clean-guide-" +
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const sections = [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

/** Render the same checked-in README; no duplicated product-help copy. */
export default function CleanGuideContent() {
  return (
    <>
      <nav aria-label="Guide sections" className="mb-6 flex flex-wrap gap-2">
        {sections.map((title) => (
          <a
            key={title}
            href={`#${headingId(title)}`}
            onClick={(event) => {
              // Keep navigation inside the dialog without changing the editor URL.
              const heading = event.currentTarget
                .closest('[role="document"]')
                ?.querySelector(`#${headingId(title)}`);
              if (heading) {
                event.preventDefault();
                heading.scrollIntoView({ block: "start" });
                (heading as HTMLElement).focus({ preventScroll: true });
              }
            }}
            className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-violet-200 hover:border-violet-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
          >
            {title}
          </a>
        ))}
      </nav>
      <article className="min-w-0 break-words text-sm leading-7 text-zinc-300">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h2: ({ children }) => (
              <h2
                id={headingId(Children.toArray(children).join(""))}
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
    </>
  );
}
