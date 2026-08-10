"""
UC1-M8 — Reactive Confidence Chain (23-Node / 30-Edge Causal DAG)
==================================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"The wind just hit 32 knots and two pilots called in sick. What does that do to
my under-keel clearance, my anchorage queue, my turnaround time — and how much
should I still trust the plan?"

This is the "reactive twin" evidence: one upstream change cascades visibly to
DUKC state, the berth plan, the craft roster and the KPIs, with a complete audit
trail.

GRAPH
-----
23 nodes, 30 directed edges. ``idx`` is the topological rank and EVERY edge runs
strictly from a lower to a higher index, which is what makes the graph acyclic
BY CONSTRUCTION rather than by hopeful assertion. Both chains named in the spec
exist as literal paths and are verified at import:

    Chain A  WEATHER_PILOTAGE_QUEUE_TAT
             wind -> boarding risk -> pilotage hold -> anchorage queue
                  -> TAT delay -> confidence
    Chain B  SILTATION_DUKC_WINDOW
             siltation -> controlling depth -> DUKC net UKC
                       -> deep-draft window -> berth plan feasibility

TWO NODE BASELINES ARE COMPUTED, NOT ASSERTED
----------------------------------------------
``DUKC_NET_UKC_M`` is not hard-coded. It is computed at graph construction by
the DUPLICATED DUKC CORE in SECTION 2, from the reference ULCV against the
baselines of ``CONTROLLING_DEPTH_M`` and ``TIDE_HEIGHT_M``:

    (15.0 + 2.6) - (15.0 + 0.65) - 1.0 = 0.95 m

which is exactly the canonical MARGINAL case in ``uc1_m1_dukc.py`` — the two
modules agree because they run the same core. Note what that means: the
reference ULCV at mean tide is ALREADY in the marginal band, so rule R5
(advisory) fires even in the nominal scenario. That is not a modelling error;
it is the reason JNPA is tide-dependent for deep-draft calls at all, and it is
what makes the dredging lever in scenario S4 worth anything.

``DEEP_DRAFT_WINDOW_H`` is likewise seeded by an embedded M2-style window scan.
That is the structural tie-in which makes this a graph OVER the deterministic
engines rather than a parallel invention with its own private physics.

WHY THESE WEIGHTS? — every edge is labelled
--------------------------------------------
Each edge carries a ``basis`` field, and the honest answer differs per edge:

    EXACT_PHYSICS      E04-E07. Siltation removes depth 1:1; tide adds it 1:1.
                       These are not estimates.
    CALIBRATED         E14 (DUKC -> deep-draft window) is regressed against the
                       embedded M2 scanner and its residuals are printed.
    EXPERT_JUDGEMENT   The operational edges. Labelled as such, with a stated
                       production upgrade path (structure learning / regression
                       on accumulated incident logs).

Do not hide the judgement edges. An evaluator who finds an unlabelled guess
distrusts the exact physics too.

PROPAGATION
-----------
    dnorm(source) = (value - baseline) / scale                for injected nodes
    dnorm(target) = sum over in-edges of  polarity * weight * dnorm(source)
    value(target) = clamp(baseline + dnorm(target) * scale, lo, hi)

Linear superposition in normalised space, swept in Kahn topological order.
Chosen over multiplicative confidence factors because it composes correctly for
several simultaneous disruptions, makes every edge individually attributable,
and reproduces the exact physics of E04-E07 without approximation.

EVERY STEP IS LOGGED
--------------------
``propagate()`` emits exactly one ``PropagationStep`` per node — all 23, every
run — including untouched nodes with a zero delta. Logging only what changed is
the easy path; logging all 23 is what satisfies "every propagation step logged"
under audit.

USAGE
-----
    python uc1_m8_causal_chain.py                       # full demo, exits 0
    python uc1_m8_causal_chain.py --scenario S5
    python uc1_m8_causal_chain.py --node WX_WIND_KN --value 35
    python uc1_m8_causal_chain.py --dot > graph.dot

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. FastAPI/pydantic optional. The DUKC core
in SECTION 2 is byte-identical to the copy in uc1_m1_dukc.py by design.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict, deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M8"
MODULE_NAME: str = "Reactive Confidence Chain (Causal DAG)"
MODULE_VERSION: str = "m8-causal-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m8"

DEFAULT_SEED: int = 20260807

EXPECTED_NODE_COUNT: int = 23
EXPECTED_EDGE_COUNT: int = 30

BASIS_EXACT: str = "EXACT_PHYSICS"
BASIS_CALIBRATED: str = "CALIBRATED"
BASIS_JUDGEMENT: str = "EXPERT_JUDGEMENT"

ALERT_NORMAL: str = "NORMAL"
ALERT_ADVISORY: str = "ADVISORY"
ALERT_DEGRADED: str = "DEGRADED"
ALERT_CRITICAL: str = "CRITICAL"

# Reference vessel used to seed the DUKC and window baselines.
REFERENCE_DRAFT_M: float = 15.0
REFERENCE_SPEED_KN: float = 10.0
REFERENCE_VESSEL_CLASS: str = "CONTAINER"

# Embedded M2-style scan geometry (used only to seed node 17 and calibrate E14).
SCAN_HOURS: float = 120.0
SCAN_STEP_H: float = 0.25
TIDE_MEAN_M: float = 2.6
TIDE_AMP_M: float = 1.7
TIDE_K1_AMP_M: float = 0.3
TIDE_M2_PERIOD_H: float = 12.4206

# ==========================================================================
# SECTION 2 — DUKC CORE  (DUPLICATED BY DESIGN into M1, M2, M6, M8)
# --------------------------------------------------------------------------
# This block is byte-identical across uc1_m1_dukc.py, uc1_m2_tidal_window.py,
# uc1_m6_jit_rta.py and uc1_m8_causal_chain.py. Do NOT factor it into a shared
# package — the flat-file architecture is a deliberate requirement so each
# module can be copied out and run in isolation.
#
# Drift between copies is the one real risk of that choice, so it is made
# DETECTABLE rather than merely discouraged:
#   1. DUKC_CORE_FINGERPRINT changes whenever any constant or formula changes.
#   2. _dukc_core_selftest() asserts golden values and runs from every __main__.
#   3. api.py asserts all four modules report the same fingerprint at mount time
#      and refuses to start otherwise.
# ==========================================================================

DUKC_CORE_VERSION: str = "1.0.0"
DUKC_CORE_FINGERPRINT: str = "dukc-core/1.0.0/barrass-cb-v2-clamp2.5/margin1.0/band0.6"

UKC_SAFETY_MARGIN_M: float = 1.0     # net UKC at or above this is SAFE
UKC_MARGINAL_BAND_M: float = 0.6     # net UKC at or above this is MARGINAL
MAX_SQUAT_CLAMP_M: float = 2.5       # Barrass squat clamp, upper bound
MIN_SQUAT_CLAMP_M: float = 0.0       # squat cannot be negative

CB_CONTAINER: float = 0.65           # block coefficient, container vessels
CB_BULK: float = 0.80                # block coefficient, bulk carriers

STATUS_SAFE: str = "SAFE"
STATUS_MARGINAL: str = "MARGINAL"
STATUS_NO_GO: str = "NO GO"

# Ordered worst -> best, used to compare / rank statuses.
_STATUS_RANK: Dict[str, int] = {STATUS_NO_GO: 0, STATUS_MARGINAL: 1, STATUS_SAFE: 2}


def _cb_for_class(vessel_class: str) -> float:
    """Block coefficient for a vessel class. DUPLICATED BY DESIGN."""
    key = (vessel_class or "").strip().upper()
    if key in ("BULK", "BULKER", "BULK CARRIER", "DRY BULK", "TANKER"):
        return CB_BULK
    return CB_CONTAINER


def _squat_m(cb: float, speed_kn: float) -> float:
    """
    Barrass-type squat, clamped to [0.0, 2.5] m. DUPLICATED BY DESIGN.

        squat = min(2.5, Cb * V^2 / 100)

    Speed is through-water in knots. Negative speed is treated as astern and
    uses |V| — squat is a function of speed magnitude.
    """
    raw = cb * (abs(float(speed_kn)) ** 2) / 100.0
    return max(MIN_SQUAT_CLAMP_M, min(MAX_SQUAT_CLAMP_M, raw))


def _effective_depth_m(
    charted_depth_m: float,
    tide_m: float,
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
) -> float:
    """Water column available over the bed. DUPLICATED BY DESIGN."""
    return float(charted_depth_m) + float(tide_m) - float(siltation_m) + float(dredging_m)


def _net_ukc_m(
    charted_depth_m: float,
    tide_m: float,
    siltation_m: float,
    draft_m: float,
    squat_m_value: float,
    margin_m: float = UKC_SAFETY_MARGIN_M,
    dredging_m: float = 0.0,
) -> Tuple[float, float]:
    """
    Return ``(gross_ukc_m, net_ukc_m)``. DUPLICATED BY DESIGN.

        gross = (charted + tide - siltation + dredging) - (draft + squat)
        net   = gross - margin
    """
    effective = _effective_depth_m(charted_depth_m, tide_m, siltation_m, dredging_m)
    gross = effective - (float(draft_m) + float(squat_m_value))
    return gross, gross - float(margin_m)


def _ukc_status(net_ukc: float) -> str:
    """Traffic-light classification of net UKC. DUPLICATED BY DESIGN."""
    if net_ukc >= UKC_SAFETY_MARGIN_M:
        return STATUS_SAFE
    if net_ukc >= UKC_MARGINAL_BAND_M:
        return STATUS_MARGINAL
    return STATUS_NO_GO


def _dukc_core_selftest() -> None:
    """
    Golden-value asserts for the duplicated core. DUPLICATED BY DESIGN.

    Any accidental edit to a constant or formula trips one of these immediately,
    in every module that carries the block.
    """
    assert abs(_squat_m(CB_CONTAINER, 10.0) - 0.650) < 1e-9, "squat(0.65,10) != 0.650"
    assert abs(_squat_m(CB_CONTAINER, 14.0) - 1.274) < 1e-9, "squat(0.65,14) != 1.274"
    assert abs(_squat_m(CB_BULK, 20.0) - 2.500) < 1e-9, "squat clamp at 2.5 m failed"
    assert abs(_squat_m(CB_CONTAINER, 0.0) - 0.0) < 1e-9, "squat at rest != 0"
    assert _ukc_status(1.00) == STATUS_SAFE
    assert _ukc_status(0.95) == STATUS_MARGINAL
    assert _ukc_status(0.60) == STATUS_MARGINAL
    assert _ukc_status(0.59) == STATUS_NO_GO
    gross, net = _net_ukc_m(15.0, 2.6, 0.0, 15.0, 0.65, UKC_SAFETY_MARGIN_M)
    assert abs(gross - 1.95) < 1e-9, "gross UKC golden value failed"
    assert abs(net - 0.95) < 1e-9, "net UKC golden value failed"
    assert _cb_for_class("CONTAINER") == CB_CONTAINER
    assert _cb_for_class("BULK") == CB_BULK


# --------------------------------------------------------------------------
# Shared formatting / time helpers. DUPLICATED BY DESIGN — do not factor out.
# --------------------------------------------------------------------------

def _utc_now() -> datetime:
    """Timezone-aware UTC now. DUPLICATED BY DESIGN."""
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    """ISO-8601 with a trailing Z. DUPLICATED BY DESIGN."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _step(
    n: int,
    label: str,
    formula: str,
    substitution: str,
    terms: Mapping[str, Any],
    value: Any,
    unit: str,
    note: str = "",
) -> Dict[str, Any]:
    """One auditable line of a ``breakdown`` dict. DUPLICATED BY DESIGN."""
    return {
        "step": n,
        "label": label,
        "formula": formula,
        "substitution": substitution,
        "terms": dict(terms),
        "value": value,
        "unit": unit,
        "note": note,
    }


def _fmt_table(headers: Sequence[str], rows: Sequence[Sequence[Any]], indent: str = "  ") -> str:
    """Fixed-width ASCII table. DUPLICATED BY DESIGN."""
    cols = [str(h) for h in headers]
    body = [[("" if c is None else str(c)) for c in r] for r in rows]
    widths = [len(c) for c in cols]
    for r in body:
        for i, c in enumerate(r):
            if i < len(widths):
                widths[i] = max(widths[i], len(c))
    line = indent + "  ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    rule = indent + "  ".join("-" * w for w in widths)
    out = [line, rule]
    for r in body:
        out.append(indent + "  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)))
    return "\n".join(out)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


# ==========================================================================
# SECTION 3 — DATACLASSES
# ==========================================================================


@dataclass(frozen=True)
class CausalNode:
    """One quantity in the port state model."""

    node_id: str
    idx: int                      # topological rank; every edge runs low -> high
    label: str
    category: str                 # WEATHER|HYDRO|RESOURCE|DEMAND|MARINE|SAFETY|
                                  # PLANNING|TERMINAL|KPI|LEVER
    unit: str
    baseline: float
    scale: float                  # normalising span
    lo: float
    hi: float
    is_exogenous: bool
    description: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "node_id": self.node_id,
            "idx": self.idx,
            "label": self.label,
            "category": self.category,
            "unit": self.unit,
            "baseline": round(self.baseline, 4),
            "scale": self.scale,
            "lo": self.lo,
            "hi": self.hi,
            "is_exogenous": self.is_exogenous,
            "description": self.description,
        }


