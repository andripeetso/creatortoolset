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

## Optional runtimes you build yourself

These are not in the repository or the Docker image. The setup scripts fetch them on your machine, and they
copy each one's licence next to the files they install.

- Video fingerprints (`scripts/install-fingerprint-runtime.sh`): Meta's ThreatExchange PDQ and TMK reference
  code, BSD licence (`THREATEXCHANGE-LICENSE`). PDQ includes CImg, dual-licensed CeCILL-C or CeCILL 2.1
  (`CIMG-NOTICE`).
- SSCD copy detection model (`scripts/install-sscd-runtime.mjs`): MIT (`scripts/sscd-LICENSE.txt`).

## Mac app

- [Sparkle](https://github.com/sparkle-project/Sparkle) (updates): MIT. It is the Mac app's only package.
