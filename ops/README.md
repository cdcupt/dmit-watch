# ops/ — deploy assets for the public stock board

Generic, secret-free templates for the two hosts involved in the public board
(TECH §6). Real values (ports, tokens) live only on the boxes, never in the repo.

## Board host (runs `board-server/`)

| File | What it is |
|------|------------|
| `vps-stock-compose.yml` | Container definition: stock `node:24-alpine`, bind-mounts `board-server/` read-only at `/app` and a writable `data/` dir at `/data`, loopback-only port map, memory/cpu caps, `/healthz` healthcheck. |
| `vps-stock.env.example` | Template for the box-local env file (`PUSH_TOKEN`, `PORT`, `SNAPSHOT_FILE`). Copy to `vps-stock.env`, fill in a fresh token, `chmod 600`. |
| `vps-stock.caddy` | Vhost snippet for the shared Caddy edge: one site block reverse-proxying to the container's loopback port. Import it from the main Caddyfile; restart (not reload) the edge. |

Deploy order: copy `board-server/` + compose file → create the env file →
`docker compose up -d` → verify `/healthz` locally → wire the Caddy snippet →
restart the edge → smoke-test every tenant domain.

## Watcher host (runs the watcher itself)

| File | What it is |
|------|------------|
| `systemd/dmit-watch-chrome.service` | Dedicated headless Chrome on CDP `127.0.0.1:9444` — the same flags `scripts/start.sh` uses, with Linux paths. Runs as the dedicated `dmitwatch` user (keeps Chrome's sandbox; no `--no-sandbox`). |
| `systemd/dmit-watch.service` | The node watcher, `After=`/`Requires=` the Chrome unit, `Restart=on-failure`. Repo checkout at `/opt/dmit-watch`; push URL + token in the service user's `~/.dmit-watch/config` (chmod 600). |

Both units install with `cp` to `/etc/systemd/system/`, `systemctl daemon-reload`,
then `systemctl enable --now dmit-watch-chrome dmit-watch`.
