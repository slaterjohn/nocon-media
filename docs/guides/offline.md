# Working offline

NoConMedia is built so that everything you do with downloaded media works without an internet connection. Only fetching new content needs the internet.

## What works offline

Everything below uses only the local database and the files on your drive:

- Signing in and the whole admin interface.
- Browsing, search (full-text search in PostgreSQL), favourites, collections, continue watching and watch history.
- Thumbnails, channel artwork and subtitles (all stored locally).
- Playback in the browser, including seeking and resuming.
- Xtream and M3U players: authentication, categories, listings, artwork and streams. Artwork links point at your own server.
- Storage management, eviction, simulation, Reconcile, and backups.

## What needs the internet

- Checking sources for new videos and downloading them.
- Discovery runs.
- Updating yt-dlp (`scripts/update-yt-dlp.sh` rebuilds the worker image and needs to download it).

The administrator interface does not load fonts, scripts or images from other sites.

## How connectivity is detected

The worker probes the URLs in `CONNECTIVITY_CHECK_URLS` every `CONNECTIVITY_INTERVAL_SEC` seconds (default 60). The defaults are:

```text
https://www.youtube.com/generate_204
https://www.google.com/generate_204
https://1.1.1.1/
```

The server counts as online if at least one probe gets any HTTP response within 5 seconds, whatever the status code. If all of them fail, it is offline. The state shows as Online or Offline under Connectivity on the dashboard and **System health**, and each change is written to **Activity**. To use your own probe (for instance an internal server), set `CONNECTIVITY_CHECK_URLS` to a comma-separated list in `.env`.

## What pauses and what resumes

While offline:

- Scheduled and manual syncs do not start. The run is recorded as `skipped_offline`.
- Queued downloads stay queued and do not start.
- Discovery runs do not start.
- Playback, search, the admin interface and Xtream carry on as normal.

A download that was running when the connection dropped can fail with a network error. Failed downloads are retried automatically a few times, then listed under Failed on the **Downloads** page, where you can retry them.

When the connection returns, the worker logs "Internet connection restored". Queued downloads start again, and sources that missed their schedule are caught up, at most three per scheduler tick (one tick a minute), so a long outage drains gradually rather than all at once.

You can also stop the worker's background work yourself with "Pause background work" on **System health**. Running jobs finish; nothing new starts. Switch it off to resume.

## The offline readiness test

**Manage > System health > Offline readiness > "Run offline readiness test"** checks, from inside the running server, that the pieces needed offline work. It reports a pass or fail line for each of:

| Check | What it looks at |
|---|---|
| Sign-in | Sign-in uses the local database. |
| Database | The database answers a query. |
| Media files | A sample of playable files exists on disk. |
| Thumbnails | Every playable item has a local thumbnail. |
| Search | Full-text search runs locally. |
| Streaming | A sample file can be opened and read. |
| Xtream and M3U | The catalogue can be built in-process. |
| No external dependencies | All artwork URLs are served by your server, not another host. |

Some checks fail on an empty library ("No playable media yet"), which is expected until you have downloaded something. This test does not disconnect anything; it inspects the library.

## The full offline acceptance test

`scripts/offline-test.sh` is a stronger test for developers and the cautious. It builds the images, then starts the stack with `compose.offline.yml`, where no service has any route to the internet. It seeds a small generated video, proves from inside each container that `https://www.youtube.com` is unreachable, and then runs checks from inside the network: sign-in, admin endpoints, browsing, search, thumbnails, range playback, Xtream authentication, catalogue and playback, and M3U.

```bash
scripts/offline-test.sh            # runs, prints PASS or FAIL, then removes everything
scripts/offline-test.sh --keep     # leaves the test stack running for debugging
```

It uses its own compose project (`nocon-offline`), a temporary media directory and a throwaway database, so it does not touch your real stack. It needs Docker and enough disk to build the images, and it takes several minutes the first time.
