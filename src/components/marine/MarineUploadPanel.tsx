/**
 * <MarineUploadPanel> — the Vessels ▸ Data Upload sub-tab. Drives the reusable
 * Marine Data-Upload workflow (validate → preview → import → history) through the
 * Phase-1 uc3/marineUpload connector. No transport logic lives here — it only
 * orchestrates the connector and renders results.
 *
 * FORMAT-GENERIC (constraint 8): the picker accepts CSV / XLSX / PDF / XML / HSP,
 * and the transport is format-agnostic (multipart file, no client-side parsing).
 * The BACKEND currently ingests CSV only and returns `status: 'REJECTED'` for other
 * formats — that outcome is surfaced verbatim (HTTP 200 + a REJECTED body), so
 * widening backend format support later needs no change here.
 *
 * RBAC: mirrors PlanImportPanel — a read-only role (viewer / shippingLine) sees the
 * panel with the controls disabled and a lock notice, never a hidden feature.
 */

import { useRef, useState } from 'react';
import {
  CalciteButton,
  CalciteLoader,
  CalciteNotice,
} from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import {
  validateMarineCsv,
  importMarineCsv,
  fetchMarineUploads,
  MARINE_TEMPLATE_PATH,
  type MarineValidateResult,
  type MarineImportResult,
  type MarineParseError,
} from '@/data/uc3/marineUpload';
import { Panel, PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

/** Formats the picker offers. Backend ingests CSV today; the rest resolve REJECTED. */
const ACCEPT = '.csv,.xlsx,.xls,.pdf,.xml,.hsp,text/csv';

/** A green/amber/red tone for an upload/validate status string. */
function statusTone(status: string): string {
  if (status === 'SUCCESS' || status === 'VALIDATED') return tokens.good;
  if (status === 'PARTIAL' || status === 'SKIPPED_DUPLICATE') return tokens.warn;
  return tokens.bad; // REJECTED | FAILED
}

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

function ErrorList({ errors }: { errors: MarineParseError[] }) {
  if (errors.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: tokens.textMuted, marginBottom: 4 }}>
        Errors ({errors.length})
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: tokens.text }}>
        {errors.slice(0, 20).map((e, i) => (
          <li key={i}>
            {e.row_number != null ? `Row ${e.row_number} — ` : ''}
            {e.column_name ? `${e.column_name}: ` : ''}
            {e.error_detail || e.error_code}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UploadHistory({ refreshKey }: { refreshKey: number }) {
  const q = useAdapterQuery(() => fetchMarineUploads({}, 25, 0), [refreshKey]);

  if (q.loading && !q.data) return <PanelLoading label="Loading history…" />;
  if (q.error) return <PanelError message={q.error} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <PanelEmpty message="No uploads yet." />;

  const TD: React.CSSProperties = {
    fontSize: 12,
    padding: `${tokens.space.sm}px ${tokens.space.md}px`,
    borderBottom: `1px solid ${tokens.border}`,
    whiteSpace: 'nowrap',
  };
  const TH: React.CSSProperties = { ...TD, textAlign: 'left', color: tokens.textMuted, fontWeight: 700, background: tokens.panelAlt };

  return (
    <div style={{ overflow: 'auto', border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['File', 'Status', 'Rows', 'OK', 'Failed', 'Dup', 'When'].map((h) => (
              <th key={h} style={TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <td style={{ ...TD, fontWeight: 600 }}>{f.filename || '—'}</td>
              <td style={{ ...TD, color: statusTone(f.status), fontWeight: 700 }}>{f.status}</td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.totalRows}</td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.successRows}</td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.failedRows}</td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.duplicateRows}</td>
              <td style={{ ...TD, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>{fmt(f.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MarineUploadPanel() {
  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<MarineValidateResult | null>(null);
  const [result, setResult] = useState<MarineImportResult | null>(null);
  const [busy, setBusy] = useState<'validate' | 'import' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const pick = (f: File | null) => {
    setFile(f);
    setValidation(null);
    setResult(null);
    setErr(null);
  };

  const onValidate = async () => {
    if (!file) return;
    setBusy('validate');
    setErr(null);
    try {
      setValidation(await validateMarineCsv(file));
      setResult(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onImport = async () => {
    if (!file) return;
    setBusy('import');
    setErr(null);
    try {
      const r = await importMarineCsv(file);
      setResult(r);
      setRefreshKey((k) => k + 1); // refresh history
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const templateHref = `${'/api'}${MARINE_TEMPLATE_PATH}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title="Vessel-call data upload — validate → import (UC-3 backend)" minHeight={160}>
        {!editable && (
          <CalciteNotice open kind="warning" scale="s" icon="lock">
            <div slot="message">Your role is read-only — validation and import are disabled.</div>
          </CalciteNotice>
        )}

        <fieldset
          disabled={!editable || undefined}
          style={{ border: 'none', padding: 0, margin: editable ? 0 : '8px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <CalciteButton scale="s" iconStart="upload" disabled={!editable || undefined} onClick={() => fileRef.current?.click()}>
              Choose file
            </CalciteButton>
            <span style={{ fontSize: 12, color: tokens.textMuted }}>{file ? file.name : 'No file chosen'}</span>
            <a
              href={templateHref}
              style={{ fontSize: 12, color: tokens.accent, marginLeft: 'auto' }}
              title="Download the vessel-call CSV template"
            >
              Download template
            </a>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <CalciteButton scale="s" appearance="outline" disabled={!editable || !file || busy != null || undefined} onClick={onValidate}>
              Validate
            </CalciteButton>
            <CalciteButton scale="s" disabled={!editable || !file || busy != null || undefined} onClick={onImport}>
              Import
            </CalciteButton>
            {busy && <CalciteLoader inline label={busy === 'validate' ? 'Validating…' : 'Importing…'} />}
          </div>

          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            Accepts CSV / XLSX / PDF / XML / HSP. This release ingests CSV; other formats return a REJECTED
            result until backend parsers land.
          </div>
        </fieldset>

        {err && <div style={{ marginTop: 8 }}><PanelError message={err} /></div>}

        {/* Validate (dry-run) outcome */}
        {validation && (
          <div style={{ marginTop: 10, padding: 10, background: tokens.panelAlt, borderRadius: tokens.radius.sm, borderLeft: `3px solid ${statusTone(validation.status)}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(validation.status) }}>
              {validation.status} — {validation.summary.valid} valid / {validation.summary.invalid} invalid / {validation.summary.duplicates} duplicate
            </div>
            <ErrorList errors={validation.errors} />
          </div>
        )}

        {/* Import outcome */}
        {result && (
          <div style={{ marginTop: 10, padding: 10, background: tokens.panelAlt, borderRadius: tokens.radius.sm, borderLeft: `3px solid ${statusTone(result.status)}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(result.status) }}>
              {result.status}
              {result.duplicate_file ? ' — identical file already imported' : ` — ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped`}
            </div>
            {result.errors && <ErrorList errors={result.errors} />}
          </div>
        )}
      </Panel>

      <Panel title="Upload history" minHeight={160}>
        <UploadHistory refreshKey={refreshKey} />
      </Panel>
    </div>
  );
}