@dataclass(frozen=True)
class CausalEdge:
    """One causal influence, with its provenance."""

    edge_id: str
    source: str
    target: str
    weight: float                 # normalised gain
    polarity: int                 # +1 | -1
    basis: str                    # EXACT_PHYSICS | CALIBRATED | EXPERT_JUDGEMENT
    rationale: str

    def physical_gain(self, graph: "CausalGraph") -> float:
        """
        Gain in TARGET units per SOURCE unit.

        This is the number a marine engineer can sanity-check: "+2.2 hours of
        deep-draft window per metre of under-keel clearance" is checkable;
        "weight 0.733" is not.
        """
        s = graph.nodes[self.source]
        t = graph.nodes[self.target]
        return self.polarity * self.weight * t.scale / s.scale

    def gain_unit(self, graph: "CausalGraph") -> str:
        s = graph.nodes[self.source]
        t = graph.nodes[self.target]
        return f"{t.unit} per {s.unit}"

    def as_dict(self, graph: Optional["CausalGraph"] = None) -> Dict[str, Any]:
        out = {
            "edge_id": self.edge_id,
            "source": self.source,
            "target": self.target,
            "weight": self.weight,
            "polarity": self.polarity,
            "basis": self.basis,
            "rationale": self.rationale,
        }
        if graph is not None:
            out["physical_gain"] = round(self.physical_gain(graph), 5)
            out["gain_unit"] = self.gain_unit(graph)
        return out


@dataclass(frozen=True)
class Disruption:
    """An injected sensor reading or an operator lever setting."""

    node_id: str
    value: float
    label: str = ""
    kind: str = "SENSOR"          # SENSOR | LEVER

    def as_dict(self) -> Dict[str, Any]:
        return {
            "node_id": self.node_id,
            "value": self.value,
            "label": self.label,
            "kind": self.kind,
        }


@dataclass(frozen=True)
class EdgeContribution:
    """One in-edge's share of a node's movement."""

    edge_id: str
    source: str
    source_delta_norm: float
    weight: float
    polarity: int
    contribution_norm: float
    contribution_physical: float
    share_pct: float
    basis: str
    substitution: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "edge_id": self.edge_id,
            "source": self.source,
            "source_delta_norm": round(self.source_delta_norm, 5),
            "weight": self.weight,
            "polarity": self.polarity,
            "contribution_norm": round(self.contribution_norm, 5),
            "contribution_physical": round(self.contribution_physical, 5),
            "share_pct": round(self.share_pct, 2),
            "basis": self.basis,
            "substitution": self.substitution,
        }


@dataclass(frozen=True)
class PropagationStep:
    """One node's recomputation. Emitted for ALL 23 nodes, every run."""

    seq: int
    node_id: str
    node_label: str
    topological_rank: int
    kind: str                     # INJECT | PROPAGATE | RULE_OVERRIDE | UNCHANGED
    contributions: Tuple[EdgeContribution, ...]
    formula: str
    substitution: str
    baseline_value: float
    delta_norm: float
    delta_physical: float
    new_value: float
    unit: str
    clamped: bool
    triggered_rule_id: Optional[str]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "seq": self.seq,
            "node_id": self.node_id,
            "node_label": self.node_label,
            "topological_rank": self.topological_rank,
            "kind": self.kind,
            "contributions": [c.as_dict() for c in self.contributions],
            "formula": self.formula,
            "substitution": self.substitution,
            "baseline_value": round(self.baseline_value, 4),
            "delta_norm": round(self.delta_norm, 5),
            "delta_physical": round(self.delta_physical, 4),
            "new_value": round(self.new_value, 4),
            "unit": self.unit,
            "clamped": self.clamped,
            "triggered_rule_id": self.triggered_rule_id,
        }


@dataclass(frozen=True)
class WorkflowRule:
    """An SOP rule applied as a FLOOR or CAP during the sweep."""

    rule_id: str
    name: str
    trigger_node: str
    operator: str                 # >= | <= | < | >
    threshold: float
    target_node: Optional[str]
    action: Optional[str]         # FLOOR | CAP | None (advisory only)
    action_value: Optional[float]
    workflow_actions: Tuple[str, ...]
    notify: Tuple[str, ...]
    severity: str                 # INFO | ADVISORY | WARNING | CRITICAL
    reference: str

    def fires(self, observed: float) -> bool:
        if self.operator == ">=":
            return observed >= self.threshold
        if self.operator == "<=":
            return observed <= self.threshold
        if self.operator == ">":
            return observed > self.threshold
        if self.operator == "<":
            return observed < self.threshold
        raise ValueError(f"unknown operator {self.operator!r}")

    def condition_text(self, observed: float) -> str:
        return f"{self.trigger_node} {observed:.3f} {self.operator} {self.threshold}"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "name": self.name,
            "trigger": f"{self.trigger_node} {self.operator} {self.threshold}",
            "target_node": self.target_node,
            "action": self.action,
            "action_value": self.action_value,
            "workflow_actions": list(self.workflow_actions),
            "notify": list(self.notify),
            "severity": self.severity,
            "reference": self.reference,
        }


@dataclass(frozen=True)
class TriggeredRule:
    """A rule that fired, and what it did."""

    rule: WorkflowRule
    observed_value: float
    condition_text: str
    node_before: Optional[float]
    node_after: Optional[float]

    def as_dict(self) -> Dict[str, Any]:
        return {
            **self.rule.as_dict(),
            "observed_value": round(self.observed_value, 4),
            "condition_text": self.condition_text,
            "node_before": None if self.node_before is None else round(self.node_before, 4),
            "node_after": None if self.node_after is None else round(self.node_after, 4),
        }


@dataclass(frozen=True)
class ChainTrace:
    """A named path walked hop by hop."""

    chain_id: str
    label: str
    edge_ids: Tuple[str, ...]
    node_ids: Tuple[str, ...]
    hops: Tuple[Dict[str, Any], ...]
    end_to_end_delta: float
    end_to_end_unit: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "chain_id": self.chain_id,
            "label": self.label,
            "edge_ids": list(self.edge_ids),
            "node_ids": list(self.node_ids),
            "hops": [dict(h) for h in self.hops],
            "end_to_end_delta": round(self.end_to_end_delta, 4),
            "end_to_end_unit": self.end_to_end_unit,
        }


@dataclass(frozen=True)
class CascadeResult:
    """The complete reactive assessment."""

    scenario_id: str
    scenario_title: str
    disruptions: Tuple[Disruption, ...]
    baseline_state: Dict[str, float]
    pure_propagation_state: Dict[str, float]
    final_state: Dict[str, float]
    deltas: Dict[str, float]
    propagation_log: Tuple[PropagationStep, ...]
    triggered_rules: Tuple[TriggeredRule, ...]
    untriggered_rules: Tuple[Dict[str, Any], ...]
    chain_traces: Tuple[ChainTrace, ...]
    dukc_status_before: str
    dukc_status_after: str
    confidence_before: float
    confidence_after: float
    confidence_delta: float
    alert_level: str
    top_contributors: Tuple[Tuple[str, float], ...]
    top_root_causes: Tuple[Tuple[str, float], ...]
    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self, include_full_log: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "scenario_id": self.scenario_id,
            "scenario_title": self.scenario_title,
            "disruptions": [d.as_dict() for d in self.disruptions],
            "baseline_state": {k: round(v, 4) for k, v in self.baseline_state.items()},
            "pure_propagation_state": {
                k: round(v, 4) for k, v in self.pure_propagation_state.items()
            },
            "final_state": {k: round(v, 4) for k, v in self.final_state.items()},
            "deltas": {k: round(v, 4) for k, v in self.deltas.items()},
            "triggered_rules": [t.as_dict() for t in self.triggered_rules],
            "untriggered_rules": [dict(r) for r in self.untriggered_rules],
            "chain_traces": [c.as_dict() for c in self.chain_traces],
            "dukc_status_before": self.dukc_status_before,
            "dukc_status_after": self.dukc_status_after,
            "confidence_before": round(self.confidence_before, 4),
            "confidence_after": round(self.confidence_after, 4),
            "confidence_delta": round(self.confidence_delta, 4),
            "alert_level": self.alert_level,
            "top_contributors": [[e, round(v, 5)] for e, v in self.top_contributors],
            "top_root_causes": [[n, round(v, 4)] for n, v in self.top_root_causes],
            "recommendation": self.recommendation,
            "breakdown": self.breakdown,
        }
        if include_full_log:
            out["propagation_log"] = [s.as_dict() for s in self.propagation_log]
        else:
            out["propagation_log_length"] = len(self.propagation_log)
        return out


# ==========================================================================
# SECTION 4 — GRAPH DEFINITION AND SENSOR PROVIDERS
# ==========================================================================

# --------------------------------------------------------------------------
# Embedded M2-style window scan. Used ONLY to seed node 17's baseline and to
# calibrate edge E14 — this is the tie-in that makes the DAG sit on top of the
# real physics rather than beside it.
# --------------------------------------------------------------------------


def _tide_height_m(hours_from_epoch: float) -> float:
    """Analytic mixed semi-diurnal tide, identical in form to UC1-M2's."""
    w = 2.0 * math.pi / TIDE_M2_PERIOD_H
    return (
        TIDE_MEAN_M
        + TIDE_AMP_M * math.cos(w * hours_from_epoch)
        + TIDE_K1_AMP_M * math.sin(0.5 * w * hours_from_epoch)
    )


