/**
 * Role model + client-side scoping (spec R-5). The tender requires the berthing
 * plan to be visible to all stakeholders "role-scoped": Marine Ops full;
 * Terminal sees own berths; Shipping line sees own vessels; Pilot desk the
 * pilotage queue; a read-only Viewer for VIP/committee use.
 *
 * SCOPE HONESTY: in this PoC the scoping is enforced *client-side* over mock
 * data — it demonstrates the role matrix and shapes every view, but it is not a
 * server-side authorization boundary. Production adds server-enforced role
 * claims on every API route (documented in the Security overview). We label the
 * active role and its scope everywhere so the behaviour is inspectable.
 */

import type { Berth, BerthingPlanEntry, PortCraftUnit, Vessel } from '@/types/domain';

export type Role = 'marineOps' | 'terminal' | 'shippingLine' | 'pilotDesk' | 'viewer';

export interface RoleDef {
  id: Role;
  label: string;
  /** One-line description of what this role can see/do. */
  scope: string;
  /** Can this role mutate (replan, run what-if, edit plan)? Viewer cannot. */
  canEdit: boolean;
  /** For terminal/shippingLine: which principal they are scoped to. */
  principalLabel?: string;
}

export const ROLES: Record<Role, RoleDef> = {
  marineOps: {
    id: 'marineOps',
    label: 'JNPA Marine Ops',
    scope: 'Full access — all berths, all vessels, all pilotage, edit & replan.',
    canEdit: true,
  },
  terminal: {
    id: 'terminal',
    label: 'Terminal Operator',
    scope: 'Own terminal berths and the calls scheduled on them.',
    canEdit: true,
    principalLabel: 'NSICT',
  },
  shippingLine: {
    id: 'shippingLine',
    label: 'Shipping Line',
    scope: 'Own vessels and their berthing windows only.',
    canEdit: false,
    principalLabel: 'MSC',
  },
  pilotDesk: {
    id: 'pilotDesk',
    label: 'Pilot Desk',
    scope: 'Pilotage queue, pilot/tug roster, DUKC windows.',
    canEdit: true,
  },
  viewer: {
    id: 'viewer',
    label: 'Read-only Viewer',
    scope: 'Read-only overview for VIP/committee — no edits.',
    canEdit: false,
  },
};

export const ROLE_LIST: RoleDef[] = Object.values(ROLES);

/**
 * A scoping principal binds a scoped role to the concrete terminal/line it
 * represents. Marine Ops / Pilot desk / Viewer ignore it.
 */
export interface Principal {
  /** Terminal id for a terminal operator (matches Berth.TERMINAL). */
  terminal?: string;
  /** Owned MMSIs for a shipping line. */
  ownedMmsi?: Set<string>;
}

export interface ScopeInput {
  berths: Berth[];
  plan: BerthingPlanEntry[];
  vessels: Vessel[];
  craft: PortCraftUnit[];
}

export interface ScopedData extends ScopeInput {
  /** True if a scoped role is hiding some records (for a "scoped" badge). */
  scoped: boolean;
}

/**
 * Apply a role's visibility scope to the full dataset. Pure — returns a new,
 * filtered dataset. Marine Ops and Viewer see everything (Viewer just can't
 * edit); Terminal is filtered to its terminal's berths; Shipping line to its
 * vessels; Pilot desk sees all vessels/craft but the plan is not its focus.
 */
export function scopeData(role: Role, principal: Principal, data: ScopeInput): ScopedData {
  const all = { ...data, scoped: false };

  switch (role) {
    case 'marineOps':
    case 'viewer':
      return all;

    case 'pilotDesk':
      // Pilotage-centric: all vessels + all craft, full plan for context.
      return all;

    case 'terminal': {
      const term = principal.terminal;
      if (!term) return all;
      const berths = data.berths.filter((b) => b.TERMINAL === term);
      const berthIds = new Set(berths.map((b) => b.BERTH_ID));
      const plan = data.plan.filter((p) => berthIds.has(p.BERTH_ID));
      const planMmsi = new Set(plan.map((p) => p.MMSI));
      const vessels = data.vessels.filter((v) => planMmsi.has(v.MMSI));
      const craft = data.craft.filter((c) => c.ASSIGNED_MMSI && planMmsi.has(c.ASSIGNED_MMSI));
      return {
        berths,
        plan,
        vessels,
        craft,
        scoped:
          berths.length !== data.berths.length ||
          plan.length !== data.plan.length ||
          vessels.length !== data.vessels.length,
      };
    }

    case 'shippingLine': {
      const owned = principal.ownedMmsi;
      if (!owned || owned.size === 0) return all;
      const vessels = data.vessels.filter((v) => owned.has(v.MMSI));
      const plan = data.plan.filter((p) => owned.has(p.MMSI));
      const berthIds = new Set(plan.map((p) => p.BERTH_ID));
      const berths = data.berths.filter((b) => berthIds.has(b.BERTH_ID));
      const craft = data.craft.filter((c) => c.ASSIGNED_MMSI && owned.has(c.ASSIGNED_MMSI));
      return {
        berths,
        plan,
        vessels,
        craft,
        scoped:
          vessels.length !== data.vessels.length || plan.length !== data.plan.length,
      };
    }

    default:
      return all;
  }
}

/** Whether a role may perform a mutating action (replan, what-if, plan edit). */
export function canEdit(role: Role): boolean {
  return ROLES[role].canEdit;
}
