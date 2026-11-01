# NoConMedia documentation

New here? Start with the [README](../README.md) for what NoConMedia is and a copy-and-paste quick start.

## Install

| Guide | Read it to |
|---|---|
| [Install on a Raspberry Pi](guides/install-raspberry-pi.md) | Flash the OS, prepare a USB drive, install, cool and power the Pi. |
| [Install with Docker](guides/install-docker.md) | Install on any 64-bit Linux machine, run the setup wizard, upgrade, read logs. |
| [Environment variables](reference/environment.md) | Every setting in `.env`, with defaults. |

## Use

| Guide | Read it to |
|---|---|
| [Sources](guides/sources.md) | Add channels, playlists, videos and searches, set schedules and filters, import Takeout history. |
| [Storage and eviction](guides/storage.md) | Understand volumes, thresholds, priorities, retention and what gets deleted. |
| [External players (Xtream and M3U)](guides/xtream-clients.md) | Give apps such as UHF and VLC access to your library. |
| [UHF on Apple TV](clients/uhf.md) | Set up UHF and run the manual compatibility checklist. |
| [Working offline](guides/offline.md) | See what works without internet and run the offline tests. |

## Operate

| Guide | Read it to |
|---|---|
| [Backup and restore](guides/backup-restore.md) | Back up the database and media, restore, move to a new machine, recover from a power cut. |
| [Reverse proxy and HTTPS](guides/reverse-proxy.md) | Put Caddy or nginx in front of the web and API ports. |
| [Troubleshooting](guides/troubleshooting.md) | Symptom, cause and fix. |
| [Security](security.md) | How authentication, sessions, external logins and the web proxy work. |

## Reference

- [API reference](api.md): the contract between the API, worker and web app.
- [Jobs, settings and the shared runtime contract](jobs.md)
- [Media streaming](media-streaming.md): range requests, HLS, M3U and Xtream response shapes.
- [Storage management](storage-management.md): the planner's exact rules.
- [Database schema](database-schema.md)

## Project status

- [MVP acceptance status](acceptance.md): each acceptance criterion with its evidence and what is outstanding.
- [Benchmarks](benchmarks.md): Raspberry Pi results are outstanding.
- [Raspberry Pi and ARM64 notes](raspberry-pi.md)

## For contributors

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first.

- [Development](development.md): repository layout, running locally, tests, adding an adapter.
- [Architecture](architecture.md)
- [Testing strategy](testing-strategy.md)
- [Database migrations](database-migrations.md)
- [Source adapters](source-adapters.md)
- [Implementation plan](implementation-plan.md)

[API reference](api.md) and [jobs](jobs.md) are the contracts between the API, worker and web app. Keep them in step with the code.
