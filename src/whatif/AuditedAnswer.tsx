/**
 * The audited answers panel for UC-1.
 *
 * Carries all nine what-if scenarios, not only the two the Notice puts to
 * marine. A cross-domain twin that hides a question because another department
 * asked it is not a cross-domain twin — a Deputy Conservator looking at a berth
 * cascade has a legitimate reason to ask what the gate is doing about it. UC-1's
 * own scenarios (I-A, I-B, N-1) are listed first; the rest follow, each labelled
 * with the use case that owns it.
 *
 * All nine are computed in UC-3, because the berthing, traffic and gate tables
 * live there. That is stated on every row rather than left to be inferred.
 *
 * The walkthrough and this panel are separate on purpose. A scenario runs, the
 * map moves and the VR scene reacts with no network call at all; pressing "Get
 * the audited figures" is what reaches the gateway. So a demo machine with no
 * backend behaves exactly as it did before, and the traceable answer is one
 * click away when there is one.
 *
 * When a walkthrough scenario with a Notice counterpart is running (M9 -> I-B,
 * M5 -> I-A), that scenario is preselected, so the figures on screen match the
 * story being told.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import WhatIfAnswer from './WhatIfAnswer';
import { orderedFor, type ScenarioEntry } from './scenarioCatalog';
import {
  ENGINE_FOR_SCENARIO,
  EngineUnavailable,
  runEngineScenario,
  type EngineResult,
} from './engineClient';

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
  const catalog = useMemo(() => orderedFor('UC-1'), []);
  // The walkthrough scenario currently running, if it has a Notice counterpart.
  const suggested = scenarioId ? ENGINE_FOR_SCENARIO[scenarioId]?.scenario : undefined;

  const [active, setActive] = useState<string>(suggested ?? catalog[0].id);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Follow the walkthrough when it moves to a scenario we can audit, so the
  // figures never describe a different scenario from the one on the map.
  useEffect(() => {
    if (suggested && suggested !== active) {
      setActive(suggested);
      setResult(null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested]);

  const entry: ScenarioEntry =
    catalog.find((s) => s.id === active) ?? catalog[0];

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runEngineScenario(entry.id, { ...entry.params }));
    } catch (err) {
      setError(
        err instanceof EngineUnavailable
          ? err.message
          : 'The audited figures could not be fetched.',
      );
    } finally {
      setLoading(false);
    }
  }, [entry]);

  return (
    <section className="audited-wrap" aria-label="Audited what-if answers">
      <header className="audited-head">
        <span className="audited-title">Audited answers</span>
        <button type="button" className="audited-run" onClick={run} disabled={loading}>
          {loading ? 'Fetching…' : result ? 'Refresh figures' : 'Get the audited figures'}
        </button>
      </header>

      <div className="audited-tabs" role="tablist">
        {catalog.map((s) => (
          <button
            key={s.id}
            role="tab"
            type="button"
            aria-selected={s.id === active}
            className={`audited-tab${s.id === active ? ' audited-tab-on' : ''}`}
            title={`${s.question}\n\nOwned by ${s.owner} · computed in ${s.answeredBy}`}
            onClick={() => {
              setActive(s.id);
              setResult(null);
              setError(null);
            }}
          >
            <span className={`audited-ref audited-ref-${s.source}`}>{s.ref}</span>
            {s.label}
            {s.owner !== 'UC-1' ? <span className="audited-owner"> {s.owner}</span> : null}
          </button>
        ))}
      </div>

      <p className="audited-question">{entry.question}</p>
      {entry.caveat ? <p className="audited-caveat">{entry.caveat}</p> : null}
      {entry.owner !== 'UC-1' ? (
        <p className="audited-hint">
          A {entry.owner} question. Shown here because a marine decision often
          turns on it — computed in {entry.answeredBy}, where its data lives.
        </p>
      ) : null}

      {!result && !error && !loading ? (
        <p className="audited-hint">
          The walkthrough runs offline. These figures come from the shared
          scenario engine and carry their method, assumptions and the queries
          they ran — the same answer UC-2 and UC-3 show.
        </p>
      ) : null}

      {error ? <p className="audited-banner" role="alert">{error}</p> : null}

      {result ? (
        <WhatIfAnswer
          result={result}
          title={`${entry.ref} — ${entry.label}`}
          classNames={CLASSES}
        />
      ) : null}
    </section>
  );
}

export default AuditedAnswer;
