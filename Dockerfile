# syntax=docker/dockerfile:1
#
# One image, two entrypoints. The API and the worker share every line of
# domain logic, so building them separately would let the two drift — the
# escalation rules the worker enforces must be the exact ones the API tested.
# `APP` selects which process the container runs.

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
RUN npm ci --include=dev --no-audit --no-fund

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
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY db ./db
COPY scripts ./scripts

# Development dependencies are not shipped.
RUN npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

USER dawaee
ENV APP=api
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node apps/${APP}/dist/index.js"]
