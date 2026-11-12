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

## Running your own server

Sign-in for AI apps works on any server with accounts (`APP_SECRET` set) that the internet reaches over https.
Behind a proxy, set `PUBLIC_ORIGIN`. The app finds where to sign in from the 401 that `/api/mcp` answers and from
`/.well-known/oauth-protected-resource/api/mcp`.

Code: `api/oauth.ts` (registration, the Allow page, tokens), `api/mcp.ts` (the tools and their labels).
