/**
 * The audited answer panel for a UC-1 scenario.
 *
 * Shown beside the walkthrough for the two scenarios the JNPA Notice actually
 * asks about — M9 (I-B extended berth window) and M5 (I-A vessel bunching). The
 * walkthrough tells the story on the map and in VR; this panel carries the
 * figures, and it fetches them from the same engine UC-2 and UC-3 use so all
 * three dashboards quote the same numbers.
 *
 * The panel is deliberately quiet until asked. A scenario runs, the map moves and
 * the VR scene reacts without any network call; pressing "Get the audited
 * figures" is what reaches the gateway. That keeps the offline walkthrough
 * genuinely offline — a demo machine with no backend still works exactly as it
 * did — while making the traceable answer one click away.
 */
import { useCallback, useState } from 'react';
import WhatIfAnswer from './WhatIfAnswer';
import {
  ENGINE_FOR_SCENARIO,
  EngineUnavailable,
  runEngineScenario,
  type EngineResult,
} from './engineClient';

/** Calcite-flavoured classes so the panel sits inside the UC-1 shell. */
const CLASSES = {
  root: 'audited-answer',
  verdict: 'audited-verdict',
  headline: 'audited-headline',
  detail: 'audited-detail',
  banner: 'audited-banner',
  section: 'audited-section',
  actions: 'audited-actions',
  action: 'audited-action',
  evidence: 'audited-evidence',
  summary: 'audited-summary',
  table: 'audited-table',
  chip: 'audited-chip',
} as const;

export function AuditedAnswer({ scenarioId }: { scenarioId: string | null }) {
  const mapping = scenarioId ? ENGINE_FOR_SCENARIO[scenarioId] : undefined;
  const [result, setResult] = useState<EngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    if (!mapping) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runEngineScenario(mapping.scenario));
    } catch (err) {
      setError(
        err instanceof EngineUnavailable
          ? err.message
          : 'The audited figures could not be fetched.',
      );
    } finally {
      setLoading(false);
    }
  }, [mapping]);

  // Eight of the ten walkthrough scenarios have no dated Notice question behind
  // them, so there is nothing to fetch and nothing is claimed.
  if (!mapping) return null;

  return (
    <section className="audited-wrap" aria-label="Audited figures">
      <header className="audited-head">
        <span className="audited-ref">{mapping.label}</span>
        <button type="button" className="audited-run" onClick={run} disabled={loading}>
          {loading ? 'Fetching…' : result ? 'Refresh figures' : 'Get the audited figures'}
        </button>
      </header>

      {!result && !error && !loading ? (
        <p className="audited-hint">
          The walkthrough runs offline. These figures come from the shared
          scenario engine and carry their method, assumptions and the queries
          they ran — the same answer UC-2 and UC-3 show.
        </p>
      ) : null}

      {error ? <p className="audited-banner" role="alert">{error}</p> : null}

      {result ? (
        <WhatIfAnswer result={result} title={mapping.label} classNames={CLASSES} />
      ) : null}
    </section>
  );
}

export default AuditedAnswer;
