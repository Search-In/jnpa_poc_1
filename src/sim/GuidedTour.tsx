/**
 * <GuidedTour> — narrated scenario walk-through overlay (spec §B2.11 + §B3.13).
 *
 * Renders a fixed bottom-centre card only while a tour is active
 * (useSimStore().tour.scenarioId is set). Each step drives the demo: it flies
 * the parent's camera to the step preset, switches the active dashboard tab, and
 * rings the highlighted map assets, while narrating a talking point mapped to a
 * rubric criterion. Prev/Next/Exit give manual control; when tour.auto is set the
 * card auto-advances (~9 s/beat) unless the viewer prefers reduced motion, in
 * which case it stays on the current step until the presenter clicks.
 *
 * Narration copy lives in the scenario definitions — every effect there is framed
 * as a simulated result under stated assumptions, never a claimed baseline
 * improvement (integrity rule, spec §A3).
 */

import { useEffect } from 'react';
import { CalciteButton, CalciteIcon } from '@esri/calcite-components-react';
import { useSimStore } from '@/sim/simStore';
import { SCENARIO_BY_ID } from '@/sim/scenarios';
import { handoffUrl, TWIN_LABEL } from './lifecycleHandoff';
import { tokens } from '@/theme/tokens';

/** How long each beat holds before auto-advancing (ms). */
const AUTO_ADVANCE_MS = 9000;

export interface GuidedTourStepPayload {
  preset: string;
  tab: string;
  highlights: string[];
}

export interface GuidedTourProps {
  /** Called on every step change so the parent flies the camera + switches tab + rings the map. */
  onStep: (s: GuidedTourStepPayload) => void;
}

/** True when the viewer has asked the OS to reduce motion. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function GuidedTour(props: GuidedTourProps) {
  const { onStep } = props;
  const tour = useSimStore((s) => s.tour);
  const gotoStep = useSimStore((s) => s.gotoStep);
  const endTour = useSimStore((s) => s.endTour);

  const scenario = tour.scenarioId ? SCENARIO_BY_ID[tour.scenarioId] : undefined;
  const steps = scenario?.steps ?? [];
  const n = steps.length;
  // Clamp the index so a persisted/out-of-range step never crashes the lookup.
  const idx = Math.min(Math.max(tour.step, 0), Math.max(n - 1, 0));
  const step = steps[idx];

  // On each step change: drive the parent (camera + tab + map rings) and mirror
  // the highlights into the sim store so other panels can spotlight the assets.
  useEffect(() => {
    if (!step) return;
    const highlights = step.highlights ?? [];
    onStep({ preset: step.preset, tab: step.tab, highlights });
    useSimStore.getState().setHighlights(highlights);
  }, [tour.scenarioId, idx, step, onStep]);

  // Auto-advance timer — only when auto is on, motion is allowed, and we are not
  // already on the last step. Cleared on unmount / step change / manual nav.
  useEffect(() => {
    if (!scenario) return;
    if (!tour.auto) return;
    if (prefersReducedMotion()) return;
    if (idx >= n - 1) return;
    const t = window.setInterval(() => {
      const cur = useSimStore.getState().tour;
      if (cur.scenarioId !== tour.scenarioId) return;
      const nextStep = cur.step + 1;
      if (nextStep <= n - 1) useSimStore.getState().gotoStep(nextStep);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(t);
  }, [scenario, tour.auto, tour.scenarioId, idx, n]);

  if (!scenario || !step) return null;

  const atFirst = idx <= 0;
  const atLast = idx >= n - 1;

  return (
    <div
      role="dialog"
      aria-label="Guided tour"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 560,
        width: 'calc(100% - 32px)',
        background: tokens.panel,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.md,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
        zIndex: 9000,
        padding: tokens.space.lg,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.sm,
        color: tokens.text,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: tokens.space.md }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, minWidth: 0 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: tokens.accent,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            {scenario.code} · {scenario.title}
          </span>
        </div>
        <span style={{ fontSize: 11, color: tokens.textMuted, whiteSpace: 'nowrap' }}>
          Step {idx + 1}/{n}
        </span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, color: tokens.text, lineHeight: 1.3 }}>{step.title}</div>

      <div style={{ fontSize: 12, color: tokens.textMuted, lineHeight: 1.5 }}>{step.narrative}</div>

      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 6, marginTop: tokens.space.xs }} aria-hidden="true">
        {steps.map((_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: i <= idx ? tokens.accent : tokens.border,
            }}
          />
        ))}
      </div>

      {/* THE CHAIN DOES NOT END HERE.
          A monsoon that suspends pilot transfer lands vessels late, which lands cargo
          late, which puts a surge on the corridor — three twins, one event. Offered as a
          link on the LAST step rather than an automatic redirect: the operator finishes
          reading the conclusion first, the new tab opens on a real click (so the browser
          does not block it), and a twin that is not running costs a dead tab rather than
          derailing the scenario being watched. */}
      {atLast && scenario.handoff && (
        <div
          style={{
            marginTop: tokens.space.xs,
            padding: tokens.space.sm,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.border}`,
            background: tokens.panelAlt,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.space.xs,
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3, color: tokens.text }}>
            This is not the end of the cycle
          </div>
          <div style={{ fontSize: 12, color: tokens.textMuted, lineHeight: 1.5 }}>
            {scenario.handoff.because}
          </div>
          <CalciteButton
            scale="s"
            kind="brand"
            iconEnd="launch"
            width="full"
            title={`Opens ${TWIN_LABEL[scenario.handoff.twin]} in a new tab, at the scenario that continues this one`}
            onClick={() => {
              const h = scenario.handoff!;
              // noopener: the opened twin gets no handle back on this window.
              window.open(handoffUrl(h), '_blank', 'noopener,noreferrer');
            }}
          >
            {scenario.handoff.cta}
          </CalciteButton>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space.sm,
          marginTop: tokens.space.xs,
        }}
      >
        <CalciteButton
          scale="s"
          kind="neutral"
          appearance="outline"
          iconStart="chevron-left"
          disabled={atFirst || undefined}
          onClick={() => gotoStep(idx - 1)}
        >
          Prev
        </CalciteButton>

        <CalciteButton scale="s" kind="neutral" appearance="transparent" onClick={() => endTour()}>
          <CalciteIcon icon="x" scale="s" />
          <span style={{ marginLeft: 4 }}>Exit tour</span>
        </CalciteButton>

        {atLast ? (
          <CalciteButton scale="s" kind="brand" iconStart="check" onClick={() => endTour()}>
            Finish
          </CalciteButton>
        ) : (
          <CalciteButton scale="s" kind="brand" iconEnd="chevron-right" onClick={() => gotoStep(idx + 1)}>
            Next
          </CalciteButton>
        )}
      </div>
    </div>
  );
}
