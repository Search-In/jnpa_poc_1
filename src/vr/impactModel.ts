/**
 * VR/3D what-if impact model (spec §B2.10 — the WHERE + HOW answers, rendered in
 * an immersive first-person view instead of a top-down fly-to).
 *
 * This module answers one question: **under the current sim levers, which port
 * assets are impacted, how badly, and what label does each one carry?** The
 * walkthrough view then rings + labels exactly those assets in 3D.
 *
 * INTEGRITY RULE — no new causal logic lives here. Every judgement is delegated
 * to the existing engine (`sim/derive.ts`, `sim/simStore.ts`, `whatif/causalGraph.ts`,
 * `sim/scenarios.ts`), so the immersive view and the 2D dashboard can never tell
 * two different stories about the same scenario. If the dashboard says pilotage
 * is suspended, this says so too — because it asks the same function.
 *
 * Everything here is pure and deterministic (no Date.now / Math.random), so a
 * rehearsed VR run reproduces exactly, matching the sim-store contract.
 */
import type { Berth } from '@/types/domain';
import type { SimLevers } from '@/sim/simStore';
import {
  channelSegmentsClosed,
  controllingDepthM,
  corridorUkc,
  incidentSuspendsMovements,
  netChannelDepthDeltaM,
  pilotageSuspended,
  tideNow,
  weatherAt,
} from '@/sim/derive';
import { CHANNEL, TERMINALS } from '@/map/portGeometry';
import { SCENARIO_BY_ID } from '@/sim/scenarios';
import { NODE_BY_ID, chainEdges, type Domain } from '@/whatif/causalGraph';

/**
 * Severity ladder. Deliberately ordinal so the renderer can sort/dedupe and pick
 * the worst state per asset. `none` never reaches the scene.
 */
export type ImpactSeverity = 'none' | 'info' | 'warn' | 'critical';

const SEVERITY_RANK: Record<ImpactSeverity, number> = {
  none: 0,
  info: 1,
  warn: 2,
  critical: 3,
};

/** Which family of 3D asset an impact is anchored to. */
export type ImpactKind = 'terminal' | 'channel' | 'anchorage' | 'pilot' | 'berth';

/**
 * One impacted asset, ready to render as a ring + floating billboard label.
 * `assetId` resolves through `scene3d.asset3dPosition()` for terminals /
 * channel segments / anchorages / PBG; berth impacts carry `berthId` instead and
 * are positioned from the berth polygon.
 */
export interface AssetImpact {
  /** Stable id — matches the highlight vocabulary the rest of the app speaks. */
  assetId: string;
  kind: ImpactKind;
  /** Short asset name for the label's first line (e.g. "BMCT"). */
  label: string;
  /** What happened, ≤ ~40 chars — the label's second line. */
  headline: string;
  /** The quantified mechanism — the label's third line. */
  detail: string;
  severity: ImpactSeverity;
  /** Drives the label/ring colour via `DOMAIN_COLOR`. */
  domain: Domain;
  /** Berth polygon id when `kind === 'berth'`. */
  berthId?: string;
}

/** A causal edge to draw between two 3D anchors, carrying its mechanism label. */
export interface ImpactEdge {
  fromAssetId: string;
  toAssetId: string;
  /** The HOW text rendered along the edge. */
  mechanism: string;
  domain: Domain;
}

/** Ambient conditions the immersive view renders physically (water, sky, wind). */
export interface VrEnvironment {
  /** Tide height above chart datum, m — drives the water plane height. */
  tideM: number;
  windKt: number;
  windDir: number;
  seaStateM: number;
  visibilityNm: number;
  rainMmHr: number;
  /** True when pilot transfer is suspended — drives the "HOLD" state in the HUD. */
  pilotageSuspended: boolean;
  /** True when a marine incident suspends movements. */
  movementsSuspended: boolean;
  /** Controlling channel depth after siltation/dredging, m. */
  controllingDepthM: number;
  /** Net channel depth change vs charted, m (negative = loss). */
  channelDepthDeltaM: number;
}

