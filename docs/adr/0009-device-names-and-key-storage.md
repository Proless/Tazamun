# 0009. Device names in plaintext; the account key is remembered by default

- Status: Accepted. The mentions of send tab are superseded by [0011](0011-private-browsing-choice-and-no-send-tab.md), which removed it.
- Date: 2026-11-25

## Context

SRS 6.5 left two questions open for P1. Onboarding and the sync engine are now built, and both depend on the answers.

**Q2: should device names be encrypted?** A device name ("Firefox on Work laptop") is set at sign-in (ACC-7) and sent with `POST /v1/sessions`. The server stores it next to the browser family and version, and returns it from `GET /v1/devices`. The extension uses that list to name devices in *Tabs on other browsers* and *Send to*. The dashboard uses it to show devices for renaming and revoking (DSH-7).

- **Encrypted:** the server sees only ciphertext. But the dashboard couldn't list devices before the passphrase is entered. Renaming would need the account key. Every client would need a `devices` collection, or encrypted fields in the device API, plus a migration path. And the server still sees how many devices there are, their browser families and versions, and when each was last seen, which reveals most of what a name does.
- **Plaintext:** the server, and anyone with access to it, can read names the user chose. Users can pick neutral names. The SRS 5.2 threat model already lists device names among the metadata the server sees.

**Q3: should the account key be remembered on the device, or the passphrase asked for at every browser start (SEC-5)?** Remembering keeps the key in `storage.local`, protected by the OS user profile, like the browser's own saved data. Not remembering keeps it in `storage.session`, which the browser clears when it closes; the extension is then locked until the passphrase is entered, and syncs nothing meanwhile. Argon2id runs about a second at each unlock.

## Decision

1. **Q2: device names stay plaintext**, as built in P1: the `deviceName` field in `POST /v1/sessions` and `PUT /v1/devices/{id}`, stored by the server, returned by `GET /v1/devices`. There is no `devices` collection. The onboarding page says so next to the name field ("The server can see this name").
2. **Q3: the default is *remember on this device*.** The setting is per device (onboarding and the options page). With it off, the key lives in `storage.session` only. The passphrase, the KEK and the auth key are never stored in either case (SEC-5).

## Consequences

- The dashboard can list, rename and revoke devices right after sign-in, before or without decrypting anything, and the server's device API stays the single source for names and last-seen times.
- An operator or attacker with server access can read device names. The privacy policy (PRIV-5) and the self-hosting docs must say so. Users who care pick neutral names.
- Encrypting names later needs a new API field or a `devices` collection, plus a migration. The `deviceName` schema allows up to 256 characters, so ciphertext would fit; old clients would show it as gibberish until updated. This would need a new ADR.
- With the default, anyone who can use the OS profile can use synced data on that device. That is the same exposure as the browser's own history and tabs on that device. Shared computers should turn *remember* off, and the options page explains this.
- With *remember* off, a browser that starts and isn't unlocked doesn't sync, including incoming *Send tab* commands. The popup and the badge show *locked*.
