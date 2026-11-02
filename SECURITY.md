# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (a private security advisory). Please do not open a public issue or pull request for a security problem.

Include what you found, the version or commit, how to reproduce it, and the impact you expect. NoConMedia is a small project run on a best-effort basis, so there's no fixed time for a reply or a fix. Reports are read, and confirmed security issues come before other work.

## Supported versions

Only the latest commit on `main` is supported. There are no maintained release branches yet.

## In scope

- Authentication and sessions for the administrator, including the setup wizard.
- The Xtream, M3U and browser-extension logins, and anything that lets one kind of login reach another's routes.
- Path traversal or reading and writing files outside the configured media and data folders.
- Command or argument injection into yt-dlp, ffmpeg or ffprobe.
- Server-side request forgery through source addresses, and CSRF.
- Credential leaks in logs, API responses or backups.
- Container hardening problems in `compose.yml` or the Dockerfiles.

## Out of scope

- Problems that need an attacker who already has administrator access, or shell access to the host.
- Findings that only apply when the deployment advice below is ignored, such as publishing the API port to the internet with no proxy.
- Denial of service by an authenticated administrator against their own server.
- Vulnerabilities in yt-dlp, ffmpeg, Docker, PostgreSQL or Redis themselves. Report those upstream.
- Missing security headers or best-practice suggestions with no demonstrated impact.

## Deployment advice

NoConMedia is built for one administrator on a trusted network.

- Run it on your LAN or behind Tailscale. That is the default and the supported setup.
- Do not expose the web port (3000) or the API port (3001) directly to the internet. If you need remote access, put a reverse proxy with HTTPS in front, bind the ports to `127.0.0.1` with `WEB_BIND` and `API_BIND`, and follow [docs/guides/reverse-proxy.md](docs/guides/reverse-proxy.md).
- Set `TRUST_PROXY=true` only when a reverse proxy sits in front and the API port is not reachable directly. Otherwise clients can forge `X-Forwarded-For`.
- Use long random values for `POSTGRES_PASSWORD` and `NOCON_PROXY_SECRET`, and keep `.env` readable only by you (`chmod 600 .env`).
- Give each Xtream or M3U device its own login so it can be revoked on its own, and use `XTREAM_ALLOWED_CIDRS` to limit which networks can use them.

The design is described in [docs/security.md](docs/security.md).
