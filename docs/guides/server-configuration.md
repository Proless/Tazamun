# Server configuration

<!-- Generated from apps/server/src/config.ts by `pnpm --filter @tazamun/server config:docs`. Do not edit by hand. -->

The server reads its configuration from environment variables and, optionally, a JSON file (ADM-1, DEP-12). It checks every value at startup and refuses to start, naming the setting, if one is missing or invalid (DEP-13).

## Where settings come from

Each setting is taken from the first of these that sets it:

1. Its environment variable, or for secrets its `_FILE` variant, which reads the value from that file (for Docker and Kubernetes secrets). Set only one of the two.
2. The JSON config file named by `TAZAMUN_CONFIG_FILE`, under the key in the *File key* column.
3. Its default.

So a config file can hold the base settings, and environment variables (for example in a Compose file) can override single values. Empty environment variables count as unset.

The config file is one JSON object. Values may be strings, numbers or booleans. Unknown keys are an error, because everything in the file is meant for Tazamun. Unknown `TAZAMUN_*` environment variables are only logged as warnings, to catch typos. The file may contain secrets; protect it like one.

```json
{
  "publicUrl": "https://sync.example.org",
  "registration": "invite",
  "storageQuotaMb": 500,
  "trustProxy": true
}
```

## Settings

`TAZAMUN_CONFIG_FILE` (environment only): path to the JSON config file. Default: none.

| Variable | File key | Default | Format | Description |
| -------- | -------- | ------- | ------ | ----------- |
| `TAZAMUN_PUBLIC_URL` | `publicUrl` | **required** | URL, e.g. `https://sync.example.org` | The URL clients use to reach this server, without a path. Must be `https://` unless the host is `localhost` or `127.0.0.1`, or `TAZAMUN_ALLOW_INSECURE` is set. |
| `TAZAMUN_PORT` | `port` | `8080` | integer 1–65535 | HTTP port to listen on, on all interfaces. TLS is handled by a reverse proxy. |
| `TAZAMUN_DATA_DIR` | `dataDir` | `/data` | directory path | Directory for all persistent state: the database, its WAL files, the instance secret and automatic backups. Must be on local storage, used by one server only. |
| `TAZAMUN_REGISTRATION` | `registration` | `invite` | `open`, `invite` or `closed` | Who may create accounts: anyone (`open`), holders of a one-time invite token (`invite`), or nobody (`closed`). |
| `TAZAMUN_STORAGE_QUOTA_MB` | `storageQuotaMb` | `200` | integer ≥ 1 | Maximum storage per account, in MiB (record IDs plus encrypted payloads). |
| `TAZAMUN_RATE_LIMIT_PER_MINUTE` | `rateLimitPerMinute` | `600` | integer ≥ 1 | Requests per minute per signed-in account, across all of its devices. |
| `TAZAMUN_AUTH_RATE_LIMIT_PER_MINUTE` | `authRateLimitPerMinute` | `10` | integer ≥ 1 | Attempts per minute for sign-in, account creation, prelogin, recovery and passphrase checks, counted per client IP and, where an account is named, per account. |
| `TAZAMUN_TRUST_PROXY` | `trustProxy` | `false` | `true` or `false` | Take the client IP from the last `X-Forwarded-For` entry. Set this only behind a reverse proxy that sets the header, or clients can fake their IP and escape rate limits. |
| `TAZAMUN_ALLOW_INSECURE` | `allowInsecure` | `false` | `true` or `false` | Allow a plain `http://` public URL on a host other than localhost. Session tokens and auth keys then cross the network unprotected. A warning is logged on every start. |
| `TAZAMUN_LOG_LEVEL` | `logLevel` | `info` | `debug`, `info`, `warn` or `error` | Lowest level that is logged. |
| `TAZAMUN_LOG_FORMAT` | `logFormat` | `json` | `json` or `pretty` | One JSON object per line, or human-readable lines for development. |
| `TAZAMUN_INSTANCE_SECRET`<br>`TAZAMUN_INSTANCE_SECRET_FILE` | `instanceSecret` | — | at least 32 characters | Secret used to make prelogin responses for unknown usernames look real and stay stable. If unset, one is generated into `<data dir>/instance-secret` on first start. Changing it changes those responses. |
