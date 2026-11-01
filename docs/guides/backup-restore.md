# Backup and restore

NoConMedia has two kinds of data: the database (settings, sources, catalogue, history, client logins) and the media files on your drive. `scripts/backup.sh` backs up the first. You back up the second yourself.

## What scripts/backup.sh saves

```bash
scripts/backup.sh                  # writes ./backups/nocon-backup-<timestamp>.tar.gz
scripts/backup.sh /mnt/backups     # or choose a folder
```

The stack must be running, because the script runs `pg_dump` inside the `postgres` container. The archive contains:

| File | Contents |
|---|---|
| `db.dump` | A full PostgreSQL dump in custom format, including external player credentials as hashes. |
| `settings.json`, `sources.json`, `storage_volumes.json` | Readable copies of those tables. |
| `clients.json` | External players without their secret hashes. Informational only. |
| `manifests/` | Every library `metadata.json` file, in the library's folder layout, and a copy of the volume marker `.noconmedia/volume.json`. |
| `info.txt` | Time, version and PostgreSQL version. |

It does not save:

- **The video, audio, artwork and subtitle files.** They are large and already on your drive. Copy them separately.
- Redis data. It is rebuilt from the database.
- Your `.env` file. Keep a copy somewhere safe, because it holds the database password. A restore can use a new password, but you need to know the other settings.
- Temporary download data.

Copy the archive off the machine. A backup on the same drive does not help if the drive fails.

### Backing up the media files

Use `rsync` to a second drive or another machine. Trailing slashes matter, and hidden folders must be included because the marker lives in `.noconmedia`:

```bash
rsync -aH --info=progress2 --exclude '.noconmedia/tmp' /mnt/nocon-media/ /mnt/backup-drive/nocon-media/
```

Run it with the stack running or stopped. A copy taken while a download is in progress is fine, since unfinished downloads sit in `.noconmedia/tmp`.

Because every video folder has a `metadata.json` sidecar, a media copy plus the Reconcile tool can rebuild the catalogue even without a database backup. You lose watch history, favourites, source settings and external player logins.

## Restoring with scripts/restore.sh

```bash
scripts/restore.sh BACKUP.tar.gz [--media-path NEWPATH] [--remap-mount OLD=NEW]
```

The script:

1. Reads `db.dump` from the archive and prints `info.txt`.
2. With `--media-path`, updates `MEDIA_PATH` in `.env`. Use this when the library now lives at a different host path.
3. Makes sure `postgres` and `redis` are running, and stops `web`, `worker` and `api`.
4. Runs `pg_restore --clean --if-exists`, which replaces what is in the database. Warnings on a fresh database are normal.
5. With `--remap-mount OLD=NEW`, rewrites the stored volume path from OLD to NEW.
6. Flushes Redis (queues and heartbeats; they are rebuilt from the database).
7. Starts everything with `docker compose up -d --wait`.

Restoring overwrites the current database. Take a fresh backup first if there is anything you want to keep.

### Restoring onto a new machine

1. Install Docker, clone the repository and put your saved `.env` in place (or run `scripts/install-pi.sh` and copy over the values you need). `POSTGRES_USER` and `POSTGRES_DB` must match the ones the backup was taken with, unless you are happy to use the defaults on both sides. `POSTGRES_PASSWORD` can be new.
2. Mount the drive with the library at the path in `MEDIA_PATH`, owned by UID 1000. Follow [Install on a Raspberry Pi](install-raspberry-pi.md#prepare-the-usb-drive) if it is a USB drive.
3. Run the restore:

```bash
scripts/restore.sh /path/to/nocon-backup-20261101-120000.tar.gz
```

4. Sign in with the administrator account from the backup. Then run Reconcile (below).

Restoring `db.dump` brings external player logins back with working passwords. Restoring from `clients.json` alone does not; create those players again and update the apps.

### Remapping volumes

Inside the containers, the library is always `/media`, whatever the host path is. If the host path changes (a new drive, a new mount point), `--media-path` is all you need:

```bash
scripts/restore.sh backup.tar.gz --media-path /mnt/new-drive
```

`--remap-mount` is only for the rarer case where the volume was registered under a different in-container path, for example `/media2`. The new path must be inside `MEDIA_ROOTS_ALLOWED` and mounted into the containers:

```bash
scripts/restore.sh backup.tar.gz --remap-mount /media2=/media
```

### The marker caveat

A volume is online only if the folder holds `.noconmedia/volume.json` with the same ID as the database row. After a restore:

- If you copied the whole drive contents (including the hidden `.noconmedia` folder), the marker is there and the volume comes online.
- If you copied the files to a new empty drive without that folder, the marker is missing and the volume stays Offline; downloads pause and the library shows as temporarily unavailable. Copy the marker back from the backup archive:

```bash
tar -xzf nocon-backup-20261101-120000.tar.gz --wildcards '*/manifests/.noconmedia/volume.json' -O \
  | sudo tee /mnt/new-drive/.noconmedia/volume.json >/dev/null
```

If `.noconmedia` does not exist yet, create it first with `sudo mkdir -p /mnt/new-drive/.noconmedia`, and make it owned by 1000:1000. Then select "Verify" on the volume in **Storage**.

- If the drive has a marker with a different ID (it belonged to another NoConMedia install), the volume stays Offline. If that drive really is your library, overwrite its marker with the one from the backup, using the command above. Do not overwrite the marker on a drive that holds a different library.

### Reconcile after a restore

The database dump and the drive may disagree if files changed after the backup was taken. Open **Manage > Storage**, scroll to "Reconcile with disk", run a dry run, read the issues, then run it for real. It rebuilds catalogue entries from the `metadata.json` files on the drive and reports missing files, orphan folders and duplicates. It does not delete files. See [Storage and eviction](storage.md#reconcile).

## Recovery after an unexpected shutdown

A power cut or `kill -9` needs no manual steps. When the worker starts it:

- Marks sync runs that were still running as failed ("interrupted by restart").
- Puts downloads that were in progress back in the queue, releases the space they had reserved and removes their staging folders.
- Releases other stale space reservations.
- Finishes any eviction that was planned but not completed: if the file is already gone it records it as done, otherwise it deletes the file.
- Re-checks every volume's marker and free space.
- Removes staging folders older than 24 hours that belong to no running download.

Partly downloaded files are never moved into the library, because the final move to the library happens only after verification. PostgreSQL and Redis recover from their own journals. Redis uses an append-only file, and if it is lost the worker re-creates the queue from the database.

After the restart, check **System health** (worker Online, volumes Online) and the **Downloads** page.

## Scheduled backups

There is no built-in scheduler. Use cron on the host if you want one, for example a nightly backup at 03:00 (replace the path with your install directory):

```text
0 3 * * * cd /home/pi/NoConMedia && scripts/backup.sh /mnt/backups >> /var/log/nocon-backup.log 2>&1
```

Remove old archives yourself.
