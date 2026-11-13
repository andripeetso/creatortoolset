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
there): Anton, Archivo, Archivo Black, Bebas Neue, Inter, Montserrat, Oswald and Poppins.

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
- The AI Editor's face steps, Face refinement and Blur faces (`apps/captions/editor-steps/face-refine`, `face-blur`),
  install one shared Python runtime on the computer the first time one of them runs, into the app's data folder
  (`runtime/mediapipe-<hash>/`, the list in `apps/captions/api/editor/mediapipe-requirements.ts`), never before the
  person switches a step on. pip installs these from PyPI:
  - `mediapipe` 1.2.2: Apache-2.0.
  - `opencv-contrib-python` 5.0.0.93: OpenCV under Apache-2.0, its packaging MIT. The wheel bundles FFmpeg (LGPL
    2.1) and other libraries; their licences are in the wheel's `cv2/LICENSE-3RD-PARTY.txt`.
  - their dependencies: NumPy (BSD-3-Clause and others, as its metadata lists), matplotlib (the matplotlib licence,
    PSF-based), Pillow (MIT-CMU), certifi (MPL-2.0, unmodified, source at https://github.com/certifi/python-certifi),
    absl-py, flatbuffers and tzdata (Apache-2.0), sounddevice and pyparsing (MIT), cffi (MIT-0), and contourpy,
    cycler, kiwisolver, pycparser, python-dateutil and packaging (BSD, packaging also Apache-2.0). Versions are
    what pip picks for that Python, so check `pip freeze` in the venv for the exact set.

  Each step then downloads its MediaPipe models from Google's model storage (URLs and SHA-256 in the step's
  `plugin.ts`), all under Apache-2.0 according to their model cards:
  - Face refinement: `face_landmarker.task` (BlazeFace short range, Face Mesh V2 and Blendshape V2) and
    `selfie_multiclass_256x256.tflite` (Multiclass Segmentation).
  - Blur faces: `blaze_face_short_range.tflite` (BlazeFace short range).
- The AI Editor's eye line (`apps/captions/api/editor/eyeline.ts`): on the person's own computer, the first analyze
  downloads the YuNet face detector `face_detection_yunet_2023mar.onnx` (232 KB) from the OpenCV Zoo copy on Hugging
  Face (`opencv/face_detection_yunet`, revision and SHA-256 pinned in that file) into the app's data folder
  (`models/opencv/face_detection_yunet/`). MIT, Copyright (c) 2020 Shiqi Yu (the `LICENSE` in that repository).

## Mac app

- [Sparkle](https://github.com/sparkle-project/Sparkle) (updates): MIT.
- WhisperKit (dictation's speech recognition), the `WhisperKit` library of
  [argmax-oss-swift](https://github.com/argmaxinc/argmax-oss-swift) 1.1.0, statically linked: MIT, Copyright (c) 2024
  argmax, inc. Its package also lists swift-argument-parser (Apache-2.0) for its command-line tools, which the app does
  not link.
- The Whisper speech models (OpenAI, MIT, https://github.com/openai/whisper), converted for Core ML by Argmax
  (https://huggingface.co/argmaxinc/whisperkit-coreml). Not in the app: dictation downloads the one chosen in
  Settings the first time someone dictates, into `~/Library/Application Support/Creator Toolset/dictation/models`.
- [FluidAudio](https://github.com/FluidInference/FluidAudio) 0.18.3 by FluidInference (dictation's Parakeet models
  on the Neural Engine), statically linked: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0). It links in,
  each listed in its `ThirdPartyLicenses/` folder:
  - fastcluster: BSD 2-clause. Until package version 1.1.23: © 2011 Daniel Müllner <https://danifold.net>; all
    changes from version 1.1.24 on: © Google Inc. All rights reserved. Redistribution and use in source and binary
    forms, with or without modification, are permitted provided that the following conditions are met:
    redistributions of source code must retain the above copyright notice, this list of conditions and the following
    disclaimer; redistributions in binary form must reproduce the above copyright notice, this list of conditions and
    the following disclaimer in the documentation and/or other materials provided with the distribution. THIS SOFTWARE
    IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING,
    BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
    IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
    EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
    LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
    SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
  - VBx (speaker clustering): Apache-2.0.
  - NemoTextProcessing, the prebuilt library of https://github.com/FluidInference/text-processing-rs: Apache-2.0,
    with NVIDIA NeMo Text Processing's grammars (Apache-2.0, Copyright (c) NVIDIA CORPORATION & AFFILIATES), rustfst
    and flate2 (MIT or Apache-2.0) and their MIT/Apache-2.0 crates.
- The Parakeet speech models: NVIDIA Parakeet TDT 0.6B v2 and v3 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2,
  https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/),
  converted for Core ML by FluidInference (https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml and
  `-v2-coreml`, CC-BY-4.0). Not in the app: dictation downloads the one chosen into
  `~/Library/Application Support/Creator Toolset/dictation/models/parakeet`.
- The server inside the app (`apps/mac/scripts/build-app.sh` puts it in `Contents/Resources/server`):
  - Node.js 22 for macOS arm64 (the official build from nodejs.org, version and SHA-256 in the script): MIT,
    with the licences of the libraries it includes in `NODE-LICENSE` next to it.
  - FFmpeg and ffprobe 7.1.1 for macOS arm64 (`apps/captions/scripts/install-ffmpeg-runtime-mac.sh`): the static
    build `1741000090_7.1.1` from https://ffmpeg.martin-riedl.de (URL and SHA-256 in the script), GPL because it
    enables GPL components (`ffmpeg -L`). Its source is FFmpeg's `n7.1.1` tag at https://github.com/FFmpeg/FFmpeg;
    the build's library versions are on that page (`versions.txt`). If you hand out an app you built, make that
    source available with it, as for the Docker image above.
  - `onnxruntime-node` (MIT) and `playwright-chromium` with `playwright-core` (Apache-2.0), and their npm
    dependencies; the fingerprint tools listed above.
  - The plug-in builder's packages, `esbuild`, `tailwindcss`, `tailwindcss-animate` and `postcss` (all MIT), with
    their npm dependencies, each with its licence file in `node_modules`.

## Dictation code in the Mac app

The dictation in `apps/mac/Sources/CreatorToolsetMac/Dictation/` (talk keys, microphone capture, transcription,
pasting at the cursor, the pill, History, Transcribe a file) is adapted from Parrot, an open-source macOS dictation
app by Humanitas Labs (https://github.com/humanitas-labs/parrot), published under this licence:

```
MIT License

Copyright (c) 2026 Humanitas Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
