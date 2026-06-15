# Go-Live & Dashboard Integration — JNPA VTMS

How to run this app on **real live data** and embed it in your existing ArcGIS
Online **Dashboard** (the one with your `imagery_hybrid` WebMap). Phased so you
get live vessels working first, then layer in port-operational data.

> **What "live, zero mock" means here**
> - **Vessels** — *real* AIS via your AISStream.io token (genuine vessel
>   positions in the Nhava Sheva box). ✅ Live today.
> - **Berths / berthing plan / port craft / KPI history** — no public source
>   exists; these come from Hosted Feature Layers you publish (seeded from
>   `seed/*.csv`, later synced to a real JNPA/TOS feed). Until published, the
>   dependent widgets show an empty state — they do **not** fall back to mock.

---

## Phase 1 — Live vessels on your imagery_hybrid map (~15 min)

### 1.1 Get three values from ArcGIS Online

| Value | Where to find it |
|-------|------------------|
| **WebMap item ID** | Open your imagery_hybrid **map** (the Map Viewer item, *not* the Dashboard). Its item page URL is `…/item.html?id=XXXXXXXXXXXX` — copy the `id`. |
| **API key** | ArcGIS Online → **Content → New item → Developer credentials → API key**. Scope it to **Basemaps** (+ Geocoding if you use search). |
| (token you already have) | AISStream.io token — already in your `.env`. |

> ⚠️ The Dashboard item id (`086aad29…`) is **not** the WebMap id. You need the
> map's id, which the Dashboard references internally.

### 1.2 Set `.env`

```dotenv
VITE_DATA_MODE=live
VITE_PORTAL_URL=https://www.arcgis.com
VITE_ARCGIS_API_KEY=<your basemap API key>
VITE_WEBMAP_ID=<your imagery_hybrid WebMap id>
VITE_AISSTREAM_TOKEN=<already set>
# leave VITE_STREAM_LAYER_URL empty → app uses the AISStream WebSocket
```

With `VITE_STREAM_LAYER_URL` empty and a token present, the `ArcGISAdapter`
opens the **AISStream WebSocket**, filters to the JNPA bounding box, and streams
real vessels. The map binds to your WebMap via `item-id={VITE_WEBMAP_ID}`, so
you get your imagery_hybrid basemap automatically.

### 1.3 Run

```bash
npm install
npm run dev      # http://localhost:5173
```

You should see **real vessels** moving on your imagery basemap, the **Vessel
Feed** populated, and the **Anchored / Approaching** KPI cards live. Delay / TAT
/ JIT / gantt cards will show an empty state until Phase 2.

> If you see no vessels: AISStream coverage is best-effort and the JNPA box can
> be quiet at times. Confirm the token is valid and widen the box in
> `src/data/aisstream.ts` (`JNPA_BBOX`) to sanity-check.

---

## Phase 2 — Publish the operational Feature Layers (real reference data)

These power Pre-Berthing/Pre-Sailing Delay, TAT, JIT, the gantt, port-craft, and
prediction widgets.

### 2.1 Publish the seed layers

```bash
ARCGIS_USER=<your AGO username> ARCGIS_PASS=<password> \
  npm run publish:layers
```

This uploads `seed/*.csv`, publishes each as a Hosted Feature Layer, and prints
the service URLs. Paste them into `.env`:

```dotenv
VITE_FS_BERTHS_URL=https://services…/JNPA_Berths/FeatureServer/0
VITE_FS_BERTHING_PLAN_URL=https://services…/JNPA_BerthingPlan/FeatureServer/0
VITE_FS_PORT_CRAFT_URL=https://services…/JNPA_PortCraft/FeatureServer/0
VITE_FS_KPI_SNAPSHOTS_URL=https://services…/JNPA_KPISnapshots/FeatureServer/0
```

The dependent widgets light up immediately. **This is real published data, not
mock** — but it's static seed data until 2.2 connects a live source.

### 2.2 Keep them current (the real-data step)

The seed layers are a starting snapshot. For authentic, continuously-updated
KPIs you need a **sync job** from JNPA's operational systems into these layers.
For each layer, tell the team the access method and I'll build the ingestion:

