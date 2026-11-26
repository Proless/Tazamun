# deploy

Everything needed to run the Tazamun server as a container ([ADR-0007](../docs/adr/0007-container-distribution.md), [SRS 3.11](<../docs/srs/3. Software Features.md#311-self-hosting-containers-and-image-publishing>)). To run a server, follow the [self-hosting guide](../docs/guides/self-hosting.md).

| Path | What it is |
| ---- | ---------- |
| [docker/Dockerfile](docker/Dockerfile) | The image `ghcr.io/proless/tazamun`: a multi-stage build whose runtime stage holds only Node and the bundled server |
| [docker/Dockerfile.dockerignore](docker/Dockerfile.dockerignore) | Build context allow-list (BuildKit reads it next to the Dockerfile) |
| [compose/docker-compose.caddy.yml](compose/docker-compose.caddy.yml) | Tazamun plus Caddy with automatic HTTPS; the Caddyfile is inline |
| [compose/docker-compose.yml](compose/docker-compose.yml) | Tazamun alone on `127.0.0.1:8080`, for an existing reverse proxy |
| [compose/.env.example](compose/.env.example) | Settings for both Compose files |
| [proxy/](proxy/) | Reverse-proxy examples: Caddy, nginx, Traefik labels |

## Building the image locally

Images are published only by CI (DEP-28). For testing, build from the repository root:

```sh
docker build -f deploy/docker/Dockerfile -t tazamun:test .
TAZAMUN_DOMAIN=localhost TAZAMUN_IMAGE=tazamun:test \
  docker compose -f deploy/compose/docker-compose.caddy.yml up -d
curl -k https://localhost/v1/health
```

With `localhost`, Caddy uses its own local certificate authority, hence `-k`. On Windows with Git Bash, set `MSYS_NO_PATHCONV=1` first, or container paths such as `/data` get rewritten into Windows paths.

## The image

- **Build stage:** installs the workspace with pnpm and bundles the server with esbuild (`pnpm --filter @tazamun/server build`) into `dist/main.js`, plus `THIRD-PARTY-LICENSES.txt`. It runs on the build machine's platform (`--platform=$BUILDPLATFORM`), because its output is plain JavaScript; a multi-arch build compiles nothing under emulation.
- **Runtime stage:** `node:26-alpine`, pinned by digest, with `apk upgrade` (Alpine ships security fixes before the Node image is rebuilt) and npm removed. It holds `/app/main.js`, linked as `/usr/local/bin/tazamun`, plus the license files.
- **Runs as** UID/GID 10001 with a read-only root filesystem. `/data` is the only volume. Port 8080.
- **`ENTRYPOINT ["tazamun"]`, `CMD ["serve"]`:** `docker run <image> invite list` runs an admin command. Node is PID 1 and handles SIGTERM itself (DEP-7).
- **`HEALTHCHECK`** runs `tazamun healthcheck`; there's no curl in the image.
- **OCI labels** take `VERSION`, `REVISION` and `CREATED` from build arguments, which CI sets.

## CI pipeline

[`.github/workflows/image.yml`](../.github/workflows/image.yml) runs on every pull request and every push to `main`:

1. Builds the image for **amd64** and for **arm64**, each on a native runner of its own architecture (`ubuntu-latest`, `ubuntu-24.04-arm`), and loads it into that runner's Docker. Publishing builds both on one amd64 runner, with QEMU for arm64's small runtime stage.
2. Runs the **smoke test** on both (DEP-29): [`apps/server/test/smoke.ts`](../apps/server/test/smoke.ts) starts the container with a fresh volume and the Compose hardening, waits for `healthy`, creates an invite with the CLI, signs up and signs in two devices with real client crypto, pushes, pulls and decrypts, revokes a device, stops with SIGTERM (must exit 0), restarts, and checks the data is still there.
3. **Scans** the amd64 image with Grype (DEP-34). The job summary shows the findings by severity; fixable Critical findings are warnings. The release workflow (P6) will fail on them. SARIF goes to code scanning once the repository is public.
4. On `main` only: builds both architectures and **publishes** `ghcr.io/proless/tazamun:edge` and `:sha-<7 chars>` (DEP-30), with version `<server version>-edge.<sha>`. That job alone has `packages: write` (DEP-38). It then starts the published image on both architectures.

Run the smoke test locally against any image:

```sh
docker build -f deploy/docker/Dockerfile -t tazamun:test .
pnpm --filter @tazamun/server smoke tazamun:test
```
