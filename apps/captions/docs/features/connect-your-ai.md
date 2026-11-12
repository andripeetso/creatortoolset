# Connect your AI

Creator Toolset is an MCP server, so an AI app can use it as you: find clips in your Media Library, write and edit in
your Content Workshop, read Review comments, start AI Editor edits, read your Instagram posts and comments, and run
scheduled tasks. Whatever it does shows in the app at once.

The address is your server followed by `/api/mcp`, e.g. `https://creatortoolset.com/api/mcp`.

## ChatGPT and Claude

Settings → Headless access → **Install** on the ChatGPT or Claude row shows these steps with the address to copy:

- **ChatGPT:** chatgpt.com/plugins → **+** → **Add custom MCP server** (no **+**: turn on Developer mode in Settings →
  Security and login). Name Creator Toolset, the address as the MCP server URL, OAuth, **Create as a plugin**.
- **Claude:** Customize → Connectors → **+ Add** → **Add custom connector**. Name Creator Toolset, the address as the
  server URL, **Continue**, **Add**, **Connect**.

Either app then sends you to Creator Toolset: sign in, check the app's name and address, press **Allow**.

The row then says Installed. **Remove** in its menu ends the connection at once; connecting again replaces the old
one. Allow gives the app what your account can do, except your AI providers, paired computers and keys.

## Claude Code, Codex and scripts

Settings → Headless access → **Install** on the Claude Code or Codex row adds it on your Mac. Any other app or script:
**Get address and key**, then send the key as `Authorization: Bearer <key>`. Each app gets a key of its own.

## What an AI app sees

Every tool says whether it only reads, adds something, or can remove or overwrite something (MCP's `readOnlyHint` and
`destructiveHint`), and whether it reaches outside your account (`openWorldHint`: a pull from Instagram, a link for
other people). A plug-in's tools count as ones that can remove, so the AI app asks you before it runs them.

## Cards in the chat

In an AI app that draws them (ChatGPT, Claude), some answers show as a card instead of text: a script
(`workshop_session` and the tools that write one), footage (`media_search`), a Review video's comments (`get_review`)
and an edit with its versions (`editor_get`, `editor_create`; it asks again by itself while the edit runs). A card
follows the app's own colours and has one button that opens the thing in Creator Toolset.

How things reach you from a chat:

- **A link into the app** opens the session, video or edit on your server, behind your own sign-in.
- **A share link** (`review_share`, `media_share`) is the public link for other people, the same the app makes.
- **A picture in a card** comes over a signed link, because the card has no sign-in of its own. It is a thumbnail,
  never the video or the original; it works for 6 hours and stops at once when you remove the app in Settings →
  Headless access. A library that a plug-in guards with a check of its own sends no pictures to cards.

The AI reads the same answer as text; the card's data goes to the card only.

Code: `api/mcp-cards.ts` (which tools have a card, its data, the signed links), `api/mcp-card-view.ts` (the card's
page: one self-contained file, MCP Apps over postMessage).

## Running your own server

Sign-in for AI apps works on any server with accounts (`APP_SECRET` set) that the internet reaches over https.
Behind a proxy, set `PUBLIC_ORIGIN`. The app finds where to sign in from the 401 that `/api/mcp` answers and from
`/.well-known/oauth-protected-resource/api/mcp`.

Code: `api/oauth.ts` (registration, the Allow page, tokens), `api/mcp.ts` (the tools and their labels).
