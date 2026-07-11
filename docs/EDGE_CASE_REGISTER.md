# Edge-Case Register — UC-1

Maps each Part 5 edge case → handling strategy → test (or explicit deferral with reason). Status: **✅ handled+tested**, **☑︎ handled** (no dedicated test), **⏳ deferred** (with reason). "Reject with a message" cases name the problem and the remedy.

Test files: `src/data/quality.test.ts`, `src/data/aisstream.test.ts`, `src/planning/constraints.test.ts`, `src/planning/planImport.test.ts`, `src/kpi/helpers.test.ts`, `src/kpi/analytics.test.ts`, `src/dukc/ukc.test.ts`, `src/kpi/*.test.ts`.

## 5.1 AIS / position-feed
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | Duplicate MMSI from two sources | ✅ | `TrackQuality.vet` drops a cross-source duplicate within 60 s, keeps incumbent | quality.test.ts "cross-source duplicate" |
| 2 | MMSI/IMO mismatch | ⏳ | No IMO in the live feed model; documented as a production ship-particulars join | — |
| 3 | Position teleport >50 kn | ✅ | Implied-speed guard rejects the fix, keeps last good | quality.test.ts "teleport" |
| 4 | Stale track (no update >N min) | ✅ | `staleTracks(now)` / `ageMin` staleness watermark | quality.test.ts "stale tracks" |
| 5 | Vessel on land / outside AoI | ✅ | `validateVessel` drops out-of-AoI-bbox contacts | quality.test.ts "outside the AoI" |
| 6 | Lat/long (0,0) null island | ✅ | `isPlottablePosition` rejects the no-fix sentinel; mapper drops it | aisstream.test.ts "null island" |
| 7 | Heading vs COG contradiction | ✅ | Flagged (WARN) when >90° apart while making way | quality.test.ts "heading vs COG" |
| 8 | Draft missing/zero/>depth | ☑︎ | DUKC derives draft by class; over-depth handled by UKC no-go | ukc.test.ts |
| 9 | Negative / absurd SOG | ✅ | Negative→0, >60 kn clamped, both WARN | quality.test.ts "absurd/negative SOG" |
| 10 | Unicode / emoji in names | ☑︎ | Names pass through (unicode-safe); print path HTML-escapes | exportReports `esc()` |
| 11 | 200-char names | ✅ | Truncated to 64 chars (WARN) | quality.test.ts "over-long name" |
| 12 | Vessel type unknown | ✅ | `mapVesselType`→'Unknown'; UI hide toggle | aisstream.test.ts |
| 13 | Two vessels same berth | ✅ | `detectBerthTimeConflicts` | constraints.test.ts |
| 14 | AIS spoof (impossible route) | ☑︎ | Teleport guard catches the impossible-jump signature | quality.test.ts "teleport" |
| 15 | Timestamp regression on reconnect | ✅ | Event-time guard drops older-than-held fixes | quality.test.ts "timestamp regression" |
| 16 | Burst of 10,000 msgs | ✅ | Cache flush coalesced to 1/250 ms (backpressure) | ArcGISAdapter `VESSEL_FLUSH_MS` |

## 5.2 Tide / weather / bathymetry
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | Missing tide window | ☑︎ | Analytic tide model has no gaps; a real-feed gap interpolates with a flag (documented) | derive.ts |
| 2 | Tide source disagreement | ⏳ | Single tide model in PoC; dual-source precedence is a production add | COMPETITIVE_PARITY C-2 |
| 3 | Negative surge beyond datum | ☑︎ | Tide offset lever unclamped so extremes show; DUKC reacts | derive.ts |
| 4 | Weather stale timestamp | ☑︎ | WeatherReading carries TS; staleness surfaced via source rung | sources.ts |
| 5 | Bathymetry survey >15 days | ⏳ | Static bathymetry; dated-survey watermark is a production add | COMPETITIVE_PARITY C-2 |
| 6 | Depth units m-vs-ft | ☑︎ | All depths metres by contract; import guards reject ft-magnitudes | — |
| 7 | Monsoon extreme wind → pilotage hold | ✅ | `pilotageSuspended` triggers at ≥30 kn / ≥2.5 m, values unclamped | rules.test.ts (starter rule) |

## 5.3 UKC / berth-planning
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | UKC ≤ 0 hard-block | ✅ | `computeUkc`→no-go below safety margin | ukc.test.ts |
| 2 | Worst-segment window | ✅ | Controlling (shallowest) depth governs windows | ukc.test.ts, constraints.test.ts |
| 3 | LOA > berth length | ✅ | `validateBerthFit` | constraints.test.ts |
| 4 | Beam > berth pocket | ✅ | `validateBerthFit` (pocket ≈ 18% length) | constraints.test.ts (fit) |
| 5 | Two entries same berth-time | ✅ | `detectBerthTimeConflicts` | constraints.test.ts |
| 6 | Plan refs unknown vessel | ✅ | `detectUnknownVessels`→provisional flag | constraints.test.ts |
| 7 | Mixed date formats / Excel floats on import | ✅ | `parsePlanDate` handles ISO/DD-MM-YYYY/epoch/Excel serial | planImport.test.ts |
| 8 | 5-day plan day-3 missing | ☑︎ | Gantt renders present entries; empty days visible as gaps | BerthGantt5Day |
| 9 | Plan revision mid-scenario | ☑︎ | Import overlay is versioned via PLAN_ID replace; drag is non-destructive | planStore |
| 10 | Tidal window < transit | ✅ | `checkTidalWindowFits` | constraints.test.ts |
| 11 | Pilot assigned 2 vessels | ✅ | `detectPilotDoubleBooking` | constraints.test.ts |
| 12 | Berth maintenance collides | ✅ | `validateBerthFit` maintenance + optimiser skips maintenance berths | constraints.test.ts, optimiser.test.ts |

