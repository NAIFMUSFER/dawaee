# syntax=docker/dockerfile:1
#
# One image, two entrypoints. The API and the worker share every line of
# domain logic, so building them separately would let the two drift — the
# escalation rules the worker enforces must be the exact ones the API tested.
# `APP` selects which process the container runs.

# NOT PINNED BY DIGEST — a known gap, deliberately left as a tag rather than
# guessed at. `node:22-bookworm-slim` is mutable: it moves with every Node 22
# patch and every Debian security rebuild, so two builds of this same commit can
# sit on different base images. For a reproducible deploy this wants to be
# `node:22-bookworm-slim@sha256:<digest>`, refreshed deliberately.
#
# The digest is not written here because it could not be resolved in the
# environment this was audited from — every container registry is blocked by
# egress policy — and inventing one would be worse than leaving the tag. Pin it
# from a machine that can reach the registry:
#   docker pull node:22-bookworm-slim
#   docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim
FROM node:22-bookworm-slim AS base
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
# The web build, served from this same origin. A browser build hosted anywhere
# else cannot call this API: static hosts forbid cross-origin fetch outright,
# so the request never leaves the page and CORS cannot rescue it.
COPY apps/api/public ./apps/api/public

# Development dependencies are not shipped.
RUN npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

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
