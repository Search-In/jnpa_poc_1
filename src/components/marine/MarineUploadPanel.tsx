/**
 * <MarineUploadPanel> — the reusable Marine Data-Upload workflow (validate → preview →
 * import → history) driven through the Phase-1 uc3/marineUpload connector. No transport
 * logic lives here — it only orchestrates the connector and renders results.
 *
 * REUSABLE ACROSS DOMAINS: the same panel serves the Vessels ▸ Data Upload sub-tab
 * (vessel-call CSV / PCS XML-HSP / pilot XLSX / port-craft PDF — the DEFAULT config)
 * and the DUKC ▸ Data Upload section (the zipped ESRI sea-channel shapefile). Callers
 * tailor only the presentation — `title`, `helpText`, the picker `accept` filter, the
 * `showTemplate` link and an `onImported` refresh hook — via optional props; every
 * default reproduces the original Vessels behaviour, so an unconfigured `<MarineUploadPanel />`
 * is unchanged. The validate / import / history business logic is identical for all
 * callers and never branches on config.
 *
 * FORMAT-GENERIC: the transport is format-agnostic (multipart file, no client-side
 * parsing). The backend detects each format by content, so `accept` only controls what
 * the OS file dialog shows — never how the file is processed.
 *
 * RBAC: mirrors PlanImportPanel — a read-only role (viewer / shippingLine) sees the
 * panel with the controls disabled and a lock notice, never a hidden feature.
 */

