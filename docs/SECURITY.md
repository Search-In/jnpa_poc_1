# Security & Compliance Overview — UC-1 (spec D-6)

Honest posture for the current PoC (frontend SPA, Track A) plus the production adds that close each gap.

## What is in place now
- **Dependency hygiene:** `npm audit` reports **0 vulnerabilities** at ship time. The unused `@arcgis/charts-components` (which pulled a vulnerable `ajv`) was removed; the vitest toolchain was upgraded to clear the dev-chain CVEs.
- **Input validation at the data boundary:** every AIS contact passes a data-quality firewall (`src/data/quality.ts`) — position/range/AoI/SOG/name checks, teleport/regression/dedup guards. Bad data is quarantined, not rendered.
- **File-upload hardening:** plan import enforces a size cap and row cap, validates every row, and **neutralises CSV formula-injection** (`= + - @` → quoted) so an uploaded file cannot attack Excel.
- **Output escaping:** the print/export path HTML-escapes user-supplied fields.
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` set at the nginx layer (`deploy/nginx.conf`).
- **Least privilege at runtime:** container runs as a non-root user, read-only root filesystem, `no-new-privileges`.
- **No secrets in the repo:** `.env` is git-ignored and blank by default; the app runs credential-free in mock mode.
- **Client-side RBAC:** the five-role visibility matrix shapes every view (`src/auth/roles.ts`).
- **Provenance integrity:** every screen/report/export carries a DATA_MODE label; no figure is presented without provenance.

## Production adds (documented, not yet built — needs a backend)
- **Authentication:** session management, lockout on brute force, MFA-ready — requires an auth server.
- **Server-side authorization:** the RBAC matrix enforced as deny-by-default role claims on **every** API route (the client-side scope is presentation, not a security boundary).
- **Credential vault:** encrypted-at-rest, admin-managed, masked, rotatable — secrets never reach the client bundle.
- **Tamper-evident audit:** an append-only, hash-chained server store of who/what/when/before-after, exportable for compliance.
- **Transport:** enforced TLS with HSTS; a 14-day-prior cert-expiry warning surfaced on the System Health page.
- **CI gates:** dependency-audit and secrets-scanning in CI on every change; contract tests per connector with drift detection.
- **Log management:** structured JSON logs, rotation, no PII, SIEM forwarding (CERT-In-aligned retention).

## OWASP ASVS mapping (summary)
| Area | Now | Production |
|---|---|---|
| V2 Auth | — | Full (auth server) |
| V4 Access control | Client-side scope | Server-side deny-by-default |
| V5 Validation/encoding | DQ firewall, CSV/HTML guards | + server validation |
| V7 Errors/logging | In-app logs | Structured + SIEM |
| V9 Communications | Proxy TLS | Enforced TLS + HSTS |
| V14 Config | Non-root, headers, no secrets in repo | + vault + CI secrets scan |