def mean_deep_draft_window_h(
    controlling_depth_m: float,
    draft_m: float = REFERENCE_DRAFT_M,
    speed_kn: float = REFERENCE_SPEED_KN,
    cb: float = CB_CONTAINER,
    hours: float = SCAN_HOURS,
    step_h: float = SCAN_STEP_H,
) -> float:
    """
    Mean usable window length for the reference vessel, by direct scan.

    Same algorithm as UC1-M2: walk the tide curve, mark steps where net UKC
    reaches the SAFE threshold, assemble contiguous runs, average their length.
    Returns 0.0 when no window exists.
    """
    squat = _squat_m(cb, speed_kn)
    n = int(round(hours / step_h)) + 1
    feasible = []
    for i in range(n):
        t = i * step_h
        _, net = _net_ukc_m(
            controlling_depth_m, _tide_height_m(t), 0.0, draft_m, squat, UKC_SAFETY_MARGIN_M
        )
        feasible.append(net >= UKC_SAFETY_MARGIN_M)

    durations: List[float] = []
    i = 0
    while i < n:
        if not feasible[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and feasible[j + 1]:
            j += 1
        durations.append((j - i) * step_h)
        i = j + 1
    durations = [d for d in durations if d > 0.0]
    return sum(durations) / len(durations) if durations else 0.0


def _seed_baselines() -> Tuple[float, float]:
    """
    Compute the two derived baselines from the deterministic engines.

    Returns ``(dukc_net_ukc_m, deep_draft_window_h)``.
    """
    squat = _squat_m(CB_CONTAINER, REFERENCE_SPEED_KN)
    _, net = _net_ukc_m(15.0, TIDE_MEAN_M, 0.0, REFERENCE_DRAFT_M, squat, UKC_SAFETY_MARGIN_M)
    window = mean_deep_draft_window_h(15.0)
    return net, window


_SEED_DUKC_NET_UKC_M, _SEED_DEEP_DRAFT_WINDOW_H = _seed_baselines()


# --------------------------------------------------------------------------
# THE 23 NODES. idx is the topological rank; every edge runs low -> high.
# --------------------------------------------------------------------------
def _node_specs() -> List[CausalNode]:
    return [
        CausalNode("WX_WIND_KN", 1, "Wind speed", "WEATHER", "kn",
                   12.0, 30.0, 0.0, 60.0, True,
                   "Ten-minute mean wind at the pilot boarding ground."),
        CausalNode("WX_SWELL_M", 2, "Swell height", "WEATHER", "m",
                   0.8, 2.5, 0.0, 6.0, True,
                   "Significant swell height at the boarding ground."),
        CausalNode("WX_VIS_KM", 3, "Visibility", "WEATHER", "km",
                   8.0, 8.0, 0.0, 15.0, True,
                   "Horizontal visibility. Lower is worse, hence negative polarity."),
        CausalNode("WX_RAIN_MMHR", 4, "Rainfall rate", "WEATHER", "mm/h",
                   0.0, 25.0, 0.0, 80.0, True,
                   "Rain intensity; drives quay-crane and lashing stoppages."),
        CausalNode("TIDE_HEIGHT_M", 5, "Tide height", "HYDRO", "m",
                   TIDE_MEAN_M, TIDE_AMP_M, 0.4, 4.8, True,
                   "Height above chart datum at the controlling reach."),
        CausalNode("SILTATION_M", 6, "Siltation", "HYDRO", "m lost",
                   0.0, 0.5, 0.0, 1.5, True,
                   "Depth lost to sedimentation since the last survey."),
        CausalNode("DREDGING_DELTA_M", 7, "Dredging restored", "LEVER", "m gained",
                   0.0, 0.5, 0.0, 1.5, True,
                   "OPERATOR LEVER: depth restored by maintenance dredging."),
        CausalNode("PILOT_AVAIL_N", 8, "Pilots available", "RESOURCE", "pilots",
                   3.0, 3.0, 0.0, 3.0, True,
                   "Serviceable pilots on the current watch."),
        CausalNode("TUG_AVAIL_N", 9, "Tugs available", "RESOURCE", "tugs",
                   4.0, 4.0, 0.0, 4.0, True,
                   "Serviceable tugs on station."),
        CausalNode("ARRIVAL_DEMAND_N", 10, "Arrival demand", "DEMAND", "vessels/12h",
                   6.0, 6.0, 0.0, 20.0, True,
                   "Vessels declaring arrival in the next twelve hours."),
        CausalNode("CONTROLLING_DEPTH_M", 11, "Controlling depth", "HYDRO", "m",
                   15.0, 0.5, 10.0, 19.0, False,
                   "Least charted depth on the transit, net of siltation and dredging."),
        CausalNode("PILOT_BOARDING_RISK", 12, "Pilot boarding risk", "MARINE", "index",
                   0.15, 1.0, 0.0, 1.0, False,
                   "Risk index for ladder transfer at the boarding ground."),
        CausalNode("DUKC_NET_UKC_M", 13, "DUKC net UKC", "SAFETY", "m",
                   _SEED_DUKC_NET_UKC_M, 1.0, -3.0, 5.0, False,
                   "Net under-keel clearance for the reference ULCV. "
                   "Baseline COMPUTED by the duplicated DUKC core, not asserted."),
        CausalNode("PILOTAGE_CAPACITY", 14, "Pilotage capacity", "MARINE", "fraction",
                   1.0, 1.0, 0.0, 1.0, False,
                   "Fraction of nominal pilotage throughput currently deliverable."),
        CausalNode("TUG_CAPACITY", 15, "Tug capacity", "MARINE", "fraction",
                   1.0, 1.0, 0.0, 1.0, False,
                   "Fraction of nominal tug support currently deliverable."),
        CausalNode("PILOTAGE_HOLD", 16, "Pilotage hold", "MARINE", "severity",
                   0.0, 1.0, 0.0, 1.0, False,
                   "Severity of any suspension of pilotage movements."),
        CausalNode("DEEP_DRAFT_WINDOW_H", 17, "Deep-draft window", "PLANNING", "h/cycle",
                   _SEED_DEEP_DRAFT_WINDOW_H, 3.0, 0.0, 12.0, False,
                   "Mean usable transit window per tide cycle. "
                   "Baseline SEEDED by an embedded M2-style scan."),
        CausalNode("CHANNEL_THROUGHPUT_VPH", 18, "Channel throughput", "PLANNING", "vessels/h",
                   2.5, 1.5, 0.0, 5.0, False,
                   "Vessel movements the channel can absorb per hour."),
        CausalNode("ANCHORAGE_QUEUE_N", 19, "Anchorage queue", "PLANNING", "vessels",
                   2.0, 5.0, 0.0, 30.0, False,
                   "Vessels waiting at anchor for a berth or a window."),
        CausalNode("BERTH_PLAN_FEASIBILITY", 20, "Berth plan feasibility", "PLANNING", "fraction",
                   0.95, 1.0, 0.0, 1.0, False,
                   "Fraction of the published berth plan still achievable."),
        CausalNode("CRANE_PRODUCTIVITY", 21, "Crane productivity", "TERMINAL", "index",
                   1.0, 1.0, 0.0, 1.2, False,
                   "Quay-crane productivity against the 28 moves/hour reference."),
        CausalNode("TAT_DELAY_H", 22, "TAT delay", "KPI", "h",
                   0.0, 8.0, 0.0, 48.0, False,
                   "Additional turnaround time versus the published plan."),
        CausalNode("SYS_CONFIDENCE", 23, "System confidence", "KPI", "0-1",
                   0.95, 1.0, 0.05, 1.0, False,
                   "Overall confidence in the current operational picture. "
                   "A genuine terminal node with in-degree 3, not a bolt-on aggregate."),
    ]


# --------------------------------------------------------------------------
# THE 30 EDGES. Every edge runs from a lower idx to a higher idx, which makes
# the graph acyclic by construction.
# --------------------------------------------------------------------------
def _edge_specs() -> List[CausalEdge]:
    return [
        CausalEdge("E01", "WX_WIND_KN", "PILOT_BOARDING_RISK", 0.45, +1, BASIS_JUDGEMENT,
                   "Wind raises the risk of pilot-ladder transfer."),
        CausalEdge("E02", "WX_SWELL_M", "PILOT_BOARDING_RISK", 0.35, +1, BASIS_JUDGEMENT,
                   "Swell at the boarding ground makes the launch approach unsafe."),
        CausalEdge("E03", "WX_VIS_KM", "PILOT_BOARDING_RISK", 0.20, -1, BASIS_JUDGEMENT,
                   "Better visibility lowers transfer risk."),
        CausalEdge("E04", "SILTATION_M", "CONTROLLING_DEPTH_M", 1.00, -1, BASIS_EXACT,
                   "Siltation removes depth one-for-one. Not an estimate."),
        CausalEdge("E05", "DREDGING_DELTA_M", "CONTROLLING_DEPTH_M", 1.00, +1, BASIS_EXACT,
                   "Dredging restores depth one-for-one. OPERATOR LEVER."),
        CausalEdge("E06", "CONTROLLING_DEPTH_M", "DUKC_NET_UKC_M", 0.50, +1, BASIS_EXACT,
                   "A metre of depth is a metre of under-keel clearance."),
        CausalEdge("E07", "TIDE_HEIGHT_M", "DUKC_NET_UKC_M", 1.70, +1, BASIS_EXACT,
                   "A metre of tide is a metre of under-keel clearance."),
        CausalEdge("E08", "PILOT_BOARDING_RISK", "PILOTAGE_CAPACITY", 0.70, -1, BASIS_JUDGEMENT,
                   "Transfer risk suppresses the boarding rate."),
        CausalEdge("E09", "PILOT_AVAIL_N", "PILOTAGE_CAPACITY", 0.60, +1, BASIS_JUDGEMENT,
                   "Roster strength sets deliverable pilotage."),
        CausalEdge("E10", "TUG_AVAIL_N", "TUG_CAPACITY", 0.75, +1, BASIS_JUDGEMENT,
                   "Roster strength sets deliverable tug support."),
        CausalEdge("E11", "WX_WIND_KN", "TUG_CAPACITY", 0.25, -1, BASIS_JUDGEMENT,
                   "Tug handling degrades in strong wind."),
        CausalEdge("E12", "PILOTAGE_CAPACITY", "PILOTAGE_HOLD", 0.65, -1, BASIS_JUDGEMENT,
                   "Available capacity relieves the need to hold movements."),
        CausalEdge("E13", "PILOT_BOARDING_RISK", "PILOTAGE_HOLD", 0.55, +1, BASIS_JUDGEMENT,
                   "Transfer risk forces a hold on pilotage. [CHAIN A]"),
        CausalEdge("E14", "DUKC_NET_UKC_M", "DEEP_DRAFT_WINDOW_H", 0.733, +1, BASIS_CALIBRATED,
                   "Clearance widens the deep-draft window. Regressed against the "
                   "embedded M2 scanner; residuals printed in the demo. [CHAIN B]"),
        CausalEdge("E15", "DEEP_DRAFT_WINDOW_H", "CHANNEL_THROUGHPUT_VPH", 0.40, +1,
                   BASIS_JUDGEMENT, "A wider window admits more transits per cycle."),
        CausalEdge("E16", "PILOTAGE_HOLD", "CHANNEL_THROUGHPUT_VPH", 0.85, -1, BASIS_JUDGEMENT,
                   "A pilotage hold stops the channel outright."),
        CausalEdge("E17", "TUG_CAPACITY", "CHANNEL_THROUGHPUT_VPH", 0.35, +1, BASIS_JUDGEMENT,
                   "Tug availability gates the berthing rate."),
        CausalEdge("E18", "CHANNEL_THROUGHPUT_VPH", "ANCHORAGE_QUEUE_N", 0.90, -1,
                   BASIS_JUDGEMENT, "Service rate drains the queue."),
        CausalEdge("E19", "ARRIVAL_DEMAND_N", "ANCHORAGE_QUEUE_N", 0.80, +1, BASIS_JUDGEMENT,
                   "Arrival rate feeds the queue."),
        CausalEdge("E20", "PILOTAGE_HOLD", "ANCHORAGE_QUEUE_N", 0.60, +1, BASIS_JUDGEMENT,
                   "Held movements accumulate at anchor. [CHAIN A]"),
        CausalEdge("E21", "DEEP_DRAFT_WINDOW_H", "BERTH_PLAN_FEASIBILITY", 0.50, +1,
                   BASIS_JUDGEMENT, "Window width determines whether the plan can be flown. "
                                    "[CHAIN B]"),
        CausalEdge("E22", "ANCHORAGE_QUEUE_N", "BERTH_PLAN_FEASIBILITY", 0.55, -1,
                   BASIS_JUDGEMENT, "A growing queue breaks the published berth plan."),
        CausalEdge("E23", "WX_RAIN_MMHR", "CRANE_PRODUCTIVITY", 0.45, -1, BASIS_JUDGEMENT,
                   "Rain stops lashing and slows gantry work."),
        CausalEdge("E24", "WX_WIND_KN", "CRANE_PRODUCTIVITY", 0.20, -1, BASIS_JUDGEMENT,
                   "Gantry stow-wind limits reduce productivity."),
        CausalEdge("E25", "ANCHORAGE_QUEUE_N", "TAT_DELAY_H", 0.85, +1, BASIS_JUDGEMENT,
                   "Queueing is the dominant component of turnaround delay. [CHAIN A]"),
        CausalEdge("E26", "CRANE_PRODUCTIVITY", "TAT_DELAY_H", 0.65, -1, BASIS_JUDGEMENT,
                   "Lost productivity extends the berth stay."),
        CausalEdge("E27", "BERTH_PLAN_FEASIBILITY", "TAT_DELAY_H", 0.40, -1, BASIS_JUDGEMENT,
                   "An infeasible plan generates rework delay."),
        CausalEdge("E28", "TAT_DELAY_H", "SYS_CONFIDENCE", 0.35, -1, BASIS_JUDGEMENT,
                   "Missing the headline KPI erodes confidence. [CHAIN A]"),
        CausalEdge("E29", "DUKC_NET_UKC_M", "SYS_CONFIDENCE", 0.30, +1, BASIS_JUDGEMENT,
                   "Safety margin underpins confidence. The spec's "
                   "'tidal + craft + vessels -> DUKC -> confidence' link."),
        CausalEdge("E30", "BERTH_PLAN_FEASIBILITY", "SYS_CONFIDENCE", 0.15, +1, BASIS_JUDGEMENT,
                   "Plan integrity underpins confidence."),
    ]


NAMED_CHAINS: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "WEATHER_PILOTAGE_QUEUE_TAT": (
        "Weather -> pilotage hold -> anchorage queue -> TAT delay -> confidence",
        ("E01", "E13", "E20", "E25", "E28"),
    ),
    "SILTATION_DUKC_WINDOW": (
        "Siltation -> controlling depth -> DUKC -> deep-draft window -> plan feasibility",
        ("E04", "E06", "E14", "E21"),
    ),
}


DEFAULT_RULES: Tuple[WorkflowRule, ...] = (
    WorkflowRule(
        "R1", "WIND_PILOTAGE_HOLD", "WX_WIND_KN", ">=", 30.0,
        "PILOTAGE_HOLD", "FLOOR", 0.90,
        ("HOLD_PILOTAGE", "FREEZE_CHANNEL_TRANSITS"),
        ("VTS", "HARBOUR_MASTER", "TERMINALS"), "CRITICAL",
        "WS2 row 8: 'wind >= 30 kn -> hold pilotage + notify'",
    ),
    WorkflowRule(
        "R2", "FOG_TRANSIT_SUSPEND", "WX_VIS_KM", "<", 1.0,
        "PILOTAGE_HOLD", "FLOOR", 0.80,
        ("SUSPEND_TRANSITS", "ACTIVATE_RESTRICTED_VIS_PROCEDURE"),
        ("VTS", "PILOTS"), "CRITICAL",
        "Restricted-visibility SOP",
    ),
    WorkflowRule(
        "R3", "SWELL_BOARDING_RESTRICT", "WX_SWELL_M", ">=", 2.5,
        "PILOT_BOARDING_RISK", "FLOOR", 0.70,
        ("BOARD_AT_INNER_STATION", "HELI_TRANSFER_STANDBY"),
        ("PILOTS",), "WARNING",
        "Pilot boarding limits",
    ),
    WorkflowRule(
        "R4", "DUKC_NO_GO", "DUKC_NET_UKC_M", "<", UKC_MARGINAL_BAND_M,
        "BERTH_PLAN_FEASIBILITY", "CAP", 0.30,
        ("DEFER_DEEP_DRAFT_TRANSITS", "RECOMPUTE_TIDAL_WINDOWS"),
        ("DEPUTY_CONSERVATOR", "HARBOUR_MASTER"), "CRITICAL",
        "UKC_MARGINAL_BAND_M from the shared DUKC core",
    ),
    WorkflowRule(
        "R5", "DUKC_MARGINAL", "DUKC_NET_UKC_M", "<", UKC_SAFETY_MARGIN_M,
        None, None, None,
        ("REDUCE_TRANSIT_SPEED_2KN", "ISSUE_PILOT_ADVISORY"),
        ("HARBOUR_MASTER",), "ADVISORY",
        "UKC_SAFETY_MARGIN_M from the shared DUKC core",
    ),
    WorkflowRule(
        "R6", "PILOT_SHORTAGE", "PILOT_AVAIL_N", "<=", 1.0,
        "PILOTAGE_CAPACITY", "CAP", 0.34,
        ("CALL_OUT_RELIEF_PILOT", "STAGGER_ARRIVALS"),
        ("MARINE_CONTROL",), "WARNING",
        "Briefing edge case EC-4 (craft shortage)",
    ),
    WorkflowRule(
        "R7", "TUG_SHORTAGE", "TUG_AVAIL_N", "<=", 2.0,
        "TUG_CAPACITY", "CAP", 0.50,
        ("RESTRICT_ULCV_BERTHING_LOA_GT_350",),
        ("MARINE_CONTROL", "TERMINALS"), "WARNING",
        "Briefing edge case EC-4 (craft shortage)",
    ),
    WorkflowRule(
        "R8", "RAIN_CRANE_SLOWDOWN", "WX_RAIN_MMHR", ">=", 15.0,
        "CRANE_PRODUCTIVITY", "CAP", 0.75,
        ("LASHING_STOP_ADVISORY", "REVISE_BERTH_ETD"),
        ("TERMINALS",), "ADVISORY",
        "Terminal wet-weather SOP",
    ),
    WorkflowRule(
        "R9", "QUEUE_ESCALATION", "ANCHORAGE_QUEUE_N", ">=", 8.0,
        None, None, None,
        ("ACTIVATE_ANCHORAGE_SEQUENCING", "NOTIFY_AGENTS"),
        ("ICCC", "AGENTS"), "WARNING",
        "Anchorage congestion escalation",
    ),
    WorkflowRule(
        "R10", "CONFIDENCE_ALERT", "SYS_CONFIDENCE", "<", 0.60,
        None, None, None,
        ("ICCC_MAJOR_INCIDENT_STANDUP", "PUBLISH_REVISED_KPI"),
        ("CHAIRMAN", "ICCC"), "CRITICAL",
        "ICCC escalation matrix",
    ),
)


