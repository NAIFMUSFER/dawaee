# syntax=docker/dockerfile:1
#
# One image, two entrypoints. The API and the worker share every line of
# domain logic, so building them separately would let the two drift — the
# escalation rules the worker enforces must be the exact ones the API tested.
# `APP` selects which process the container runs.

# Pinned to the exact linux/amd64 manifest resolved from node:22-bookworm-slim
# by the successful release CI build on 2026-09-06. The readable tag records
# the intended Node/Debian line; the digest is the supply-chain identity.
# Refresh the digest deliberately after a reviewed base-image update.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV NODE_ENV=production
WORKDIR /app
# `postgresql-client` is here for scripts/migrate.sh, which the deploy runs
# before the new version takes traffic.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
# `--ignore-scripts`: no dependency gets to run arbitrary code during the build.
#
# The whole tree has exactly two install-phase scripts — esbuild's `postinstall`,
# twice — and neither is needed: the binary arrives through the platform-specific
# optional dependency, and this build compiles with `tsc`, not esbuild. Verified
# by building and running the image both ways.
#
# `prepare` scripts do not enter into it. npm runs those only for git and local
# dependencies, and every entry in both lockfiles resolves from the registry, so
# the ~100 `prepare` scripts in the tree never execute either way.
RUN npm ci --include=dev --no-audit --no-fund --ignore-scripts

# --------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npx tsc -b packages/shared packages/core apps/api apps/worker

# ----------------------------------------------------------- web artefact
# Build the browser UI from the exact mobile source in this commit. Previously
# the image copied the last committed apps/api/public bundle, so a reviewed UI
# fix could deploy while Safari kept serving older JavaScript indefinitely.
FROM deps AS web
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY packages packages
COPY apps/mobile apps/mobile
COPY scripts scripts
RUN cd apps/mobile \
 && npm ci --include=dev --legacy-peer-deps --no-audit --no-fund --ignore-scripts \
 && cd /app \
 && API_URL="" bash ./scripts/build-web.sh

# -------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
# Never run the process as root.
RUN groupadd --system --gid 1001 dawaee && useradd --system --uid 1001 --gid dawaee dawaee

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
# Only the compiled output and the manifests that point at it. Copying the whole
# `packages` directory also shipped each package's `src`, its `test` suite and a
# tsconfig.tsbuildinfo — none of which any runtime path reads. `.dockerignore`
# cannot help here: this is a stage-to-stage copy, not a context transfer.
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
# The web build, served from this same origin. It is generated in the `web`
# stage above from this exact commit rather than copied from a stale artefact.
COPY --from=web /app/apps/api/public ./apps/api/public

# Development dependencies are not shipped. npm is needed only to perform this
# prune during image construction; neither runtime entrypoint nor migrate.sh uses
# npm afterwards (they execute node and psql directly). Remove npm/npx from the
# final artefact as well: shipping an unused package manager is unnecessary
# attack surface, and in Node 22.23.2 it carried a fixable CRITICAL tar advisory
# (CVE-2026-59873) inside npm's own dependency tree.
RUN npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Build identity, so a running service can say which commit it is.
#
# Passed at build time and frozen into the image; never read from the running
# environment, which is what makes it describe the ARTEFACT rather than
# whatever the platform happens to have configured. Placed here, after every
# COPY and the prune, so changing a commit SHA invalidates nothing above it and
# the layer cache still works.
#
# Defaults are literally `unknown`. A build that forgets to pass them produces
# an image that says so, rather than one that reports a stale or invented SHA —
# and the whole point of the endpoint is being able to trust the answer.
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

# `exec`, and it is load-bearing.
#
# Without it this was `sh -c "node …"`, which left `sh` as PID 1 with node as a
# child. A container stop sends SIGTERM to PID 1 only, and dash does not forward
# it, so node never saw the signal: measured, `docker stop -t 30` waited the full
# 30 seconds and then SIGKILLed, exit 137, with no shutdown line in the log.
#
# Both processes register SIGTERM handlers that matter. The API drains in-flight
# requests before closing the pool — a patient's "Taken" confirmation must not be
# lost to a deploy. The worker waits for the current tick to finish so a delivery
# is not abandoned mid-flight. Neither ran; every deploy was a hard kill.
#
# `exec` replaces the shell with node, so node IS PID 1 and receives the signal
# directly. The shell is still needed for one thing only — expanding ${APP} to
# choose which of the two entrypoints this container runs.
CMD ["sh", "-c", "exec node apps/${APP}/dist/index.js"]
