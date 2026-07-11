# UC-1 LOOP 2 — HARDENING LOG (Track A, mock-data-primary)

Running log of Loop 2 changes. Scope decision: **Track A** (build everything achievable in the SPA over mock stores; document backend-only items as "production adds"). Each entry is a self-contained, test-accompanied change; the app stays runnable throughout. Gates recorded per tier.

Baseline at Loop 2 start (2026-07-11): `tsc -b` clean · **56/56 tests** · ESLint 0 warnings · `npm audit`: 8 vulns (2 critical / 1 high / 5 moderate).

---

## TIER 0 — crash / corrupt-data / silently-mislead / block-install

**Goal:** remove anything that can corrupt the twin, mislead a viewer, or fail a security gate before any feature work.

### T0.1 — Build-chain CVE remediation → 0 vulnerabilities
- **Bumped `vitest` 2.1.9 → 3.2.7 and `@vitest/coverage-v8` → 3.2.7** (`package.json`). This cleared the dev/test-chain advisories that were pulled in via vitest's bundled `vite@5.4.21` / `esbuild@0.21.5`:
  - CRITICAL — `vitest <3.2.6`: arbitrary file read/execute when the Vitest UI server is listening.
  - HIGH — `vite <=6.4.2`: `server.fs.deny` bypass on Windows alternate paths.
  - MODERATE ×3 — esbuild dev-server request reflection; vite optimized-deps path traversal; launch-editor NTLMv2 disclosure.
  - These never shipped in `dist/` (dev-only), but failed a naive `npm audit` / any CI gate. The 2→3 major bump was verified non-breaking: **all tests still pass** under vitest 3.2.7, coverage still runs.
- **Removed unused dependency `@arcgis/charts-components@4.34.9`** (`package.json`). It was the *only* source of the remaining production-reaching advisory:
  - MODERATE — `ajv <6.14.0` ReDoS via the `$data` option (transitive through charts-components).
  - Verified **zero references** anywhere in `src/` / `index.html` — the app charts with **Chart.js + react-chartjs-2** (see `src/charts/setup.ts`, `assumptions.ts:47`), and `ajv` was already tree-shaken out of the bundle. Removing the dead dependency **eliminates** the CVE outright rather than accepting it — strictly better than a documented waiver.
- **Result:** `npm audit` and `npm audit --omit=dev` both report **0 vulnerabilities**. No accepted/waived CVEs remain. (`eslint`'s transitive `ajv@6.15.0` is ≥6.14.0, i.e. already patched, and dev-only.)

### T0.2 — Integrity: AIS mapper no longer fabricates (0,0) "null island" positions
- **File:** `src/data/aisstream.ts`. Previously `mapAisMessage` defaulted a missing latitude/longitude to `0`/`0` (old lines 109–110), plotting a **ghost vessel at (0,0) off West Africa** on the JNPA twin as if it were a real contact — the exact "silently mislead / corrupt the twin" failure mode. AIS transmits 0/0 as its *no-fix sentinel*, so this actively manufactured bad data.
- **Fix:** added `isPlottablePosition(lat, lon)` — rejects non-number/NaN/Infinity, `|lat|>90`, `|lon|>180`, and the `(0,0)` sentinel. `mapAisMessage` now **drops** (returns `null`) any PositionReport without a real fix instead of inventing one. The live consumer (`ArcGISAdapter` `onVessel`, via `openAisStream`'s `if (vessel)` guard) already treats `null` as "no vessel," so no caller change was needed.
- **Scope discipline:** this is the hard integrity *floor* only. Richer AIS sanity (speed-implied teleport, land-mask, staleness/confidence decay, cross-source dedup, backpressure) is deliberately deferred to **Tier 1 / edge-case 5.1** — not folded in here.
- **Tests (+6):** `src/data/aisstream.test.ts` now covers: drop-when-no-position, drop-`(0,0)`-sentinel, drop-out-of-range/non-finite, accept-valid-MetaData-only-position, plus a direct `isPlottablePosition` truth table. **62/62 pass.**

### Tier 0 gates (all green)
- `npx vitest run` → **62/62** (was 56; +6 integrity tests).
- `tsc -b --noEmit` → clean.
- `npm run lint` (`--max-warnings 0`) → clean.
- `npm run build` → succeeds (`dist/` unaffected by the dev-dep bump and the dead-dep removal).
- `npm audit` → **0 vulnerabilities**.

**No baselines claimed, DATA_MODE discipline untouched, no new runtime internet dependency.** No unrelated changes bundled.

---

_Next tier (T1) — pending: connector-readiness UI + per-source driver-status (mock/replay), client-side RBAC scoping, marine-logic edge cases (5.1 AIS pathologies, 5.3 berth-planning conflicts), plan CSV/XLSX import + manual entry, workflow composer, berth-constraint rejection. One item at a time, each with its test._
