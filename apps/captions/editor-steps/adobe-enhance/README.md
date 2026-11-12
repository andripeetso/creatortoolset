# Adobe Enhance Speech

A plug-in for Creator Toolset. It adds Adobe's Enhance Speech to the Audio Enhancer, with your own Adobe account.

## What you get

- **An engine in the Audio Enhancer:** Adobe Enhance Speech, beside NVIDIA and ElevenLabs. Once you are signed in, a new
  file starts on it.
- **Settings → Adobe Enhance Speech:** one row. Sign in to Adobe, or Sign out.
- **Setup:** the Audio Enhancer counts as set up once you are signed in to Adobe. Until then its row says "Needs an API
  key or an Adobe sign-in".

## What it needs

- Google Chrome on the Mac.
- An Adobe account. Adobe's plan sets how long a file can be and how much time you get each day.
- For the setup row: a version of the app with the plug-in slot `needs`. Without it the engine works, and the row
  still asks for an API key.

## How it works

- Adobe has no API for Enhance Speech. This plug-in uses Adobe's web page in Google Chrome. Adobe's terms of use apply
  to your account.
- You sign in once, in a Chrome window the plug-in opens on Adobe's page. You type there yourself. The window closes once
  Adobe's page says you are in.
- Each run opens the same Chrome profile hidden, puts your file in Adobe's page and takes Adobe's result back. Your
  audio goes to Adobe.
- One file at a time. The result comes out at the same loudness as the other engines'.
- When Adobe says no, the run ends with one line saying why: you are signed out, the day's time is used up, the file is
  longer than your plan takes, or Adobe took no upload (late in the day, when the time left is shorter than the file).
  After the day's time is used up, the engine waits until the time Adobe gives. The other engines keep working.
- Its files: Chrome's profile, under the data folder in `plugins/adobe-enhance/<account>/`. Sign out deletes them.

## Add it

- **The Mac app:** the account menu → Community → Plug-ins → Audio Enhancer → Adobe Enhance Speech → Download, then
  Switch on in the app's own dialog. The app comes with this folder (`editor-steps/adobe-enhance`) and copies it into your
  plug-ins folder.
- **A checkout:** copy it to `apps/captions/plugins/adobe-enhance/` and build.
- It is for the person whose computer runs the server (its admin account). A hosted server never offers it.

## Engine id

`adobespeech`. It is not `adobe`, so it can sit beside another Adobe engine on the same server.

## Tests

From `apps/captions`, with this folder copied to `plugins/adobe-enhance` (the tests need it compiled in; the app's own
`pnpm test` leaves this folder out):

```sh
pnpm exec vitest run --config plugins/adobe-enhance/vitest.config.ts               # routes, setup, refusals
ADOBE_E2E=1 pnpm exec vitest run --config plugins/adobe-enhance/vitest.config.ts   # + runs in Chrome
```

The Chrome runs go to a stand-in of Adobe's page on this machine, never to Adobe. `ADOBE_E2E_WINDOW=1` also opens the
sign-in window on screen for a few seconds. Two settings exist for tests only: `ADOBE_ENHANCE_URL` (the page) and
`ADOBE_ENHANCE_CHROME` (Chrome's program; empty = no Chrome). On Linux, point `ADOBE_ENHANCE_CHROME` at Chromium and keep
`TMPDIR` short (`/tmp/x`): Chromium refuses to start when the path of its lock socket under `TMPDIR` is too long.
