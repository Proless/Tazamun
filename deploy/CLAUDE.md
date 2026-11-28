# CLAUDE.md: deploy

Pitfalls for the container image, the Compose files, the reverse-proxy examples and the image pipeline (`.github/workflows/image.yml`). How to use them is in [README.md](README.md).

## Pitfalls

- **The image runs a bundle, not the TypeScript source.** `pnpm deploy` or a production install would copy `@tazamun/core` into `node_modules`, where Node refuses to strip types. `apps/server/build.ts` bundles everything into `dist/main.js` with esbuild instead.
- **The build stage runs on `$BUILDPLATFORM`.** Its output is plain JavaScript, so arm64 images build without emulation. Only the small runtime `RUN` (user, directories) runs under QEMU. Keep anything heavy out of the runtime stage.
- **The build context is an allow-list** in `deploy/docker/Dockerfile.dockerignore` (BuildKit reads `<Dockerfile>.dockerignore`). A new file the build needs must be added there.
- **`ENTRYPOINT` is `tazamun`.** `docker compose exec tazamun tazamun <cmd>` (exec ignores the entrypoint) but `docker compose run --rm tazamun <cmd>` (run uses it). Mixing them up gives `Unknown command "tazamun"`.
- **`restore` from `docker compose run`** runs in a new container with its own network namespace, so its "is the server running?" check can't see the real server. Always stop the server first.
- **Git Bash on Windows rewrites container paths** (`/data` → `C:/...`) in `docker` arguments. Set `MSYS_NO_PATHCONV=1`.
- **Native modules:** the server uses the built-in `node:sqlite` (Q1), so the image needs no native builds. Keep it that way. A native dependency must be built in the same base image family (glibc vs musl) and architecture as the runtime stage, or its binaries won't load.
- **arm64 under QEMU** is very slow, and native compiles can time out. The test job uses native arm64 runners; only the publish job still emulates arm64's small runtime stage. Cache dependency layers.
- **PID 1 and signals:** `CMD ["npm", "start"]` doesn't forward `SIGTERM` properly. Run `node` directly (or use a minimal init), or `docker stop` will kill the server without checkpointing the WAL.
- **Non-root plus bind mounts:** a host directory owned by root won't be writable by UID 10001. Document `chown 10001:10001`, prefer named volumes, and make the server fail with a clear message when `/data` isn't writable.
- **SQLite files:** the `-wal` and `-shm` files must stay next to the database on the same volume. Never put `/data` on NFS or SMB, and never run two containers on one `/data`. Corruption follows.
- **HEALTHCHECK without curl:** distroless or slim images don't include it. Use the built-in `tazamun healthcheck` subcommand.
- **Tags:** never move `latest` for a pre-release. Never re-push an existing `X.Y.Z` tag. Users pin to versions, and replacing one silently breaks trust and signatures.
- **GHCR visibility:** a newly created package on GHCR is private by default. Make it public once, and link it to the repository.
- **Docker Hub limits:** anonymous pulls are rate-limited. Default the docs to GHCR.
- **Pin third-party actions by commit SHA**, with the version in a comment (`uses: docker/build-push-action@<sha> # v7.4.0`). Tags can be moved; `trivy-action`'s were hijacked in 2026. Dependabot updates SHA pins. Pick releases at least two weeks old, as `minimumReleaseAge` does for npm.
- **The repository and `ghcr.io/proless/tazamun` are public** (since 2026-11-25). Making the repository public did **not** change the existing package: its visibility is set separately in the package settings, and until then an anonymous pull fails with `unauthorized`. `image.yml` uploads SARIF to code scanning only while the repository is public (`!github.event.repository.private`); keep that guard, since a private repository needs GitHub Advanced Security for it. The upload needs `security-events: write` on the `test` job. Without it, pull requests still pass but every push to `main` fails at "Upload to code scanning" ("Resource not accessible by integration"), and `publish` is skipped, so `edge` silently stops updating. That happened from 2026-11-25 until the job got the permission. A stale `docker login ghcr.io` also gives `unauthorized` for a public image: `docker logout ghcr.io`.
- **The smoke test** (`apps/server/test/smoke.ts`) runs on the runner, talks to the container over a random loopback port, and uses `@tazamun/core` like a real client (Argon2id included). Run it locally with `pnpm --filter @tazamun/server smoke <image>`.
- **The arm64 smoke test runs on a native arm64 runner** (`ubuntu-24.04-arm`). Under QEMU it was OOM-killed at random (exit 137, repeatedly in November 2026): the emulator's own memory counted against the container's 256 MB limit, so the limit didn't measure the server. Don't move it back to QEMU. If it fails, read the exit code, OOMKilled flag and stderr it prints. On a native runner, 137 with OOMKilled means the server really exceeded 256 MB (PERF-7).
- **Token scope:** don't give the workflow `write-all`. Use `packages: write`, `id-token: write` and `security-events: write` only on the jobs that need them, and keep the Docker Hub token out of PR workflows from forks.
- **Reverse proxies:** nginx's default `client_max_body_size` (1 MB) is below the API's 2 MB batch limit, and missing `X-Forwarded-Proto` breaks the public-URL check. Both belong in the proxy examples.
