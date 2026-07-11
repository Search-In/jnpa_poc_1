/**
 * <RoleSwitcher> — header control to switch the active stakeholder role (R-5).
 * Changing role re-scopes every data view (berths/vessels/plan) via the role
 * store. Shows the role's scope on hover and a "read-only" hint for view roles.
 */
import { CalciteSelect, CalciteOption } from '@esri/calcite-components-react';
import { useRoleStore } from './roleStore';
import { ROLE_LIST, ROLES, type Role } from './roles';
import { tokens } from '@/theme/tokens';

export function RoleSwitcher() {
  const role = useRoleStore((s) => s.role);
  const setRole = useRoleStore((s) => s.setRole);
  const def = ROLES[role];

  return (
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
  );
}
