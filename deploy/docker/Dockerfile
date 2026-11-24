# syntax=docker/dockerfile:1
#
# Tazamun server image (DEP-1…11, ADR-0007). Build from the repository root:
#
#   docker build -f deploy/docker/Dockerfile -t tazamun .
#
# Images are published only by CI (DEP-28). Build locally for testing only.

# Pinned by digest (DEP-37); Dependabot proposes updates. Keep both stages on the same image.
ARG NODE_IMAGE=node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# ---- Build ---------------------------------------------------------------------------------
# Runs on the build machine's own platform: the output is plain JavaScript, so a multi-arch
# build never compiles anything under QEMU emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
# The pnpm version comes from packageManager in package.json (Node 25+ has no corepack).
RUN npm install --global --no-fund --no-audit --loglevel=error \
      "$(node -p 'require("./package.json").packageManager')"
RUN --mount=type=cache,id=tazamun-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter "@tazamun/server..."

COPY tsconfig.base.json ./
COPY packages/core/src packages/core/src
COPY apps/server/build.ts apps/server/
COPY apps/server/src apps/server/src
RUN pnpm --filter @tazamun/server build

# ---- Runtime -------------------------------------------------------------------------------
# Only Node and one bundled file (DEP-2): no package manager, no node_modules, no source.
FROM ${NODE_IMAGE} AS runtime

# npm and npx aren't needed at run time and are a common source of scanner findings.
# UID/GID 10001 is fixed and documented (DEP-3); /data is the only writable path (DEP-4).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/docker-entrypoint.sh \
 && addgroup -S -g 10001 tazamun \
 && adduser -S -D -H -u 10001 -G tazamun -s /sbin/nologin tazamun \
 && mkdir -p /data /app \
 && chown 10001:10001 /data

COPY --from=build --chmod=0755 /src/apps/server/dist/main.js /app/main.js
COPY --from=build /src/apps/server/dist/THIRD-PARTY-LICENSES.txt /app/
COPY LICENSE /app/
# The bundle starts with `#!/usr/bin/env node`, so `tazamun` runs node directly and node is
# PID 1, receiving SIGTERM itself (DEP-7).
RUN ln -s /app/main.js /usr/local/bin/tazamun

ENV NODE_ENV=production
WORKDIR /app
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080

# DEP-6: no curl in the image; the CLI checks /v1/health itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["tazamun", "healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["tazamun"]
CMD ["serve"]

# DEP-10. CI passes the real values.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="Tazamun" \
      org.opencontainers.image.description="Self-hosted, end-to-end encrypted sync server for tabs, history, bookmarks and extensions across Chrome, Edge and Firefox." \
      org.opencontainers.image.source="https://github.com/Proless/Tazamun" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
