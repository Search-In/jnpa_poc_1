/**
 * <PlanImportPanel> — plan import + manual entry/edit UI (spec IU-2, [O]).
 *
 * A JNPA planner can (a) upload a CSV (or paste CSV text), (b) add a call by hand
 * with a small form. Imported rows are validated (dates, formula-injection, size
 * caps) by parsePlanCsv and constraint-checked by validatePlan; every problem is
 * shown with its line and remedy. Rows land in the client-side plan overlay
 * (mock-first), clearly labelled manual entry. Read-only roles see the list but
 * cannot add/import.
 */
import { useMemo, useRef, useState } from 'react';
import { CalciteButton, CalciteNotice } from '@esri/calcite-components-react';
import { parsePlanCsv, type ImportRowError } from './planImport';
import { validatePlan } from './constraints';
import { usePlanStore } from './planStore';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import type { Berth } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import { istDateTime } from '@/util/format';
import { SourceBadge } from '@/provenance/SourceBadge';

const CSV_TEMPLATE =
  'BERTH_ID,MMSI,VESSEL_NAME,PLANNED_START,PLANNED_END,STATUS\n' +
  'NSICT-1,419000001,MSC EXAMPLE,11-07-2026 06:00,11-07-2026 18:00,scheduled';

interface ManualDraft {
  berthId: string;
  mmsi: string;
  name: string;
  start: string;
  end: string;
}
const EMPTY_DRAFT: ManualDraft = { berthId: '', mmsi: '', name: '', start: '', end: '' };

