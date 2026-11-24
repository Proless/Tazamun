# 0007. One container image, built and published only by CI

- Status: Accepted
- Date: 2026-11-24

## Context

Tazamun has no official hosted service, so every user depends on someone self-hosting a server. If self-hosting is hard, nobody uses the product. Self-hosters expect a single image, a Compose file, sensible defaults, multi-arch support (many run Raspberry Pis or ARM VPSs), and a trustworthy supply chain: an image they can verify was built from this repository.

## Decision

- **One image**, `ghcr.io/proless/tazamun`, containing the server and the dashboard. SQLite is embedded; there are no companion containers. A Caddy Compose variant is offered for automatic HTTPS but isn't required.
- **State only in `/data`.** The container runs as a non-root user, works with a read-only root filesystem, and is safe to destroy and recreate.
- **Exactly one instance per `/data`, on local storage** (SQLite constraint). Horizontal scaling is a non-goal for 1.0. One small instance serves dozens of accounts (PERF-7).
- **CI is the only publisher.** Pull requests build and smoke-test the image. `main` publishes `edge`. SemVer tags publish `X.Y.Z`, `X.Y`, `X` and `latest`. Releases are scanned, signed with keyless cosign, and carry an SBOM and provenance attestations. Base images are pinned by digest and updated by bot PRs.
- GHCR is the primary registry. Docker Hub is a mirror for releases.

Requirements: SRS [section 3.11](<../srs/3. Software Features.md#311-self-hosting-containers-and-image-publishing>) (DEP-1…39).

## Consequences

- Getting started is `docker compose up -d` plus one environment variable.
- The supply chain can be verified (`cosign verify`, attestations), which matters for a privacy product even with end-to-end encryption, because the server serves the dashboard's JavaScript.
- SQLite limits deployments to one instance. If multi-instance hosting is ever needed, the storage layer must be swapped (e.g. for Postgres) behind the same API. That would need a new ADR.
- Native modules would have to build for both architectures. Q1 chose the built-in `node:sqlite`, so the server has none ([ADR-0004](0004-typescript-monorepo-stack.md)). Keep it that way: a new native dependency needs a good reason.
- Maintaining two registries and signing adds CI complexity. All of it lives in one release workflow.
