# syntax=docker/dockerfile:1
#
# The Creator Toolset server (apps/captions) built from the pnpm workspace.
# The build context is the repository root, so this file is run through
# apps/captions/docker-compose.yml, which sets the context to ../..
#
#   cd apps/captions && docker compose up -d --build

# ---------- build stage ----------
FROM node:22-bookworm-slim AS build
# the pnpm version the root package.json pins
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
# Chromium for the export renderer is installed here and copied to the runtime stage
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /repo

# The manifests first, so the install layer stays cached while the source changes.
# apps/mac has no dependencies, but pnpm needs its manifest to see the whole workspace.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY apps/captions/package.json apps/captions/
COPY apps/mac/package.json apps/mac/
RUN pnpm install --frozen-lockfile

COPY apps/captions apps/captions
RUN pnpm --filter @creator-toolset/captions run build \
  && pnpm --filter @creator-toolset/captions exec playwright install chromium-headless-shell \
  && pnpm --filter @creator-toolset/captions deploy --prod /deploy

# ---------- runtime stage ----------
FROM node:22-bookworm-slim
WORKDIR /app

# The Debian FFmpeg package is too old for reliable ProRes alpha signalling. The checksum-pinned
# FFmpeg 7 build goes to /app/runtime/ffmpeg, which the app finds without any setting.
COPY apps/captions/scripts/install-ffmpeg-runtime.sh /tmp/install-ffmpeg-runtime.sh
# zip: packaging PNG sequences
# fonts: fallback system fonts for libass (the app's own fonts ship in dist/public/fonts)
# libnss/libatk/libgbm & co: the Chromium shared libraries the export renderer loads
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils zip fontconfig fonts-dejavu-core \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  && rm -rf /var/lib/apt/lists/* \
  && /tmp/install-ffmpeg-runtime.sh /app/runtime \
  && rm -f /tmp/install-ffmpeg-runtime.sh

COPY --from=build /deploy/package.json ./package.json
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/apps/captions/dist ./dist
COPY --from=build /ms-playwright /ms-playwright
# `docker compose exec app node scripts/doctor.mjs` checks the running install
COPY apps/captions/scripts/doctor.mjs ./scripts/doctor.mjs

ENV NODE_ENV=production
ENV PORT=3000
# project data, accounts, exports: mount a volume here
ENV DATA_DIR=/data
# fontconfig/libass cache must land somewhere writable when the root fs is read-only
ENV XDG_CACHE_HOME=/tmp/.cache
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /data && chown node:node /data
# unprivileged: a compromised process can't apt-install or write outside /data and /tmp
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/boot.js"]
