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

Template for new ADRs:

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```
