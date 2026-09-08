# syntax=docker/dockerfile:1
# One image, two entrypoints. APP selects API or worker.

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci --include=dev --no-audit --no-fund --ignore-scripts

# --------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npx tsc -b packages/shared packages/core apps/api apps/worker

# ------------------------------------------------------------ web build
# The web UI is source code, not a hand-maintained binary artefact. Building it
# inside the production image guarantees that a GitHub-only mobile/UI change is
# what Render serves; previously Docker copied the last committed public bundle,
# so source fixes could deploy successfully while Safari kept running old UI.
FROM deps AS web
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY packages packages
COPY apps/mobile apps/mobile
COPY scripts scripts
# Mobile has its own lockfile. Root dependencies remain available for the
# monorepo-aware Metro resolver while package-local Expo dependencies live here.
RUN cd apps/mobile \
 && npm ci --legacy-peer-deps --no-audit --no-fund --ignore-scripts \
 && cd /app \
 && API_URL="" ./scripts/build-web.sh

# -------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 dawaee && useradd --system --uid 1001 --gid dawaee dawaee

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY db ./db
COPY scripts ./scripts
# Always copy the web bundle produced from this exact commit.
COPY --from=web /app/apps/api/public ./apps/api/public

RUN npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

ARG GIT_COMMIT=unknown
ARG APP_VERSION=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=$GIT_COMMIT APP_VERSION=$APP_VERSION BUILD_TIME=$BUILD_TIME
LABEL org.opencontainers.image.revision=$GIT_COMMIT \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.created=$BUILD_TIME \
      org.opencontainers.image.source="https://github.com/NAIFMUSFER/dawaee"

USER dawaee
ENV APP=api
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "exec node apps/${APP}/dist/index.js"]
