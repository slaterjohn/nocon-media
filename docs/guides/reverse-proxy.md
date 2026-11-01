# Reverse proxy and HTTPS

**The default recommendation is to keep NoConMedia on your LAN, over plain HTTP, with no reverse proxy.** The administrator login, external player passwords and video all travel unencrypted, which is acceptable on a home network you control. Add a reverse proxy only if you need HTTPS or want to reach the server from outside. If you do, put a VPN such as WireGuard or Tailscale in front of it before considering a public address.

This guide uses Caddy (automatic certificates) and nginx. Both run on the host, not in the compose stack. The compose `frontend` network has no route to the internet, so a proxy container on it could not obtain certificates.

## What is exposed

| Port | Service | Used by |
|---|---|---|
| 3000 | web | Browsers: the admin interface and web player. It proxies `/api/*` to the API internally. |
| 3001 | api | Xtream and M3U players (`/player_api.php`, `/get.php`, `/movie/...`), and the API itself. |

PostgreSQL and Redis are not published.

## Prepare .env

```text
WEB_BIND=127.0.0.1
API_BIND=127.0.0.1
COOKIE_SECURE=true
TRUST_PROXY=true
TRUSTED_PROXY_CIDRS=172.18.0.0/16
NOCON_PROXY_SECRET=<openssl rand -hex 32>
PUBLIC_XTREAM_URL=https://xtream.example.com
```

Apply the change:

```bash
docker compose up -d
```

### What each setting does

- **WEB_BIND / API_BIND.** `127.0.0.1` publishes the ports on the host's loopback only, so the proxy on the same host can reach them and nothing else on the network can. With `API_BIND=127.0.0.1`, LAN players can no longer use `http://host:3001`; they must use the proxied HTTPS name (point your router's DNS at the server so the name works inside the LAN).
- **COOKIE_SECURE.** Adds the `Secure` flag to the session cookie. Set it to `true` only when users reach the site over HTTPS. With `true` over plain HTTP, sign-in appears to succeed but the browser drops the cookie.
- **TRUST_PROXY.** Makes the API read `X-Forwarded-For` and `X-Forwarded-Host` from the proxy, so the Xtream network allow-list and rate limits see the real client address. Only enable it when a proxy sits in front of the API port and clients cannot reach that port directly. Otherwise a client can forge its address.
- **TRUSTED_PROXY_CIDRS.** Limits `TRUST_PROXY` to those proxy addresses. Without it, `TRUST_PROXY=true` trusts every hop. The address the API sees for a proxy on the host is usually the Docker gateway of the `frontend` network, not `127.0.0.1`. Find the subnet:

```bash
docker network inspect nocon-media_frontend --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

Then check it works: after a request through the proxy, the "Last used" IP for a player in **External players**, or a session in **Settings > Account and security**, should show the real client address. This variable is not in `.env.example`, but `.env` is passed to the API, so it works when added.
- **NOCON_PROXY_SECRET.** A shared secret that the bundled web container sends to the API alongside the browser's real address. The API believes that address only when the secret matches, so a direct caller on port 3001 cannot fake it. It is the same value on `web` and `api` and is set by compose from `.env`. It is separate from `TRUST_PROXY`, and both can be on. Browser logins use the secret; Xtream players, which reach the API directly, use `TRUST_PROXY`.
- **PUBLIC_XTREAM_URL.** The base address handed to players in generated server URLs, playlists, stream links and artwork links. Without it, the API derives it from the request's `Host` header.

One limit: the web container records the address of whoever connects to it. Behind a proxy, that is the proxy, so every browser user shares one sign-in rate-limit bucket (5 attempts a minute per address). Use the proxy's own rate limiting for the login page as well.

## Caddy

Install Caddy on the host and put this in `/etc/caddy/Caddyfile`, with your own names:

```text
nocon.example.com {
    reverse_proxy 127.0.0.1:3000
}

xtream.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy
```

Caddy passes the `Host` header through and adds `X-Forwarded-For`. Streaming and range requests work without extra options. The second block is only needed for Xtream and M3U players.

## nginx

For each site, with certificates from your own tooling (for example certbot):

```text
server {
    listen 443 ssl;
    server_name nocon.example.com;
    ssl_certificate     /etc/letsencrypt/live/nocon.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nocon.example.com/privkey.pem;

    client_max_body_size 200m;          # Takeout history import
    proxy_buffering off;                # stream video as it arrives
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 443 ssl;
    server_name xtream.example.com;
    ssl_certificate     /etc/letsencrypt/live/xtream.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xtream.example.com/privkey.pem;

    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Checking it

```bash
curl -I https://nocon.example.com/login
curl -s "https://xtream.example.com/player_api.php?username=USER&password=PASS"
```

The first returns HTTP 200. The second returns JSON for a valid player. Then sign in in a browser; if you are sent back to the login page, check `COOKIE_SECURE` and that you are on HTTPS. If every state-changing action returns a "csrf" error, the proxy is not passing the original `Host` header.

The Xtream endpoints are still limited to private networks by default. A public hostname used from outside the LAN also needs `XTREAM_ALLOWED_CIDRS` or the Settings list changed; see [External players](xtream-clients.md#restrict-by-network). Opening them to the internet is a decision to make carefully, as the player password is part of the URL.

This setup has not been exercised in the project's automated tests.
