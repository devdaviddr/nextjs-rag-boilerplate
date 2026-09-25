# Backups & restore

[← Back to README](../README.md)

This page covers what gets backed up automatically, how to check it is still
working, and how to get your data back.

Everything this app remembers lives in two places: rows in Postgres (accounts,
knowledge bases, documents, the searchable [chunks](rag.md) built from them, and
conversations) and files in MinIO (the PDFs people uploaded, profile photos).
Lose either and the app is empty. A
self-hosted box has no managed-service safety net, so the production stack
brings its own: two small sidecar containers that copy both stores to disk on a
schedule, with no cron for you to write.

The production stack ([`docker-compose.prod.yml`](../docker-compose.prod.yml))
backs up both stores automatically:

- Postgres: the `db-backup` service (a maintained
  [`postgres-backup-local`](https://github.com/prodrigestivill/docker-postgres-backup-local)
  image) writes nightly compressed dumps to `./backups/postgres/` and prunes
  ones older than `BACKUP_RETENTION_DAYS` (default 14).
- MinIO: the `minio-backup` sidecar runs `mc mirror` on an interval
  (`BACKUP_INTERVAL_SECONDS`, default daily) into `./backups/minio/`.

Both run as part of `make tunnel-up` / `make deploy`, so there is nothing to
switch on.

> [!WARNING]
> `./backups/` lives on the **same host** as the data. It survives container
> recreation but **not disk failure**. For disk-failure resilience, enable the
> optional offsite copy below. Backups contain full user data (emails, password
> hashes, uploaded files). They are git/docker-ignored; keep the host
> directory permissions tight (e.g. `chmod 700 backups`).

## Configuration

Set these in `.env`. All are optional, and the defaults are shown:

```bash
BACKUP_RETENTION_DAYS=14      # daily Postgres dumps to keep
BACKUP_INTERVAL_SECONDS=86400 # MinIO mirror cadence (24h)
```

## Verifying backups are actually happening

A backup service that has silently stopped is worse than none. The doctor script fails if the newest dump is stale or
missing:

```bash
./scripts/backup-verify.sh
# or against a real deploy path:
BACKUP_DIR=/srv/app/backups/postgres MAX_AGE_HOURS=25 ./scripts/backup-verify.sh
```

Run it from cron/monitoring and alert on a non-zero exit.

The check is deliberately cheap. It confirms the newest `*.sql.gz` exists, is
non-empty, and was written inside the freshness window (`MAX_AGE_HOURS`,
default 25). It does not open the dump. To prove a dump restores, follow the
runbook below, and do it once by hand before you need it.

---

## Restore — Postgres

Read this whole section before typing anything. Dumps are compressed SQL
(`pg_dump -Z6`), written under `./backups/postgres/daily/`.

The order matters. You restore into a scratch database first, confirm it is
sound, and only then touch the real one. Steps 1 to 3 are safe and change
nothing. **Step 4 is destructive.**

**1. List the dumps (newest first) and pick one.**

```bash
ls -t backups/postgres/daily/*.sql.gz | head
```

**2. Create a scratch database and load the dump into it.** Never load straight
into production.

```bash
# create a scratch db
docker compose -f docker-compose.prod.yml exec db \
  createdb -U postgres app_restore_test

# load the dump
gunzip -c backups/postgres/daily/<dump>.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d app_restore_test
```

Replace `<dump>` with the filename from step 1. Watch the output for errors. A
truncated dump fails loudly here, which is why you load it into a scratch
database first.

**3. Sanity-check it, then confirm the schema is migration-current.**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_restore_test \
  pnpm db:migrate   # should report "No migrations to apply"
```

"No migrations to apply" means the dump's schema matches the code you are
running. If it applies migrations instead, the dump is older than your current
schema. That is expected after an upgrade, but note it before continuing.

> `docker-compose.prod.yml` publishes no host port for `db`, so
> `localhost:5432` only resolves if you have a Postgres reachable there (the
> development stack in `docker-compose.yml` does publish it). To run the check
> inside the Compose network instead, use the `migrate` service, which already
> has `pnpm` and reaches `db` by name:
>
> ```bash
> docker compose -f docker-compose.prod.yml run --rm \
>   -e DATABASE_URL=postgresql://postgres:postgres@db:5432/app_restore_test \
>   migrate pnpm db:migrate
> ```

**4. Restore into the real database.** Stop the `app` service first, drop and
recreate the `app` database (or restore into a fresh one and repoint
`DATABASE_URL`), load the dump exactly as in step 2 but targeting that database,
then bring `app` back up.

Always stop `app` first. If the app keeps writing while the database is half
restored, an incident you could have recovered from becomes one you can't.

## Restore — MinIO

The mirror is a plain directory tree under `./backups/minio/<bucket>/`. Push it
back into the bucket:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  --entrypoint sh \
  -v "$PWD/backups/minio:/backups" minio-backup \
  -c "mc alias set local http://minio:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD && \
    mc mirror --overwrite /backups/\$S3_BUCKET local/\$S3_BUCKET"
```

You need `--entrypoint sh`, and it has to come **before** the service name. The
`minio-backup` service defines its whole backup loop in `entrypoint:` rather
than `command:`, and `docker compose run` only overrides the command. Without
the override, your restore arguments are appended to the sidecar's own
live-to-backup loop, which mirrors the empty bucket over the backup you are
trying to restore from.

Otherwise this is the same `mc mirror` the sidecar runs, with source and
destination swapped. `--overwrite` replaces objects that already exist in the
bucket and leaves alone anything the backup doesn't have.

## Optional: offsite copy (disk-failure resilience)

The copy on the host is lost if the disk fails. To also push backups to an
S3-compatible offsite target such as Cloudflare R2, add an `mc` alias and a
mirror step. It is off by default; each deployment opts in.

> On macOS, Time Machine backs up `./backups` because it is a normal folder.
> The Docker volumes (`pgdata`, `miniodata`) live inside Docker's Linux VM, and
> Time Machine does **not** cover them. Rely on the dumps plus this offsite
> copy, or point `./backups` at an external drive.

Create an API token with the least privilege it needs (write-only to the backup
bucket), and set:

```bash
OFFSITE_BACKUP_ENDPOINT=https://<account>.r2.cloudflarestorage.com
OFFSITE_BACKUP_ACCESS_KEY=...
OFFSITE_BACKUP_SECRET_KEY=...
OFFSITE_BACKUP_BUCKET=my-app-backups
```

Then extend the `minio-backup` loop (or add a cron on the host) with:

```bash
mc alias set offsite "$OFFSITE_BACKUP_ENDPOINT" "$OFFSITE_BACKUP_ACCESS_KEY" "$OFFSITE_BACKUP_SECRET_KEY"
mc mirror --overwrite /backups "offsite/$OFFSITE_BACKUP_BUCKET"
```

---

## Why it's built this way

`db-backup` uses a maintained image, `prodrigestivill/postgres-backup-local`,
instead of a shell script this repo would have to maintain. Scheduling
`pg_dump`, rotating old files and handling a failed run are already solved
there. It is configured for daily dumps only: `BACKUP_KEEP_WEEKS` and
`BACKUP_KEEP_MONTHS` are both `0`, so `BACKUP_RETENTION_DAYS` is the whole
retention policy, and there is one kind of file in one place to reason about.

Dumps are compressed and carry no ownership. `POSTGRES_EXTRA_OPTS: '-Z6 --no-owner'`
gives level-6 gzip compression, and `--no-owner` drops the `OWNER TO` statements
so a dump loads cleanly into a database owned by a different role, which is the
scratch-database case in step 2 above.

MinIO gets a live mirror instead of versioned snapshots. No ready-made backup
image exists for MinIO, so `minio-backup` is a small sidecar loop running
`mc mirror`, the same one-shot/sidecar pattern as `minio-init`. It uses
`--overwrite`, which keeps the copy current but never removes files from it. As
a result, an object deleted from the live bucket is still in the mirror, so an
accidental delete can be recovered even though this is not a snapshot system.

`backup-verify.sh` checks that backups are fresh, not that they are correct. It
is meant to run every day from monitoring, so it stays cheap: existence, size,
mtime. A full restore-and-diff drill takes real time, so it is a manual runbook
step you schedule yourself.

## Not covered (by design)

- Point-in-time recovery (WAL archiving). Nightly dumps are the chosen
  fidelity; add `pgBackRest`/`wal-g` if you need a sub-day RPO.
- Backup encryption at rest. This relies on host or volume encryption; layer
  `age`/`gpg` on the dumps if you need it.
- Automated restore drills in CI. The restore above is a manual runbook
  step; run it periodically against a scratch stack.

---

Next: [Feature → Production](workflow.md), the loop from a branch on your
laptop to a running release on the box you just backed up.