export interface VrImpactModel {
  impacts: AssetImpact[];
  edges: ImpactEdge[];
  environment: VrEnvironment;
  /** Active scenario id, or null in free-run. */
  scenarioId: string | null;
  /** Scenario title for the HUD, or null. */
  scenarioTitle: string | null;
}

export interface ImpactInput {
  levers: SimLevers;
  clockH: number;
  berths: Berth[];
  scenarioId: string | null;
}

/** Pick the worse of two severities. */
function worst(a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** One decimal, sign-prefixed — the house style for a delta in a label. */
function signed(n: number, unit: string): string {
  const v = Number(n.toFixed(2));
  return `${v > 0 ? '+' : ''}${v} ${unit}`;
}

/**
 * Severity from under-keel clearance, using the same go/marginal/no-go bands the
 * DUKC corridor colours by (`ukcColor`): < 0.5 m is a no-go, < 1.0 m marginal.
 */
function ukcSeverity(ukcM: number): ImpactSeverity {
  if (ukcM < 0.5) return 'critical';
  if (ukcM < 1.0) return 'warn';
  return 'none';
}

/**
 * Compute every impacted asset under the current levers.
 *
 * Ordering is deterministic: pilotage → channel → berth/terminal → anchorage,
 * then by severity (worst first) within each group, so the HUD's "most impacted"
 * list and the in-scene labels agree and never reshuffle between frames.
 */
export function computeImpacts(input: ImpactInput): VrImpactModel {
  const { levers, clockH, berths, scenarioId } = input;

  const weather = weatherAt(clockH, levers);
  const held = pilotageSuspended(weather);
  const movementsHeld = incidentSuspendsMovements(levers);
  const closed = new Set(channelSegmentsClosed(levers));
  const depth = controllingDepthM(levers);
  const depthDelta = netChannelDepthDeltaM(levers);

  const impacts: AssetImpact[] = [];

  // ---- Pilot boarding ground -------------------------------------------------
  // Weather limits, visibility and craft availability all land on the same
  // physical asset, so they merge into one label with the worst severity.
  {
    const reasons: string[] = [];
    let sev: ImpactSeverity = 'none';
    if (held) {
      const why =
        weather.seaStateM >= 2.5
          ? `sea ${weather.seaStateM} m ≥ 2.5 m limit`
          : weather.windKt >= 30
            ? `wind ${weather.windKt} kt ≥ 30 kt limit`
            : `visibility ${weather.visibilityNm} nm < 1.0 nm`;
      reasons.push(why);
      sev = worst(sev, 'critical');
    }
    if (movementsHeld) {
      reasons.push('marine incident — movements suspended');
      sev = worst(sev, 'critical');
    }
    if (levers.pilotsDown > 0) {
      reasons.push(`${levers.pilotsDown} pilot${levers.pilotsDown > 1 ? 's' : ''} unavailable`);
      sev = worst(sev, 'warn');
    }
    if (levers.tugsDown > 0) {
      reasons.push(`${levers.tugsDown} tug${levers.tugsDown > 1 ? 's' : ''} unavailable`);
      sev = worst(sev, 'warn');
    }
    if (sev !== 'none') {
      impacts.push({
        assetId: 'PBG',
        kind: 'pilot',
        label: 'Pilot Boarding Ground',
        headline: held || movementsHeld ? 'Pilot transfer suspended' : 'Reduced pilot capacity',
        detail: reasons.join(' · '),
        severity: sev,
        domain: 'pilotage',
      });
    }
  }

  // ---- Channel segments ------------------------------------------------------
  // Closure (oil spill) outranks a UKC squeeze on the same reach.
  {
    const ukcBySeg = new Map(corridorUkc(clockH, levers).map((r) => [r.seg.id, r]));
    for (const seg of CHANNEL) {
      const isClosed = closed.has(seg.id);
      const row = ukcBySeg.get(seg.id);
      const ukcM = row ? Number(row.ukcM.toFixed(2)) : Number.NaN;
      const sev = isClosed ? 'critical' : Number.isFinite(ukcM) ? ukcSeverity(ukcM) : 'none';
      if (sev === 'none') continue;
      impacts.push({
        assetId: seg.id,
        kind: 'channel',
        label: seg.name,
        headline: isClosed ? 'Fairway closed' : ukcM < 0.5 ? 'UKC breach — no-go' : 'UKC marginal',
        detail: isClosed
          ? 'Segment shut while the incident is contained'
          : `UKC ${ukcM} m · controlling depth ${depth} m${depthDelta !== 0 ? ` (${signed(depthDelta, 'm')})` : ''} · tide ${weather.tideM} m`,
        severity: sev,
        domain: 'channel',
      });
    }
  }

  // ---- Berths taken out of service, and their parent terminals ---------------
  {
    const out = new Set(levers.berthsOut);
    const affectedTerminals = new Set<string>();
    for (const b of berths) {
      if (!out.has(b.BERTH_ID)) continue;
      affectedTerminals.add(b.TERMINAL);
      impacts.push({
        assetId: b.BERTH_ID,
        berthId: b.BERTH_ID,
        kind: 'berth',
        label: b.BERTH_NAME || b.BERTH_ID,
        headline: 'Berth out of service',
        detail: `${b.TERMINAL} · ${b.LENGTH_M} m · ${b.DRAFT_M} m draft — calls reallocate`,
        severity: 'critical',
        domain: 'berth',
      });
    }
    // A lever may name a berth the fixture set doesn't carry; still surface it
    // rather than silently dropping the operator's input.
    for (const id of out) {
      if (berths.some((b) => b.BERTH_ID === id)) continue;
      impacts.push({
        assetId: id,
        berthId: id,
        kind: 'berth',
        label: id,
        headline: 'Berth out of service',
        detail: 'Removed from the plan by the active scenario',
        severity: 'critical',
        domain: 'berth',
      });
      const terminal = id.split('-')[0];
      if (TERMINALS.some((t) => t.id === terminal)) affectedTerminals.add(terminal);
    }
    for (const t of TERMINALS) {
      if (!affectedTerminals.has(t.id)) continue;
      impacts.push({
        assetId: t.id,
        kind: 'terminal',
        label: t.name,
        headline: 'Berthing sequence replanned',
        detail: 'A berth is out — calls reallocate across terminals',
        severity: 'warn',
        domain: 'berth',
      });
    }
  }

  // ---- Deep-draft terminals losing their tidal window ------------------------
  // A depth loss bites the deepest-design terminals first; that is the whole M2
  // story, so it must be visible ON the terminal in the walkthrough.
  if (depthDelta < 0) {
    for (const t of TERMINALS) {
      // Available water for this terminal's design call vs its max draft.
      const available = depth + weather.tideM;
      const margin = Number((available - t.maxDraftM).toFixed(2));
      const sev = ukcSeverity(margin);
      if (sev === 'none') continue;
      impacts.push({
        assetId: t.id,
        kind: 'terminal',
        label: t.name,
        headline: margin < 0.5 ? 'Deep-draft window lost' : 'Deep-draft window narrowed',
        detail: `Design draft ${t.maxDraftM} m vs ${available.toFixed(2)} m available (depth ${depth} m + tide ${weather.tideM} m) · margin ${margin} m`,
        severity: sev,
        domain: 'channel',
      });
    }
  }

  // ---- Anchorage pressure ----------------------------------------------------
  {
    const queueing = held || movementsHeld || closed.size > 0;
    const extra = levers.extraArrivals;
    if (queueing || extra > 0) {
      const bits: string[] = [];
      if (extra > 0) bits.push(`${extra} extra arrival${extra > 1 ? 's' : ''} compressed into the window`);
      if (held) bits.push('inbound vessels hold — pilotage suspended');
      else if (movementsHeld) bits.push('inbound vessels hold — movements suspended');
      else if (closed.size > 0) bits.push('inbound vessels hold — fairway closed');
      const sev: ImpactSeverity = queueing && extra > 0 ? 'critical' : queueing ? 'warn' : 'info';
      impacts.push({
        assetId: 'ANCH-WAIT',
        kind: 'anchorage',
        label: 'Waiting anchorage',
        headline: 'Arrival queue building',
        detail: bits.join(' · '),
        severity: sev,
        domain: 'berth',
      });
      if (extra > 0) {
        impacts.push({
          assetId: 'ANCH-OUTER',
          kind: 'anchorage',
          label: 'Outer anchorage',
          headline: 'Anchorage filling',
          detail: `${extra} additional vessel${extra > 1 ? 's' : ''} at anchor awaiting a window`,
          severity: 'warn',
          domain: 'berth',
        });
      }
    }
  }

  // ---- Service overrun -------------------------------------------------------
  if (levers.berthWindowExtendH > 0) {
    for (const b of berths) {
      if (b.STATUS !== 'occupied') continue;
      impacts.push({
        assetId: b.BERTH_ID,
        berthId: b.BERTH_ID,
        kind: 'berth',
        label: b.BERTH_NAME || b.BERTH_ID,
        headline: 'Alongside window extended',
        detail: `Service overrun ${signed(levers.berthWindowExtendH, 'h')} — berth releases late, next call slips`,
        severity: 'warn',
        domain: 'berth',
      });
    }
  }

  const KIND_ORDER: Record<ImpactKind, number> = {
    pilot: 0,
    channel: 1,
    berth: 2,
    terminal: 3,
    anchorage: 4,
  };
  impacts.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.assetId.localeCompare(b.assetId)
  );

  const scenario = scenarioId ? SCENARIO_BY_ID[scenarioId] : undefined;

  return {
    impacts,
    edges: scenario ? causalEdgesFor(scenario.chain) : [],
    environment: {
      tideM: tideNow(clockH, levers),
      windKt: weather.windKt,
      windDir: weather.windDir,
      seaStateM: weather.seaStateM,
      visibilityNm: weather.visibilityNm ?? 10,
      rainMmHr: weather.rainMmHr ?? 0,
      pilotageSuspended: held,
      movementsSuspended: movementsHeld,
      controllingDepthM: depth,
      channelDepthDeltaM: depthDelta,
    },
    scenarioId: scenarioId ?? null,
    scenarioTitle: scenario?.title ?? null,
  };
}

