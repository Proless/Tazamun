# 0002. End-to-end encryption with a server that only stores ciphertext

- Status: Accepted
- Date: 2026-11-24

## Context

Revision 1 of the SRS promised privacy, data ownership and encryption at rest, and also had the **server** detect and resolve conflicts. Those requirements contradict each other: to merge, the server must read the data, so encryption at rest would protect only against someone stealing the disk, not against the operator. Browsing history is among the most sensitive data a person has, and many users will run on an instance someone else operates.

## Decision

- All payloads are encrypted on the client (extension or dashboard page) with keys derived from the user's passphrase. The server never sees plaintext, the passphrase, or usable keys.
- The server is a **simple record store**: accounts, device sessions, encrypted records with sequence numbers, expiry, quotas. It contains no merge or business logic about the data.
- Conflict resolution moves to the clients ([ADR-0003](0003-sync-protocol-records-hlc.md)).
- Key hierarchy: passphrase → Argon2id → (`authKey`, `KEK`); a random account key wrapped by the KEK; per-collection keys derived by HKDF. Parameters are in SRS [section 5.2](<../5. Other Nonfunctional Requirements.md#52-security-requirements>).

## Consequences

- **Good:** operators can't read user data; the server is small, cheap and easy to audit; the privacy claim is true.
- **Cost:** a lost passphrase means lost data, which must be communicated clearly. Server-side search or analytics are impossible, so the dashboard decrypts and indexes everything in the browser. A malicious operator can still serve a backdoored dashboard (documented limitation).
- **Rule for contributors:** a feature that needs the server to read plaintext must be redesigned or rejected.
