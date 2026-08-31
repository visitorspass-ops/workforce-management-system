# Build context MUST be the repo root (not worker/), so this can copy
# ingest-core/ alongside worker/ — the worker imports the shared pipeline
# from ../ingest-core/run.ts, it isn't duplicated in here.
#
# Example build command from the repo root:
#   docker build -f worker/Dockerfile -t wfm-worker .
#
# Most hosts that build from a Dockerfile (Railway, Fly, Render) let you
# set the Dockerfile path AND keep the build context at the repo root —
# that's the setting to use. See worker/README.md for host-specific notes.
FROM node:20-slim

# duckdb's native binding needs build tools to compile if a prebuilt binary
# isn't available for the host's platform/arch.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm install --omit=dev

COPY ingest-core ./ingest-core
COPY worker/server.ts ./server.ts

ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "server.ts"]
