# @tazamun/core

The shared library of Tazamun: everything that the extension, the dashboard and the server must agree on. It runs unchanged in Node and in browsers, and contains no browser-extension or server APIs.

| Module | Status | What it does |
| ------ | ------ | ------------ |
| `hlc` | Done | Hybrid Logical Clock: orders edits across devices (ENG-7, [ADR-0003](../../docs/adr/0003-sync-protocol-records-hlc.md)) |
| `schema` | Done for `tabs`, `commands`, `history`, `extensions` | Wire format of the HTTP API, and decrypted payload schemas per collection (zod) ([SRS 4.4](<../../docs/srs/4. External Interface Requirements.md#44-communications-interfaces>)). `bookmarks` follows in P4, `devices` after Q2. |
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

Schemas validate what comes off the wire and out of decryption:

```ts
import { schema } from '@tazamun/core';

// Server response (plaintext envelope only).
const page = schema.pullResponse.parse(await response.json());

// After decrypting one record's payload:
const result = schema.decodePayload(schema.COLLECTIONS.tabs, JSON.parse(plaintext));
switch (result.status) {
  case 'ok':
    if (!result.payload.deleted) render(result.payload.data.windows);
    break;
  case 'newer-version': // ENG-10: keep the record, don't apply it, ask the user to update
  case 'invalid': // result.issues has paths and codes only, never values
    break;
}

// Building a payload to encrypt and push:
const payload = schema.livePayload(schema.COLLECTIONS.tabs, hlc.serialize(clock), { windows });
const tombstone = schema.tombstonePayload(schema.COLLECTIONS.tabs, hlc.serialize(clock));
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
  schema/
    primitives.ts record ID, device ID, HLC stamp, timestamps, base64url
    envelope.ts   HTTP API wire format (records, pull, push, errors, limits)
    payload.ts    decrypted payload {v, deleted, hlc, data}, decodePayload, versioning
    collections/  one file per collection: tabs, commands, history, extensions
test/             shared fixtures and test vectors (crypto vectors go here)
```

Unit tests live next to the code as `*.test.ts`. Property-based tests use [fast-check](https://fast-check.dev).
