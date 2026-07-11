# Deployment Guide — UC-1 (spec D-1)

The app is a static single-page application. It can be served by any static host or by the bundled Docker image. Default mode is **mock** — it runs fully with **no credentials**.

## Option A — Docker (recommended)
Requirements: Docker + Docker Compose on a clean Ubuntu server.

```bash
docker compose up -d          # builds the image, serves on :8080 (non-root)
curl -s localhost:8080/health # {"status":"ok","service":"uc1-vtms"}
```

- The container runs as the unprivileged `nginx` user, read-only root FS, `no-new-privileges`.
- **Air-gap**: `docker compose build` bundles all app assets and the base images into the image; no network is needed at run time. Build once on a connected machine, `docker save`/`load` the image into the air-gapped environment.

## Option B — Static host
```bash
npm ci
npm run build         # → dist/
# serve dist/ with any static server / CDN / nginx
```

## TLS
Terminate TLS at a reverse proxy (nginx/Caddy/Traefik) or your load balancer in front of port 8080. Provide your own certificate; renew before expiry (a 14-day-prior warning appears on the System Health page — see D-2). Example nginx front-end: proxy_pass to `http://uc1-vtms:8080`, add HSTS.

## Hardware sizing (guidance)
Static SPA — modest. For a single-site JNPA command centre:
- **CPU** 2 vCPU · **RAM** 2 GB · **Disk** 5 GB (image + logs).
- Scales horizontally behind the proxy; the bundle is cache-friendly (hashed immutable assets).

## Configuration
Build-time env (`.env`, all optional; blank = mock):
| Var | Purpose |
|---|---|
| `VITE_DATA_MODE` | `mock` (default) / `live` |
| `VITE_AISSTREAM_TOKEN` | AISStream live AIS |
| `VITE_STREAM_LAYER_URL` | ArcGIS Velocity stream layer |
| `VITE_WEATHER_FEED_URL` | live weather feed |
| `VITE_ARCGIS_API_KEY` / `VITE_OAUTH_APPID` | ArcGIS private items (only if used) |

> Bringing a source live: provide its credential, then follow the go-live checklist on the **Connectors** tab. Until then that source runs on the mock driver and the twin keeps working.

## Update / rollback (D-4)
- Versioned image tags (`uc1-vtms:<version>`). Deploy a new tag; roll back by re-pointing to the previous tag.
- No database migrations in the SPA tier. A staging profile = a second compose stack on a staging host to rehearse updates.
