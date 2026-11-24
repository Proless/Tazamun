# @tazamun/core

The shared library of Tazamun: everything that the extension, the dashboard and the server must agree on. It runs unchanged in Node and in browsers, and contains no browser-extension or server APIs.

| Module | Status | What it does |
| ------ | ------ | ------------ |
| `hlc` | Done | Hybrid Logical Clock: orders edits across devices (ENG-7, [ADR-0003](../../docs/adr/0003-sync-protocol-records-hlc.md)) |
| `schema` | P0 | Record envelope and per-collection payload schemas (zod) ([SRS 4.4](<../../docs/srs/4. External Interface Requirements.md#44-communications-interfaces>)) |
| `crypto` | P0 | Argon2id, HKDF, AES-GCM key wrapping and payload encryption ([SRS 5.2](<../../docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>)) |
| merge functions | P1+ | One pure merge function per data type |
| API client | P1 | Typed client for the HTTP API |

## Usage

Other workspace packages depend on it with `"@tazamun/core": "workspace:*"` and import modules by namespace:

```ts
import { hlc } from '@tazamun/core';

// A new device starts at zero. Persist the clock after every change.
let clock = hlc.createHlc(deviceId);

// Local edit: stamp the changed field.
clock = hlc.tick(clock, Date.now());
const stamp = hlc.serialize(clock); // "001795000000000:00000000:<deviceId>"

// After applying a remote change, move the clock past it.
try {
  clock = hlc.receive(clock, hlc.parse(remoteStamp), Date.now());
} catch (error) {
  if (!(error instanceof hlc.HlcDriftError)) throw error;
  // The remote clock is far in the future: keep our clock, warn the user.
}

// Last writer wins: the larger stamp wins.
const winner = hlc.compare(a, b) >= 0 ? a : b;
```

The package exports its TypeScript source directly (`"exports": "./src/index.ts"`); there is no build step.

## Scripts

Run from the repository root:

| Command | What it does |
| ------- | ------------ |
| `pnpm --filter @tazamun/core typecheck` | Type-check this package |
| `pnpm test --project core` | Run this package's tests |
| `pnpm test:watch --project core` | Tests in watch mode |

## Layout

```text
src/
  index.ts        public API: re-exports each module as a namespace
  hlc/            hlc.ts, hlc.test.ts, index.ts
test/             shared fixtures and test vectors (crypto vectors go here)
```

Unit tests live next to the code as `*.test.ts`. Property-based tests use [fast-check](https://fast-check.dev).
