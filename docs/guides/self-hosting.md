# Self-hosting Tazamun

Tazamun has no official hosted service: every account lives on a server someone runs. This guide gets one running with Docker. The server stores only encrypted data. Whoever runs it can see metadata (how many records, when, and from which IP addresses) but never your tabs, history or bookmarks ([SRS 5.2](<../srs/5. Other Nonfunctional Requirements.md#52-security-requirements>)).

> **Status:** only the `edge` image exists so far, built from the latest `main`. Expect changes until 1.0. While the repository is private, so is the image; it becomes pullable without signing in when the project is published.

## What you need

- A Linux machine with **Docker Engine and Compose v2.23 or later** (`docker compose version`). 1 vCPU and 512 MB of RAM is plenty; the server itself stays under 256 MB.
- A **domain name**, such as `sync.example.org`, whose DNS record points at the machine.
- Ports **80 and 443** open, if you use the bundled Caddy for HTTPS.
- **Local storage** for the data volume. See [Data and storage](#data-and-storage).

## Quick start with automatic HTTPS

This uses [`docker-compose.caddy.yml`](../../deploy/compose/docker-compose.caddy.yml): Tazamun plus [Caddy](https://caddyserver.com), which gets a TLS certificate from Let's Encrypt by itself.

```sh
mkdir tazamun && cd tazamun
curl -fsSLO https://raw.githubusercontent.com/Proless/Tazamun/main/deploy/compose/docker-compose.caddy.yml
curl -fsSL -o .env https://raw.githubusercontent.com/Proless/Tazamun/main/deploy/compose/.env.example
nano .env                              # set TAZAMUN_DOMAIN=sync.example.org
docker compose -f docker-compose.caddy.yml up -d
curl https://sync.example.org/v1/health   # {"status":"ok"}
```

Then create an invite for each person who should get an account:

```sh
docker compose -f docker-compose.caddy.yml exec tazamun tazamun invite create
```

The token is shown once. Give it to the person; they enter it in the extension when creating their account. To avoid repeating `-f docker-compose.caddy.yml`, rename the file to `compose.yaml`; the commands below assume you did.

## Behind a reverse proxy you already run

Use [`docker-compose.yml`](../../deploy/compose/docker-compose.yml). It publishes Tazamun on `127.0.0.1:8080` only, so only the proxy on the same machine can reach it. Configure the proxy to:

- forward `https://<your domain>` to `http://127.0.0.1:8080`,
- set `X-Forwarded-For` and `X-Forwarded-Proto` (the Compose file sets `TAZAMUN_TRUST_PROXY=true`, so rate limits apply per client and not per proxy),
- accept request bodies of **at least 2 MB**. nginx's default of 1 MB breaks syncing with `413` errors.

Ready-made examples are in [`deploy/proxy/`](../../deploy/proxy/): a [Caddyfile](../../deploy/proxy/Caddyfile), an [nginx server block](../../deploy/proxy/nginx.conf), and [Traefik labels](../../deploy/proxy/docker-compose.traefik.yml) to layer on top of the Compose file.

## Configuration

The Compose files pass the settings from `.env` to the server: `TAZAMUN_DOMAIN`, `TAZAMUN_REGISTRATION` (`invite`, `open` or `closed`), `TAZAMUN_STORAGE_QUOTA_MB` and `TAZAMUN_LOG_LEVEL`. Every other setting is in the [configuration reference](server-configuration.md). Add it under `environment:` in the Compose file, or mount a JSON config file and set `TAZAMUN_CONFIG_FILE`.

The server checks its configuration at startup and refuses to start, naming the problem, if something is wrong. `docker compose logs tazamun` shows the message.

## Admin commands

Run them with `docker compose exec tazamun tazamun <command>` while the server runs:

| Command | What it does |
| ------- | ------------ |
| `invite create [--expires 7d]` · `invite list` · `invite revoke <id>` | Manage one-time invite tokens |
| `accounts list` | ID, created, last seen, devices and storage per account. No content. |
| `accounts delete <id> --yes` | Delete an account and its data (a backup is written first) |
| `backup <file>` | Consistent copy of the database, safe while running |
| `migrate --status` | Schema version and pending migrations |
| `version` · `healthcheck` | Version · health check (used by the image's `HEALTHCHECK`) |

`restore` is the exception: it needs the server stopped. See below. All commands are described in the [server README](../../apps/server/README.md#admin-commands).

## Data and storage

Everything the server keeps is in the `/data` volume: the SQLite database with its `-wal` and `-shm` files, the instance secret, and automatic backups in `/data/backups`. The container itself holds no state and can be recreated at any time.

- **Use local storage.** Never put `/data` on NFS, SMB or another network filesystem. SQLite's locking doesn't work there, and the database gets corrupted.
- **One server per volume.** Never run two Tazamun containers on the same `/data`, for the same reason. Tazamun doesn't scale horizontally; one small instance serves dozens of accounts.
- **Named volumes are easiest.** The Compose files use one (`tazamun-data`). If you prefer a host directory, it must be writable by the container's user, **UID and GID 10001**: `sudo chown -R 10001:10001 /srv/tazamun`. Otherwise the server stops with a message saying exactly that.

The container runs as a non-root user, with a read-only root filesystem and all Linux capabilities dropped. The Compose files limit it to 256 MB of memory and half a CPU.

## Backups

Backups contain only ciphertext and metadata, but they're still worth protecting: they show who has accounts and how much they store.

```sh
docker compose exec tazamun tazamun backup /data/backups/manual-$(date +%F).db
docker compose cp tazamun:/data/backups/manual-$(date +%F).db .   # copy it off the volume
```

Copy backups to another machine regularly. The server also writes `pre-migrate-*`, `pre-restore-*` and `pre-delete-*` copies into `/data/backups` before risky operations, and keeps the last few of each.

### Restore

```sh
docker compose stop tazamun
docker compose cp ./manual-2026-11-24.db tazamun:/data/backups/restore.db   # if it isn't on the volume yet
docker compose run --rm --no-deps tazamun restore /data/backups/restore.db
docker compose start tazamun
```

`restore` checks the backup with `PRAGMA integrity_check` first, and saves the current database as `pre-restore-<time>.db` before replacing it. Changes made after the backup was taken are lost on the server, but devices keep their local data.

## Upgrades

```sh
docker compose pull
docker compose up -d
```

On start, the server backs up the database to `/data/backups/pre-migrate-<from>-<to>.db`, then migrates it. Clients keep syncing. To go back to an older image, restore that pre-migration backup with the older image; a server refuses to open a database newer than itself.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `The data directory /data is not writable` | A bind-mounted host directory isn't owned by UID 10001. Run `chown -R 10001:10001` on it, or use a named volume. |
| `TAZAMUN_PUBLIC_URL must use https://` | The server only runs with an `https://` public URL. The Compose files build it from `TAZAMUN_DOMAIN`. |
| Sync fails with `413` | The reverse proxy limits bodies below 2 MB. Raise it (nginx: `client_max_body_size 4m;`). |
| Everyone gets `RATE_LIMITED` at once | The server sees the proxy's IP for every client. Make sure the proxy sets `X-Forwarded-For` and `TAZAMUN_TRUST_PROXY=true` is set. |
| Caddy can't get a certificate | DNS for `TAZAMUN_DOMAIN` doesn't point at this machine yet, or ports 80/443 are blocked. `docker compose logs caddy` says which. |
| Container is `unhealthy` | `docker compose logs tazamun` shows why the server isn't answering. |