import { useRef, useState, type ReactNode } from 'react';
import { CalciteButton, CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { env } from '@/data/config';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import {
  validateMarineCsv,
  importMarineCsv,
  overrideImportMarineCsv,
  fetchMarineUploads,
  fetchMarineUpload,
  MARINE_TEMPLATE_PATH,
  type MarineValidateResult,
  type MarineImportResult,
  type MarineParseError,
} from '@/data/uc3/marineUpload';
import { importFailureReason } from '@/data/uc3/importFailure';
import type { MarineUploadRowError } from '@/types/domain';
import { Panel, PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

/** DEFAULT picker formats (Vessels domain): CSV vessel-calls, PCS XML/HSP, pilot-card
 *  XLSX and port-craft PDF. Sea-channel ZIP/SHP is intentionally NOT here — that upload
 *  now lives under the DUKC section, which passes its own `accept`. The transport is
 *  format-agnostic (backend detects by content); this list only controls the OS dialog. */
const DEFAULT_ACCEPT = '.csv,.xlsx,.xls,.pdf,.xml,.hsp,text/csv';

/** DEFAULT help text (Vessels domain). */
const DEFAULT_HELP_TEXT =
  'Accepts CSV (vessel calls), XML/HSP (PCS messages), XLSX (pilot cards) and PDF (port craft). The backend detects the format by content.';

/** DEFAULT panel title (Vessels domain). */
const DEFAULT_TITLE = 'Vessel-call data upload — validate → import (UC-3 backend)';

/** Presentation-only configuration. Every field is optional and defaults to the
 *  original Vessels behaviour, so `<MarineUploadPanel />` with no props is unchanged. */
export interface MarineUploadPanelProps {
  /** Panel heading. */
  title?: string;
  /** Help line under the action buttons. */
  helpText?: ReactNode;
  /** File-dialog `accept` filter (does not affect processing). */
  accept?: string;
  /**
   * Explicit gateway `document_type` (e.g. `BATHYMETRY`). Sent on validate/import
   * so PDF charts are not mis-routed to PORT_CRAFT. Omit for content-sniffed uploads.
   */
  documentType?: string;
  /** Show the "Download template" link (vessel-call CSV template). Default true. */
  showTemplate?: boolean;
  /** Called after a successful (non-throwing) import — lets a sibling view refresh. */
  onImported?: (result: MarineImportResult) => void;
}

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

/** Collapse identical ledger messages (a chart can store 15k+ of the same fault). */
function groupLedgerErrors(errors: MarineUploadRowError[]): { message: string; count: number }[] {
  const map = new Map<string, number>();
  for (const e of errors) {
    const msg = (e.errorMessage || '').trim() || '(no message)';
    map.set(msg, (map.get(msg) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count);
}

function LedgerErrorList({ errors }: { errors: MarineUploadRowError[] }) {
  if (errors.length === 0) return null;
  const groups = groupLedgerErrors(errors);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: tokens.textMuted, marginBottom: 4 }}>
        Ledger errors ({errors.length}
        {groups.length < errors.length ? ` · ${groups.length} distinct` : ''})
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: tokens.text }}>
        {groups.slice(0, 20).map((g) => (
          <li key={g.message}>
            {g.count > 1 ? `${g.count}× — ` : ''}
            {g.message}
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
  const TH: React.CSSProperties = {
    ...TD,
    textAlign: 'left',
    color: tokens.textMuted,
    fontWeight: 700,
    background: tokens.panelAlt,
  };

  return (
    <div
      style={{
        overflow: 'auto',
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['File', 'Status', 'Rows', 'OK', 'Failed', 'Dup', 'When'].map((h) => (
              <th key={h} style={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <td style={{ ...TD, fontWeight: 600 }}>{f.filename || '—'}</td>
              <td style={{ ...TD, color: statusTone(f.status), fontWeight: 700 }}>{f.status}</td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {f.totalRows}
              </td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {f.successRows}
              </td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {f.failedRows}
              </td>
              <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {f.duplicateRows}
              </td>
              <td style={{ ...TD, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                {fmt(f.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MarineUploadPanel({
  title = DEFAULT_TITLE,
  helpText = DEFAULT_HELP_TEXT,
  accept = DEFAULT_ACCEPT,
  documentType,
  showTemplate = true,
  onImported,
}: MarineUploadPanelProps = {}) {
  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<MarineValidateResult | null>(null);
  const [result, setResult] = useState<MarineImportResult | null>(null);
  /** Row errors from GET /uploads/{id} — import response often omits repo faults. */
  const [ledgerErrors, setLedgerErrors] = useState<MarineUploadRowError[]>([]);
  const [ledgerDetail, setLedgerDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState<'validate' | 'import' | 'override' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const uploadOpts = documentType ? { documentType } : {};

  const pick = (f: File | null) => {
    setFile(f);
    setValidation(null);
    setResult(null);
    setLedgerErrors([]);
    setLedgerDetail(null);
    setErr(null);
  };

  const onValidate = async () => {
    if (!file) return;
    setBusy('validate');
    setErr(null);
    try {
      setValidation(await validateMarineCsv(file, uploadOpts));
      setResult(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Import, optionally overriding the ledger's duplicate check.
   *
   * ONE code path: override changes only which connector runs. The success handling —
   * result panel, history refresh, `onImported` — is identical, so every lifecycle view
   * that already refreshes after an import refreshes after an override too, with no
   * second notification path to keep in sync.
   */
  const runImport = async (override: boolean) => {
    if (!file) return;
    setBusy(override ? 'override' : 'import');
    setErr(null);
    setLedgerErrors([]);
    setLedgerDetail(null);
    try {
      const r = override
        ? await overrideImportMarineCsv(file, uploadOpts)
        : await importMarineCsv(file, uploadOpts);
      setResult(r);
      setRefreshKey((k) => k + 1); // refresh history
      onImported?.(r); // let a sibling view (e.g. SeaChannelTable) refresh

      // Persist-path failures write errors to the ledger only — the import body
      // usually has `warnings`, not `errors`. Pull detail so the operator sees why.
      const needsDetail =
        r.file_id != null &&
        (r.status === 'FAILED' || r.status === 'PARTIAL' || r.status === 'REJECTED') &&
        !(r.errors && r.errors.length > 0);
      if (needsDetail) {
        try {
          const detail = await fetchMarineUpload(r.file_id!);
          setLedgerErrors(detail.errors);
          setLedgerDetail(detail.file?.errorDetail || null);
        } catch {
          // Non-fatal — history still refreshed; detail is best-effort.
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const isDuplicateSkip =
    result?.status === 'SKIPPED_DUPLICATE' || result?.duplicate_file === true;

  const templateHref = `${env.uc3.apiBase}${MARINE_TEMPLATE_PATH}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title={title} minHeight={160}>
        {!editable && (
          <CalciteNotice open kind="warning" scale="s" icon="lock">
            <div slot="message">Your role is read-only — validation and import are disabled.</div>
          </CalciteNotice>
        )}

        <fieldset
          disabled={!editable || undefined}
          style={{
            border: 'none',
            padding: 0,
            margin: editable ? 0 : '8px 0 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              style={{ display: 'none' }}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <CalciteButton
              scale="s"
              iconStart="upload"
              disabled={!editable || undefined}
              onClick={() => fileRef.current?.click()}
            >
              Choose file
            </CalciteButton>
            <span style={{ fontSize: 12, color: tokens.textMuted }}>
              {file ? file.name : 'No file chosen'}
            </span>
            {showTemplate && (
              <a
                href={templateHref}
                style={{ fontSize: 12, color: tokens.accent, marginLeft: 'auto' }}
                title="Download the vessel-call CSV template"
              >
                Download template
              </a>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <CalciteButton
              scale="s"
              appearance="outline"
              disabled={!editable || !file || busy != null || undefined}
              onClick={onValidate}
            >
              Validate
            </CalciteButton>
            <CalciteButton
              scale="s"
              disabled={!editable || !file || busy != null || undefined}
              onClick={() => runImport(false)}
            >
              Import
            </CalciteButton>
            {/* Development / audit affordance: re-process a file the ledger already has.
                Outline + neutral, so Import stays the primary action. Not destructive —
                the gateway upserts and deletes nothing — so no confirmation dialog. */}
            <CalciteButton
              scale="s"
              appearance="outline"
              kind="neutral"
              disabled={!editable || !file || busy != null || undefined}
              onClick={() => runImport(true)}
              title="Re-process this file even if it was imported before. Updates existing records and refreshes the lifecycle; deletes nothing."
            >
              Override Import
            </CalciteButton>
            {busy && (
              <CalciteLoader
                inline
                label={
                  busy === 'validate'
                    ? 'Validating…'
                    : busy === 'override'
                      ? 'Re-processing…'
                      : 'Importing…'
                }
              />
            )}
          </div>

          <div style={{ fontSize: 11, color: tokens.textMuted }}>{helpText}</div>
        </fieldset>

        {err && (
          <div style={{ marginTop: 8 }}>
            <PanelError message={err} />
            <WhyFailed reason={`Transport/auth error: ${err}`} />
          </div>
        )}

        {/* Validate (dry-run) outcome */}
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
              {validation.status} — {validation.summary.valid} valid /{' '}
              {validation.summary.invalid} invalid / {validation.summary.duplicates} duplicate
            </div>
            <WhyFailed
              reason={importFailureReason({
                status: validation.status,
                errors: validation.errors,
                invalid: validation.summary.invalid,
              })}
            />
            <ErrorList errors={validation.errors} />
          </div>
        )}

        {/* Import outcome */}
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
              {result.duplicate_file
                ? ' — identical file already imported'
                : ` — ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped`}
            </div>
            <WhyFailed
              reason={importFailureReason({
                status: result.status,
                errors: result.errors,
                duplicateFile: result.duplicate_file,
                detail: ledgerDetail,
              })}
            />
            {result.errors && <ErrorList errors={result.errors} />}
            <LedgerErrorList errors={ledgerErrors} />
            {isDuplicateSkip && editable && file && (
              <div
                style={{
                  marginTop: 8,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  disabled={busy != null || undefined}
                  onClick={() => runImport(true)}
                >
                  Re-import anyway
                </CalciteButton>
                <span style={{ fontSize: 11, color: tokens.textMuted }}>
                  Re-processes this file (override). Upserts rows; does not delete history.
                </span>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Upload history" minHeight={160}>
        <UploadHistory refreshKey={refreshKey} />
      </Panel>
    </div>
  );
}
