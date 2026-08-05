/**
 * <VesselPredictionsSheet> — the AI/ML predictions side panel for one vessel.
 *
 * Opened from the Predictions column of the live-AIS table. It renders the
 * `uc1-dashboard/1.0.0` document the model service returns: one card per model
 * that ran, the inputs those models actually used, the fleet-level numbers, and
 * — first, not last — what the adapter had to assume.
 *
 * THE ORDER OF THIS PANEL IS THE POINT
 * ------------------------------------
 * An AIS position report carries no draught, no cargo and no ATA. The service
 * estimates them from published bands and names every substitution in a ledger.
 * So the assumptions notice sits ABOVE the numbers, not in a footnote: a NO-GO
 * under-keel clearance computed from an estimated draft is navigational advice
 * to check, not a clearance to act on. Reversing that order would be the single
 * easiest way to make this panel dangerous.
 *
 * Rendering is generic on purpose. Each model publishes five to nine fields and
 * the set differs per model; the document ships its own glossary, and the
 * service's self-test fails the build if a key is added without one. So every
 * field is rendered with its definition as a tooltip, and a field a model gains
 * tomorrow appears here without a frontend change — instead of being silently
 * dropped by a hand-written interface. `modelViews.ts` supplies only what the
 * data cannot: order, titles, the headline field, and which verdicts are amber.
 */

import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  CalciteButton,
  CalciteChip,
  CalciteNotice,
  CalcitePanel,
  CalciteSheet,
} from '@esri/calcite-components-react';
import { useAppStore } from '@/store/useAppStore';
import { usePredictionStore, selectOpenPrediction } from '@/data/ml/predictionStore';
import { buildContext } from '@/data/ml/predictions';
import type { ModelBlock, ModelFieldValue, VesselMapping } from '@/data/ml/types';
import { PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';
import {
  MODEL_VIEWS,
  formatValue,
  gridFields,
  humaniseKey,
  orderedBlocks,
  statusTone,
  type ModelView,
  type Tone,
} from './modelViews';

const TONE_COLOUR: Record<Tone, string> = {
  good: tokens.good,
  warn: tokens.warn,
  bad: tokens.bad,
  neutral: tokens.textMuted,
};

const SECTION_TITLE: CSSProperties = {
  margin: `${tokens.space.lg}px 0 ${tokens.space.sm}px`,
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: tokens.textMuted,
};

const CARD: CSSProperties = {
  border: `1px solid ${tokens.border}`,
  borderRadius: tokens.radius.md,
  background: tokens.panel,
  padding: tokens.space.md,
};

/**
 * What the models' row-level flags mean, for the chip's hover.
 *
 * They are shouted acronyms on the wire (`TIDE_SYNTHETIC`) and mean nothing to a
 * reader who has not seen the model docs. Anything not listed falls back to the
 * generic hint rather than being hidden — a new flag is worth showing.
 */
const FLAG_HINTS: Record<string, string> = {
  TIDE_SYNTHETIC: 'Tide came from the modelled harmonic curve, not a gauge reading.',
  WAIT_IS_LOWER_BOUND:
    'The wait was computed against this fleet only, so a real queue would be longer.',
  QUEUE_DERIVED: 'Anchorage queue was inferred from berth occupancy, not observed.',
};

/** Stand-in when a response carries no ledger, so the chip never crashes. */
const EMPTY_MAPPING: VesselMapping = {
  adapter_version: '',
  mmsi: '',
  vessel: '',
  degraded: false,
  derived: [],
  assumptions: [],
  warnings: [],
  inputs_observed: 0,
  inputs_assumed: 0,
};

const KEY: CSSProperties = { fontSize: 11.5, color: tokens.textMuted, whiteSpace: 'nowrap' };
const VAL: CSSProperties = {
  fontSize: 12.5,
  color: tokens.text,
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'right',
};

/**
 * The ⓘ affordance: explanatory text on hover, and reachable by keyboard.
 *
 * `tabIndex={0}` + `title` rather than a custom popover, for the same reason
 * FieldGrid uses `title`: it needs no state, survives inside a Calcite notice's
 * slotted light DOM, and a screen reader announces it for free.
 */
function InfoHint({ text }: { text: string }) {
  return (
    <span
      role="note"
      tabIndex={0}
      title={text}
      aria-label={text}
      style={{ marginLeft: 4, fontSize: 10, color: tokens.textMuted, cursor: 'help' }}
    >
      ⓘ
    </span>
  );
}

/** A verdict chip whose colour carries the domain meaning of the word. */
function StatusChip({ value }: { value: ModelFieldValue }) {
  const tone = statusTone(value);
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0.3,
        color: TONE_COLOUR[tone],
        border: `1px solid ${TONE_COLOUR[tone]}`,
        borderRadius: tokens.radius.sm,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {formatValue(value)}
    </span>
  );
}

