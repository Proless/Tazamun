/**
 * Schema migrations (ADM-4). Entry i takes the database from `user_version` i to i + 1.
 * Append only: never edit or reorder a migration that has been released, because existing
 * databases have already run it.
 *
 * Times are milliseconds since the epoch. Hashes are raw 32-byte BLOBs. Everything the server
 * stores about content is ciphertext (rule 1).
 */
export const MIGRATIONS: readonly string[] = [
  // 1: accounts, invites, devices, sessions, records.
  `
  CREATE TABLE accounts (
    id                  TEXT    PRIMARY KEY,
    salt                TEXT    NOT NULL,
    kdf_params          TEXT    NOT NULL,  -- JSON
    auth_hash           BLOB    NOT NULL,  -- SHA-256(authKey), SEC-4
    wrapped_account_key TEXT    NOT NULL,
    created_at          INTEGER NOT NULL,
    last_seen_at        INTEGER NOT NULL,
    storage_bytes       INTEGER NOT NULL DEFAULT 0,
    last_seq            INTEGER NOT NULL DEFAULT 0  -- ADR-0003: per-account counter
  ) STRICT;

  CREATE TABLE invites (
    id          TEXT    PRIMARY KEY,         -- short public ID for list and revoke
    token_hash  BLOB    NOT NULL UNIQUE,     -- SHA-256 of the token
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    used_at     INTEGER
  ) STRICT;

  CREATE TABLE devices (
    account_id      TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    id              TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    browser_family  TEXT    NOT NULL,
    browser_version TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  ) STRICT;

  CREATE TABLE sessions (
    token_hash   BLOB    PRIMARY KEY,        -- SHA-256 of the token, SEC-4
    account_id   TEXT    NOT NULL,
    device_id    TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    FOREIGN KEY (account_id, device_id) REFERENCES devices (account_id, id) ON DELETE CASCADE
  ) STRICT;
  -- One session per device (SRS 4.4.1).
  CREATE UNIQUE INDEX sessions_device ON sessions (account_id, device_id);

  CREATE TABLE records (
    account_id  TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    collection  TEXT    NOT NULL,
    id          TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    expires_at  INTEGER,
    payload     TEXT    NOT NULL,
    size        INTEGER NOT NULL,             -- bytes counted against the quota
    PRIMARY KEY (account_id, collection, id)
  ) STRICT;
  CREATE UNIQUE INDEX records_seq ON records (account_id, collection, seq);
  CREATE INDEX records_expiry ON records (expires_at) WHERE expires_at IS NOT NULL;
  `,
  // 2: usernames and the recovery key (ACC-5, ACC-13, ADR-0010). All three are NULL for accounts
  // created before; such an account sets them from a signed-in device.
  `
  ALTER TABLE accounts ADD COLUMN username TEXT;
  CREATE UNIQUE INDEX accounts_username ON accounts (username);
  ALTER TABLE accounts ADD COLUMN recovery_auth_hash BLOB;           -- SHA-256(recovery auth key)
  ALTER TABLE accounts ADD COLUMN recovery_wrapped_account_key TEXT;
  `,
];
