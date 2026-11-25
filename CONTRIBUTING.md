# Contributing to Tazamun

Thanks for helping. Tazamun is an end-to-end encrypted, self-hostable sync for tabs, history, bookmarks and extensions across Chrome, Edge and Firefox. This page covers how to set up, the rules every change must follow, and how to get a pull request merged.

## Before you start

- Read the [README](README.md) for the big picture, then the parts of the [requirements (SRS)](docs/srs/) and the [architecture decisions (ADRs)](docs/adr/README.md) that touch your change. Requirements say **what**; ADRs say **why**.
- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Each app and package has its own `README.md` (what it is, how to use it) and `CLAUDE.md` (rules and pitfalls for that folder). Read both before working in a folder.

## Setup

You need **Node 26** and **pnpm 12**. Node 25 and later no longer include corepack, so install pnpm yourself:

```sh
npm install -g pnpm
pnpm install
pnpm --filter @tazamun/core exec playwright install chromium firefox   # once, for browser tests
```

| Command | What it does |
| ------- | ------------ |
| `pnpm test` | All tests in Node |
| `pnpm test:browser` | The same tests in Chromium and Firefox |
| `pnpm lint` | ESLint (type-aware) |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm format` | Format with Prettier (`pnpm format:check` only checks) |
| `pnpm licenses:check` | Check dependency licenses |
| `pnpm --filter @tazamun/server dev` | Run the server locally ([apps/server/README.md](apps/server/README.md)) |
| `pnpm --filter @tazamun/server tazamun <command>` | Run an admin command, such as `invite create` |
| `pnpm --filter @tazamun/extension dev` | Run the extension in Chrome with live reload (`dev:firefox` for Firefox) |
| `pnpm --filter @tazamun/extension build` then `test:e2e` | End-to-end tests: Chromium and the installed Firefox against the real server |

CI runs all of these except the server and extension `dev` commands on every pull request; it also builds the extension for all three browsers, runs `web-ext lint`, and runs the end-to-end tests in Chromium and Firefox.

## Rules every change must follow

These come from the design and never change. A pull request that breaks one won't be merged.

1. **The server never sees plaintext.** No feature may need it, not even for search, the dashboard or debugging ([ADR-0002](docs/adr/0002-end-to-end-encryption-dumb-server.md)).
2. **The sync engine contains no code for a specific data type.** Data types are modules ([ADR-0001](docs/adr/0001-one-product-module-architecture.md)).
3. **Merge functions are pure,** live in `packages/core`, and are tested in Node.
4. **Browser events are never the source of truth.** They trigger a diff against the local mirror.
5. **Never log plaintext:** no URLs, titles, keys, tokens, passphrases or history record IDs, on the client or on the server.
6. **Never destroy user data without a recoverable copy** (snapshots, tombstones, the deletion guard).
7. **Never capture private or incognito browsing.**
8. **Hard-to-reverse decisions get an ADR.**

Also:

- Test on **Firefox** as well as Chromium. Firefox regressions slip through most easily.
- Don't add your own crypto. Use the functions in `packages/core/src/crypto`.
- Keep dependencies few. Production dependencies must have a permissive license (see [scripts/README.md](scripts/README.md)).

## Commits and pull requests

- Branch from `main` and open a pull request. Nobody pushes to `main` directly.
- Use [Conventional Commits](https://www.conventionalcommits.org) and reference requirement IDs:

  ```text
  feat(tabs): send tab to device (TAB-7)
  fix(core): reject payloads with a newer schema version (ENG-10)
  docs(srs): clarify tombstone expiry (HIS-8)
  ```

- Keep pull requests small and focused. One feature or fix each.

Before asking for review, check that:

- [ ] `pnpm test`, `pnpm test:browser`, `pnpm lint` and `pnpm typecheck` pass.
- [ ] New logic has tests. Merge functions, schemas and crypto get property-based tests ([fast-check](https://fast-check.dev)), not only examples.
- [ ] The folder's `README.md` and `CLAUDE.md` are updated if you changed what the code does or found a pitfall.
- [ ] If the code and the SRS now disagree, the SRS is updated in the same pull request, with the reason in the description.
- [ ] If the change contradicts an ADR, a new ADR supersedes it. Old ADRs are never rewritten.
- [ ] Nothing new is logged that could contain user data.

## Changing stored formats

Serialized HLCs, payload schemas, crypto parameters and URL normalization end up in users' encrypted data. Changing one breaks existing records. If a test in `packages/core/test/vectors/` or a schema test fails after your change, you changed a stored format: revert it, or plan a version bump and a migration and describe it in an ADR.

## Reporting a security problem

Please **don't open a public issue** for a vulnerability. Report it privately through GitHub's private vulnerability reporting: **Security** tab → **Report a vulnerability**. Include what you found and how to reproduce it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
