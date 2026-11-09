# syntax=docker/dockerfile:1
#
# The Connect broker (apps/relay). No dependencies: the image runs the TypeScript source with Node's own type
# stripping, so there is no build step. Build from the repository root:
#
#   docker build -f apps/relay/Dockerfile -t creatortoolset-relay .
#
# Secrets come from the environment at run time (see .env.example). Nothing here reads a .env file.

FROM node:22-bookworm-slim
WORKDIR /app
COPY apps/relay/package.json apps/relay/
COPY apps/relay/src apps/relay/src
ENV NODE_ENV=production RELAY_DATA_DIR=/data PORT=44610 RELAY_LISTEN_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 44610
USER node
WORKDIR /app/apps/relay
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/main.ts"]
