# Contributing to NoConMedia

Thanks for helping. Bug reports, documentation fixes and pull requests are all welcome. For anything larger than a small fix, open an issue first so the approach can be agreed before you spend time on it.

By contributing you agree that your work is licensed under the [AGPL-3.0](LICENSE), the same as the rest of the project.

## Development set-up

You need Node.js 22 or later (the Docker images use 24), pnpm 10 (`corepack enable` picks up the pinned version), Docker, and ffmpeg and ffprobe on your `PATH`.

```bash
git clone https://github.com/slaterjohn/nocon-media.git
cd nocon-media
pnpm install
pnpm test:infra        # Postgres 17 and Redis 7 for tests, on 127.0.0.1:55432 and :56379
```

[docs/development.md](docs/development.md) explains the repository layout, how to run the API, worker and web app locally, and how to use the fake yt-dlp so you do not need internet access.

## Running the tests

| Command | What it runs | Needs |
|---|---|---|
| `pnpm -r typecheck` | TypeScript across the workspace | nothing |
| `pnpm test` | Unit tests | nothing |
| `pnpm test:integration` | Integration tests against real Postgres and Redis | `pnpm test:infra`, ffmpeg |
| `pnpm vitest run` | Unit and integration tests together | `pnpm test:infra`, ffmpeg |
| `pnpm test:e2e` | Playwright browser tests | `pnpm test:infra`, `pnpm build`, ffmpeg, Chromium |

Integration tests read `TEST_DATABASE_URL` and `TEST_REDIS_URL` if you want to point them at other servers.

GitHub Actions runs the type check, the unit and integration tests, and `docker compose config` on every push and pull request. It does not run the end-to-end tests, because they build the web app and drive a browser, which is too heavy for every push. Run `pnpm test:e2e` yourself when you change the web app, the setup wizard or playback.

## Conventions that matter

- **The API and job documents are contracts.** [docs/api.md](docs/api.md) and [docs/jobs.md](docs/jobs.md) describe the agreement between the API, the worker and the web app. If you change an endpoint, a response shape, a queue, a job payload, a Redis key, a setting or a state transition, update the matching document in the same pull request.
- **Tests with every change.** Add or update unit or integration tests for behaviour you change. Bug fixes need a test that fails without the fix.
- **UK English in the interface.** User-facing text uses UK spelling, sentence case, and plain, specific wording. Guides under `docs/guides/` quote UI labels, so update them when labels change.
- **No shell.** Spawn child processes with argument arrays. Never use `shell: true`, and put user-supplied values after `--` where the tool supports it.
- **Path safety.** Resolve media paths only with `resolveInside()` from `@nocon/shared`. Never join user input to a path by hand.
- **Validate input.** Check every external input with zod, reusing schemas from `@nocon/shared`.
- **No credentials in logs.** Use the redaction helpers for URLs.
- **Additive migrations.** Keep database changes additive; see [docs/database-migrations.md](docs/database-migrations.md).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make a focused change. Unrelated clean-ups belong in a separate pull request.
3. Run `pnpm -r typecheck` and `pnpm vitest run`, and `pnpm test:e2e` if you touched the web app.
4. Fill in the pull request template: what changed, why, and how you tested it. Include screenshots for visible changes.
5. A maintainer will review. Expect requests for changes, and please keep the discussion on the pull request.

Only download, test and share content you have the right to. Do not add features that circumvent DRM.

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Report security problems privately, as described in [SECURITY.md](SECURITY.md).
