import { GuideArticle, headingId } from "@/components/GuideArticle";
import source from "../../docs/video-cleaner/README.md?raw";

const PREFIX = "clean-guide-";
const sections = [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

/** Render the same checked-in README; no duplicated product-help copy. */
export default function CleanGuideContent() {
  return (
    <>
      <nav aria-label="Guide sections" className="mb-6 flex flex-wrap gap-2">
        {sections.map((title) => (
          <a
            key={title}
            href={`#${headingId(title, PREFIX)}`}
            onClick={(event) => {
              // Keep navigation inside the dialog without changing the editor URL.
              const heading = event.currentTarget
                .closest('[role="document"]')
                ?.querySelector(`#${headingId(title, PREFIX)}`);
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
      <GuideArticle source={source} idPrefix={PREFIX} />
    </>
  );
}
