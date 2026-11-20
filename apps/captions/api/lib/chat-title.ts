/**
 * A chat's name, written by the person's own AI from its first message and what came with it (the open project, the
 * page, the files), so the list says what the chat is about rather than repeating its first words.
 */

/** What the first message of a chat said and showed. */
export interface TitleSource {
  text: string;
  /** The Workshop project open when it was sent. */
  project?: string;
  /** The page it was sent from: its title and the lines that say what is on screen. */
  page?: string;
  visible?: string;
  /** Text highlighted on the page and sent with it. */
  quote?: string;
  /** Names of the files, folders and pictures sent with it. */
  attachments?: string[];
}

export const TITLE_SYSTEM = `Write a title that will help the user recognize this chat weeks later, in a list of their chats in a creator's video and content app.
Answer with the title only, on one line.

Before answering, silently reduce the request to:
- Subject: What video, piece, feature, or problem is this really about?
- Outcome: What does the user ultimately want to make, understand, or change?
- Incidental instructions: What only describes how the assistant should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- When the message is vague ("edit the video", "fix this", "make it better"), take the subject from the open project, the page, the quoted text, or the attachments: "Edit the apology video", not "Edit the video".
- Capture the umbrella goal when the request lists several steps.
- Models, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For research, name the question domain rather than the research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Write the title in the language of the user's message.
- Turn file and project names into plain words ("ApologyVideoButStandalone" → "apology video").
- No quotes, labels, filler, emoji, or trailing punctuation.`;

const cap = (s: string | undefined, n: number) => {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The user turn: the message first, then what came with it, each part capped. */
export function titlePrompt(s: TitleSource): string {
  const parts = [`User message:\n${cap(s.text, 4000) || "(no text)"}`];
  if (s.project) parts.push(`Open project: ${cap(s.project, 200)}`);
  if (s.page) parts.push(`Page: ${cap(s.page, 200)}`);
  if (s.visible) parts.push(`On screen:\n${cap(s.visible, 1000)}`);
  if (s.quote) parts.push(`Quoted from the page:\n${cap(s.quote, 1000)}`);
  if (s.attachments?.length) parts.push(`Attachments: ${cap(s.attachments.join(", "), 1000)}`);
  return parts.join("\n\n");
}

const MAX_TITLE = 120;

/** The model's answer as a title: its first line, without quotes or a closing full stop; "" when there is none. */
export function cleanTitle(raw: string): string {
  const line = (raw.trim().split(/\r?\n/)[0] ?? "")
    .replace(/^title:\s*/i, "")
    .replace(/^["'`“”‘’*]+|["'`“”‘’*.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^new chat$/i.test(line)) return "";
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}
