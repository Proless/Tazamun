# 0010. Usernames for signing in, and a recovery key instead of the recovery kit

- Status: Accepted
- Date: 2026-11-26

## Context

Until now an account was a random 22-character account ID protected by a passphrase (ACC-1). Nobody can remember the ID, so the extension offered a **recovery kit** (server URL, account ID, pairing code; ACC-5) and a **pairing code** (`tazamun:<accountId>@<serverUrl>`; ACC-6) to carry it to the next browser. Using it daily showed two problems:

- **The recovery kit didn't recover anything.** It held no secret, so with a lost passphrase it was useless. Its name promised more than it did.
- **Signing in needed a document.** A second browser needed the kit or the pairing code from the first one, not something a person knows.

End-to-end encryption puts a hard limit on any fix: whoever can unlock the data must hold a key the server doesn't have. A "forgot password" email can't bring data back, because the server would need the key (rule 1, ADR-0002). Within that limit we considered:

1. A **recovery key**: a second random key, shown once, that opens a second copy of the account key.
2. A **username** instead of the account ID as what people type.
3. **Device-to-device pairing**: a signed-in browser hands the account key to a new one over an encrypted channel.
4. **Passkeys** with the WebAuthn PRF extension.
5. **Single sign-on** (OIDC) for authentication only.

## Decision

Build 1 and 2 now. Pairing (3) and passkeys (4) can follow later; SSO (5) is out, since it still needs a key from somewhere.

### Usernames (ACC-13)

- People sign in with **server + username + passphrase**. A username is 3–32 characters: lowercase ASCII letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. Clients normalize input (NFKC, trim, lowercase); the server accepts only the normalized form. ASCII only, so look-alike letters from other scripts can't imitate another user.
- Usernames are unique per server and **can be changed** (`PUT /v1/accounts/me/username`).
- The **account ID stays** the internal identifier: it is still random, still in the AAD of the wrapped account key and every record (SEC-2, SEC-3), and still the key of every table. A username is only a lookup handle, so renaming touches no encrypted data and format v1 is unchanged.
- **Prelogin takes the username** (`POST /v1/prelogin`, in the body so it stays out of proxy access logs) and returns the account ID, salt and KDF parameters. For an unknown username it returns a stable fake account ID and salt derived from the instance secret, so prelogin doesn't reveal which usernames exist (SEC-9). Sign-in (`POST /v1/sessions`) still takes the account ID.
- **Registration does reveal** that a username is taken (`409 USERNAME_TAKEN`); that's unavoidable for a unique name. It is rate-limited, and in `invite` mode only invite holders get that far. A taken username doesn't use up the invite.
- The username is **plaintext metadata** the operator can read, like device names (ADR-0009).

### Recovery key (ACC-5)

- At sign-up the client generates **160 random bits**, shown once as 32 Crockford base32 characters in 8 groups of 4 (`ABCD-EFGH-…`). Typing is forgiving: case, spaces and dashes don't matter, and I, L and O read as 1, 1 and 0.
- The key is uniformly random and long, so **HKDF-SHA256** derives from it (empty salt, like SEC-2): a recovery auth key (`info = "tazamun/v1/recovery/auth"`) and a recovery KEK (`info = "tazamun/v1/recovery/kek"`). No Argon2id: it would add nothing against 160 bits of entropy.
- The recovery KEK wraps the same account key with AES-256-GCM and AAD `tazamun/v1/recovery-account-key|<accountId>`. That AAD differs from the passphrase wrap's, so neither bundle can stand in for the other. The server stores SHA-256 of the recovery auth key and the wrapped key, exactly as it does for the passphrase (ACC-3). It never sees the recovery key or the recovery KEK.
- **Recovering** takes two requests, both with the recovery auth key, rate-limited per IP and per account: `POST /v1/recovery/key` returns the recovery-wrapped account key; the client unwraps it and sets a new passphrase with `POST /v1/recovery/passphrase`, which ends every session, as a passphrase change does (ACC-9). The device then signs in normally. The recovery key keeps working.
- A signed-in, unlocked device can **make a new recovery key** (`PUT /v1/recovery`, which needs the passphrase again); the old one stops working. Accounts from before this ADR start without one and are asked to make one.
- `test/vectors/tazamun-recovery-v1.json` pins the format, checked against an independent computation with `node:crypto`.

### Removed

- The **recovery kit** and the **pairing code**: the username replaces what they carried. The kit's printable document is replaced by one that holds the recovery key, the server and the username, and says to keep it as safe as the passphrase.
- `GET /v1/accounts/{id}/prelogin`.

## Consequences

- Signing in on a new browser needs only what a person knows: server, username, passphrase.
- Data is lost only when **both** the passphrase and the recovery key are lost (and no device is signed in). The recovery key is a second secret that opens the account with the username; whoever finds it can read the data. The UI and the document say so.
- The operator learns a chosen username per account. Someone can find out whether a username exists by trying to register it.
- Accounts created before migration 2 have no username and no recovery key. A signed-in browser sets both from the options page; until then the account can't be signed into from a new browser.
- Pairing (option 3) can be added later without changing anything here.