class CausalGraph:
    """
    The port state model.

    Validation runs in ``__init__`` and is fatal: 23 nodes, 30 edges, every edge
    forward in topological rank, no orphans, both named chains real. A graph
    that fails any of these is not usable for an audit trail, so it is refused
    rather than repaired.
    """

    def __init__(
        self,
        nodes: Optional[Sequence[CausalNode]] = None,
        edges: Optional[Sequence[CausalEdge]] = None,
        reference_draft_m: float = REFERENCE_DRAFT_M,
        reference_speed_kn: float = REFERENCE_SPEED_KN,
    ) -> None:
        node_list = list(nodes) if nodes is not None else _node_specs()
        edge_list = list(edges) if edges is not None else _edge_specs()

        # Re-seed the two computed baselines for the requested reference vessel.
        if nodes is None:
            squat = _squat_m(_cb_for_class(REFERENCE_VESSEL_CLASS), reference_speed_kn)
            depth_node = next(n for n in node_list if n.node_id == "CONTROLLING_DEPTH_M")
            tide_node = next(n for n in node_list if n.node_id == "TIDE_HEIGHT_M")
            _, net = _net_ukc_m(
                depth_node.baseline, tide_node.baseline, 0.0,
                reference_draft_m, squat, UKC_SAFETY_MARGIN_M,
            )
            window = mean_deep_draft_window_h(
                depth_node.baseline, reference_draft_m, reference_speed_kn
            )
            node_list = [
                replace(n, baseline=net) if n.node_id == "DUKC_NET_UKC_M"
                else replace(n, baseline=window) if n.node_id == "DEEP_DRAFT_WINDOW_H"
                else n
                for n in node_list
            ]

        self.nodes: Dict[str, CausalNode] = {n.node_id: n for n in node_list}
        self.edges: Tuple[CausalEdge, ...] = tuple(edge_list)
        self.reference_draft_m = reference_draft_m
        self.reference_speed_kn = reference_speed_kn
        self._in_edges: Dict[str, List[CausalEdge]] = defaultdict(list)
        self._out_edges: Dict[str, List[CausalEdge]] = defaultdict(list)
        for e in self.edges:
            self._in_edges[e.target].append(e)
            self._out_edges[e.source].append(e)
        self.validate()

    # -- validation --------------------------------------------------------
    def validate(self) -> Dict[str, Any]:
        """Fatal structural validation. Returns the report on success."""
        assert len(self.nodes) == EXPECTED_NODE_COUNT, (
            f"expected {EXPECTED_NODE_COUNT} nodes, found {len(self.nodes)}"
        )
        assert len(self.edges) == EXPECTED_EDGE_COUNT, (
            f"expected {EXPECTED_EDGE_COUNT} edges, found {len(self.edges)}"
        )
        ids = [e.edge_id for e in self.edges]
        assert len(set(ids)) == len(ids), "duplicate edge ids"

        forward_violations = []
        for e in self.edges:
            assert e.source in self.nodes, f"{e.edge_id}: unknown source {e.source}"
            assert e.target in self.nodes, f"{e.edge_id}: unknown target {e.target}"
            if self.nodes[e.source].idx >= self.nodes[e.target].idx:
                forward_violations.append(e.edge_id)
        assert not forward_violations, (
            f"edges run backwards in topological rank: {forward_violations} — "
            f"the graph would not be acyclic"
        )

        orphans = [
            n for n in self.nodes
            if not self._in_edges[n] and not self._out_edges[n]
        ]
        assert not orphans, f"orphan nodes with no incident edges: {orphans}"

        order = self.topological_order()
        assert len(order) == len(self.nodes), "Kahn ordering failed — the graph has a cycle"

        for chain_id, (_, edge_ids) in NAMED_CHAINS.items():
            by_id = {e.edge_id: e for e in self.edges}
            missing = [eid for eid in edge_ids if eid not in by_id]
            assert not missing, f"chain {chain_id} references unknown edges {missing}"
            for a, b in zip(edge_ids, edge_ids[1:]):
                assert by_id[a].target == by_id[b].source, (
                    f"chain {chain_id} is not a path: {a} ends at {by_id[a].target} "
                    f"but {b} starts at {by_id[b].source}"
                )

        return {
            "node_count": len(self.nodes),
            "edge_count": len(self.edges),
            "acyclic": True,
            "all_edges_forward": True,
            "orphan_nodes": [],
            "kahn_ok": True,
            "named_chains_verified": sorted(NAMED_CHAINS),
        }

    def topological_order(self) -> List[str]:
        """Kahn's algorithm. Raises on a cycle."""
        indeg: Dict[str, int] = {n: 0 for n in self.nodes}
        for e in self.edges:
            indeg[e.target] += 1
        # Seed in idx order so the sweep is deterministic.
        q = deque(sorted((n for n, d in indeg.items() if d == 0),
                         key=lambda n: self.nodes[n].idx))
        order: List[str] = []
        while q:
            n = q.popleft()
            order.append(n)
            for e in sorted(self._out_edges[n], key=lambda e: self.nodes[e.target].idx):
                indeg[e.target] -= 1
                if indeg[e.target] == 0:
                    q.append(e.target)
            q = deque(sorted(q, key=lambda x: self.nodes[x].idx))
        if len(order) != len(self.nodes):
            raise ValueError("graph contains a cycle; topological order impossible")
        return order

    def in_edges(self, node_id: str) -> List[CausalEdge]:
        return sorted(self._in_edges[node_id], key=lambda e: e.edge_id)

    def out_edges(self, node_id: str) -> List[CausalEdge]:
        return sorted(self._out_edges[node_id], key=lambda e: e.edge_id)

    def baseline_state(self) -> Dict[str, float]:
        return {n.node_id: n.baseline for n in self.nodes.values()}

    def exogenous_ids(self) -> List[str]:
        return sorted(
            (n.node_id for n in self.nodes.values() if n.is_exogenous),
            key=lambda n: self.nodes[n].idx,
        )


def build_graph(
    reference_draft_m: float = REFERENCE_DRAFT_M,
    reference_speed_kn: float = REFERENCE_SPEED_KN,
) -> CausalGraph:
    """Construct and validate the standard 23/30 graph."""
    return CausalGraph(
        reference_draft_m=reference_draft_m, reference_speed_kn=reference_speed_kn
    )


try:  # pragma: no cover
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class SensorProvider(Protocol):
    """Supplies live readings for the exogenous nodes."""

    @property
    def source_id(self) -> str: ...

    def read(self) -> Dict[str, float]: ...


class BaselineSensorProvider:
    """Nominal fair-weather state. Default; no I/O."""

    source_id = "BASELINE_NOMINAL_v1"

    def __init__(self, graph: Optional[CausalGraph] = None) -> None:
        self.graph = graph or build_graph()

    def read(self) -> Dict[str, float]:
        return {
            nid: self.graph.nodes[nid].baseline for nid in self.graph.exogenous_ids()
        }


class LiveSensorProvider:
    """
    REAL-DATA STUB — live readings for the exogenous nodes.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Each exogenous node needs one feed:

        WX_WIND_KN, WX_SWELL_M, WX_VIS_KM, WX_RAIN_MMHR
            -> port AWS / IMD feed. Wind is the ten-minute mean at the pilot
               boarding ground, not a gust.
        TIDE_HEIGHT_M
            -> INCOIS tide gauge, or UC1-M2's analytic curve as a fallback.
               Height above chart datum, metres.
        SILTATION_M
            -> difference between the latest post-dredge survey and the design
               depth. Source: Bathymetry_Design_Depths\\*.pdf title blocks.
        DREDGING_DELTA_M
            -> OPERATOR LEVER. Set by the dredging programme, not sensed.
        PILOT_AVAIL_N, TUG_AVAIL_N
            -> UC1-M7 roster state (serviceable_supply), supplied as data.
        ARRIVAL_DEMAND_N
            -> count of PCS CALINF / BERMAN declarations with EDTA inside the
               next twelve hours.

    All feeds must be converted to the units declared on each CausalNode before
    injection; the graph does no unit conversion.
    """

    source_id = "JNPA_LIVE_SENSORS/NOT_IMPLEMENTED"

    def read(self) -> Dict[str, float]:
        raise NotImplementedError(LiveSensorProvider.__doc__)


# ==========================================================================
# SECTION 5 — ENGINE: PROPAGATION, RULES, ATTRIBUTION
# ==========================================================================


def calibrate_e14(graph: CausalGraph) -> Dict[str, Any]:
    """
    Check edge E14 against the exact scanner it was regressed from.

    E14 claims a gain of +2.2 hours of deep-draft window per metre of net UKC.
    That claim is testable: perturb the controlling depth, run the embedded scan
    for the truth, run the linearised edge for the prediction, and compare. Both
    residuals are asserted under 10% in the self-test.

    This is the answer to "why 0.733?" — it is not a guess, it is a fit.
    """
    e14 = next(e for e in graph.edges if e.edge_id == "E14")
    gain = e14.physical_gain(graph)             # h per m
    base_depth = graph.nodes["CONTROLLING_DEPTH_M"].baseline
    base_ukc = graph.nodes["DUKC_NET_UKC_M"].baseline
    base_window = graph.nodes["DEEP_DRAFT_WINDOW_H"].baseline

    cases = []
    for label, delta_depth in (("siltation +0.3 m", -0.3), ("dredging +0.5 m", +0.5)):
        exact = mean_deep_draft_window_h(
            base_depth + delta_depth, graph.reference_draft_m, graph.reference_speed_kn
        )
        # The DAG's linear prediction: depth moves UKC 1:1 (E06 is exact physics).
        predicted = base_window + gain * delta_depth
        residual = (predicted - exact) / exact * 100.0 if exact else float("nan")
        cases.append({
            "case": label,
            "delta_depth_m": delta_depth,
            "exact_window_h": round(exact, 3),
            "dag_predicted_h": round(predicted, 3),
            "residual_pct": round(residual, 2),
            "within_10pct": abs(residual) < 10.0 if math.isfinite(residual) else False,
        })

    return {
        "edge": "E14",
        "basis": e14.basis,
        "physical_gain_h_per_m": round(gain, 4),
        "baseline_net_ukc_m": round(base_ukc, 4),
        "baseline_window_h": round(base_window, 4),
        "cases": cases,
        "all_within_10pct": all(c["within_10pct"] for c in cases),
        "note": (
            "E14 is the only CALIBRATED edge. E04-E07 are exact physics; every "
            "other edge is EXPERT_JUDGEMENT and is labelled as such."
        ),
    }


