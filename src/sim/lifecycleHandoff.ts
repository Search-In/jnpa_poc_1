/**
 * Cross-twin lifecycle hand-off — where a scenario's story continues once THIS twin has
 * told its part.
 *
 * A port disruption does not respect the boundary between the three twins. A monsoon that
 * suspends pilot transfer in UC-1 lands vessels late; the late discharge stacks up in
 * UC-2's yard; working that backlog off puts a truck surge on UC-3's corridor. Each twin
 * modelled its own segment and stopped, so the operator saw three unrelated demos of one
 * event.
 *
 * A hand-off names the next segment and how to reach it. It is deliberately a LINK and a
 * sentence rather than an automatic redirect:
 *
 *   • the operator finishes reading the conclusion before moving on, instead of being
 *     navigated away mid-sentence;
 *   • it opens on a real click, which is what keeps a browser from blocking the tab;
 *   • and a twin that is not running simply fails to load a tab, rather than silently
 *     breaking the scenario the operator is watching.
 *
 * The origins are dev defaults, overridable per deployment — the three apps are served
 * from different hosts in production and only ever share a machine on a developer's
 * laptop.
 */

/** Which twin picks the story up. */
export type TwinId = 'UC1' | 'UC2' | 'UC3';

const ORIGIN_ENV: Record<TwinId, string | undefined> = {
  UC1: import.meta.env.VITE_UC1_APP_URL,
  UC2: import.meta.env.VITE_UC2_APP_URL,
  UC3: import.meta.env.VITE_UC3_APP_URL,
};

/**
 * Production hosts, from each twin's own nginx `server_name`:
 *   UC-1  deploy/nginx.conf                       -> vessel-one.searchintech.in
 *   UC-2  apps/web/nginx.conf                     -> logistics-two.searchintech.in
 *   UC-3  (already the gateway origin everywhere) -> traffic-three.searchintech.in
 *
 * Overridable per build with VITE_UC{1,2,3}_APP_URL, so a staging stack or a laptop can
 * point the chain at itself without a code change. The DEFAULTS are production because
 * that is where this runs unattended: a deployed build with an unset variable should link
 * to the deployed twin, not to a localhost that only exists on a developer's machine.
 */
const ORIGIN_DEFAULT: Record<TwinId, string> = {
  UC1: 'https://vessel-one.searchintech.in',
  UC2: 'https://logistics-two.searchintech.in',
  UC3: 'https://traffic-three.searchintech.in',
};
/**
 * Local dev, for `VITE_UC{1,2,3}_APP_URL` on a laptop:
 *   UC-2 :5173 · UC-1 :5174 · UC-3 :5175
 */
export const ORIGIN_LOCAL: Record<TwinId, string> = {
  UC1: 'http://localhost:5174',
  UC2: 'http://localhost:5173',
  UC3: 'http://localhost:5175',
};

export const TWIN_LABEL: Record<TwinId, string> = {
  UC1: 'UC-1 · Vessel Traffic',
  UC2: 'UC-2 · Cargo & Logistics',
  UC3: 'UC-3 · Traffic & Corridor',
};

export interface LifecycleHandoff {
  /** The twin that continues the story. */
  twin: TwinId;
  /** Scenario id to open there — the receiving app's own vocabulary, not ours. */
  scenarioId: string;
  /** Button text. Names the NEXT segment, not the mechanism. */
  cta: string;
  /**
   * Why the story continues — the causal link between the two segments, in one
   * sentence. Shown above the button so the jump is explained rather than merely
   * offered.
   */
  because: string;
}

/** Origin for a twin: deployment override, else the local dev port. */
export function twinOrigin(twin: TwinId): string {
  return (ORIGIN_ENV[twin] || ORIGIN_DEFAULT[twin]).replace(/\/+$/, '');
}

/**
 * Deep link into the next twin's scenario.
 *
 * `?scenario=<id>` is the parameter all three apps already accept, so this needs no new
 * contract — UC-1 and UC-2 read it on mount, and UC-3 gained the same handler when this
 * chain was built.
 */
export function handoffUrl(h: LifecycleHandoff): string {
  return `${twinOrigin(h.twin)}/?scenario=${encodeURIComponent(h.scenarioId)}`;
}
