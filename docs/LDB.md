# NLDS Logistics Data Bank — container track

**What it is.** Track-by-container-number against NLDS/LDB's public API, the same
data behind `https://ldb.co.in/ldb/searate/44/<container>`. It gives a container's
ocean leg — carrier, origin/destination, ETD/ETA, milestones, vessel leg, route
path and demurrage counters.

**Where it appears.** Vessels ▸ **Track by Container**.

**Auth.** Mobile **OTP**, exactly as ldb.co.in's guest "searate" UI does it. There
is no long-lived API key to provision: the operator verifies a mobile number in
the app, and the resulting JWT tracks **any** container until it expires.

---

## Data path

```
browser  →  /ldb-proxy/…  →  https://ldb.co.in/apigateway/…
 (relative, same-origin)     Vite plugin in dev · nginx in production
```

LDB sends no usable CORS header for our origin, and its Azure App Gateway WAF
**403s a forwarded localhost `Origin`/`Referer`**, so the browser never calls it
directly. Dev uses a custom middleware plugin (`ldbDevProxy()` in
`vite.config.ts`) that re-fetches with clean same-site headers — chosen over
`http-proxy` header overrides because the WAF also inspects `Accept`. Production
needs the equivalent at `deploy/nginx.conf` (`location /ldb-proxy/`); without it,
every track request 404s.

## The three calls

```
1. GET  {proxy}/apigateway/otp-sms/generate?mobileNo=…            → LDB sends an SMS
2. GET  {proxy}/apigateway/otp-sms/verify?mobileNo=…&otp=…        → { jwtToken }
3. POST {proxy}/apigateway/track/cntr/?cntrNo=…&mobileNo=…        → the track
   Authorization: Bearer <jwtToken>
```

Step 3 is a **POST with an empty body** and query parameters — matching LDB's own
Angular client, which rejects a GET. The JWT is **mobile-scoped** (claim
`mobileNo`), not container-scoped, so one verified session serves every lookup
until LDB answers 401.

The token is held in `sessionStorage` under `searateToken` — the same key LDB's
own app uses, so a token pasted from a real LDB tab works as a bootstrap.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITE_LDB_ENABLED` | `true` | Master switch. `false` → no request is made at all. |
| `VITE_LDB_PROXY_BASE` | `/ldb-proxy` | Relative prefix. Keep it relative — an absolute origin reintroduces CORS *and* the WAF block. |
| `VITE_LDB_ACCESS_TOKEN` | *(empty)* | Optional bootstrap `searateToken`, pasted from an LDB tab. Prefer in-app OTP, which writes the same key. Vite **inlines** this into the bundle — never a long-lived shared credential. |
| `VITE_LDB_MOBILE_NO` | *(empty)* | Pre-fills the OTP form. |
| `VITE_LDB_SAMPLE_FALLBACK` | `true` | Serve the bundled sample when a live call fails — **only for CCLU7468361**, see below. |

## Fallback semantics

The sample is served **only for `CCLU7468361`**, the one container it actually
describes. Any other number returns the real error instead, because answering a
different number with that container's journey would be a fabricated record
presented as a lookup result.

**Auth failures are never answered with a sample** — they are re-thrown, because
"verify your mobile number" is the one failure an operator can act on.

When the sample *is* served, the reason is classified
(`src/data/ldb/failure.ts`) and named in the notice above the track card:

| Reason | Notice says | Typical cause |
|---|---|---|
| `disabled` | switched off in this build | `VITE_LDB_ENABLED=false` |
| `unauthorized` | session expired or never verified | (normally re-thrown, not seen here) |
| `lookup-failed` | LDB unreachable or replied with something unusable | proxy missing, WAF block, network, non-JSON body |
| `empty` | no record for this container | LDB answered, has nothing |
| `error` | the live call failed | anything else — raw message under *Technical details* |

## Proving the live path

The trap: **with `VITE_LDB_SAMPLE_FALLBACK=true`, a failure for CCLU7468361 looks
exactly like a success.** The panel fills with a plausible track either way. So
the live path is only proven with the fallback **off**.

1. Set `VITE_LDB_SAMPLE_FALLBACK=false` and restart the dev server (Vite inlines
   `import.meta.env` at start — editing `.env` alone changes nothing).
2. Confirm the proxy exists on the tier you are testing: the `ldbDevProxy()`
   plugin for dev, `deploy/nginx.conf` for production.
3. Verify a mobile number through the OTP form and track `CCLU7468361`.
4. Check **both**: the amber "Showing bundled sample data" notice is **absent**,
   and the data differs from `src/data/ldb/sample.ts` (JNPT → Shanghai on OOCL
   "XIN SHANGHAI"). Identical output means you are still on the sample.
5. Track a *second*, different container — a live session must resolve it too.
6. Re-enable `VITE_LDB_SAMPLE_FALLBACK=true` for the demo, so a venue-network
   failure degrades to a labelled sample rather than an error.
7. Re-run the LDB test cases: TC-024, TC-025, TC-057, TC-090, TC-116, TC-117.

**Env-key mapping across the three apps** — the same LDB source, three naming
conventions. Note the other two still use a static key, not OTP:

| App | Base/proxy | Credential | Notes |
|---|---|---|---|
| UC-1 (this repo) | `VITE_LDB_PROXY_BASE` | OTP session (`searateToken`) | `VITE_LDB_ACCESS_TOKEN` is a bootstrap only |
| UC-2 (`jnpa_poc_2`) | `LDB_URL`, `VITE_LDB_API_BASE` | — | Origin spoof is **dev-server-only**; deployed builds need a reverse proxy |
| UC-3 (`jnpa-uc3-poc`) | `LDB_BASE_URL` | `LDB_API_KEY` | Currently 100 % MOCK; neither var is in its `.env.local.example` |

## Known limits

- Single-container lookup only — no bulk, no watchlist.
- Nothing is persisted; each search is a fresh call.
- The OTP session lives in `sessionStorage`, so it does not survive a tab close.
- The bundled sample covers one container only (see *Fallback semantics*).

## Verifying by hand

```bash
# Through the dev proxy — expect an OTP-gated 401 without a bearer:
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'http://localhost:5173/ldb-proxy/apigateway/track/cntr/?cntrNo=CCLU7468361&mobileNo=<no>'

# With a searateToken copied from sessionStorage:
curl -s -X POST -H "Authorization: Bearer $SEARATE_TOKEN" \
  'http://localhost:5173/ldb-proxy/apigateway/track/cntr/?cntrNo=CCLU7468361&mobileNo=<no>' \
  | head -c 400
```
