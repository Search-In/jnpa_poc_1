/**
 * <RoleSwitcher> — header control to switch the active stakeholder role (R-5).
 * Changing role re-scopes every data view (berths/vessels/plan) via the role
 * store. Shows the role's scope on hover and a "read-only" hint for view roles.
 *
 * When the Shipping Line role is active it also offers a carrier picker fed by
 * the shared JNPA registry — see <ShippingLinePicker> below.
 */
import { useState } from 'react';
import { CalciteSelect, CalciteOption } from '@esri/calcite-components-react';
import { useRoleStore } from './roleStore';
import { ROLE_LIST, ROLES, type Role } from './roles';
import { tokens } from '@/theme/tokens';
import { getAdapter } from '@/data';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';

/**
 * Carrier picker for the Shipping Line role.
 *
 * DISPLAY-ONLY, deliberately. The registry behind it carries no MMSI, so a
 * selection cannot be joined to `Vessel` and must NOT drive `roleStore`'s
 * `ownedMmsi` — doing so would filter the map to zero vessels. Selecting a
 * carrier therefore changes this control and nothing else; the role's existing
 * vessel scoping is untouched.
 *
 * Options show the LINE CODE (ESA, KMD, RCL …) because the backend's
 * `line_name` is null for every row. That is the honest rendering of the data
 * that exists — no code→name table is invented here.
 *
 * Fetched once (interval 0): the registry only changes when the backend
 * re-imports. Any failure degrades to a muted note, so a backend outage can
 * never break the header.
 */
function ShippingLinePicker() {
  const { data, loading, error } = useAdapterQuery(() => getAdapter().getShippingLines(), []);
  const [selected, setSelected] = useState<string>('');

  const note = (text: string, title?: string) => (
    <span style={{ fontSize: 11, color: tokens.textMuted }} title={title}>
      {text}
    </span>
  );

  if (loading) return note('Carriers…');
  if (error) return note('Carriers unavailable', `Shipping-line registry unavailable: ${error}`);
  if (!data || data.length === 0) return note('No carriers');

  return (
    <label
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
      title={
        'Shipping lines from the shared JNPA registry, busiest first. Shown by line ' +
        'code — the source carries no carrier names. Display only: this does not ' +
        're-scope vessels.'
      }
    >
      <span aria-hidden style={{ color: tokens.textMuted }}>Carrier</span>
      <CalciteSelect
        label="Shipping line"
        scale="s"
        width="auto"
        value={selected}
        onCalciteSelectChange={(e) => setSelected((e.target as HTMLCalciteSelectElement).value)}
      >
        <CalciteOption value="">{`All (${data.length})`}</CalciteOption>
        {data.map((l) => (
          <CalciteOption key={l.lineCode} value={l.lineCode}>
            {`${l.lineCode} (${l.containerCount.toLocaleString()})`}
          </CalciteOption>
        ))}
      </CalciteSelect>
    </label>
  );
}

export function RoleSwitcher() {
  const role = useRoleStore((s) => s.role);
  const setRole = useRoleStore((s) => s.setRole);
  const def = ROLES[role];

  return (
    <>
      <label
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
        title={def.scope}
      >
        <span aria-hidden style={{ color: tokens.textMuted }}>Role</span>
        <CalciteSelect
          label="Active role"
          scale="s"
          width="auto"
          value={role}
          onCalciteSelectChange={(e) =>
            setRole((e.target as HTMLCalciteSelectElement).value as Role)
          }
        >
          {ROLE_LIST.map((r) => (
            <CalciteOption key={r.id} value={r.id}>
              {r.label}
            </CalciteOption>
          ))}
        </CalciteSelect>
        {!def.canEdit && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: tokens.warn,
              border: `1px solid ${tokens.warn}`,
              borderRadius: 3,
              padding: '1px 4px',
            }}
            title="This role is read-only"
          >
            READ-ONLY
          </span>
        )}
      </label>
      {role === 'shippingLine' && <ShippingLinePicker />}
    </>
  );
}