/**
 * Project a scenario's causal chain onto physical anchors. Nodes carry `where[]`
 * asset ids; an edge becomes drawable when BOTH ends have somewhere to stand.
 * Purely KPI nodes (preBerthDelay, jit, tat) have no `where`, so the chain
 * terminates at the last physical asset — which is correct: you cannot stand on
 * a KPI. Those are reported in the HUD instead.
 */
export function causalEdgesFor(chain: string[]): ImpactEdge[] {
  const out: ImpactEdge[] = [];
  const seen = new Set<string>();
  for (const e of chainEdges(chain)) {
    const from = NODE_BY_ID[e.from];
    const to = NODE_BY_ID[e.to];
    const fromAnchor = from?.where?.[0];
    const toAnchor = to?.where?.[0];
    if (!fromAnchor || !toAnchor || fromAnchor === toAnchor) continue;
    const key = `${fromAnchor}->${toAnchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      fromAssetId: fromAnchor,
      toAssetId: toAnchor,
      mechanism: e.mechanism,
      domain: to.domain,
    });
  }
  return out;
}

/** Highest severity present — drives the HUD's overall state chip. */
export function overallSeverity(impacts: AssetImpact[]): ImpactSeverity {
  return impacts.reduce<ImpactSeverity>((acc, i) => worst(acc, i.severity), 'none');
}
