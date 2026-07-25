/**
 * <BerthingUploadPanel> — the 5-Day Berthing ▸ Data Upload sub-tab. Drives the
 * berthing Data-Upload workflow (validate → preview → import) through the Phase-1
 * uc3/berthing connector. No transport logic lives here — it only orchestrates the
 * connector and renders results.
 *
 * Mirrors <MarineUploadPanel> (the marine upload) but targets the SEPARATE berthing
 * endpoints (`/api/berthing/validate`, `/api/berthing/upload`) and adds a terminal
 * selector — the source is per-terminal daily reports (APMT/BMCT/NSFT/NSICT/NSIGT) in
 * PDF/CSV/XLS/XLSX. 'All terminals' means "read the per-row Terminal column". The
 * backend detects the format by content; the picker `accept` is only the OS dialog hint.
 *
 * RBAC: mirrors MarineUploadPanel — a read-only role sees the controls disabled with a
 * lock notice, never a hidden feature. A successful import calls `onImported` so the
 * sibling Terminal Reports view can refresh.
 */

import { useRef, useState } from 'react';
import { CalciteButton, CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import {
  validateBerthing,
  importBerthing,
  BERTHING_TERMINALS,
  type BerthingValidateResult,
  type BerthingImportResult,
  type BerthingParseError,
} from '@/data/uc3/berthing';
import { Panel, PanelError } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

/** Formats the picker offers: terminal berthing reports as PDF, or the CSV/XLS/XLSX
 *  normalised equivalents. The backend detects each by content — this only controls
 *  what the OS file dialog shows. */
const ACCEPT = '.pdf,.csv,.xlsx,.xls,application/pdf,text/csv';

/** A green/amber/red tone for an upload/validate status string. */
function statusTone(status: string): string {
  if (status === 'SUCCESS' || status === 'VALIDATED') return tokens.good;
  if (status === 'PARTIAL' || status === 'SKIPPED_DUPLICATE') return tokens.warn;
  return tokens.bad; // REJECTED | FAILED
}

function ErrorList({ errors }: { errors: BerthingParseError[] }) {
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

export function BerthingUploadPanel({ onImported }: { onImported?: (result: BerthingImportResult) => void } = {}) {
  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [terminal, setTerminal] = useState(''); // '' → All terminals (per-row column)
  const [validation, setValidation] = useState<BerthingValidateResult | null>(null);
  const [result, setResult] = useState<BerthingImportResult | null>(null);
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
      setValidation(await validateBerthing(file, terminal || undefined));
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
      const r = await importBerthing(file, terminal || undefined);
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
    <Panel title="Terminal berthing report upload — validate → import (UC-3 backend)" minHeight={160}>
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
            value={terminal}
            onChange={(e) => setTerminal(e.target.value)}
            style={selectStyle}
            aria-label="Terminal for this upload"
            disabled={!editable || undefined}
          >
            <option value="">All terminals (per-row)</option>
            {BERTHING_TERMINALS.map((t) => <option key={t} value={t}>{t}</option>)}
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
          Accepts a terminal berthing report as PDF (APMT/BMCT/NSFT/NSICT/NSIGT) or its CSV/XLS/XLSX
          equivalent. The backend detects the format by content and upserts one row per vessel call.
        </div>
      </fieldset>

      {err && <div style={{ marginTop: 8 }}><PanelError message={err} /></div>}

      {/* Validate (dry-run) outcome */}
      {validation && (
        <div style={{ marginTop: 10, padding: 10, background: tokens.panelAlt, borderRadius: tokens.radius.sm, borderLeft: `3px solid ${statusTone(validation.status)}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: statusTone(validation.status) }}>
            {validation.status}
            {validation.terminal ? ` · ${validation.terminal}` : ''} — {validation.summary.valid} valid / {validation.summary.invalid} invalid / {validation.summary.duplicates} duplicate
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
  );
}
