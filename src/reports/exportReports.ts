/**
 * Marine KPI report export (spec §B3.14) — clean printable views of the Berthing
 * Plan and Arrivals & Departures. Opens a print-friendly window with a self-
 * contained HTML document (no external assets, works offline) and triggers the
 * browser print dialog. Every export carries a provenance line (SIMULATED) so a
 * printed page can never be mistaken for a live JNPA record (integrity §A3).
 */
import type { BerthingPlanEntry, ArrivalsDeparturesBlock } from '@/types/domain';

const IST_OFFSET_MS = 5.5 * 3_600_000;

function istDateTime(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

const STYLE = `
  body{font:13px 'Segoe UI',Arial,sans-serif;color:#111;margin:24px;}
  h1{font-size:18px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin:0 0 14px;}
  .prov{display:inline-block;background:#fff3cd;border:1px solid #e0a800;color:#7a5b00;
    font-size:11px;padding:3px 8px;border-radius:4px;margin:0 0 14px;}
  table{border-collapse:collapse;width:100%;font-size:12px;}
  th,td{border:1px solid #ccc;padding:5px 8px;text-align:left;}
  th{background:#f2f2f2;} tr:nth-child(even) td{background:#fafafa;}
  .foot{margin-top:16px;color:#777;font-size:11px;}
  @media print{.noprint{display:none;}}
`;

function openPrint(title: string, bodyHtml: string): void {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>` +
      bodyHtml +
      `<div class="foot">JNPA Digital Twin PoC · Use Case 1 · Generated ${istDateTime(dateNow())}. ` +
      `Figures are SIMULATED results under stated assumptions (see in-app Assumptions register) — not live JNPA records or baselines.</div>` +
      `<div class="noprint" style="margin-top:12px"><button onclick="window.print()">Print</button></div>` +
      `</body></html>`,
  );
  w.document.close();
}

/** Wall-clock only for the printed generation timestamp (not on any sim path). */
function dateNow(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.timeOrigin + performance.now()) : 0;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function exportBerthingPlan(plan: BerthingPlanEntry[]): void {
  const rows = plan
    .slice()
    .sort((a, b) => a.PLANNED_START - b.PLANNED_START)
    .map(
      (p) =>
        `<tr><td>${esc(p.BERTH_ID)}</td><td>${esc(p.VESSEL_NAME)}</td><td>${esc(p.MMSI)}</td>` +
        `<td>${istDateTime(p.PLANNED_START)}</td><td>${istDateTime(p.PLANNED_END)}</td>` +
        `<td>${p.ACTUAL_START ? istDateTime(p.ACTUAL_START) : '—'}</td>` +
        `<td>${p.ACTUAL_END ? istDateTime(p.ACTUAL_END) : '—'}</td><td>${esc(p.STATUS)}</td></tr>`,
    )
    .join('');
  openPrint(
    'JNPA Berthing Plan',
    `<h1>Berthing Plan</h1><p class="sub">Marine KPI report — planned vs actual alongside windows</p>` +
      `<div class="prov">SIMULATED · demo data under stated assumptions</div>` +
      `<table><thead><tr><th>Berth</th><th>Vessel</th><th>MMSI</th><th>Planned start</th>` +
      `<th>Planned end</th><th>Actual start</th><th>Actual end</th><th>Status</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`,
  );
}

export function exportArrivalsDepartures(blocks: ArrivalsDeparturesBlock[]): void {
  const rows = blocks
    .map(
      (b) =>
        `<tr><td>${esc(b.label)}</td><td>${istDateTime(b.blockStart)}</td>` +
        `<td>${b.arrivals}</td><td>${b.departures}</td></tr>`,
    )
    .join('');
  const totalA = blocks.reduce((s, b) => s + b.arrivals, 0);
  const totalD = blocks.reduce((s, b) => s + b.departures, 0);
  openPrint(
    'JNPA Arrivals & Departures',
    `<h1>Arrivals &amp; Departures</h1><p class="sub">Marine KPI report — vessel movements by time block</p>` +
      `<div class="prov">SIMULATED · demo data under stated assumptions</div>` +
      `<table><thead><tr><th>Block</th><th>Start</th><th>Arrivals</th><th>Departures</th></tr></thead>` +
      `<tbody>${rows}<tr><td colspan="2"><strong>Total</strong></td><td><strong>${totalA}</strong></td>` +
      `<td><strong>${totalD}</strong></td></tr></tbody></table>`,
  );
}
