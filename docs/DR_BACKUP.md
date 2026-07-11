# DR / Backup Runbook — UC-1 (spec D-3)

## Scope in the current PoC (frontend SPA)
The SPA holds no server-side data. Operator session state (sim clock, scenario, camera, active role, imported plan overlay, composed workflow rules) is persisted to the browser's **sessionStorage** and restored automatically on reload — this is the crash-recovery you exercise in `docs/UAT_HANDOVER.md` step 11.

**What to back up today:** the deployment artefacts and config —
- the built image (`docker save uc1-vtms:<version>`),
- `.env` / deploy config (store securely; it may hold credentials in a live deployment),
- `deploy/nginx.conf` and `docker-compose.yml`.

Restore = redeploy the saved image with the saved config. RTO for the static tier is minutes.

## Production (with the backend that live deployment adds)
Once a backend + datastore exist (users, audit log, persisted plans/rules, KPI history), the runbook becomes:

1. **Scheduled automated backups** (nightly) of: the database, application config, and the audit log. Encrypt at rest.
2. **Retention** configurable (default 30 days rolling + monthly archives).
3. **One-click restore drill** — documented and tested quarterly:
   - stop the app, restore the DB snapshot, restore config, restart, run the smoke checklist.
   - target **RTO** and **RPO** stated in the operations SLA.
4. **90-day restore** validated within the documented RTO.
5. Backups monitored; the System Health page shows **last successful backup time** and alerts if it is stale.

## Disaster scenarios
| Scenario | Response |
|---|---|
| Host lost | Redeploy image + config on a new host (minutes). |
| Config corrupted | Restore `.env`/compose from backup. |
| **[PROD]** DB corrupted | Restore latest snapshot; replay buffered events; run reconciliation report. |
| **[PROD]** Disk 90% full | Ingest pauses with a loud admin alert; UI stays read-available; free space / extend volume. |
| ArcGIS/token outage | App auto-falls back to the offline basemap; renew token in config. |
