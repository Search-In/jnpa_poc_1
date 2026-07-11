# Operator & Admin Manual — UC-1 Vessel Traffic Management

For JNPA stakeholders operating the Digital Twin day-to-day. No engineering knowledge assumed; no command line needed to operate.

## 1. Who does what (roles)
Switch your role with the **Role** selector in the header. Each role re-scopes what you see:

| Role | Sees | Can edit |
|---|---|---|
| **JNPA Marine Ops** | Everything | Yes |
| **Terminal Operator** | Own terminal's berths and their calls | Yes |
| **Shipping Line** | Own vessels and their windows | No (read) |
| **Pilot Desk** | Pilotage queue, roster, DUKC windows | Yes |
| **Read-only Viewer** | Overview (for VIP/committee) | No |

> Scoping here is client-side over demo data; a live deployment enforces the same matrix server-side on every request.

## 2. The screens
- **3D scene** (default): live vessel positions, anchorage, channel, berths, pilot station.
- **2D/3D toggle**: flip to the flat AIS map.
- **KPI Wall**: the six marine KPIs (JIT %, pre-sailing / pre-berthing delay, avg TAT, port-craft, prediction accuracy). Every number is a **simulated result / target**, labelled as such.
- **5-Day Berthing**: the berth × time Gantt with DUKC go/marginal/no-go shading. Turn on **What-if replan** (Marine Ops / Terminal / Pilot) to drag a call; invalid drops are rejected with the reason.
- **Plan Import**: upload a CSV (or paste), or add a call by hand. Bad rows are rejected with a line + reason.
- **DUKC / RTUKC**: predictive under-keel windows (DUKC) and the live readout during a transit (RTUKC).
- **Port Craft**: pilots/tugs/mooring as finite resources, with conflicts and a swap suggestion.
- **What-If**: run a scenario (monsoon hold, draft restriction, berth outage, pilot shortage, bunching) and read the Reactive Causality Guide.
- **Workflows**: compose automation rules (below) and watch the ledger fire.
- **Analytics & JIT**: JIT arrival advice, occupancy heat calendar, waiting-time distribution, terminal TAT, and the **Optimise** button.
- **Connectors**: the go-live status of every data source.
- **Reports**: printable/exportable Berthing Plan and Arrivals & Departures.
- **Methodology**: the assumptions register with sources.

## 3. Importing a berthing plan
1. **Plan Import** tab → **Choose file** (CSV) or paste rows, then **Import**.
2. Required columns: `BERTH_ID, MMSI, VESSEL_NAME, PLANNED_START, PLANNED_END` (`STATUS`, `PLAN_ID` optional).
3. Dates accepted: `DD-MM-YYYY HH:mm`, ISO (`2026-07-11T06:00`), epoch ms, or Excel serial — all read as **IST**.
4. Any row that can't be parsed is listed with its line number and the fix. Nothing is silently dropped.
5. Imported calls appear on the 5-Day Berthing Gantt.

## 4. Building an automation rule (no code)
1. **Workflows** tab → **Workflow composer**.
2. Name the rule. Set the **WHEN** trigger (a metric, a comparator, a value).
3. Optionally add **AND** conditions.
4. Add one or more **THEN** actions (notify a role / raise alert / propose replan / hold pilotage).
5. **Save**. Editing a saved rule bumps its **version**. Toggle **enabled/disabled** any time.
6. Governance: the **ADVISORY/AUTO** switch in the ledger decides whether firing rules only propose (human signs off) or auto-apply.

## 5. Admin tasks
- **Thresholds / targets**: KPI targets live in `src/config/targets.ts`; assumptions in `src/config/assumptions.ts` with sources shown on the Methodology page. (A UI editor for these is a planned admin addition.)
- **Connectors**: bring a source live by providing its credential and following its go-live checklist on the **Connectors** tab (credentials → sandbox → contract test → shadow → cutover).
- **Branding / port parameters**: configured at deploy time (see `docs/DEPLOYMENT.md`).

## 6. Data provenance (always visible)
The **DATA_MODE chip** is always on and shows **SIMULATED / REPLAY / LIVE** plus the worst source rung. Every report and export prints its data mode and generation time. If you ever see a figure without a provenance label, treat it as a defect.

## 7. Troubleshooting runbook (top issues)
| Symptom | Cause | Fix (no vendor call) |
|---|---|---|
| Map is blank | ArcGIS token expired / offline | The app auto-falls back to an offline basemap; add `?offline=1` to force it. Renew the token in deploy config. |
| "credential absent" on a connector | Live key not provisioned | Provide the key per the Connectors go-live checklist; until then the source runs on mock. |
| An imported plan row didn't appear | Row was rejected | Check the "Rejected rows" list on Plan Import for the line + reason (usually a date format). |
| A drag on the Gantt snapped back | The move violated a constraint | Read the ⛔ alert — it names the conflict (e.g. berth-time overlap). Choose a free slot/berth. |
| KPIs show 0 / empty | No data yet (fresh install) | Expected empty state; values populate as vessels berth. Not an error. |
| Vessel jumped / disappeared | Bad AIS fix was quarantined | The data-quality firewall drops teleports/null-island/duplicates. Check the Connectors DQ counts. |
| Workflow rule never fires | Rule disabled or threshold not met | Confirm it's **enabled** and the trigger metric actually crosses the threshold. |
| Feed dropped mid-session | Network blip | AIS auto-reconnects with backoff; the DATA_MODE chip shows the degraded rung until it recovers. |
| Page lost my state on refresh | — | Sim clock, scenario, camera, role, imported plan, and rules are restored automatically; other view state resets by design. |
| Numbers look too good | Misreading provenance | All improvement figures are **simulated under stated assumptions / targets**, never JNPA baselines. See Methodology. |

For deployment, backup/restore, and security, see `docs/DEPLOYMENT.md`, `docs/DR_BACKUP.md`, and `docs/SECURITY.md`.
