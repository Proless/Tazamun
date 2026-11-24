# Tazamun

**One extension, one account, and one place for your browser data across Chrome, Edge and Firefox. End-to-end encrypted and self-hostable.**

Tazamun syncs **tabs, history, bookmarks and your extension list** between browsers from different vendors. It replaces a separate tab manager, history tool and bookmark syncer, each with its own account. Your data is encrypted on your devices; the server only ever stores ciphertext, and you can run that server yourself.

> **Status:** early development (phase P0, foundations). Nothing is usable yet. See the [roadmap](CLAUDE.md#roadmap).

## How it works

- A browser extension on each device publishes its data as small records and encrypts each record before it leaves the browser.
- A small server stores the encrypted records and hands out changes. It can't read or merge them.
- Each device downloads changes, decrypts them and merges them locally. A Hybrid Logical Clock decides which edit is newest.
- A web dashboard, served by the same server, decrypts your data in the browser so you can see everything in one place.

Details: [architecture](<docs/srs/2. Overall Description.md#22-architecture>), [sync model](<docs/srs/2. Overall Description.md#23-sync-model>), [security](<docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>).

## Repository

| Folder | What it is |
| ------ | ---------- |
| [packages/core](packages/core/README.md) | Shared library: schemas, crypto, HLC, merge functions |
| `packages/ui` | Shared Vue components (planned) |
| `apps/extension` | Browser extension for Chrome, Edge and Firefox (planned) |
| `apps/server` | Sync server and dashboard host (planned) |
| `apps/dashboard` | Web dashboard (planned) |
| `deploy/` | Docker image, Compose files, reverse-proxy examples (planned) |
| [docs](docs/README.md) | Requirements (SRS) and architecture decisions (ADRs) |

Each app and package has its own `README.md` explaining what it is and how to use it.

## Development

Requirements: Node 26 and pnpm 12 (`npm install -g pnpm`).

```sh
pnpm install
pnpm test        # all tests
pnpm lint
pnpm typecheck
```

Reference requirement IDs in commits and pull requests, e.g. `feat(tabs): send tab to device (TAB-7)`.

## License

[MIT](LICENSE)
