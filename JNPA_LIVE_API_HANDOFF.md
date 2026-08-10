# JNPA LIVE Port-Data API — hand-off for PoC-1 (UC-I Vessel & Berth)

> Task file for a Claude Code session in THIS repo. The UC-3 repo
> (`../jnpa-uc3-poc`) has already proven the live path end-to-end and fixed its
> own deployment/backend/frontend gaps. This file carries everything that
> session learned, so PoC-1 can be brought onto the LIVE APIs the same way.

## 1. Connectivity — verified facts (2026-08-06)

- JNPA's PoC data API base: `https://dt.jnpa.in/poc-api-data-access` (client
  must call `…/v2/...`; a configured base ending in `/v2` should be stripped —
  spec defect D1).
- The API **allowlists the remote desktop's static IP**. That egress is reachable
  through a **SOCKS5 proxy on the jnpa3 EC2** (`i-0ef6b078c0257a4d2`,
  public `65.2.212.121`, private `172.31.37.14`), port **1080**
  (an SSH reverse tunnel bound to 127.0.0.1 on the EC2, re-exposed on the
  private interface via `socat TCP-LISTEN:1080,bind=172.31.37.14,fork,reuseaddr
  TCP:127.0.0.1:1080`).
- Proxy URL to use:
  - from a laptop / anything outside AWS: `socks5://65.2.212.121:1080`
  - from a process **on the EC2**: `socks5://localhost:1080`
  - from a **Docker container on the EC2**: `socks5://172.31.37.14:1080`
    (`localhost` inside a container is the container itself — this bit UC-3).
- Verified working (HTTP 200, ~0.5 s):

  ```bash
  curl --socks5-hostname 65.2.212.121:1080 \
    -X POST "https://dt.jnpa.in/poc-api-data-access/v2/auth/token" \
    -H "Content-Type: application/json" \
    -d '{"clientKey": "<ISSUED_CLIENT_KEY>"}'
  ```

- Auth: client key → bearer valid exactly 3600 s; org **Keltron**, scopes
  `groups:read`, `files:read`. The issued key lives in the UC-3 repo's
  `.env.local` (`JNPA_PORTDATA_CLIENT_KEY`) — copy it from there or from the
  team vault. **Never commit it** (NOTICE_API_ACCESS.md violation; UC-3 had to
  scrub one from `gateway/config.py`).

## 2. Live-server quirks UC-3 already hit (defend the same way)

- **ETag `-gzip` suffix**: the front-end gzips on the fly and answers
  `ETag: "<sha256>-gzip"` (Apache mod_deflate convention). Compare checksums on
  the **base hash** and log the deviation; don't hard-fail (the body sha256
  matches the record's `checksumSha256` exactly).
- Timestamps with `+05:30` must be percent-encoded on the wire (`%2B`) — send
  through a proper query encoder, never pre-encoded, never raw (defect D22).
- `429` carries no `Retry-After` (defect D6) — blind 60 s + jitter wait.
- `nextCursor` is opaque; pass back verbatim (defect D13).
- Report groups answer a 5-field envelope without the pagination trio (D9).
- If Python/httpx is used for a `socks5://` proxy, the **`socksio` package is
  required at runtime** (`httpx[socks]`) — plain `httpx` raises ImportError.
  UC-3 pinned `httpx[socks]==0.27.*` in its gateway image.

## 3. What PoC-1 consumes

UC-1's data comes from two directions — audit BOTH in this repo:

1. **Direct JNPA API ingest (if this repo has its own client/sync):** the
   marine-relevant groups are `nlp-marine` (vessel spine: profile, call info,
   berth request/allotment, arrival/departure — live matched≈1260 records),
   `port-craft-pilot` (pilot memos, craft allocation), `berthing-reports`
   (report group, JSON per terminal/date), `bathymetry` (static — served
   empty; the sample-pack dump is the source). Wire env-driven config:
   `JNPA_PORTDATA_API_URL`, `JNPA_PORTDATA_CLIENT_KEY`, `JNPA_PORTDATA_PROXY`
   (+ timeout/retries/rate budget), and make sure the deploy (compose/systemd)
   actually passes them into the runtime — UC-3's compose passed nothing until
   fixed.
2. **Via the UC-3 gateway (shared backend):** UC-3 ingests all marine groups
   into `core.vessel_call`, `vessel_call_event`, `pilotage`, `port_craft`,
   `sea_channel`, `bathymetry_sounding`, `berthing_record` etc., and serves
   them at `/api/marine/*`, `/api/berthing/*` plus the integration surface
   `/api/integrations/jnpa/{health,runs,records,defects,report-snapshots}`.
   Those endpoints currently have **zero consumers inside the UC-3 repo** —
   they were built for PoC-1's status card / marine screens. If PoC-1 reads
   the UC-3 gateway, point it at the UC-3 gateway URL and consume from there
   instead of re-ingesting.

## 4. Tasks for this session

1. Locate this repo's JNPA API client / ingest layer (grep for `dt.jnpa.in`,
   `jnpa`, `portdata`, `clientKey`). Determine which of §3's two modes applies.
2. Wire the live config end-to-end (env vars → runtime → deploy files), with
   the proxy URL per environment as in §1. Add `.env.example` entries; never
   hardcode the key or URL in business code.
3. If Python+httpx: add `httpx[socks]` / `socksio` to the dependency manifest
   baked into the image that runs the client.
4. Smoke-test live through the tunnel (UC-3 has a reusable pattern:
   `jnpa-uc3-poc/scripts/jnpa_live_check.py` — auth, groups catalogue, one
   records page per group, report groups, file download + sha256 + 304
   revalidation). Port or adapt it here for the marine groups.
5. Audit for received-but-unrendered fields on the UC-1 dashboards (UC-3 found
   whole sections dropped silently) and fix or document the gaps.
6. Report: what was wired, what passed live, remaining gaps.

## 5. Operational cautions

- The EC2 SG inbound rule for port 1080 should be restricted to known source
  IPs (an open SOCKS proxy = anyone can egress via JNPA's allowlisted IP).
- The `socat` forwarder on the EC2 is a `nohup` process — it dies on reboot;
  re-run it (or install a systemd unit) after any restart.
- Client-side rate budget: stay under the documented 120 req/min (UC-3 uses
  100/min); the API deliberately slows bad-key auth attempts (~250 ms).
- JNPA's 31-Jul-2026 notice REQUIRES observed API defects to be reported —
  log/record deviations (UC-3 persists them in `core.api_defect_log` and
  serves `/api/integrations/jnpa/defects?format=md`).
