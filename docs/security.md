# Security

## Threat model

LAN appliance with one administrator, untrusted devices on the same network possible, optional exposure through a reverse proxy. Assets: admin account, external client credentials, viewing history, the host filesystem.

## Administrator authentication

- Passwords hashed with `crypto.scrypt` (N=2^15, r=8, p=1, 16-byte salt, 64-byte key) and compared with `timingSafeEqual`. Minimum length 10.
- Session: 32 random bytes, cookie `nocon_session`, `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true` (set behind HTTPS), `Path=/`. Stored as SHA-256 in `sessions`; 30-day sliding expiry with a hard 90-day absolute lifetime from creation (use never extends past it); revocable individually or all-but-current.
- CSRF: state-changing `/api` requests must carry `X-NoCon-CSRF: 1` *and* an `Origin`/`Referer` (when present) matching the host. Browsers will not add custom headers cross-site without a CORS preflight, which the API never approves.
- Login rate limit: 5 attempts / minute / IP plus 20 / hour / username. Each attempt is recorded *before* the password is hashed, so a burst of parallel requests cannot exceed the limit; a successful sign-in clears the IP and username counters. The in-memory tables are pruned and hard-capped at 10,000 keys each.
- Password hashing (login, setup, password change) runs through a limiter: at most 2 scrypt operations at once (each needs ~32 MiB), the rest queue. `POST /api/setup/admin` checks whether an administrator exists before hashing.
- Setup endpoints only work while no admin exists.

## Client IP and the web proxy

The browser talks to the `web` container, which proxies `/api/*` to the API. Without extra care the API would see every request as coming from the web container (one shared login-throttle bucket, so one LAN user could lock everyone out), and trusting `X-Forwarded-For` would let any client choose its own IP.

- **`NOCON_PROXY_SECRET`** (set the same value on `web` and `api`; e.g. `openssl rand -hex 32`). The web proxy drops every client-supplied `x-forwarded-for`, `x-real-ip` and `x-nocon-*` header (it forwards an explicit allowlist only) and sends `x-nocon-client-ip: <peer IP>`, `x-nocon-proxy-secret: <secret>` and the original `Host` as `x-forwarded-host`.
- The peer IP is the real TCP peer address of the incoming connection. Next.js route handlers cannot see the socket and Next only fills `x-forwarded-for` when the header is *absent* (a client-supplied value passes through and nothing is appended), so no `x-forwarded-for` entry can be trusted. `apps/web/instrumentation.ts` therefore stamps `x-nocon-peer-ip` from `socket.remoteAddress` on every request (overwriting anything the client sent) before Next sees it. If a reverse proxy sits in front of `web`, the peer is that proxy, so all users share one throttle bucket; the proxy's own rate limiting should then be used for login.
- The API has one helper, `clientIp(req)`: if `NOCON_PROXY_SECRET` is set and the request's `x-nocon-proxy-secret` matches (constant-time compare), it uses `x-nocon-client-ip` (must be a valid IP address); otherwise it uses the socket / trusted-proxy address. It is used for the login throttle, the rate-limit key, `sessions.ip`, external-client `lastIp`, the `XTREAM_ALLOWED_CIDRS` check and stream sessions. A direct caller on the published API port cannot forge the header without the secret.
- `X-Forwarded-Host` (used for the CSRF `Origin` comparison and for generated Xtream/M3U URLs) is honoured only when `TRUST_PROXY=true` or the proxy secret matched.
- **`TRUST_PROXY`** (default `false`) makes Fastify honour `X-Forwarded-For`. Set **`TRUSTED_PROXY_CIDRS`** (comma list, e.g. `172.18.0.0/16`) together with it to trust the header only from those proxies; without the list `TRUST_PROXY=true` trusts every hop, which is only safe when the API port is not reachable except through your proxy.

## External clients (Xtream / M3U / extension)

- Separate credentials per client: generated username and 24-char random password (≈143 bits). Stored as SHA-256 (high-entropy secrets do not need a slow KDF, and Xtream clients authenticate on every request).
- Plaintext shown once on create/rotate. Clients can be disabled, rotated or revoked; revoked credentials fail immediately.
- Xtream credentials never grant access to `/api` admin routes; admin sessions never satisfy Xtream routes.
- Credentials in URLs are redacted from logs (`redactUrl`: `/movie/u/p/…`, `password=`, `username=`, `token=`).
- Rate limit on Xtream/M3U API endpoints (`player_api.php`, `get.php`, `xmltv.php`, artwork): 300 req/min/IP. Stream URLs (`/movie/…`) have their own, higher limit of 3000 req/min/IP because players issue many range requests per playback.
- `XTREAM_ALLOWED_CIDRS` (default: RFC1918, loopback, link-local, CGNAT, ULA) restricts Xtream/M3U to trusted networks; set to `0.0.0.0/0` explicitly to open up. The IP is determined as described under "Client IP and the web proxy".