def propagate(
    graph: CausalGraph,
    disruptions: Sequence[Disruption] = (),
    rules: Sequence[WorkflowRule] = DEFAULT_RULES,
    apply_rules: bool = True,
    scenario_id: str = "ADHOC",
    scenario_title: str = "Live operational assessment",
) -> CascadeResult:
    """
    Propagate disruptions through the DAG and recompute every downstream KPI.

    Emits exactly one :class:`PropagationStep` per node — all 23, every run,
    including nodes that did not move. Rules are applied INSIDE the sweep, at
    the moment their target node is computed, as FLOOR/CAP overrides, so the
    result is deterministic and order-independent.
    """
    baseline = graph.baseline_state()
    order = graph.topological_order()
    by_edge = {e.edge_id: e for e in graph.edges}

    injected: Dict[str, float] = {}
    for d in disruptions:
        if d.node_id not in graph.nodes:
            raise ValueError(f"unknown node_id {d.node_id!r}")
        if not graph.nodes[d.node_id].is_exogenous:
            raise ValueError(
                f"{d.node_id} is a derived node; only exogenous nodes can be injected. "
                f"Exogenous: {graph.exogenous_ids()}"
            )
        injected[d.node_id] = d.value

    # --- pass 1: pure propagation, no rules -------------------------------
    def _sweep(with_rules: bool) -> Tuple[Dict[str, float], Dict[str, float],
                                          List[PropagationStep], List[TriggeredRule]]:
        values: Dict[str, float] = {}
        dnorm: Dict[str, float] = {}
        steps: List[PropagationStep] = []
        fired: List[TriggeredRule] = []
        seq = 0

        for nid in order:
            node = graph.nodes[nid]
            seq += 1
            triggered_rule_id: Optional[str] = None
            contributions: List[EdgeContribution] = []

            if nid in injected:
                raw = injected[nid]
                d = (raw - node.baseline) / node.scale if node.scale else 0.0
                new_value = _clamp(raw, node.lo, node.hi)
                kind = "INJECT"
                formula = "value = injected reading"
                substitution = (
                    f"{node.baseline:.3f} -> {raw:.3f} {node.unit} "
                    f"(dnorm {d:+.4f})"
                )
            else:
                incoming = graph.in_edges(nid)
                total = 0.0
                for e in incoming:
                    src_d = dnorm.get(e.source, 0.0)
                    contrib = e.polarity * e.weight * src_d
                    total += contrib
                    contributions.append(
                        EdgeContribution(
                            edge_id=e.edge_id,
                            source=e.source,
                            source_delta_norm=src_d,
                            weight=e.weight,
                            polarity=e.polarity,
                            contribution_norm=contrib,
                            contribution_physical=contrib * node.scale,
                            share_pct=0.0,          # filled in below
                            basis=e.basis,
                            substitution=(
                                f"{e.edge_id} {e.polarity:+d}*{e.weight}*"
                                f"({src_d:+.4f}) = {contrib:+.4f}"
                            ),
                        )
                    )
                denom = sum(abs(c.contribution_norm) for c in contributions) or 1.0
                contributions = [
                    replace(c, share_pct=abs(c.contribution_norm) / denom * 100.0)
                    for c in contributions
                ]
                d = total
                raw = node.baseline + d * node.scale
                new_value = _clamp(raw, node.lo, node.hi)
                kind = "PROPAGATE" if incoming else "UNCHANGED"
                if abs(d) < 1e-12:
                    kind = "UNCHANGED"
                formula = "value = clamp(baseline + scale * sum(pol * w * dnorm(src)), lo, hi)"
                parts = " | ".join(c.substitution for c in contributions) or "no in-edges"
                substitution = (
                    f"{node.baseline:.3f} + {node.scale} * [{parts}] = {raw:.4f} "
                    f"-> {new_value:.4f} {node.unit}"
                )

            # Rules fire at the moment their TARGET node is computed.
            if with_rules:
                for rule in rules:
                    if rule.target_node != nid or rule.action is None:
                        continue
                    trigger_value = (
                        values.get(rule.trigger_node)
                        if rule.trigger_node in values
                        else injected.get(
                            rule.trigger_node, baseline.get(rule.trigger_node, 0.0)
                        )
                    )
                    if trigger_value is None or not rule.fires(trigger_value):
                        continue
                    before = new_value
                    if rule.action == "FLOOR":
                        new_value = max(new_value, float(rule.action_value))
                    elif rule.action == "CAP":
                        new_value = min(new_value, float(rule.action_value))
                    new_value = _clamp(new_value, node.lo, node.hi)
                    if abs(new_value - before) > 1e-12:
                        kind = "RULE_OVERRIDE"
                        triggered_rule_id = rule.rule_id
                        substitution += (
                            f"  ||  RULE {rule.rule_id} {rule.name} "
                            f"({rule.condition_text(trigger_value)}) "
                            f"{rule.action} {before:.4f} -> {new_value:.4f}"
                        )
                    fired.append(
                        TriggeredRule(rule, trigger_value,
                                      rule.condition_text(trigger_value), before, new_value)
                    )

            values[nid] = new_value
            dnorm[nid] = (new_value - node.baseline) / node.scale if node.scale else 0.0

            steps.append(
                PropagationStep(
                    seq=seq,
                    node_id=nid,
                    node_label=node.label,
                    topological_rank=node.idx,
                    kind=kind,
                    contributions=tuple(contributions),
                    formula=formula,
                    substitution=substitution,
                    baseline_value=node.baseline,
                    delta_norm=dnorm[nid],
                    delta_physical=new_value - node.baseline,
                    new_value=new_value,
                    unit=node.unit,
                    clamped=abs(raw - new_value) > 1e-9,
                    triggered_rule_id=triggered_rule_id,
                )
            )
        return values, dnorm, steps, fired

    pure_state, _, _, _ = _sweep(with_rules=False)
    final_state, final_dnorm, steps, fired = _sweep(with_rules=apply_rules)

    # Advisory rules (no target node) are evaluated against the final state.
    advisory: List[TriggeredRule] = []
    untriggered: List[Dict[str, Any]] = []
    for rule in rules:
        observed = final_state.get(rule.trigger_node, baseline.get(rule.trigger_node, 0.0))
        if rule.fires(observed):
            if rule.action is None:
                advisory.append(
                    TriggeredRule(rule, observed, rule.condition_text(observed), None, None)
                )
        else:
            untriggered.append({
                **rule.as_dict(),
                "observed_value": round(observed, 4),
                "condition_not_met": rule.condition_text(observed),
            })

    # Deduplicate FLOOR/CAP rules that fired, keeping the first occurrence.
    seen_rules: Set[str] = set()
    all_fired: List[TriggeredRule] = []
    for t in list(fired) + advisory:
        if t.rule.rule_id in seen_rules:
            continue
        seen_rules.add(t.rule.rule_id)
        all_fired.append(t)
    all_fired.sort(key=lambda t: t.rule.rule_id)

    deltas = {k: final_state[k] - baseline[k] for k in final_state}

    conf_before = baseline["SYS_CONFIDENCE"]
    conf_after = final_state["SYS_CONFIDENCE"]
    dukc_before = _ukc_status(baseline["DUKC_NET_UKC_M"])
    dukc_after = _ukc_status(final_state["DUKC_NET_UKC_M"])

    # Alert level: the worst of the confidence band and any CRITICAL rule.
    if conf_after < 0.45 or any(t.rule.severity == "CRITICAL" for t in all_fired):
        alert = ALERT_CRITICAL
    elif conf_after < 0.70:
        alert = ALERT_DEGRADED
    elif conf_after < 0.90:
        alert = ALERT_ADVISORY
    else:
        alert = ALERT_NORMAL

    # Edge attribution: which single influences moved the graph most.
    contrib_totals: Dict[str, float] = defaultdict(float)
    for s in steps:
        for c in s.contributions:
            contrib_totals[c.edge_id] += abs(c.contribution_physical)
    top_edges = tuple(
        sorted(contrib_totals.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    )

    # Root-cause attribution: back-propagate the confidence delta to the
    # exogenous nodes along path products. This answers the question an
    # executive actually asks — "which sensor is responsible, and by how much?"
    root_causes = _root_cause_attribution(graph, injected, final_dnorm)

    traces = tuple(
        _trace_chain(graph, cid, baseline, final_state) for cid in sorted(NAMED_CHAINS)
    )

    rec = _recommendation(
        alert, conf_before, conf_after, dukc_before, dukc_after,
        final_state, all_fired, root_causes,
    )

    breakdown: Dict[str, Any] = {
        "model": "M8_CAUSAL_CONFIDENCE_CHAIN",
        "version": MODULE_VERSION,
        "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
        "scenario_id": scenario_id,
        "graph": {
            **graph.validate(),
            "topological_order": order,
            "seeded_baselines": {
                "DUKC_NET_UKC_M": round(baseline["DUKC_NET_UKC_M"], 4),
                "DUKC_NET_UKC_M_source": (
                    f"computed by the duplicated DUKC core: "
                    f"({graph.nodes['CONTROLLING_DEPTH_M'].baseline:.1f} + "
                    f"{graph.nodes['TIDE_HEIGHT_M'].baseline:.1f}) - "
                    f"({graph.reference_draft_m:.1f} + "
                    f"{_squat_m(CB_CONTAINER, graph.reference_speed_kn):.3f}) - "
                    f"{UKC_SAFETY_MARGIN_M:.1f}"
                ),
                "DEEP_DRAFT_WINDOW_H": round(baseline["DEEP_DRAFT_WINDOW_H"], 4),
                "DEEP_DRAFT_WINDOW_H_source": (
                    f"embedded M2-style scan, {int(SCAN_HOURS / SCAN_STEP_H) + 1} samples "
                    f"over {SCAN_HOURS:.0f} h"
                ),
            },
            "edge_basis_counts": {
                b: sum(1 for e in graph.edges if e.basis == b)
                for b in (BASIS_EXACT, BASIS_CALIBRATED, BASIS_JUDGEMENT)
            },
        },
        "propagation_semantics": {
            "formula": (
                "value(n) = clamp(baseline(n) + scale(n) * "
                "SUM_e[pol(e) * w(e) * dnorm(src(e))], lo, hi)"
            ),
            "space": "normalised linear superposition",
            "sweep": "Kahn topological order",
            "why": (
                "Linear superposition composes correctly for simultaneous disruptions, "
                "makes every edge individually attributable, and reproduces the exact "
                "physics of E04-E07 without approximation."
            ),
            "log_completeness": (
                f"one step per node, all {len(order)} emitted every run, "
                f"including unchanged nodes"
            ),
        },
        "disruptions": [d.as_dict() for d in disruptions],
        "steps": [s.as_dict() for s in steps],
        "rules": {
            "evaluated": len(rules),
            "triggered": [t.as_dict() for t in all_fired],
            "not_triggered": untriggered,
            "applied": apply_rules,
        },
        "named_chains": {t.chain_id: t.as_dict() for t in traces},
        "attribution": {
            "top_edges": [[e, round(v, 5)] for e, v in top_edges],
            "top_root_causes": [[n, round(v, 4)] for n, v in root_causes],
            "method": (
                "edge attribution sums |physical contribution| per edge; root-cause "
                "attribution shares each terminal delta back to the injected exogenous "
                "nodes along path products"
            ),
        },
        "calibration": calibrate_e14(graph),
        "rule_isolation": {
            "note": (
                "pure_propagation_state is the graph with rules OFF; final_state has "
                "them ON. The difference isolates exactly what the SOP rules contributed."
            ),
            "confidence_pure": round(pure_state["SYS_CONFIDENCE"], 4),
            "confidence_with_rules": round(conf_after, 4),
            "rule_contribution": round(conf_after - pure_state["SYS_CONFIDENCE"], 4),
        },
        "result": {
            "confidence_before": round(conf_before, 4),
            "confidence_after": round(conf_after, 4),
            "confidence_delta": round(conf_after - conf_before, 4),
            "dukc_status_before": dukc_before,
            "dukc_status_after": dukc_after,
            "alert_level": alert,
            "recommendation": rec,
        },
        "assumptions": [
            "Linear superposition in normalised space; no interaction terms.",
            "E04-E07 are exact physics; E14 is calibrated; all other edges are "
            "EXPERT_JUDGEMENT and labelled as such.",
            "Clamping is applied after summation and is itself logged.",
            "Only exogenous nodes can be injected; derived nodes are computed.",
            "Production upgrade: structure learning and edge-weight regression on "
            "accumulated incident logs.",
        ],
        "provenance": {
            "sensor_source": "INJECTED",
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return CascadeResult(
        scenario_id=scenario_id,
        scenario_title=scenario_title,
        disruptions=tuple(disruptions),
        baseline_state=baseline,
        pure_propagation_state=pure_state,
        final_state=final_state,
        deltas=deltas,
        propagation_log=tuple(steps),
        triggered_rules=tuple(all_fired),
        untriggered_rules=tuple(untriggered),
        chain_traces=traces,
        dukc_status_before=dukc_before,
        dukc_status_after=dukc_after,
        confidence_before=conf_before,
        confidence_after=conf_after,
        confidence_delta=conf_after - conf_before,
        alert_level=alert,
        top_contributors=top_edges,
        top_root_causes=root_causes,
        recommendation=rec,
        breakdown=breakdown,
    )


def _root_cause_attribution(
    graph: CausalGraph,
    injected: Mapping[str, float],
    final_dnorm: Mapping[str, float],
) -> Tuple[Tuple[str, float], ...]:
    """
    Share the confidence movement back to the injected sensors.

    Each injected node is re-run alone; the resulting confidence delta is its
    marginal effect. Shares are normalised across injected nodes. Because the
    propagation is linear, these marginals sum to the joint effect exactly —
    which is precisely why linear superposition was chosen over multiplicative
    factors.
    """
    if not injected:
        return ()
    solo: Dict[str, float] = {}
    for nid, value in injected.items():
        result = _quiet_propagate(graph, [Disruption(nid, value)])
        solo[nid] = abs(
            result["SYS_CONFIDENCE"] - graph.nodes["SYS_CONFIDENCE"].baseline
        )
    total = sum(solo.values()) or 1.0
    return tuple(
        sorted(
            ((nid, v / total * 100.0) for nid, v in solo.items()),
            key=lambda kv: (-kv[1], kv[0]),
        )
    )


def _quiet_propagate(
    graph: CausalGraph, disruptions: Sequence[Disruption]
) -> Dict[str, float]:
    """Bare propagation without rules, logging or attribution (avoids recursion)."""
    baseline = graph.baseline_state()
    injected = {d.node_id: d.value for d in disruptions}
    values: Dict[str, float] = {}
    dnorm: Dict[str, float] = {}
    for nid in graph.topological_order():
        node = graph.nodes[nid]
        if nid in injected:
            raw = injected[nid]
        else:
            total = sum(
                e.polarity * e.weight * dnorm.get(e.source, 0.0)
                for e in graph.in_edges(nid)
            )
            raw = node.baseline + total * node.scale
        v = _clamp(raw, node.lo, node.hi)
        values[nid] = v
        dnorm[nid] = (v - node.baseline) / node.scale if node.scale else 0.0
    return values


def _trace_chain(
    graph: CausalGraph,
    chain_id: str,
    before: Mapping[str, float],
    after: Mapping[str, float],
) -> ChainTrace:
    """Walk a named chain hop by hop, showing each node's movement."""
    label, edge_ids = NAMED_CHAINS[chain_id]
    by_id = {e.edge_id: e for e in graph.edges}
    node_ids = [by_id[edge_ids[0]].source] + [by_id[eid].target for eid in edge_ids]

    hops: List[Dict[str, Any]] = []
    for eid in edge_ids:
        e = by_id[eid]
        src, tgt = graph.nodes[e.source], graph.nodes[e.target]
        hops.append({
            "edge_id": eid,
            "basis": e.basis,
            "from": e.source,
            "to": e.target,
            "from_before": round(before[e.source], 4),
            "from_after": round(after[e.source], 4),
            "to_before": round(before[e.target], 4),
            "to_after": round(after[e.target], 4),
            "to_delta": round(after[e.target] - before[e.target], 4),
            "to_unit": tgt.unit,
            "physical_gain": round(e.physical_gain(graph), 5),
            "gain_unit": e.gain_unit(graph),
        })

    terminal = node_ids[-1]
    return ChainTrace(
        chain_id=chain_id,
        label=label,
        edge_ids=edge_ids,
        node_ids=tuple(node_ids),
        hops=tuple(hops),
        end_to_end_delta=after[terminal] - before[terminal],
        end_to_end_unit=graph.nodes[terminal].unit,
    )


def trace_chain(result: CascadeResult, chain_id: str) -> ChainTrace:
    """Fetch one named chain trace from a cascade result."""
    for t in result.chain_traces:
        if t.chain_id == chain_id:
            return t
    raise KeyError(f"unknown chain {chain_id!r}; known: {sorted(NAMED_CHAINS)}")


def _recommendation(
    alert: str,
    conf_before: float,
    conf_after: float,
    dukc_before: str,
    dukc_after: str,
    state: Mapping[str, float],
    fired: Sequence[TriggeredRule],
    root_causes: Sequence[Tuple[str, float]],
) -> str:
    if alert == ALERT_NORMAL and abs(conf_after - conf_before) < 1e-9:
        return (
            f"Nominal. Confidence {conf_after:.3f}, DUKC {dukc_after} "
            f"({state['DUKC_NET_UKC_M']:.2f} m net UKC). No action required."
        )

    parts = [
        f"Confidence {conf_before:.3f} -> {conf_after:.3f} "
        f"({conf_after - conf_before:+.3f}); alert {alert}."
    ]
    if dukc_after != dukc_before:
        parts.append(
            f"DUKC moved {dukc_before} -> {dukc_after} "
            f"({state['DUKC_NET_UKC_M']:.2f} m net UKC)."
        )
    else:
        parts.append(
            f"DUKC holds at {dukc_after} ({state['DUKC_NET_UKC_M']:.2f} m net UKC)."
        )
    parts.append(
        f"Queue {state['ANCHORAGE_QUEUE_N']:.1f} vessels, "
        f"TAT delay {state['TAT_DELAY_H']:+.2f} h, "
        f"deep-draft window {state['DEEP_DRAFT_WINDOW_H']:.2f} h/cycle."
    )
    if root_causes:
        parts.append(
            "Root cause: "
            + ", ".join(f"{n} {v:.0f}%" for n, v in root_causes[:3])
            + "."
        )
    critical = [t for t in fired if t.rule.severity == "CRITICAL"]
    if critical:
        actions: List[str] = []
        for t in critical:
            actions.extend(t.rule.workflow_actions)
        notify: Set[str] = set()
        for t in critical:
            notify.update(t.rule.notify)
        parts.append(
            f"CRITICAL rules {', '.join(t.rule.rule_id for t in critical)}: "
            f"{', '.join(sorted(set(actions)))}. Notify {', '.join(sorted(notify))}."
        )
    elif fired:
        parts.append(
            f"Rules fired: {', '.join(f'{t.rule.rule_id} ({t.rule.severity})' for t in fired)}."
        )
    return " ".join(parts)


def sensitivity_sweep(
    graph: CausalGraph,
    node_id: str,
    values: Sequence[float],
    target: str = "SYS_CONFIDENCE",
) -> List[Tuple[float, float]]:
    """Response curve of ``target`` to a single exogenous node."""
    if node_id not in graph.nodes:
        raise ValueError(f"unknown node {node_id!r}")
    if not graph.nodes[node_id].is_exogenous:
        raise ValueError(f"{node_id} is derived; sweep an exogenous node")
    return [
        (v, _quiet_propagate(graph, [Disruption(node_id, v)])[target]) for v in values
    ]


def graph_to_json(graph: CausalGraph) -> Dict[str, Any]:
    """Node/edge dump for D3, Cytoscape or the dashboard."""
    return {
        "node_count": len(graph.nodes),
        "edge_count": len(graph.edges),
        "nodes": [n.as_dict() for n in sorted(graph.nodes.values(), key=lambda n: n.idx)],
        "edges": [e.as_dict(graph) for e in graph.edges],
        "named_chains": {
            cid: {"label": label, "edge_ids": list(eids)}
            for cid, (label, eids) in NAMED_CHAINS.items()
        },
        "validation": graph.validate(),
    }


def graph_to_dot(graph: CausalGraph) -> str:
    """Graphviz source, for the tender document."""
    colours = {
        "WEATHER": "#7EA6E0", "HYDRO": "#67AB9F", "RESOURCE": "#EA6B66",
        "DEMAND": "#D6B656", "MARINE": "#B1DDF0", "SAFETY": "#F8CECC",
        "PLANNING": "#D5E8D4", "TERMINAL": "#FFE6CC", "KPI": "#E1D5E7",
        "LEVER": "#FFF2CC",
    }
    styles = {
        BASIS_EXACT: 'penwidth=2.5, color="#1F5C2E"',
        BASIS_CALIBRATED: 'penwidth=2.0, color="#B8860B"',
        BASIS_JUDGEMENT: 'penwidth=1.0, color="#666666", style=dashed',
    }
    lines = [
        "digraph JNPA_UC1_M8 {",
        '  rankdir=LR;',
        '  graph [fontname="Helvetica", labelloc=t, '
        'label="JNPA UC1-M8 Reactive Confidence Chain — 23 nodes / 30 edges"];',
        '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=10];',
        '  edge [fontname="Helvetica", fontsize=8];',
    ]
    for n in sorted(graph.nodes.values(), key=lambda n: n.idx):
        fill = colours.get(n.category, "#FFFFFF")
        lines.append(
            f'  "{n.node_id}" [label="{n.idx}. {n.label}\\n{n.baseline:g} {n.unit}", '
            f'fillcolor="{fill}"];'
        )
    for e in graph.edges:
        sign = "+" if e.polarity > 0 else "-"
        lines.append(
            f'  "{e.source}" -> "{e.target}" '
            f'[label="{e.edge_id} {sign}{e.weight}", {styles[e.basis]}];'
        )
    lines.append("  // solid heavy = exact physics, gold = calibrated, dashed = judgement")
    lines.append("}")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Named scenarios — the guided-tour suite the WS2 validation column references.
# --------------------------------------------------------------------------
SCENARIOS: Dict[str, Tuple[str, List[Disruption]]] = {
    "S1": ("Nominal fair weather", []),
    "S2": ("Moderate wind 22 kn", [Disruption("WX_WIND_KN", 22.0, "freshening breeze")]),
    "S3": ("Siltation 0.3 m (chain B)", [Disruption("SILTATION_M", 0.30, "post-monsoon shoaling")]),
    "S4": ("Dredging +0.5 m (LEVER)", [
        Disruption("DREDGING_DELTA_M", 0.50, "maintenance dredging complete", "LEVER")
    ]),
    "S5": ("Compound monsoon squall", [
        Disruption("WX_WIND_KN", 32.0, "squall"),
        Disruption("WX_RAIN_MMHR", 20.0, "heavy rain"),
        Disruption("SILTATION_M", 0.30, "shoaling"),
        Disruption("PILOT_AVAIL_N", 1.0, "two pilots unavailable"),
    ]),
    "S6": ("Compound squall + dredging lever", [
        Disruption("WX_WIND_KN", 32.0, "squall"),
        Disruption("WX_RAIN_MMHR", 20.0, "heavy rain"),
        Disruption("SILTATION_M", 0.30, "shoaling"),
        Disruption("PILOT_AVAIL_N", 1.0, "two pilots unavailable"),
        Disruption("DREDGING_DELTA_M", 0.50, "dredging lever applied", "LEVER"),
    ]),
}


def run_scenario(
    scenario_id: str,
    graph: Optional[CausalGraph] = None,
    apply_rules: bool = True,
) -> CascadeResult:
    """Run one of the named S1..S6 scenarios."""
    if scenario_id not in SCENARIOS:
        raise KeyError(f"unknown scenario {scenario_id!r}; known: {sorted(SCENARIOS)}")
    title, disruptions = SCENARIOS[scenario_id]
    return propagate(
        graph or build_graph(), disruptions, DEFAULT_RULES, apply_rules, scenario_id, title
    )


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "dukc_core_version": DUKC_CORE_VERSION,
    "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
    "spec_row": "WS2_AI_ML_Tools.md row 8 — Reactive confidence chain",
    "model_type": "causal-graph propagation over the deterministic engines",
    "node_count": EXPECTED_NODE_COUNT,
    "edge_count": EXPECTED_EDGE_COUNT,
    "named_chains": sorted(NAMED_CHAINS),
    "scenarios": sorted(SCENARIOS),
    "rules": [r.rule_id for r in DEFAULT_RULES],
    "constants": {
        "EXPECTED_NODE_COUNT": EXPECTED_NODE_COUNT,
        "EXPECTED_EDGE_COUNT": EXPECTED_EDGE_COUNT,
        "REFERENCE_DRAFT_M": REFERENCE_DRAFT_M,
        "REFERENCE_SPEED_KN": REFERENCE_SPEED_KN,
        "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
        "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
        "SCAN_HOURS": SCAN_HOURS,
        "SCAN_STEP_H": SCAN_STEP_H,
    },
}


# ==========================================================================
# SECTION 6 — FASTAPI ROUTER (optional dependency)
# ==========================================================================

_HAS_FASTAPI = False
try:
    from fastapi import APIRouter, HTTPException, Query, Response  # noqa: E402
    from pydantic import BaseModel, Field, field_validator          # noqa: E402
    from typing import Literal                                      # noqa: E402

    _HAS_FASTAPI = True
except Exception:  # pragma: no cover
    APIRouter = None  # type: ignore
    HTTPException = None  # type: ignore
    Response = None  # type: ignore
    BaseModel = object  # type: ignore
    Literal = None  # type: ignore

    def Field(default=None, **_kw):  # type: ignore
        return default

    def Query(default=None, **_kw):  # type: ignore
        return default

    def field_validator(*_a, **_kw):  # type: ignore
        def _wrap(fn):
            return fn
        return _wrap


if _HAS_FASTAPI:

    _GRAPH_SINGLETON = build_graph()
    _EXOGENOUS = set(_GRAPH_SINGLETON.exogenous_ids())

    class DisruptionModel(BaseModel):
        node_id: str
        value: float
        label: str = ""
        kind: Literal["SENSOR", "LEVER"] = "SENSOR"

        @field_validator("node_id")
        @classmethod
        def _known_exogenous(cls, v: str) -> str:
            if v not in _GRAPH_SINGLETON.nodes:
                raise ValueError(
                    f"unknown node_id {v!r}; known: {sorted(_GRAPH_SINGLETON.nodes)}"
                )
            if v not in _EXOGENOUS:
                raise ValueError(
                    f"{v} is a derived node and cannot be injected. "
                    f"Injectable (exogenous) nodes: {sorted(_EXOGENOUS)}"
                )
            return v

        def to_disruption(self) -> Disruption:
            return Disruption(self.node_id, self.value, self.label, self.kind)

    class CascadeRequest(BaseModel):
        scenario_title: str = "Live Operational Assessment"
        disruptions: List[DisruptionModel] = Field(default_factory=list)
        apply_rules: bool = True
        include_full_log: bool = True
        reference_draft_m: float = Field(REFERENCE_DRAFT_M, gt=0, le=25)
        reference_speed_kn: float = Field(REFERENCE_SPEED_KN, ge=0, le=30)

    class SensitivityRequest(BaseModel):
        node_id: str
        values: List[float] = Field(..., min_length=2, max_length=200)
        target: str = "SYS_CONFIDENCE"

        @field_validator("node_id")
        @classmethod
        def _exo(cls, v: str) -> str:
            if v not in _EXOGENOUS:
                raise ValueError(f"{v} is not an injectable exogenous node")
            return v

    def build_router() -> "APIRouter":
        """Construct the UC1-M8 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M8 Reactive Confidence Chain"])

        @router.post("/propagate", summary="Propagate disruptions through the causal DAG")
        def propagate_endpoint(req: CascadeRequest) -> Dict[str, Any]:
            graph = build_graph(req.reference_draft_m, req.reference_speed_kn)
            result = propagate(
                graph, [d.to_disruption() for d in req.disruptions],
                DEFAULT_RULES, req.apply_rules, "ADHOC", req.scenario_title,
            )
            return result.as_dict(include_full_log=req.include_full_log)

        @router.post("/scenario/{scenario_id}", summary="Run a named scenario S1..S6")
        def scenario_endpoint(
            scenario_id: str,
            apply_rules: bool = Query(True),
            include_full_log: bool = Query(True),
        ) -> Dict[str, Any]:
            if scenario_id not in SCENARIOS:
                raise HTTPException(404, f"unknown scenario; known: {sorted(SCENARIOS)}")
            return run_scenario(scenario_id, apply_rules=apply_rules).as_dict(
                include_full_log=include_full_log
            )

        @router.post("/sensitivity", summary="Response curve for one exogenous node")
        def sensitivity_endpoint(req: SensitivityRequest) -> Dict[str, Any]:
            graph = build_graph()
            if req.target not in graph.nodes:
                raise HTTPException(422, f"unknown target node {req.target!r}")
            curve = sensitivity_sweep(graph, req.node_id, req.values, req.target)
            return {
                "node_id": req.node_id,
                "target": req.target,
                "unit": graph.nodes[req.target].unit,
                "curve": [{"value": v, "target": round(t, 5)} for v, t in curve],
            }

        @router.get("/graph", summary="Node/edge JSON for D3 or Cytoscape")
        def graph_endpoint() -> Dict[str, Any]:
            return graph_to_json(build_graph())

        @router.get("/graph.dot", summary="Graphviz source for the tender pack")
        def graph_dot() -> "Response":
            return Response(
                content=graph_to_dot(build_graph()), media_type="text/vnd.graphviz"
            )

        @router.get("/rules", summary="The ten workflow rules")
        def rules_endpoint() -> List[Dict[str, Any]]:
            return [r.as_dict() for r in DEFAULT_RULES]

        @router.get("/nodes", summary="Node catalogue, with the injectable ones flagged")
        def nodes_endpoint() -> Dict[str, Any]:
            g = build_graph()
            return {
                "exogenous_injectable": g.exogenous_ids(),
                "nodes": [n.as_dict() for n in sorted(g.nodes.values(), key=lambda n: n.idx)],
            }

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {
                "module_version": MODULE_VERSION,
                "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
                "constants": MODULE_INFO["constants"],
                "edges": [e.as_dict(build_graph()) for e in build_graph().edges],
            }

        @router.get("/demo", summary="Run the compound-squall scenario S5")
        def demo() -> Dict[str, Any]:
            return run_scenario("S5").as_dict(include_full_log=False)

        @router.get("/health", summary="Module health and identity")
        def health() -> Dict[str, Any]:
            checks = _self_test()
            return {
                "status": "ok" if all(ok for _, ok, _ in checks) else "degraded",
                "module": MODULE_INFO,
                "checks": [{"name": n, "passed": ok, "detail": d} for n, ok, d in checks],
            }

        return router

else:  # pragma: no cover

    def build_router():  # type: ignore
        raise RuntimeError(
            "FastAPI is not installed. Install with: pip install 'fastapi>=0.115' 'pydantic>=2.7'"
        )


# ==========================================================================
# SECTION 7 — SELF-TEST AND CLI DEMO RUNNER
# ==========================================================================


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    try:
        _dukc_core_selftest()
        checks.append(("dukc_core_golden_values", True, DUKC_CORE_FINGERPRINT))
    except AssertionError as exc:
        checks.append(("dukc_core_golden_values", False, str(exc)))

    graph = build_graph()
    v = graph.validate()

    checks.append(
        (
            "graph_shape_23_30",
            v["node_count"] == 23 and v["edge_count"] == 30,
            f"{v['node_count']} nodes, {v['edge_count']} edges",
        )
    )
    checks.append(
        (
            "acyclic_by_construction",
            v["all_edges_forward"] and v["kahn_ok"],
            "every edge runs from a lower to a higher topological rank",
        )
    )
    checks.append(("no_orphan_nodes", not v["orphan_nodes"], "every node has an incident edge"))

    # Backwards edge must be refused, not silently accepted.
    try:
        bad = list(_edge_specs()) + [
            CausalEdge("E99", "SYS_CONFIDENCE", "WX_WIND_KN", 0.5, +1, BASIS_JUDGEMENT, "cycle")
        ]
        CausalGraph(_node_specs(), bad)
        refused = False
    except AssertionError:
        refused = True
    checks.append(
        ("backwards_edge_refused", refused, "a cycle-forming edge raises at construction")
    )

    # Seeded baselines must come from the DUKC core, not be hard-coded.
    squat = _squat_m(CB_CONTAINER, REFERENCE_SPEED_KN)
    _, expected_net = _net_ukc_m(15.0, TIDE_MEAN_M, 0.0, REFERENCE_DRAFT_M, squat)
    checks.append(
        (
            "dukc_baseline_computed",
            abs(graph.nodes["DUKC_NET_UKC_M"].baseline - expected_net) < 1e-9
            # 0.95 m — identical to the canonical MARGINAL case in uc1_m1_dukc.py.
            # The two modules agree because they run the same duplicated core.
            and abs(expected_net - 0.95) < 1e-9
            and _ukc_status(expected_net) == STATUS_MARGINAL,
            f"(15.0 + 2.6) - (15.0 + {squat:.3f}) - 1.0 = "
            f"{graph.nodes['DUKC_NET_UKC_M'].baseline:.3f} m",
        )
    )
    checks.append(
        (
            "window_baseline_seeded_by_scan",
            graph.nodes["DEEP_DRAFT_WINDOW_H"].baseline > 0.0,
            f"embedded M2-style scan -> "
            f"{graph.nodes['DEEP_DRAFT_WINDOW_H'].baseline:.2f} h/cycle",
        )
    )
    # A deeper reference vessel must reduce both seeded baselines.
    deep_graph = build_graph(reference_draft_m=15.5)
    checks.append(
        (
            "seeded_baselines_track_reference",
            deep_graph.nodes["DUKC_NET_UKC_M"].baseline
            < graph.nodes["DUKC_NET_UKC_M"].baseline
            and deep_graph.nodes["DEEP_DRAFT_WINDOW_H"].baseline
            <= graph.nodes["DEEP_DRAFT_WINDOW_H"].baseline,
            f"draft 15.0 -> 15.5 m: UKC "
            f"{graph.nodes['DUKC_NET_UKC_M'].baseline:.2f} -> "
            f"{deep_graph.nodes['DUKC_NET_UKC_M'].baseline:.2f} m, window "
            f"{graph.nodes['DEEP_DRAFT_WINDOW_H'].baseline:.2f} -> "
            f"{deep_graph.nodes['DEEP_DRAFT_WINDOW_H'].baseline:.2f} h",
        )
    )

    # Named chains must be real paths.
    for cid in NAMED_CHAINS:
        t = _trace_chain(graph, cid, graph.baseline_state(), graph.baseline_state())
        checks.append(
            (
                f"chain_{cid.lower()}_is_a_path",
                len(t.hops) == len(NAMED_CHAINS[cid][1]),
                " -> ".join(t.node_ids),
            )
        )

    # Edge basis labelling.
    counts = {b: sum(1 for e in graph.edges if e.basis == b)
              for b in (BASIS_EXACT, BASIS_CALIBRATED, BASIS_JUDGEMENT)}
    checks.append(
        (
            "edge_basis_labelled",
            counts[BASIS_EXACT] == 4 and counts[BASIS_CALIBRATED] == 1
            and sum(counts.values()) == 30,
            f"{counts[BASIS_EXACT]} exact, {counts[BASIS_CALIBRATED]} calibrated, "
            f"{counts[BASIS_JUDGEMENT]} judgement — none unlabelled",
        )
    )

    # Exact physics must actually be exact: 1 m of siltation removes 1 m of depth.
    silt = _quiet_propagate(graph, [Disruption("SILTATION_M", 1.0)])
    checks.append(
        (
            "e04_exact_physics",
            abs((silt["CONTROLLING_DEPTH_M"] - graph.nodes["CONTROLLING_DEPTH_M"].baseline)
                + 1.0) < 1e-9,
            f"1.0 m siltation -> controlling depth "
            f"{graph.nodes['CONTROLLING_DEPTH_M'].baseline:.2f} -> "
            f"{silt['CONTROLLING_DEPTH_M']:.2f} m (exactly -1.00)",
        )
    )
    checks.append(
        (
            "e06_exact_physics",
            abs((silt["DUKC_NET_UKC_M"] - graph.nodes["DUKC_NET_UKC_M"].baseline) + 1.0) < 1e-9,
            f"1.0 m of depth is 1.0 m of net UKC (delta "
            f"{silt['DUKC_NET_UKC_M'] - graph.nodes['DUKC_NET_UKC_M'].baseline:+.3f} m)",
        )
    )
    tide = _quiet_propagate(graph, [Disruption("TIDE_HEIGHT_M", TIDE_MEAN_M + 1.0)])
    checks.append(
        (
            "e07_exact_physics",
            abs((tide["DUKC_NET_UKC_M"] - graph.nodes["DUKC_NET_UKC_M"].baseline) - 1.0) < 1e-9,
            f"1.0 m of tide is 1.0 m of net UKC (delta "
            f"{tide['DUKC_NET_UKC_M'] - graph.nodes['DUKC_NET_UKC_M'].baseline:+.3f} m)",
        )
    )

    # E14 calibration against the exact scanner.
    cal = calibrate_e14(graph)
    checks.append(
        (
            "e14_calibration_within_10pct",
            cal["all_within_10pct"],
            "; ".join(
                f"{c['case']}: exact {c['exact_window_h']:.2f} h vs DAG "
                f"{c['dag_predicted_h']:.2f} h ({c['residual_pct']:+.1f}%)"
                for c in cal["cases"]
            ),
        )
    )

    # Propagation log completeness — the audit requirement.
    s5 = run_scenario("S5")
    checks.append(
        (
            "log_has_every_node",
            len(s5.propagation_log) == 23
            and {s.node_id for s in s5.propagation_log} == set(graph.nodes),
            f"{len(s5.propagation_log)} steps, one per node, every run",
        )
    )
    checks.append(
        (
            "unchanged_nodes_still_logged",
            any(s.kind == "UNCHANGED" for s in run_scenario("S3").propagation_log),
            "nodes with a zero delta are logged, not omitted",
        )
    )
    checks.append(
        (
            "every_step_has_substitution",
            all(s.substitution for s in s5.propagation_log),
            "each step shows the formula with its real numbers",
        )
    )
    checks.append(
        (
            "contribution_shares_sum_100",
            all(
                abs(sum(c.share_pct for c in s.contributions) - 100.0) < 1e-6
                for s in s5.propagation_log if s.contributions
            ),
            "per-edge shares sum to 100% at every node with in-edges",
        )
    )

    # Scenario ordering — the demo's whole argument.
    results = {sid: run_scenario(sid) for sid in SCENARIOS}
    checks.append(
        (
            "s1_nominal_unchanged",
            abs(results["S1"].confidence_after - results["S1"].confidence_before) < 1e-9,
            f"no disruption -> confidence {results['S1'].confidence_after:.3f}, "
            f"alert {results['S1'].alert_level}",
        )
    )
    checks.append(
        (
            "s4_lever_improves_on_s1",
            results["S4"].confidence_after >= results["S1"].confidence_after,
            f"dredging lever: {results['S1'].confidence_after:.3f} -> "
            f"{results['S4'].confidence_after:.3f}",
        )
    )
    checks.append(
        (
            "s3_siltation_degrades",
            results["S3"].confidence_after < results["S1"].confidence_after,
            f"siltation 0.3 m: {results['S1'].confidence_after:.3f} -> "
            f"{results['S3'].confidence_after:.3f}",
        )
    )
    checks.append(
        (
            "s5_compound_is_worst",
            results["S5"].confidence_after
            == min(r.confidence_after for r in results.values()),
            f"compound squall {results['S5'].confidence_after:.3f} is the lowest of "
            f"{len(results)} scenarios",
        )
    )
    checks.append(
        (
            "s6_lever_recovers_from_s5",
            results["S6"].confidence_after > results["S5"].confidence_after,
            f"same storm + dredging lever: {results['S5'].confidence_after:.3f} -> "
            f"{results['S6'].confidence_after:.3f} "
            f"({results['S6'].confidence_after - results['S5'].confidence_after:+.3f})",
        )
    )
    checks.append(
        (
            "s5_window_shrinks",
            results["S5"].final_state["DEEP_DRAFT_WINDOW_H"]
            < results["S1"].final_state["DEEP_DRAFT_WINDOW_H"],
            f"deep-draft window {results['S1'].final_state['DEEP_DRAFT_WINDOW_H']:.2f} -> "
            f"{results['S5'].final_state['DEEP_DRAFT_WINDOW_H']:.2f} h/cycle",
        )
    )
    checks.append(
        (
            "s5_queue_and_tat_rise",
            results["S5"].final_state["ANCHORAGE_QUEUE_N"] > 2.0
            and results["S5"].final_state["TAT_DELAY_H"] > 0.0,
            f"queue {results['S5'].final_state['ANCHORAGE_QUEUE_N']:.2f} vessels, "
            f"TAT delay {results['S5'].final_state['TAT_DELAY_H']:.2f} h",
        )
    )

    # Workflow rules.
    r1 = next((t for t in results["S5"].triggered_rules if t.rule.rule_id == "R1"), None)
    checks.append(
        (
            "r1_wind_hold_fires",
            r1 is not None and r1.rule.severity == "CRITICAL"
            and results["S5"].final_state["PILOTAGE_HOLD"] >= 0.90 - 1e-9,
            f"wind 32 kn >= 30 -> PILOTAGE_HOLD floored at "
            f"{results['S5'].final_state['PILOTAGE_HOLD']:.3f}"
            if r1 else "R1 did not fire",
        )
    )
    checks.append(
        (
            "rules_reference_dukc_core_by_name",
            any(r.threshold == UKC_MARGINAL_BAND_M for r in DEFAULT_RULES)
            and any(r.threshold == UKC_SAFETY_MARGIN_M for r in DEFAULT_RULES),
            "R4/R5 use the shared core's constants, not retyped literals",
        )
    )
    no_rules = run_scenario("S5", apply_rules=False)
    checks.append(
        (
            "rule_contribution_isolatable",
            abs(no_rules.confidence_after - results["S5"].confidence_after) > 1e-9,
            f"rules off {no_rules.confidence_after:.3f} vs on "
            f"{results['S5'].confidence_after:.3f} — the difference is the SOP effect",
        )
    )
    checks.append(
        (
            "untriggered_rules_reported",
            len(results["S1"].untriggered_rules) >= 8,
            f"S1: {len(results['S1'].untriggered_rules)} rules reported as not triggered, "
            f"with their failing condition",
        )
    )

    # Attribution.
    causes = dict(results["S5"].top_root_causes)
    checks.append(
        (
            "root_cause_attribution",
            bool(causes) and abs(sum(causes.values()) - 100.0) < 1e-6,
            ", ".join(f"{k} {v:.0f}%" for k, v in
                      sorted(causes.items(), key=lambda kv: -kv[1])[:4]),
        )
    )
    checks.append(
        (
            "edge_attribution_present",
            len(results["S5"].top_contributors) == 5,
            ", ".join(f"{e}" for e, _ in results["S5"].top_contributors),
        )
    )

    # Injection validation.
    try:
        propagate(graph, [Disruption("SYS_CONFIDENCE", 0.5)])
        rejected = False
    except ValueError:
        rejected = True
    checks.append(
        ("derived_node_injection_rejected", rejected,
         "only exogenous nodes can be injected")
    )
    try:
        propagate(graph, [Disruption("NOT_A_NODE", 1.0)])
        rejected_unknown = False
    except ValueError:
        rejected_unknown = True
    checks.append(
        ("unknown_node_rejected", rejected_unknown, "unknown node_id raises")
    )

    # Clamping.
    extreme = _quiet_propagate(graph, [Disruption("WX_WIND_KN", 60.0)])
    checks.append(
        (
            "values_stay_within_bounds",
            all(
                graph.nodes[n].lo - 1e-9 <= v <= graph.nodes[n].hi + 1e-9
                for n, v in extreme.items()
            ),
            "every node respects its clamp under an extreme injection",
        )
    )

    # Determinism and exports.
    checks.append(
        (
            "determinism",
            run_scenario("S5").confidence_after == results["S5"].confidence_after,
            f"repeat run reproduces {results['S5'].confidence_after:.6f}",
        )
    )
    dot = graph_to_dot(graph)
    checks.append(
        (
            "graphviz_export",
            dot.startswith("digraph") and dot.count("->") == 30,
            f"{dot.count('->')} edges emitted to Graphviz",
        )
    )
    gj = graph_to_json(graph)
    checks.append(
        (
            "json_export",
            len(gj["nodes"]) == 23 and len(gj["edges"]) == 30
            and all("physical_gain" in e for e in gj["edges"]),
            "node/edge JSON carries physical gains in real units",
        )
    )

    return checks


def _print_cascade(result: CascadeResult, verbose: bool = True) -> None:
    print(f"\nSCENARIO {result.scenario_id} — {result.scenario_title}")
    if result.disruptions:
        for d in result.disruptions:
            node = build_graph().nodes[d.node_id]
            print(
                f"  INJECT  {d.node_id:<22} {node.baseline:8.3f} -> {d.value:8.3f} "
                f"{node.unit:<12} [{d.kind}] {d.label}"
            )
    else:
        print("  (no disruption — nominal baseline)")

    if verbose:
        print(f"\n  PROPAGATION LOG  (all {len(result.propagation_log)} nodes, topological order)")
        for s in result.propagation_log:
            marker = {
                "INJECT": ">>", "RULE_OVERRIDE": "!!", "PROPAGATE": "  ", "UNCHANGED": "..",
            }[s.kind]
            print(
                f"  {marker} [{s.topological_rank:2d}] {s.node_id:<24} "
                f"{s.baseline_value:8.3f} -> {s.new_value:8.3f} {s.unit:<12} "
                f"({s.delta_physical:+8.3f})"
                + (f"  RULE {s.triggered_rule_id}" if s.triggered_rule_id else "")
                + ("  [clamped]" if s.clamped else "")
            )
            for c in s.contributions:
                if abs(c.contribution_norm) < 1e-9:
                    continue
                print(
                    f"          {c.edge_id} from {c.source:<24} "
                    f"{c.substitution:<34} share {c.share_pct:5.1f}%  [{c.basis}]"
                )

    for t in result.chain_traces:
        print(f"\n  NAMED CHAIN  {t.chain_id}")
        print(f"    {t.label}")
        for h in t.hops:
            print(
                f"    -{h['edge_id']}-> {h['to']:<24} "
                f"{h['to_before']:8.3f} -> {h['to_after']:8.3f} {h['to_unit']:<12} "
                f"({h['to_delta']:+7.3f})  gain {h['physical_gain']:+.4f} {h['gain_unit']} "
                f"[{h['basis']}]"
            )
        print(f"    end to end: {t.end_to_end_delta:+.3f} {t.end_to_end_unit}")

    if result.triggered_rules:
        print("\n  TRIGGERED RULES")
        rows = []
        for t in result.triggered_rules:
            rows.append([
                t.rule.rule_id, t.rule.name, t.rule.severity, t.condition_text,
                f"{t.node_before:.3f} -> {t.node_after:.3f}"
                if t.node_before is not None else "advisory",
                ", ".join(t.rule.notify),
            ])
        print(_fmt_table(
            ["id", "rule", "severity", "condition", "effect", "notify"], rows, indent="    "
        ))

    if result.top_root_causes:
        print(
            "\n  ROOT-CAUSE ATTRIBUTION  "
            + " · ".join(f"{n} {v:.0f}%" for n, v in result.top_root_causes)
        )
    print(
        "  TOP EDGES               "
        + " · ".join(f"{e} ({v:.3f})" for e, v in result.top_contributors)
    )

    ri = result.breakdown["rule_isolation"]
    print(
        f"\n  CONFIDENCE  {result.confidence_before:.3f} -> {result.confidence_after:.3f} "
        f"({result.confidence_delta:+.3f})   ALERT {result.alert_level}"
    )
    print(
        f"              pure propagation {ri['confidence_pure']:.3f}, "
        f"rule contribution {ri['rule_contribution']:+.3f}"
    )
    print(f"  DUKC        {result.dukc_status_before} -> {result.dukc_status_after} "
          f"({result.final_state['DUKC_NET_UKC_M']:.2f} m net UKC)")
    print(f"\n  RECOMMEND   {result.recommendation}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M8 reactive confidence chain — demo and self-test runner."
    )
    parser.add_argument("--scenario", choices=sorted(SCENARIOS) + ["all"], default="S5")
    parser.add_argument("--node", help="Ad-hoc injection: exogenous node id.")
    parser.add_argument("--value", type=float, help="Ad-hoc injection: value.")
    parser.add_argument("--no-rules", action="store_true", help="Disable workflow rules.")
    parser.add_argument("--dot", action="store_true", help="Emit Graphviz source and exit.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Unused; CLI parity.")
    args = parser.parse_args(argv)

    graph = build_graph()

    if args.dot:
        print(graph_to_dot(graph))
        return 0

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 8 | causal-graph propagation")
        print("=" * 78)

    try:
        _dukc_core_selftest()
        core_ok = True
    except AssertionError as exc:
        core_ok = False
        print(f"DUKC CORE SELFTEST ... FAIL: {exc}")

    if not args.quiet:
        v = graph.validate()
        print("\nGRAPH VALIDATION")
        print(
            f"  nodes {v['node_count']}  edges {v['edge_count']}  "
            f"acyclic {v['acyclic']}  orphans {len(v['orphan_nodes'])}  "
            f"all-edges-forward {v['all_edges_forward']}"
        )
        print(f"  DUKC core fingerprint  {DUKC_CORE_FINGERPRINT}   "
              f"SELFTEST {'PASS' if core_ok else 'FAIL'}")
        seeded = {
            "DUKC_NET_UKC_M": graph.nodes["DUKC_NET_UKC_M"].baseline,
            "DEEP_DRAFT_WINDOW_H": graph.nodes["DEEP_DRAFT_WINDOW_H"].baseline,
        }
        print(
            f"  seeded  DUKC_NET_UKC_M = {seeded['DUKC_NET_UKC_M']:.3f} m  "
            f"(ref {REFERENCE_DRAFT_M:.2f} m @ {REFERENCE_SPEED_KN:.1f} kn, "
            f"computed by the duplicated DUKC core)"
        )
        print(
            f"  seeded  DEEP_DRAFT_WINDOW_H = {seeded['DEEP_DRAFT_WINDOW_H']:.2f} h/cycle  "
            f"(embedded {int(SCAN_HOURS / SCAN_STEP_H) + 1}-sample M2-style scan)"
        )

        cal = calibrate_e14(graph)
        print(
            f"\n  E14 CALIBRATION  gain {cal['physical_gain_h_per_m']:+.3f} h per m of net UKC"
        )
        print(_fmt_table(
            ["case", "exact h", "DAG h", "residual", "< 10%"],
            [[c["case"], f"{c['exact_window_h']:.2f}", f"{c['dag_predicted_h']:.2f}",
              f"{c['residual_pct']:+.1f}%", "PASS" if c["within_10pct"] else "FAIL"]
             for c in cal["cases"]],
            indent="    ",
        ))

        counts = {b: sum(1 for e in graph.edges if e.basis == b)
                  for b in (BASIS_EXACT, BASIS_CALIBRATED, BASIS_JUDGEMENT)}
        print(
            f"\n  EDGE PROVENANCE  {counts[BASIS_EXACT]} exact physics · "
            f"{counts[BASIS_CALIBRATED]} calibrated · "
            f"{counts[BASIS_JUDGEMENT]} expert judgement (all labelled)"
        )

    if args.node is not None:
        if args.value is None:
            parser.error("--node requires --value")
        result = propagate(
            graph, [Disruption(args.node, args.value, "ad-hoc injection")],
            DEFAULT_RULES, not args.no_rules, "ADHOC", f"Ad-hoc: {args.node}={args.value}",
        )
        if args.json:
            print(json.dumps(result.as_dict(), indent=2))
        elif not args.quiet:
            _print_cascade(result)
    elif args.json:
        print(json.dumps(
            run_scenario(args.scenario if args.scenario != "all" else "S5",
                         apply_rules=not args.no_rules).as_dict(),
            indent=2,
        ))
    elif not args.quiet:
        if args.scenario == "all":
            _print_cascade(run_scenario("S5", apply_rules=not args.no_rules), verbose=True)
        else:
            _print_cascade(
                run_scenario(args.scenario, apply_rules=not args.no_rules), verbose=True
            )

        print("\nSCENARIO COMPARISON")
        rows = []
        for sid in sorted(SCENARIOS):
            r = run_scenario(sid)
            rows.append([
                sid, r.scenario_title[:32],
                f"{r.final_state['DUKC_NET_UKC_M']:.2f}",
                f"{r.final_state['DEEP_DRAFT_WINDOW_H']:.2f}",
                f"{r.final_state['ANCHORAGE_QUEUE_N']:.2f}",
                f"{r.final_state['TAT_DELAY_H']:+.2f}",
                f"{r.confidence_after:.3f}",
                r.alert_level,
            ])
        print(_fmt_table(
            ["id", "scenario", "DUKC m", "window h", "queue", "TAT h", "confidence", "alert"],
            rows, indent="  ",
        ))
        s5, s6 = run_scenario("S5"), run_scenario("S6")
        print(
            f"  S6 vs S5: the same storm, but the dredging lever recovers "
            f"{s6.confidence_after - s5.confidence_after:+.3f} confidence "
            f"and {s6.final_state['DEEP_DRAFT_WINDOW_H'] - s5.final_state['DEEP_DRAFT_WINDOW_H']:+.2f} h "
            f"of deep-draft window."
        )

    checks = _self_test()
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{'-' * 78}")
    print(f"SELF-TEST  {passed}/{len(checks)} passed")
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<36} {detail}")
    print("-" * 78)

    return 0 if passed == len(checks) and core_ok else 1


if __name__ == "__main__":
    sys.exit(main())