/**
 * Key/value rows with the document's own glossary as the tooltip. `title` rather
 * than a custom popover so the definition is available to a keyboard user and to
 * a screen reader without any JS.
 */
function FieldGrid({
  fields,
  glossary,
}: {
  fields: Array<[string, ModelFieldValue]>;
  glossary: Record<string, string>;
}) {
  if (fields.length === 0) return null;
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: `${tokens.space.xs}px ${tokens.space.md}px`,
        margin: `${tokens.space.sm}px 0 0`,
      }}
    >
      {fields.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={KEY} title={glossary[key] ?? undefined}>
            {humaniseKey(key)}
            {glossary[key] ? ' ⓘ' : ''}
          </dt>
          <dd style={{ ...VAL, margin: 0 }}>{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** M3's per-factor attribution, as proportional bars. */
function DriverBars({ drivers }: { drivers: ModelFieldValue }) {
  if (!Array.isArray(drivers) || drivers.length === 0) return null;
  return (
    <div style={{ marginTop: tokens.space.sm, display: 'grid', gap: tokens.space.xs }}>
      {drivers.map((raw, i) => {
        const d = (raw ?? {}) as Record<string, ModelFieldValue>;
        const share = typeof d.share_pct === 'number' ? d.share_pct : 0;
        return (
          <div key={`${String(d.factor)}-${i}`} style={{ display: 'grid', gap: 2 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: tokens.text }}>{humaniseKey(String(d.factor ?? '—'))}</span>
              <span style={{ color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                {formatValue(d.hours)} h · {formatValue(d.share_pct)}%
              </span>
            </div>
            <div
              aria-hidden
              style={{ height: 4, background: tokens.panelAlt, borderRadius: 2, overflow: 'hidden' }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, share))}%`,
                  height: '100%',
                  background: tokens.accent,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Free-text the model wrote to explain itself (M1/M5/M6 recommendations). */
function Prose({ text }: { text: ModelFieldValue }) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return (
    <p style={{ margin: `${tokens.space.sm}px 0 0`, fontSize: 12, lineHeight: 1.45, color: tokens.text }}>
      {text}
    </p>
  );
}

function ModelCard({
  view,
  block,
  question,
  glossary,
}: {
  view: ModelView;
  block: ModelBlock;
  question?: string;
  glossary: Record<string, string>;
}) {
  const headline = view.headline ? block[view.headline] : undefined;
  const status = view.statusKey ? block[view.statusKey] : undefined;
  return (
    <section style={CARD} aria-label={view.title}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: tokens.text }}>
          {view.title}
          {/* The plain-English question this model answers used to sit under the
              title as a permanent line of italics. An operator who has read it
              once does not need it on every open, so it moved into the info
              affordance — hover or focus, same text, none of the height. */}
          {question && <InfoHint text={question} />}
        </h3>
        {status !== undefined && <StatusChip value={status} />}
        {headline !== undefined && (
          <span
            style={{ marginLeft: 'auto', fontSize: 17, fontWeight: 700, color: tokens.text, fontVariantNumeric: 'tabular-nums' }}
            title={view.headline ? glossary[view.headline] : undefined}
          >
            {formatValue(headline)}
            {view.unit ? <span style={{ fontSize: 11, color: tokens.textMuted }}> {view.unit}</span> : null}
          </span>
        )}
      </header>

      <FieldGrid fields={gridFields(block, view)} glossary={glossary} />
      {view.richKeys?.includes('top_drivers') && <DriverBars drivers={block.top_drivers} />}
      {view.richKeys?.map((key) =>
        key === 'top_drivers' ? null : <Prose key={key} text={block[key]} />,
      )}
    </section>
  );
}

/**
 * The estimated-inputs indicator: one chip, with the full list on hover.
 *
 * This started as a full-width amber notice that listed every substitution above
 * the numbers. It was too loud for what it says. The whole panel is a
 * *prediction* — the operator already knows these are estimates — so a banner
 * arguing the point on every open buries the figures they came for.
 *
 * What is NOT given up: the substitutions are still stated verbatim, on hover
 * here and in full in the "Model inputs" section below. Which values were
 * estimated is real information — `Draft_m` in particular is what every UKC
 * figure rests on — so it stays one hover away rather than being deleted.
 */
function EstimatedChip({ mapping }: { mapping: VesselMapping }) {
  if (!mapping.degraded) {
    return (
      <CalciteChip scale="s" icon="check-circle" title="Every value the models used came from the AIS row or the port context.">
        all inputs observed
      </CalciteChip>
    );
  }
  const detail = [
    `${mapping.inputs_assumed} of the ${mapping.inputs_assumed + mapping.inputs_observed} values these models needed were not in the AIS row, so a published constant was used:`,
    ...mapping.assumptions.map((a) => `• ${a}`),
    ...(mapping.warnings.length ? ['', 'Notes:', ...mapping.warnings.map((w) => `• ${w}`)] : []),
  ].join('\n');
  return (
    <CalciteChip scale="s" kind="brand" icon="exclamation-mark-triangle" title={detail}>
      {mapping.inputs_assumed} estimated
    </CalciteChip>
  );
}

/** A collapsed disclosure — reference detail that should not cost height. */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details style={{ marginTop: tokens.space.sm }}>
      <summary style={{ cursor: 'pointer', ...SECTION_TITLE, margin: 0 }}>{summary}</summary>
      <div style={{ marginTop: tokens.space.sm }}>{children}</div>
    </details>
  );
}

export function VesselPredictionsSheet() {
  const vessels = useAppStore((s) => s.vessels);
  const kpis = useAppStore((s) => s.kpis);

  const openMmsi = usePredictionStore((s) => s.openMmsi);
  const openVesselName = usePredictionStore((s) => s.openVesselName);
  const loading = usePredictionStore((s) => s.loading);
  const error = usePredictionStore((s) => s.error);
  const response = usePredictionStore((s) => s.response);
  const scored = usePredictionStore((s) => s.scored);
  const feedSize = usePredictionStore((s) => s.feedSize);
  const close = usePredictionStore((s) => s.close);
  const refresh = usePredictionStore((s) => s.refresh);

  const prediction = usePredictionStore(selectOpenPrediction);
  const dashboard = response?.dashboard ?? null;
  const glossary = dashboard?.glossary ?? {};
  const mapping = prediction?.mapping ?? null;

  const blocks = useMemo(
    () => (prediction ? orderedBlocks(prediction.models) : []),
    [prediction],
  );

  const context = useMemo(
    () => buildContext({ berthOccupancyPct: kpis?.berthOccupancy.value ?? null }),
    [kpis],
  );

  const failed = dashboard?.run.models_failed ?? [];

  return (
    <CalciteSheet
      label={`AI predictions — ${openVesselName || 'vessel'}`}
      open={openMmsi !== null}
      position="inline-end"
      widthScale="l"
      displayMode="float"
      onCalciteSheetClose={() => close()}
    >
      {/* `key` is load-bearing, not a list-rendering habit.
          `calcite-panel` handles its own close button by setting `closed = true`
          ON THE ELEMENT (panelCloseHandler in the Calcite source). Its React
          wrapper only writes properties whose React prop CHANGED, and we never
          pass `closed` — so that mutation is permanent: the second time the
          sheet opened it rendered an empty white box with no header and no ✕,
          because the panel inside it was still closed from the first visit.
          Keying on the open vessel forces a fresh element per open, which cannot
          inherit that state. It also drops the previous vessel's scroll
          position, which is what an operator opening a different ship expects. */}
      <CalcitePanel
        key={openMmsi ?? 'closed'}
        heading={openVesselName || 'AI predictions'}
        description={openMmsi ? `MMSI ${openMmsi} · UC-1 model suite` : undefined}
        closable
        onCalcitePanelClose={() => close()}
      >
        <div style={{ padding: tokens.space.md, display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
          {loading && <PanelLoading label="Scoring the fleet through the UC-1 models…" />}

          {/* PanelError takes a message only (~24 call sites share that
              signature), so the retry sits beside it rather than inside it. */}
          {!loading && error && (
            <>
              <PanelError message={error} />
              <CalciteButton
                scale="s"
                appearance="outline"
                iconStart="refresh"
                width="half"
                onClick={() => {
                  void refresh(vessels, context);
                }}
              >
                Try again
              </CalciteButton>
            </>
          )}

          {/* `openMmsi` is part of the condition, not just of the message: the
              sheet animates shut over ~200 ms, and without it the closing panel
              would flash "no prediction for MMSI null" on its way out. */}
          {!loading && !error && !prediction && openMmsi && (
            <CalciteNotice open kind="info" scale="s" icon="information">
              <div slot="title">No prediction for this vessel</div>
              <div slot="message">
                The model service answered, but returned no block for MMSI {openMmsi}. Re-run the
                scoring to include her.
              </div>
            </CalciteNotice>
          )}

          {!loading && !error && prediction && dashboard && (
            <>
              {failed.length > 0 && (
                <CalciteNotice open kind="danger" scale="s" icon="exclamation-mark-circle">
                  <div slot="title">{failed.length} model(s) failed in this run</div>
                  <div slot="message">
                    {failed.map((f) => `${f.model}: ${f.error}`).join(' · ')}
                  </div>
                </CalciteNotice>
              )}

              {/* One status line. Everything here is a fact about THIS run that
                  changes how the numbers read — how many hulls the fleet models
                  saw, whether the row was live, what was estimated. Anything
                  that only explains itself lives on a hover. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.xs, alignItems: 'center' }}>
                <CalciteChip scale="s" icon="ship" title="M4 occupancy, the M5 berth plan and M7 craft conflicts describe this whole set, not one hull.">
                  fleet of {scored}
                  {feedSize > scored ? ` of ${feedSize}` : ''}
                </CalciteChip>
                <EstimatedChip mapping={prediction.mapping ?? EMPTY_MAPPING} />
                {prediction.source === 'live' && (
                  <CalciteChip scale="s" kind="brand" icon="satellite-3">
                    live AIS row
                  </CalciteChip>
                )}
                {prediction.flags.map((flag) => (
                  <CalciteChip key={flag} scale="s" kind="neutral" title={FLAG_HINTS[flag] ?? 'Row-level caveat from the models'}>
                    {flag}
                  </CalciteChip>
                ))}
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart="refresh"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    void refresh(vessels, context);
                  }}
                >
                  Re-score
                </CalciteButton>
              </div>

              {dashboard.run.vessels_dropped ? (
                <CalciteNotice open kind="warning" scale="s" icon="exclamation-mark-triangle">
                  <div slot="title">
                    {dashboard.run.vessels_dropped} vessel(s) left out of the fleet models
                  </div>
                  <div slot="message">
                    {dashboard.run.dropped_reason ??
                      'The feed is larger than the service scores in one call.'}{' '}
                    M4 occupancy, the M5 berth plan and M7 craft conflicts describe the{' '}
                    {scored} vessels that were sent.
                  </div>
                </CalciteNotice>
              ) : null}

              {/* The answer the operator opened this for — no section heading
                  above it, because the sheet's own title already says what it
                  is and a heading over the only primary content is furniture. */}
              <div style={{ display: 'grid', gap: tokens.space.sm }}>
                {blocks.map(({ view, block }) => (
                  <ModelCard
                    key={view.id}
                    view={view}
                    block={block}
                    question={dashboard.model_questions[view.id]}
                    glossary={glossary}
                  />
                ))}
              </div>

              {/* Reference, not answer. Both were full sections costing a screen
                  of scrolling each; collapsed, they cost one line and are still
                  one click away. The model inputs carry the estimated values in
                  full, which is why the chip above can afford to be a chip. */}
              <Disclosure summary={`Model inputs (${mapping ? `${mapping.inputs_assumed} estimated` : 'as used'})`}>
                <div style={CARD}>
                  <FieldGrid fields={Object.entries(prediction.input)} glossary={glossary} />
                  {mapping && mapping.assumptions.length > 0 && (
                    <ul style={{ margin: `${tokens.space.sm}px 0 0`, paddingLeft: 16, fontSize: 11, lineHeight: 1.5, color: tokens.textMuted }}>
                      {mapping.assumptions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                      {mapping.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )}
                  <p style={{ margin: `${tokens.space.sm}px 0 0`, fontSize: 11, color: tokens.textMuted }}>
                    {Object.entries(prediction.data_quality)
                      .map(([k, v]) => `${humaniseKey(k)} = ${v}`)
                      .join(' · ') || 'no provenance reported'}
                  </p>
                </div>
              </Disclosure>

              <Disclosure summary="Port-level figures (whole fleet)">
                <div style={{ display: 'grid', gap: tokens.space.sm }}>
                  {Object.entries(dashboard.port_summary).map(([key, block]) => (
                    <section key={key} style={CARD} aria-label={humaniseKey(key)}>
                      <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: tokens.text }}>
                        {humaniseKey(key)}
                      </h3>
                      <FieldGrid fields={Object.entries(block)} glossary={glossary} />
                    </section>
                  ))}
                  <p style={{ margin: 0, fontSize: 10.5, color: tokens.textMuted }}>
                    {response?.adapter.moduleId} {response?.adapter.version} · generated{' '}
                    {dashboard.run.generated_at_utc}
                  </p>
                </div>
              </Disclosure>
            </>
          )}
        </div>
      </CalcitePanel>
    </CalciteSheet>
  );
}

/** Exported for the table column so both agree on what the button is called. */
export const PREDICTIONS_COLUMN_LABEL = 'Predictions';
export { MODEL_VIEWS };