export function PlanImportPanel() {
  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);
  const imported = usePlanStore((s) => s.imported);
  const addMany = usePlanStore((s) => s.addMany);
  const upsert = usePlanStore((s) => s.upsert);
  const remove = usePlanStore((s) => s.remove);
  const clear = usePlanStore((s) => s.clear);

  const berthsQ = useAdapterQuery<Berth[]>(() => getAdapter().getBerths(), [], 60_000);

  const [csvText, setCsvText] = useState('');
  const [errors, setErrors] = useState<ImportRowError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<ManualDraft>(EMPTY_DRAFT);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Constraint violations across the imported overlay (live). Fit + berth-time
  // overlap checks run here; unknown-vessel/pilot checks need the live vessel &
  // craft sets, surfaced on the Gantt where those are already loaded.
  const violations = useMemo(() => {
    if (!berthsQ.data) return [];
    return validatePlan({ plan: imported, berths: berthsQ.data, craft: [], vessels: [] });
  }, [imported, berthsQ.data]);

  const runImport = (text: string) => {
    const res = parsePlanCsv(text);
    setErrors(res.errors);
    if (res.entries.length) {
      addMany(res.entries);
      setNotice(`Imported ${res.entries.length} row(s)${res.errors.length ? `, ${res.errors.length} rejected` : ''}.`);
    } else {
      setNotice(res.errors.length ? 'No rows imported — see errors below.' : 'No rows found.');
    }
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
    runImport(text);
  };

  const addManual = () => {
    const res = parsePlanCsv(
      'BERTH_ID,MMSI,VESSEL_NAME,PLANNED_START,PLANNED_END\n' +
        [draft.berthId, draft.mmsi, draft.name, draft.start, draft.end]
          .map((c) => `"${c.replace(/"/g, '""')}"`)
          .join(',')
    );
    if (res.entries.length) {
      upsert({ ...res.entries[0], PLAN_ID: `MAN-${Date.now() % 1_000_000}` });
      setDraft(EMPTY_DRAFT);
      setErrors([]);
      setNotice('Call added.');
    } else {
      setErrors(res.errors);
      setNotice('Could not add — fix the fields below.');
    }
  };

  const input = (label: string, key: keyof ManualDraft, placeholder: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: tokens.textMuted }}>
      {label}
      <input
        value={draft[key]}
        placeholder={placeholder}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        disabled={!editable}
        style={{
          padding: '5px 7px',
          background: tokens.panel,
          color: tokens.text,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
          fontSize: 12,
        }}
      />
    </label>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto', color: tokens.text, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <SourceBadge source="BERTH_PLAN" />
        <span style={{ fontSize: 11, color: tokens.textMuted }}>Manual entry — client-side overlay (mock)</span>
      </div>

      {!editable && (
        <CalciteNotice open kind="warning" scale="s" icon="lock">
          <div slot="message">Your role is read-only — import and manual entry are disabled.</div>
        </CalciteNotice>
      )}

      {/* Upload / paste */}
      <fieldset
        disabled={!editable}
        style={{ border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, padding: 10, margin: 0 }}
      >
        <legend style={{ fontSize: 12, color: tokens.textMuted, padding: '0 6px' }}>Import CSV / XLSX-as-CSV</legend>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <CalciteButton scale="s" iconStart="upload" onClick={() => fileRef.current?.click()} disabled={!editable}>
            Choose file
          </CalciteButton>
          <CalciteButton scale="s" appearance="outline" iconStart="copy" onClick={() => setCsvText(CSV_TEMPLATE)}>
            Load template
          </CalciteButton>
        </div>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={CSV_TEMPLATE}
          rows={4}
          disabled={!editable}
          style={{
            width: '100%',
            marginTop: 8,
            padding: 8,
            fontFamily: 'monospace',
            fontSize: 11,
            background: tokens.panel,
            color: tokens.text,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
            resize: 'vertical',
          }}
        />
        <CalciteButton scale="s" style={{ marginTop: 8 }} onClick={() => runImport(csvText)} disabled={!editable || !csvText.trim()}>
          Import pasted rows
        </CalciteButton>
      </fieldset>

      {/* Manual add */}
      <fieldset
        disabled={!editable}
        style={{ border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, padding: 10, margin: 0 }}
      >
        <legend style={{ fontSize: 12, color: tokens.textMuted, padding: '0 6px' }}>Add a call by hand</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          {input('Berth id', 'berthId', 'NSICT-1')}
          {input('MMSI', 'mmsi', '419000001')}
          {input('Vessel name', 'name', 'MSC ...')}
          {input('Start (DD-MM-YYYY HH:mm)', 'start', '11-07-2026 06:00')}
          {input('End (DD-MM-YYYY HH:mm)', 'end', '11-07-2026 18:00')}
        </div>
        <CalciteButton scale="s" style={{ marginTop: 8 }} iconStart="plus" onClick={addManual} disabled={!editable}>
          Add call
        </CalciteButton>
      </fieldset>

      {notice && (
        <CalciteNotice open scale="s" kind={errors.length ? 'warning' : 'success'} icon>
          <div slot="message">{notice}</div>
        </CalciteNotice>
      )}

      {/* Row errors */}
      {errors.length > 0 && (
        <div style={{ fontSize: 11, color: tokens.bad, border: `1px solid ${tokens.bad}`, borderRadius: tokens.radius.sm, padding: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Rejected rows</div>
          {errors.slice(0, 12).map((e, i) => (
            <div key={i}>line {e.line} · {e.field}: {e.message}</div>
          ))}
          {errors.length > 12 && <div>…and {errors.length - 12} more.</div>}
        </div>
      )}

      {/* Constraint violations on the overlay */}
      {violations.length > 0 && (
        <div style={{ fontSize: 11, color: tokens.warn, border: `1px solid ${tokens.warn}`, borderRadius: tokens.radius.sm, padding: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Constraint checks ({violations.length})</div>
          {violations.slice(0, 10).map((v, i) => (
            <div key={i}>{v.code.replace(/_/g, ' ')}: {v.message}</div>
          ))}
        </div>
      )}

      {/* Current overlay */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Overlay calls ({imported.length})</span>
          {imported.length > 0 && editable && (
            <CalciteButton scale="s" appearance="outline" kind="danger" iconStart="trash" onClick={clear}>
              Clear all
            </CalciteButton>
          )}
        </div>
        {imported.length === 0 ? (
          <div style={{ fontSize: 11, color: tokens.textMuted }}>No manual/imported calls yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {imported.map((e) => (
              <div
                key={e.PLAN_ID}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 11,
                  padding: '4px 8px',
                  background: tokens.panelAlt,
                  borderRadius: tokens.radius.sm,
                }}
              >
                <span>
                  <strong>{e.VESSEL_NAME}</strong> · {e.BERTH_ID} · {istDateTime(e.PLANNED_START)}
                </span>
                {editable && (
                  <CalciteButton scale="s" appearance="transparent" iconStart="x" onClick={() => remove(e.PLAN_ID)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