## API

- Every body/query/param validated with zod; unknown fields stripped.
- Body limit 1 MiB (Takeout upload 200 MiB on its own route).
- Errors return `{error, message}` without stack traces in production.
- Global rate limit 600 req/min/IP for `/api`.
- Response headers: JSON responses and streamed files carry `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; `/api` responses add `X-Frame-Options: DENY`. The web app sets `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` and a Content-Security-Policy (`default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'` and a few more). `'unsafe-inline'` remains in `script-src` because Next.js injects inline hydration scripts and nonces would force every page to render dynamically.
- Takeout import: the archive is streamed and aborted once the decompressed watch-history exceeds 256 MiB (`MAX_TAKEOUT_DECOMPRESSED`; the API answers 400 "This archive is too large to import"), so a zip bomb is never inflated in memory. The HTML parser is linear-time and ignores anchors longer than 4 KB.

## Filesystem

- All media paths are relative paths stored in the DB, joined with `resolveInside(root, rel)` which normalises, rejects `..`/absolute/NUL, and verifies the `realpath` stays inside the root. For a path that does not exist yet, the deepest existing ancestor is resolved and must also be inside the real root. A result equal to the root itself is rejected unless the caller passes `{allowRoot: true}`; eviction additionally refuses any `mediaDir` with fewer than two path segments, so a corrupt row can never delete a whole volume.
- Storage directories chosen in the setup wizard must be under `MEDIA_ROOTS_ALLOWED` (default `/media`), so the admin UI cannot be used to browse or write arbitrary host paths.
- Containers run as UID 1000 (`node`), with `no-new-privileges`, read-only root filesystem for api/web, `cap_drop: [ALL]`.

## Source URLs (SSRF)

- YouTube adapter only accepts allowlisted hosts; IDs are validated against strict regexes.
- Artwork fetched by the worker only from allowlisted image CDNs (`*.ytimg.com`, `*.ggpht.com`, `*.googleusercontent.com`). Redirects are followed manually (max 3 hops) and every `Location` is re-checked against the https + allowlist rules; the response must be `image/*` and is streamed with a 5 MiB cap.
- Sidecar `metadata.json` files are untrusted input (they live on user-writable disks). Library reconcile derives platform, id and URL from the canonical key (`youtube:<11-char id>`) and skips anything else; the downloader and `YouTubeAdapter.fetchMediaInfo` refuse any URL that is not a YouTube video URL; every file a sidecar references must be a plain filename (no `/`, `\`, `..` or NUL).
- Future generic adapters must use `assertPublicHttpUrl`: http/https only, resolves DNS and rejects loopback, private, link-local, CGNAT, multicast and metadata (169.254.169.254) addresses.
- yt-dlp and ffmpeg are spawned with argument arrays (`spawn(cmd, args, {shell:false})`). User input is always placed after `--` where the tool supports it (ffprobe is given an absolute path instead, since older builds reject `--`). ffmpeg/ffprobe run with `-protocol_whitelist file,pipe` so a crafted container cannot make them open network or concat/subfile URLs. Child processes start with a minimal environment (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `XDG_CACHE_HOME`, `TMPDIR`, `FFMPEG_PATH`, proxy/CA variables and `NOCON_YTDLP_*`); database, Redis and proxy secrets are not passed on.

## Secrets

- `.env` is git-ignored; `.env.example` has placeholders. `SESSION_SECRET` is not needed (tokens are random), but `POSTGRES_PASSWORD` must be set.
- Per-source cookie files for yt-dlp are uploaded with `PUT /api/sources/:id/cookies` and stored at `${DATA_ROOT}/secrets/source-<id>.txt` (file mode 0600, folder mode 0700), never on the media volume. The upload is limited to 1 MiB and must look like a Netscape cookies file. No route returns the path or the contents (sources only expose `hasCookies`), the activity log and API logs never contain them, and deleting the source deletes the file. See `docs/guides/sources.md#cookies`.
- Sidecar `metadata.json` files contain public video metadata only — no viewing history, no credentials.

## Network exposure

Only `web:3000` and `api:3001` are published. PostgreSQL and Redis are on an internal Docker network with no published ports. See `docs/guides/reverse-proxy.md` for HTTPS with Caddy.