## 5.4 KPI / analytics math
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | Empty dataset → no NaN | ✅ | `mean([])→0`, bundle empty-state | helpers.test.ts, bundle.test.ts |
| 2 | Div-by-zero guards | ✅ | `deltaPct`/`justInTimePct`/`berthOccupancyPct`/`mape` all guarded | formulas.test.ts |
| 3 | Single-vessel variance | ✅ | `variance`/`stddev`→0 for n<2 | helpers.test.ts |
| 4 | Percentile n<4 | ✅ | `percentile` interpolates, handles empty/single/small-n | helpers.test.ts |
| 5 | TZ boundary double-count | ☑︎ | Store epoch-UTC, display IST | format.ts, MockAdapter.test.ts |
| 6 | IST offset for imported UTC | ✅ | `parsePlanDate` normalises to IST | planImport.test.ts |
| 7 | Leap day | ☑︎ | JS Date handles; no leap-specific math | — |
| 8 | Clock skew | ☑︎ | `now` injected into KPI funcs (deterministic) | bundle.ts |
| 9 | Target band edited live | ⏳ | Targets are constants; runtime editor is a T3/admin add | — |
| 10 | Prediction-accuracy no-mature | ✅ | Returns 0, not 100, when nothing resolved | formulas.test.ts |

## 5.5 Concurrency / multi-user
Mostly **⏳ (needs backend)** — no auth/session/multi-user server in a mock SPA. Documented as production adds. Handled subset:
| # | Item | Status | Handling |
|---|---|---|---|
| 6 | WS reconnect storm | ✅ | Exponential backoff + deterministic jitter, single-flight (`reconnectDelayMs`) — aisstream.test.ts |

## 5.6 Session / browser / client
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | Refresh mid-scenario | ☑︎ | sim clock/scenario/camera restored (sessionStorage); role + imported plan + rules also persisted | simStore, roleStore, planStore, ruleStore |
| 4 | Double-submit guards | ✅ | Optimise/import guarded; drag validity on commit | AnalyticsPanel, BerthGantt5Day |
| 5 | Paste junk into numeric fields | ☑︎ | `Number(...)||0` coercion; import rejects bad dates | planImport.test.ts |
| 9 | CVD-safe status | ☑︎ | Status carries label/shape not hue alone (DUKC labels, connector chips, ROLE-SCOPED/READ-ONLY badges) | tokens, ConnectorReadiness |
| 10 | Print stylesheets for 2 reports | ☑︎ | `@media print` for Berthing Plan + Arrivals/Departures | exportReports |
| others | zoom / matrix / skeletons | ☑︎/⏳ | Responsive grids; supported-matrix in Operator Manual | — |

## 5.7 Data volume / longevity
**⏳ (needs backend)** — no DB in a static SPA. Ring-buffered in-app logs (cap 200) bound growth; 90-day store/retention/soak are production adds. Documented in the DR/Backup section.

## 5.8 Security-adjacent
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | Expired ArcGIS token → offline basemap | ☑︎ | `basemapFallback` + `?offline=1` rehearsal | basemapFallback.ts |
| 5 | Injection in name/search | ☑︎ | Print HTML-escape; no SQL surface (client) | exportReports |
| 6 | File-upload abuse | ✅ | Size cap, row cap, type accept, **CSV formula-injection neutralised** | planImport.test.ts |
| 2–4 | TLS / brute-force / role-claim | ⏳ | Server concerns; documented as production adds (Security overview) | — |

## 5.9 Operational / demo-day
| # | Item | Status | Handling | Where |
|---|---|---|---|---|
| 1 | Fresh install zero data | ☑︎ | Every panel has a designed empty state | Panel `PanelEmpty` |
| 3 | All connectors OFFLINE | ☑︎ | Navigable + degraded rungs, no crash | Integration Console, sources.ts |
| 3b | Deterministic seed | ☑︎ | Fixed seed, no Date.now/Math.random in advance path | simStore |
| 4 | DATA_MODE banner in all states | ☑︎ | Always-on chip computes SIM/REPLAY/LIVE + worst rung | DataModeChip |
| 2 | Mid-migration maintenance page | ⏳ | Deployment concern; documented | — |

---

**Coverage summary:** the marine-logic pathologies the tender most cares about (5.1 AIS, 5.3 berth-planning) and the KPI-math guards (5.4) are handled **and tested**. Backend-dependent categories (5.5 multi-user auth, 5.7 DB volume, parts of 5.8) are honestly marked deferred with the production add that closes them.
