# Connect your AI

Creator Toolset is an MCP server, so an AI app can use it as you: find clips in your Media Library, write and edit in
your Content Workshop, read Review comments, start AI Editor edits, read your Instagram posts and comments, and run
scheduled tasks. Whatever it does shows in the app at once.

The address is your server followed by `/api/mcp`, e.g. `https://creatortoolset.com/api/mcp`.

## ChatGPT and Claude

They reach the app on your computer through your Creator Toolset account (the Connect service), so the computer must
be linked to your account. Nothing of yours is kept on the way: each request goes to your computer and back.

1. In ChatGPT's or Claude's store, find Creator Toolset and add it.
2. Sign in to your Creator Toolset account, pick your computer, press **Allow**.
3. Allow it once more on the computer: the page opens Creator Toolset there, where **Allow** finishes it.

Or start on the computer: Settings → Headless access → **Install** on the ChatGPT or Claude row opens Creator
Toolset's page in that store and allows it on the computer in the same press. The row says Installed once the app has
used it. **Remove** in its menu ends the connection at once. While the computer is off, the app is told so.

The rows show once Creator Toolset is listed in that store. Any server can still be added by its own address (`/api/mcp`)
in an app that takes one; that app then asks you to sign in to that server.

## Claude Code, Codex and scripts

Settings → Headless access → **Install** on the Claude Code or Codex row adds it on your Mac. Any other app or script:
**Get address and key**, then send the key as `Authorization: Bearer <key>`. Each app gets a key of its own.

## What an AI app sees

Every tool says whether it only reads, adds something, or can remove or overwrite something (MCP's `readOnlyHint` and
`destructiveHint`), and whether it reaches outside your account (`openWorldHint`: a pull from Instagram, a link for
other people). A plug-in's tools count as ones that can remove, so the AI app asks you before it runs them.

## Cards in the chat

In an AI app that draws them (ChatGPT, Claude), some answers show as a card instead of text:

- **A script** (`workshop_session` and the tools that write one): its lines, hooks and post description, and a
  Find footage button that asks for clips to go with it.
- **Footage** (`media_search`): the clips with their pictures; a clip plays in the card, and Start an edit goes on from
  there.
- **A Review video** (`get_review`): the video, each comment with its time (a press jumps the video there) and the
  frame it points at, and a Resolve button on every open comment.
- **An edit** (`editor_get`, `editor_create`): its versions and where each stands; it asks again by itself while the
  edit runs, and a ready version opens in Review.
- **An account's posts** (`instagram_posts`): each post with its plays, likes and comments.

A card follows the app's own colours and has one button that opens the thing in Creator Toolset. A button that needs
the AI app (Resolve, Refresh, a follow-up message) shows only where that app offers it.

How things reach you from a chat:

- **A link into the app** opens the session, video or edit on your server, behind your own sign-in.
- **A share link** (`review_share`, `media_share`) is the public link for other people, the same the app makes.
- **A picture or a video in a card** comes over a signed link, because the card has no sign-in of its own. A library
  clip gives its thumbnail and the playable copy the library made, never the camera original; a Review video gives
  what its viewers watch. A link works for 6 hours and stops at once when you remove the app in Settings → Headless
  access. On an install where a plug-in guards the library with a check of its own, nothing leaves on such a link.

The AI reads the same answer as text; the card's data goes to the card only. Everything a chat makes is saved in the
account on your server (a session, an edit, a Review video): nothing lives only in the chat.

Code: `api/mcp-cards.ts` (which tools have a card, its data, the signed links), `api/mcp-card-view.ts` (the card's
page: one self-contained file, MCP Apps over postMessage).

## Running your own server

Sign-in for AI apps works on any server with accounts (`APP_SECRET` set) that the internet reaches over https.
Behind a proxy, set `PUBLIC_ORIGIN`. The app finds where to sign in from the 401 that `/api/mcp` answers and from
`/.well-known/oauth-protected-resource/api/mcp`.

Code: `api/oauth.ts` (registration, the Allow page, tokens), `api/mcp.ts` (the tools and their labels).
