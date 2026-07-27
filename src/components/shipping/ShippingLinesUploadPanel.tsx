/**
 * <ShippingLinesUploadPanel> — the Shipping Lines ▸ Data Upload tab.
 * Drives the shipping-lines Data-Upload workflow (validate → preview → import) through
 * the UC-3 shippingLines connector. No transport logic lives here — it only orchestrates
 * the connector and renders results.
 *
 * Mirrors <MarineUploadPanel> / <BerthingUploadPanel> but targets the SEPARATE
 * shipping-lines endpoints (`/api/shipping-lines/validate`, `/upload`) and adds the
 * required document-type selector: IAL (Import Advance List), EAL (Export Advance List)
 * or EDO (Electronic Delivery Order / CODECO). The backend detects the physical format
 * by content, so `accept` is only the OS dialog hint.
 *
 * RBAC: mirrors the other upload panels — a read-only role sees the controls disabled
 * with a lock notice. A successful import calls `onImported` so the sibling Overview and
 * Carrier Registry tabs can both refresh.
 */

import { useRef, useState } from 'react';
import { CalciteButton, CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import {
  validateShippingLines,
  importShippingLines,
  SHIPPING_LINES_LIST_TYPES,
  type ShippingLinesValidateResult,
  type ShippingLinesImportResult,
  type ShippingLinesParseError,
} from '@/data/uc3/shippingLines';
import { Panel, PanelError } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

/** Formats the picker offers: advance lists as CSV/XLS/XLSX, EDO as XLSX (CODECO XML in
 *  a cell). The backend detects each by content — this only controls the OS dialog. */
const ACCEPT = '.csv,.xlsx,.xls,.xml,text/csv';

/** Human labels for the document-type selector. */
const LIST_TYPE_LABELS: Record<string, string> = {
  IAL: 'IAL — Import Advance List',
  EAL: 'EAL — Export Advance List',
  EDO: 'EDO — Electronic Delivery Order',
};

function statusTone(status: string): string {
  if (status === 'SUCCESS' || status === 'VALIDATED') return tokens.good;
  if (status === 'PARTIAL' || status === 'SKIPPED_DUPLICATE') return tokens.warn;
  return tokens.bad; // REJECTED | FAILED
}

function ErrorList({ errors }: { errors: ShippingLinesParseError[] }) {
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

export function ShippingLinesUploadPanel({ onImported }: { onImported?: (result: ShippingLinesImportResult) => void } = {}) {
  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [listType, setListType] = useState<string>('IAL');
  const [validation, setValidation] = useState<ShippingLinesValidateResult | null>(null);
  const [result, setResult] = useState<ShippingLinesImportResult | null>(null);
  const [busy, setBusy] = useState<'validate' | 'import' | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
      setValidation(await validateShippingLines(file, listType));
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
      const r = await importShippingLines(file, listType);
      setResult(r);
      onImported?.(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const selectStyle = {
    fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
  };

  return (
    <Panel title="Shipping-line data upload — validate → import (UC-3 backend)" minHeight={160}>
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
          <select
            value={listType}
            onChange={(e) => setListType(e.target.value)}
            style={selectStyle}
            aria-label="Document type"
            disabled={!editable || undefined}
          >
            {SHIPPING_LINES_LIST_TYPES.map((t) => <option key={t} value={t}>{LIST_TYPE_LABELS[t]}</option>)}
          </select>
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
          Accepts an Import/Export Advance List (IAL/EAL) as CSV/XLS/XLSX, or an Electronic
          Delivery Order (EDO / CODECO) as XLSX. The backend detects the format by content and
          idempotently collapses byte-identical rows on re-import.
        </div>
      </fieldset>

      {err && <div style={{ marginTop: 8 }}><PanelError message={err} /></div>}

      {/* Validate (dry-run) outcome */}
      {validation && (
        <div style={{ marginTop: 10, padding: 10, background: tokens.panelAlt, borderRadius: tokens.radius.sm, borderLeft: `3px solid ${statusTone(validation.status)}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(validation.status) }}>
            {validation.status} · {validation.list_type} — {validation.summary.valid} valid / {validation.summary.invalid} invalid / {validation.summary.duplicates} duplicate
          </div>
          <ErrorList errors={validation.errors} />
        </div>
      )}

      {/* Import outcome */}
      {result && (
        <div style={{ marginTop: 10, padding: 10, background: tokens.panelAlt, borderRadius: tokens.radius.sm, borderLeft: `3px solid ${statusTone(result.status)}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(result.status) }}>
            {result.status}
            {result.duplicate_file ? ' — identical file already imported' : ` — ${result.imported} imported, ${result.skipped} skipped, ${result.invalid} invalid`}
          </div>
          {result.errors && <ErrorList errors={result.errors} />}
        </div>
      )}
    </Panel>
  );
}
