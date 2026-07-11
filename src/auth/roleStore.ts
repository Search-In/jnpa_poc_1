/**
 * Active-role store (spec R-5). Holds the currently-selected stakeholder role
 * and its scoping principal, persisted to sessionStorage so a refresh keeps the
 * operator in the same role (crash recovery). Client-side only — see roles.ts
 * for the scope-honesty note.
 */
import { create } from 'zustand';
import { type Role, type Principal, ROLES } from './roles';

const KEY = 'jnpa.role.v1';

interface Persisted {
  role: Role;
  terminal?: string;
  ownedMmsi?: string[];
}

/** Default demo principals per scoped role (mock data). */
const DEFAULT_TERMINAL = 'NSICT';
const DEFAULT_LINE_MMSI = ['419000001', '419000002', '419000003'];

function load(): Persisted {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Persisted;
  } catch {
    /* ignore */
  }
  return { role: 'marineOps' };
}

function persist(p: Persisted): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function principalFor(p: Persisted): Principal {
  return {
    terminal: p.terminal ?? (p.role === 'terminal' ? DEFAULT_TERMINAL : undefined),
    ownedMmsi:
      p.role === 'shippingLine'
        ? new Set(p.ownedMmsi ?? DEFAULT_LINE_MMSI)
        : undefined,
  };
}

interface RoleState {
  role: Role;
  principal: Principal;
  setRole: (role: Role) => void;
}

export const useRoleStore = create<RoleState>((set) => {
  const initial = load();
  return {
    role: initial.role,
    principal: principalFor(initial),
    setRole: (role) => {
      const p: Persisted = {
        role,
        terminal: role === 'terminal' ? DEFAULT_TERMINAL : undefined,
        ownedMmsi: role === 'shippingLine' ? DEFAULT_LINE_MMSI : undefined,
      };
      persist(p);
      set({ role, principal: principalFor(p) });
    },
  };
});

/** Convenience: the active role's definition. */
export function activeRoleDef(role: Role) {
  return ROLES[role];
}