| Layer | Real source (to confirm with JNPA) | Update cadence |
|-------|-------------------------------------|----------------|
| Berths | Static terminal/berth register | one-time |
| **BerthingPlan** | **TOS / berth-planning / VTS export** (planned + actual berth/sail times) | every few min |
| PortCraft | Pilotage / marine-ops system | every few min |
| KPISnapshots | App computes + appends, or JNPA source | hourly |

Until 2.2 is wired, document to evaluators that operational layers are seeded
reference data; vessels are live.

---

## Phase 3 — Production AIS via ArcGIS Velocity (post-award upgrade)

When a licensed feed (e.g. **Kpler AIS**) and a **Velocity** subscription are
available, swap the free fallback for the supported pipeline:

1. In **Velocity**, create a feed from the AIS source (key on **MMSI**).
2. Build a real-time analytic → **Stream Layer** (live) + **spatiotemporal
   Feature Layer** (history).
3. Set in `.env`:
   ```dotenv
   VITE_STREAM_LAYER_URL=https://…/StreamServer
   VITE_FS_VESSELS_URL=https://…/FeatureServer/0
   ```
   With `VITE_STREAM_LAYER_URL` set, the app uses the Stream Layer instead of
   AISStream. No UI code changes. The Stream Layer is also added to the map, and
   its layerview feeds positions back to the KPI engine (`pushStreamGraphic`).

---

## Phase 4 — Embed into your Dashboard

### 4.1 Build & host

```bash
npm run build      # → dist/  (base is "./", embed-path safe)
```

Host `dist/` on HTTPS — required for OAuth + the AIS WebSocket. Options:
- ArcGIS Online: **Content → New item → Application** → host the build (or use
  ArcGIS Enterprise / any HTTPS static host: Netlify, S3+CloudFront, etc.).
- Register the hosted URL as an **app item** in your org.

### 4.2 Add to the Dashboard

In your Dashboard → **edit → add element → Embedded Content** → point the URL at
your hosted app. Size it to a full panel. Because the app reads the **same
WebMap** (`VITE_WEBMAP_ID`) the Dashboard uses, vessel/berth context stays
consistent across both.

> **Cleaner long-term alternative:** wrap these components as an **Experience
> Builder** custom widget instead of an iframe — it shares the portal OAuth
> session and the same items, avoiding a second login.

---

## Phase 5 — Auth for org items (needed once you query private layers)

If your Feature Layers are **not** shared publicly, add OAuth so named users sign
in (no secrets in the bundle):

1. ArcGIS Online → **Content → New item → Application → register**.
2. Add **Redirect URIs**: `http://localhost:5173` (dev) and your prod host.
3. Set `VITE_OAUTH_APPID=<App ID>`. The app uses ArcGIS `IdentityManager`
   (OAuth 2.0, named user) for org items; the API key stays basemap-only.

(If you share the Feature Layers publicly within your org's sharing policy, you
can skip OAuth for the PoC — the API key + public layers suffice.)

---

## Quick reference — `.env` by phase

| Var | Phase 1 (live vessels) | Phase 2 (KPIs) | Phase 3 (Velocity) |
|-----|:---:|:---:|:---:|
| `VITE_DATA_MODE=live` | ✅ | ✅ | ✅ |
| `VITE_WEBMAP_ID` | ✅ | ✅ | ✅ |
| `VITE_ARCGIS_API_KEY` | ✅ | ✅ | ✅ |
| `VITE_AISSTREAM_TOKEN` | ✅ | ✅ | (unused) |
| `VITE_FS_*_URL` | — | ✅ | ✅ |
| `VITE_STREAM_LAYER_URL` / `VITE_FS_VESSELS_URL` | — | — | ✅ |
| `VITE_OAUTH_APPID` | if private layers | if private layers | if private layers |

## Security note
All `VITE_*` vars are build-time and ship in the client bundle — only ever put
**public** keys / item ids there. The AISStream token and a basemap-scoped API
key are acceptable; **never** put a named-user password or a privileged key in
`.env`. `ARCGIS_USER` / `ARCGIS_PASS` are used only by the publish script at the
command line and are never bundled.
```
