# Tazamun

**One extension, one account, and one place for your browser data across Chrome, Edge and Firefox. End-to-end encrypted and self-hostable.**

Tazamun syncs **tabs, history, bookmarks and your extension list** between browsers from different vendors. It replaces a separate tab manager, history tool and bookmark syncer, each with its own account. Your data is encrypted on your devices; the server only ever stores ciphertext, and you can run that server yourself.

> **Status:** early development. P0 (foundations) is done: the shared core library with the clock, record schemas and encryption is built and tested. P1 (server, sync engine, accounts and tabs) is in progress: the server API is built; the extension is not yet. Nothing is usable yet. See the [roadmap](CLAUDE.md#roadmap).

## How it works

- A browser extension on each device publishes its data as small records and encrypts each record before it leaves the browser.
- A small server stores the encrypted records and hands out changes. It can't read or merge them.
- Each device downloads changes, decrypts them and merges them locally. A Hybrid Logical Clock decides which edit is newest.
- A web dashboard, served by the same server, decrypts your data in the browser so you can see everything in one place.

Details: [architecture](<docs/srs/2. Overall Description.md#22-architecture>), [sync model](<docs/srs/2. Overall Description.md#23-sync-model>), [security](<docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>).

## Repository

| Folder | What it is |
| ------ | ---------- |
| [packages/core](packages/core/README.md) | Shared library: Hybrid Logical Clock, record schemas, encryption. Merge functions and the API client follow in P1. |
| `packages/ui` | Shared Vue components (planned) |
| [apps/extension](apps/extension/README.md) | Browser extension for Chrome, Edge and Firefox, built with WXT and Vue (scaffold; onboarding and sync are next) |
| [apps/server](apps/server/README.md) | Sync server: HTTP API, accounts, encrypted record storage. Built on Hono and `node:sqlite`. Serves the dashboard from P3. |
| `apps/dashboard` | Web dashboard (planned, P3) |
| [deploy](deploy/README.md) | Docker image, Compose files, reverse-proxy examples. To run a server: [self-hosting guide](docs/guides/self-hosting.md). |
| [docs](docs/README.md) | Requirements (SRS) and architecture decisions (ADRs) |
| [scripts](scripts/README.md) | Repository maintenance scripts (license check) |

Each app and package has its own `README.md` (what it is, how to use it) and `CLAUDE.md` (rules and pitfalls for working in it).

## Development

Requirements: Node 26 and pnpm 12 (`npm install -g pnpm`).

```sh
pnpm install
pnpm test            # all tests in Node
pnpm test:browser    # the same tests in Chromium and Firefox
pnpm lint
pnpm typecheck
pnpm licenses:check
```

Before the first browser run, install the browsers once: `pnpm --filter @tazamun/core exec playwright install chromium firefox`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the rules every change must follow, and how pull requests are reviewed.

## License

[MIT](LICENSE)
