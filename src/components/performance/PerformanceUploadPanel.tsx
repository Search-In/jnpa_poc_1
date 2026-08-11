/**
 * <PerformanceUploadPanel> — Performance & Reports ▸ Data Upload.
 * Admin-only gateway flow: validate → import Daily Status / monthly TEU / LDB PDF|CSV|XLSX.
 */

import { useRef, useState } from 'react';
import { CalciteButton, CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  PERF_REPORT_TYPES,
  PERF_REPORT_TYPE_LABELS,
  PERF_UPLOAD_ACCEPT,
  fetchPerformanceUploads,
  importPerformanceUpload,
  perfTemplateHref,
  validatePerformanceUpload,
  type PerfImportResult,
  type PerfParseError,
  type PerfReportType,
  type PerfValidateResult,
} from '@/data/uc3/performanceUpload';
import { importFailureReason } from '@/data/uc3/importFailure';
import { Panel, PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

function statusTone(status: string): string {
  const s = status.toUpperCase();
  if (s === 'SUCCESS' || s === 'VALIDATED' || s === 'IMPORTED') return tokens.good;
  if (s === 'PARTIAL' || s === 'SKIPPED_DUPLICATE') return tokens.warn;
  return tokens.bad;
}

function ErrorList({ errors }: { errors: PerfParseError[] }) {
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

function WhyFailed({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div
      role="alert"
      style={{
        marginTop: 8,
        fontSize: 12,
        color: tokens.bad,
        lineHeight: 1.4,
        border: `1px solid ${tokens.bad}`,
        borderRadius: tokens.radius.sm,
        padding: 8,
        background: `${tokens.bad}10`,
      }}
    >
      <strong>Why it failed:</strong> {reason}
    </div>
  );
}

function UploadHistory({ refreshKey, reportType }: { refreshKey: number; reportType: PerfReportType }) {
  const q = useAdapterQuery(() => fetchPerformanceUploads(reportType, 25, 0), [refreshKey, reportType]);
  if (q.loading && !q.data) return <PanelLoading label="Loading history…" />;
  if (q.error) return <PanelError message={q.error} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <PanelEmpty message="No performance uploads yet for this report type." />;

  const TD: React.CSSProperties = {
    fontSize: 12,
    padding: `${tokens.space.sm}px ${tokens.space.md}px`,
    borderBottom: `1px solid ${tokens.border}`,
    whiteSpace: 'nowrap',
  };
  const TH: React.CSSProperties = {
    ...TD,
    textAlign: 'left',
    color: tokens.textMuted,
    fontWeight: 700,
    background: tokens.panelAlt,
  };

  return (
    <div style={{ overflow: 'auto', border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['File', 'Status', 'Rows', 'Inserted', 'Errors', 'When', 'Notes'].map((h) => (
              <th key={h} style={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.uploadId || f.filename}>
              <td style={{ ...TD, fontWeight: 600, whiteSpace: 'normal', maxWidth: 220 }}>{f.filename || '—'}</td>
              <td style={{ ...TD, color: statusTone(f.status), fontWeight: 700 }}>{f.status || '—'}</td>
              <td style={TD}>{f.rowCount}</td>
              <td style={TD}>{f.insertedCount}</td>
              <td style={TD}>{f.errorCount}</td>
              <td style={{ ...TD, color: tokens.textMuted }}>{f.createdAt ? istDateTime(f.createdAt) : '—'}</td>
              <td style={{ ...TD, whiteSpace: 'normal', maxWidth: 240, color: tokens.bad }}>{f.notes || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PerformanceUploadPanel({ onImported }: { onImported?: () => void } = {}) {
  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reportType, setReportType] = useState<PerfReportType>('daily_status');
  const [validation, setValidation] = useState<PerfValidateResult | null>(null);
  const [result, setResult] = useState<PerfImportResult | null>(null);
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
      setValidation(await validatePerformanceUpload(file, reportType));
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
      const r = await importPerformanceUpload(file, reportType);
      setResult(r);
      setRefreshKey((k) => k + 1);
      if ((r.status || '').toUpperCase() === 'IMPORTED' || (r.status || '').toUpperCase() === 'SUCCESS') {
        onImported?.();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const selectStyle = {
    fontSize: 12,
    padding: '5px 8px',
    borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.border}`,
    background: tokens.panel,
    color: tokens.text,
  };

  const canUpload = editable;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title="Performance data upload — Daily Status / TEU / LDB (UC-3, admin)" minHeight={160}>
        {!canUpload && (
          <CalciteNotice open kind="warning" scale="s" icon="lock">
            <div slot="message">
              Your role is read-only — validation and import are disabled. Gateway also requires a
              DTCCC_ADMIN JWT when auth is enabled.
            </div>
          </CalciteNotice>
        )}

        {canUpload && (
          <CalciteNotice open kind="info" scale="s" icon="information">
            <div slot="message">
              Gateway enforces <strong>DTCCC_ADMIN</strong> on these endpoints. A non-admin token returns
              403 — the Why-it-failed panel will show that auth error.
            </div>
          </CalciteNotice>
        )}

        <fieldset
          disabled={!canUpload || undefined}
          style={{
            border: 'none',
            padding: 0,
            margin: canUpload ? 0 : '8px 0 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value as PerfReportType)}
              style={selectStyle}
              aria-label="Report type"
            >
              {PERF_REPORT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PERF_REPORT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <input
              ref={fileRef}
              type="file"
              accept={PERF_UPLOAD_ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <CalciteButton scale="s" iconStart="upload" onClick={() => fileRef.current?.click()}>
              Choose file
            </CalciteButton>
            <span style={{ fontSize: 12, color: tokens.textMuted }}>{file ? file.name : 'No file chosen'}</span>
            <a
              href={perfTemplateHref(reportType)}
              style={{ fontSize: 12, color: tokens.accent, marginLeft: 'auto' }}
              title="Download CSV template for this report type"
            >
              Download template
            </a>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <CalciteButton
              scale="s"
              appearance="outline"
              disabled={!file || busy != null || undefined}
              onClick={onValidate}
            >
              Validate
            </CalciteButton>
            <CalciteButton scale="s" disabled={!file || busy != null || undefined} onClick={onImport}>
              Import
            </CalciteButton>
            {busy && <CalciteLoader inline label={busy === 'validate' ? 'Validating…' : 'Importing…'} />}
          </div>

          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            Accepts official JNPA report <strong>PDF</strong>, or CSV/XLSX built from the template
            (.pdf, .csv, .xlsx, .xlsm, .txt). Wrong report_type vs file content is a common reject.
          </div>
        </fieldset>

        {err && (
          <div style={{ marginTop: 8 }}>
            <PanelError message={err} />
            <WhyFailed reason={`Transport/auth error: ${err}`} />
          </div>
        )}

        {validation && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: tokens.panelAlt,
              borderRadius: tokens.radius.sm,
              borderLeft: `3px solid ${statusTone(validation.status)}`,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(validation.status) }}>
              {validation.status} · {validation.report_type}
            </div>
            <WhyFailed
              reason={importFailureReason({
                status: validation.status,
                errors: validation.errors,
              })}
            />
            <ErrorList errors={validation.errors} />
          </div>
        )}

        {result && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: tokens.panelAlt,
              borderRadius: tokens.radius.sm,
              borderLeft: `3px solid ${statusTone(result.status)}`,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(result.status) }}>
              {result.status}
              {result.inserted != null ? ` — ${result.inserted} inserted, ${result.skipped ?? 0} skipped` : ''}
            </div>
            <WhyFailed
              reason={importFailureReason({
                status: result.status,
                errors: result.errors,
              })}
            />
            {result.errors && <ErrorList errors={result.errors} />}
          </div>
        )}
      </Panel>

      <Panel title="Upload history — performance import ledger" minHeight={160}>
        <UploadHistory refreshKey={refreshKey} reportType={reportType} />
      </Panel>
    </div>
  );
}
