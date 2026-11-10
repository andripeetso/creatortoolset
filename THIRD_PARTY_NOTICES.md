# Third-party notices

Creator Toolset's own code is MIT (see [LICENSE](LICENSE)). It uses, downloads or ships the third-party parts
below. Most direct dependencies are MIT, ISC, BSD or Apache-2.0; this file lists the ones under other licences,
and the programs the Docker image or the setup scripts download. Each part keeps its own licence.

## FFmpeg (GPL), downloaded by the Docker image

The Docker image does not use the distribution's FFmpeg package. While the image builds,
`apps/captions/scripts/install-ffmpeg-runtime.sh` downloads a checksum-pinned static FFmpeg 7.1 build and
installs it as `/app/runtime/ffmpeg`. FFmpeg is not in this repository.

- The build: the `linux64-gpl` build `ffmpeg-n7.1.5-1-g7d0e842004` from release `autobuild-2026-06-30-13-34` of
  https://github.com/BtbN/FFmpeg-Builds (the exact URL and SHA-256 are in the script).
- Its licence: the GPL, because the build enables GPL components. `ffmpeg -L` prints the exact terms, and the
  archive carries its `LICENSE.txt`.
- Its source: FFmpeg at commit `7d0e842004` of the `release/7.1` branch, https://github.com/FFmpeg/FFmpeg. The
  scripts that make the build, with the versions of the libraries it links, are in the FFmpeg-Builds repository
  at that release.

If you publish an image you built, you distribute that FFmpeg binary: make its source available with it, as
the GPL asks (pointing at the two repositories above at those versions is the usual way).

## FFmpeg (GPL), bundled in the Mac app

The Mac app carries `ffmpeg` and `ffprobe` in `Contents/Resources/server/runtime/`. While the app builds,
`apps/captions/scripts/install-ffmpeg-runtime-mac.sh` downloads them from a checksum-pinned static build.

- The build: FFmpeg 7.1.1 for macOS arm64 from https://ffmpeg.martin-riedl.de (the exact URLs and SHA-256 are in
  the script). It is configured with `--enable-gpl`; `ffmpeg -version` prints the full configuration.
- Its licence: the GPL. `ffmpeg -L` prints the exact terms.
- Its source: every GitHub release of the app carries `ffmpeg-<version>.tar.xz`, FFmpeg's source for the version
  inside it, as published at https://ffmpeg.org/releases/. The scripts that make the build, with the libraries it
  links, are at https://git.martin-riedl.de/ffmpeg/build-script.

The app also bundles Node.js (its licence is `server/NODE-LICENSE` inside the app). This file and the app's own
`LICENSE` are in `Contents/Resources/`.

## npm dependencies

| Package | Licence | How it is used |
|---|---|---|
| `mediabunny` | MPL-2.0 | Direct dependency of `apps/captions`: reads and writes video in the browser (story splitting, local exports). Unmodified; its source is on npm and at https://github.com/Vanilagy/mediabunny. |
| `sharp` | Apache-2.0 | Not a direct dependency: `@huggingface/transformers` pulls it in. |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | sharp's prebuilt libvips binaries for each platform, installed by npm alongside sharp. Unmodified; libvips' source is at https://github.com/libvips/libvips, the build scripts at https://github.com/lovell/sharp-libvips. |
| `playwright-chromium` | Apache-2.0 | Direct dependency; the Docker image downloads Playwright's Chromium headless shell (BSD-3-Clause, with Chromium's own third-party notices inside the browser's folder). |
| `type-fest` (one copy), `victory-vendor` | (MIT OR CC0-1.0), MIT AND ISC | Pulled in by other packages; listed only because their licence fields name two licences. |

`pnpm licenses list --prod` in `apps/captions` prints every package's licence.

## Fonts

`apps/captions/public/fonts/` bundles Google Fonts under the SIL Open Font License 1.1 (the text is in `OFL.txt`
there): Anton, Archivo Black, Bebas Neue, Inter, Montserrat, Oswald and Poppins.

## Provider and platform marks

The AI provider marks in Settings (`apps/captions/src/components/settings/ProviderLogos.tsx`) are single SVG paths
copied into the code: most from [Simple Icons](https://simpleicons.org) (CC0 1.0), Grok and Antigravity from
[@lobehub/icons-static-svg](https://github.com/lobehub/lobe-icons) (MIT). The social platform marks in Settings →
Social accounts (`apps/captions/src/components/settings/PlatformLogos.tsx`: Instagram, Facebook, YouTube, TikTok, X)
are single paths from Simple Icons (CC0 1.0), as published there. The marks themselves are trademarks of
their owners and are shown only to name the product a row is about.

## Optional runtimes you build yourself

These are not in the repository or the Docker image. The setup scripts fetch them on your machine, and they
copy each one's licence next to the files they install.

- Video fingerprints (`scripts/install-fingerprint-runtime.sh`): Meta's ThreatExchange PDQ and TMK reference
  code, BSD licence (`THREATEXCHANGE-LICENSE`). PDQ includes CImg, dual-licensed CeCILL-C or CeCILL 2.1
  (`CIMG-NOTICE`).
- SSCD copy detection model (`scripts/install-sscd-runtime.mjs`): MIT (`scripts/sscd-LICENSE.txt`).

## Mac app

- [Sparkle](https://github.com/sparkle-project/Sparkle) (updates): MIT. It is the Mac app's only package.
- The server inside the app (`apps/mac/scripts/build-app.sh` puts it in `Contents/Resources/server`):
  - Node.js 22 for macOS arm64 (the official build from nodejs.org, version and SHA-256 in the script): MIT,
    with the licences of the libraries it includes in `NODE-LICENSE` next to it.
  - FFmpeg and ffprobe 7.1.1 for macOS arm64 (`apps/captions/scripts/install-ffmpeg-runtime-mac.sh`): the static
    build `1741000090_7.1.1` from https://ffmpeg.martin-riedl.de (URL and SHA-256 in the script), GPL because it
    enables GPL components (`ffmpeg -L`). Its source is FFmpeg's `n7.1.1` tag at https://github.com/FFmpeg/FFmpeg;
    the build's library versions are on that page (`versions.txt`). If you hand out an app you built, make that
    source available with it, as for the Docker image above.
  - `onnxruntime-node` (MIT) and `playwright-chromium` with `playwright-core` (Apache-2.0), and their npm
    dependencies; the fingerprint tools and, when built with it, the SSCD model listed below.
  - The plug-in builder's packages, `esbuild`, `tailwindcss`, `tailwindcss-animate` and `postcss` (all MIT), with
    their npm dependencies, each with its licence file in `node_modules`.
