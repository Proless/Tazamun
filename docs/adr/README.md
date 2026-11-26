# Architecture Decision Records

Each ADR records one decision that is hard to reverse: the context, the decision, and its consequences. To change a decision, add a new ADR that supersedes the old one. Don't rewrite history.

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](0001-one-product-module-architecture.md) | One product: a generic engine with pluggable data-type modules | Accepted |
| [0002](0002-end-to-end-encryption-dumb-server.md) | End-to-end encryption with a server that only stores ciphertext | Accepted |
| [0003](0003-sync-protocol-records-hlc.md) | Sync protocol: encrypted records, server sequence numbers, merging on the client | Accepted |
| [0004](0004-typescript-monorepo-stack.md) | TypeScript monorepo; supersedes the .NET/MySQL stack | Accepted |
| [0005](0005-history-stored-in-extension.md) | Synced history lives in Tazamun, not in native browser history | Accepted |
| [0006](0006-bookmark-safety.md) | Bookmark safety: diff against a mirror, snapshots, mass-deletion guard | Accepted |
| [0007](0007-container-distribution.md) | One container image, built and published only by CI | Accepted |
| [0008](0008-crypto-implementation.md) | Crypto implementation: Web Crypto plus hash-wasm, and the details SEC-1…3 leave open | Accepted |
| [0009](0009-device-names-and-key-storage.md) | Device names in plaintext; the account key is remembered by default (Q2, Q3) | Accepted; send-tab mentions superseded by 0011 |
| [0010](0010-usernames-and-recovery-key.md) | Usernames for signing in, and a recovery key instead of the recovery kit | Accepted |
| [0011](0011-private-browsing-choice-and-no-send-tab.md) | Private browsing is the user's choice; send tab is removed | Accepted |
| [0012](0012-firefox-for-android-in-1-0.md) | Firefox for Android is a 1.0 target, as a partial device | Proposed |

Template for new ADRs:

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```
