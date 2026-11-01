# Troubleshooting

Each entry gives the symptom, the likely cause and the fix. Start by reading the logs (last entry) and the **System health** page, which lists problems under "Needs attention" with a suggested step.

## Setup says the drive is on the container filesystem

**Symptom.** In the setup wizard's Storage step, or when adding a volume, a warning reads "This looks like the container's own filesystem. Is the drive mounted?"

**Cause.** The folder you chose is not on a separate mount inside the container. Usually the drive is not mounted on the host when Docker starts the containers, so `MEDIA_PATH` is an empty folder on the SD card or system disk. It can also mean `MEDIA_PATH` in `.env` points at the wrong place. Media saved there would sit on the system disk and be lost if the containers are recreated.

**Fix.**

```bash
findmnt /mnt/nocon-media          # should show your USB device; adjust the path
grep MEDIA_PATH .env
```

Mount the drive (`sudo mount -a`), make sure `MEDIA_PATH` is the mount point, then restart so the containers see it, and validate again.

```bash
docker compose restart api worker
```

Only tick "I'm happy to store media on this filesystem" if you really mean to store the library on the system disk.

## Permission denied on /media

**Symptom.** Validation shows "NoConMedia cannot write to this folder. Check its permissions." Downloads fail with permission errors in the worker log.

**Cause.** The containers run as UID 1000 and that user cannot write to `MEDIA_PATH` or `DATA_PATH`.

**Fix.**

```bash
sudo chown -R 1000:1000 /mnt/nocon-media data
docker compose exec api ls -ld /media /data
```

Drives formatted as NTFS or exFAT do not support Unix ownership; either mount them with `uid=1000,gid=1000` in the fstab options or format the drive as ext4. Note that the checks run as the container user, so `ls -l` on the host does not tell the whole story if SELinux or mount options interfere.

## A volume is offline

**Symptom.** Storage and System health show the volume as Offline, a notification says `Storage volume "..." is offline`, downloads are paused, videos show as temporarily unavailable.

**Cause.** The marker file `.noconmedia/volume.json` is missing or does not match. The drive is unplugged, not mounted, mounted at a different path, or a different drive is mounted there. Nothing has been deleted.

**Fix.** Confirm the drive is mounted with `findmnt` and that `ls -a /mnt/nocon-media` shows `.noconmedia`. Then select "Verify" on the volume in **Storage**. If the host mount is right and the volume stays offline, restart the containers so they pick up the mount: `docker compose restart api worker`. See [Storage](storage.md#missing-drives).

## Downloads are stuck in "Waiting for storage"

**Symptom.** The Downloads page shows items under "Waiting for storage" and the dashboard count is non-zero.

**Cause.** The download would push the volume past its limit, and no media is eligible for removal. Typical reasons: every source is "Keep everything", the new source's priority is lower than what fills the disk, the source has "Automatic eviction" switched off, or the volume is simply full.

**Fix.** Use **Storage > Simulate a download** with the same priority to see what would happen. Then free space (delete media you no longer need, or lower retention on old sources with "Preview impact"), raise a source's priority, switch on its automatic eviction, lower the minimum free space, or add a volume. The worker rechecks waiting downloads every 10 minutes, so they start by themselves after space appears.

## A source needs attention or shows yt-dlp errors

**Symptom.** A source shows "Needs attention", a "Source keeps failing" notification appears, or **Activity** shows `source.sync.failed`.

**Cause.** Three runs in a row failed. Open the source to see the last error. Common ones:

- **Rate limit** ("HTTP Error 429", or "Sign in to confirm you're not a bot"). YouTube is throttling the server's IP address. NoConMedia backs off for at least an hour per failure.
- **yt-dlp out of date.** YouTube changes often; an old yt-dlp starts failing with extraction errors.
- **Private, removed or age-restricted video**, or a channel that was renamed or deleted.
- **No internet.** See [Working offline](offline.md); sync runs are then skipped rather than failed.

**Fix.**

1. Wait. Rate limits usually clear in hours. Do not hammer "Sync now". Lower the schedule frequency (daily rather than hourly) for many sources.
2. Update yt-dlp. Choose a release from <https://github.com/yt-dlp/yt-dlp/releases> and run:

```bash
scripts/update-yt-dlp.sh 2026.10.26      # replace with the newer release, YYYY.MM.DD
```

   This rebuilds the worker image, restarts the worker and records the version in `.env`.
3. Slow the requests with a yt-dlp argument in `.env`, for example `YTDLP_EXTRA_ARGS=--sleep-requests 1` (see the warning in the [environment reference](../reference/environment.md)).
4. If the video needs a signed-in account you are entitled to use, upload cookies on the source page (**Authentication cookies**). See [Sources](sources.md#cookies).
5. Check the source address still works, then select "Sync now". One success clears the warning.

## An Xtream client cannot connect

**Symptom.** UHF or another player reports a login or network error.

**Checks, in order.**

1. **Address and port.** The server URL is `http://<host>:<API_PORT_PUBLIC>` (3001 by default), not the web port 3000. Test from another device on the same network:

```bash
curl -s "http://nocon.local:3001/player_api.php?username=USER&password=PASS"
```

   JSON with `user_info` means the server works. `{"user_info":{"auth":0}}` means the credentials are wrong.
2. **Network restriction.** HTTP 403 "This network is not allowed to use external player access" means the client's address is outside the allowed ranges (private ranges by default). Check **Settings > External player access > Advanced settings > Networks allowed for Xtream and M3U** and `XTREAM_ALLOWED_CIDRS`. Phones on mobile data or guest networks are common culprits. On Docker Desktop (macOS and Windows) the API may see a non-private source address even for devices on your LAN; set `XTREAM_ALLOWED_CIDRS` to your LAN range (for example `192.168.1.0/24`) rather than `0.0.0.0/0`.
3. **Credentials.** The password is shown only once. Rotate it if lost.
4. **Status.** A player that is disabled or revoked cannot sign in. See **External players**.
5. **Switches.** "Xtream Codes API" and "M3U playlist" must be on in Settings > External player access; HTTP 404 on `player_api.php` means Xtream is off.
6. **Firewall.** The API port (`API_PORT_PUBLIC`, default 3001) must be reachable. `API_BIND=127.0.0.1` makes it unreachable from the LAN.
7. **Empty list.** Only downloaded videos on an online volume are listed.

## A video will not play in the browser

**Symptom.** The player shows an error or stays black.

**Cause and fix.**

- **Codec.** Resolutions above 1080p from YouTube are usually VP9 or AV1 in MP4 or WebM, which not every browser plays (Safari in particular). The files are kept as downloaded; NoConMedia does not transcode. Set the source to 1080p or lower, or use a browser that supports the codec.
- **Container.** Files that are not MP4, WebM or M4A are served as HLS. The first request returns "preparing" while the worker makes a segmented copy, then plays. This needs the worker running and "HLS streaming" on in Settings > External player access > Advanced settings (and `ENABLE_HLS` not `false`). HLS remuxes without re-encoding, so it fixes container problems but not unsupported codecs.
- **Volume offline.** The video shows as temporarily unavailable. See above.
- **File missing.** Run Reconcile (dry run) in **Storage**.
- Press play again, or reload the page, after the worker finishes.

## The worker is offline

**Symptom.** System health shows the worker Offline with "The worker is not running. Downloads and syncs are paused." The dashboard says Worker Offline.

**Cause.** The worker container stopped, is restarting, or cannot reach Redis or Postgres. The page reads a heartbeat that the worker refreshes every 15 seconds and that expires after 60.

**Fix.**

```bash
docker compose ps
docker compose logs --tail 100 worker
docker compose up -d worker
```

If it is running but "Paused", switch off "Pause background work" on System health.

## The database or Redis is unhealthy

**Symptom.** Setup checks fail, System health shows Database or Redis "Down", or `docker compose ps` shows `unhealthy`.

**Likely causes and fixes.**

- **Changed `POSTGRES_PASSWORD` after the first start.** PostgreSQL stores the password in its volume when it first initialises and ignores later changes to `.env`. Put the old password back, or set the new one in the database:

```bash
docker compose exec postgres psql -U nocon -d nocon -c "ALTER USER nocon PASSWORD 'the-new-password'"
```

- **System disk full.** `df -h`. PostgreSQL stops when it cannot write. Free space and run `docker compose up -d`.
- **Not enough memory.** Check `docker compose logs postgres` for out-of-memory kills, and `dmesg | tail`.
- **Corruption after power loss.** PostgreSQL normally recovers by itself on start. If it does not, restore a backup: [Backup and restore](backup-restore.md).

## Redis shows permission errors

**Symptom.** `docker compose logs redis` shows "Permission denied" for the append-only file or `/data`, and the container restarts.

**Cause.** The Redis data volume has the wrong owner, often after a change to the container hardening or restoring a volume copied from elsewhere. The compose file gives Redis the capabilities it needs to take ownership at start (`CHOWN`, `SETUID` and others); removing them breaks that.

**Fix.** Check `compose.yml` still has the `cap_add` entries for `redis`. If the volume is damaged, remove it. Redis holds only queues and heartbeats, and the worker rebuilds the queue from the database, so nothing is lost:

```bash
docker compose stop redis
docker volume rm nocon-media_redisdata
docker compose up -d --wait
```

## The Pi is running hot

**Symptom.** System health shows a temperature above 70 °C (a warning) or 80 °C (an alert), or the Pi throttles.

**Fix.** Fit an active cooler or fan and make sure air can move around the case. Check the power supply (27 W for a Pi 5) because under-voltage causes throttling too: `vcgencmd get_throttled` should print `throttled=0x0`. In the meantime, use "Pause background work" on System health, keep `DEPLOYMENT_PROFILE=lightweight`, and lower `WORKER_CPUS` in `.env` (for example `1.0`, then `docker compose up -d`).

## Sign-in is blocked

**Symptom.** "Too many sign-in attempts. Try again in Ns."

**Cause.** The limit is 5 attempts a minute per IP address and 20 an hour per username. Wait for the time shown. Behind a reverse proxy all users share one address; see [Reverse proxy](reverse-proxy.md).

## Reading the logs

```bash
docker compose logs -f worker           # downloads, syncs, connectivity, recovery
docker compose logs -f api              # requests, migrations on boot
docker compose logs --tail 200 web postgres redis
docker compose logs --since 30m worker
```

Set `LOG_LEVEL=debug` in `.env` and run `docker compose up -d` for more detail. Credentials in Xtream URLs are redacted in the API logs. When reporting a problem, include the relevant log lines and the output of `docker compose ps`, and remove anything private first.
