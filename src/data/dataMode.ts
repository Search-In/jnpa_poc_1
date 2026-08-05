/**
 * The data-mode vocabulary and its resolver — the ONE place that decides what
 * `VITE_DATA_MODE` is allowed to be, and what happens when it is something else.
 *
 * Why this exists as its own module: the failure it prevents is silent and
 * expensive. `VITE_DATA_MODE` used to be a bare cast, and `createBaseAdapter`
 * (src/data/index.ts) falls through to `MockAdapter` for any value it does not
 * recognise. So a typo — or the `VITE_DATA_MODE=uc3` instruction that circulated
 * in a programme document — produced a dashboard full of INVENTED vessels that
 * looked exactly like a working one. Nothing failed, nothing warned; an operator
 * could demo simulated traffic believing it was real. An unrecognised value must
 * be loud.
 *
 * Deliberately dependency-free (no `import.meta.env`, no config import) so the
 * Vite config can import it at BUILD time and fail the build, while the browser
 * bundle imports the same rules at RUNTIME. One vocabulary, two enforcement
 * points, no second copy to drift.
 */

/**
 * Every accepted value, in the order the README documents them.
 *   mock   — offline simulated fleet, zero credentials (the default).
 *   live   — real feeds only (ArcGIS Stream Layer / Feature Layers / aisstream).
 *   hybrid — simulated fleet WITH real aisstream/AISHub vessels layered on top.
 */
export const DATA_MODES = ['mock', 'live', 'hybrid'] as const;

export type DataMode = (typeof DATA_MODES)[number];

export interface DataModeResolution {
  /** The mode to actually use. Always a legal value — unknown input falls back. */
  mode: DataMode;
  /** Operator-language explanation, or null when the input was legal. */
  warning: string | null;
}

/** The fallback an unrecognised value lands on. Matches `createBaseAdapter`. */
export const DEFAULT_DATA_MODE: DataMode = 'mock';

function isDataMode(v: string): v is DataMode {
  return (DATA_MODES as readonly string[]).includes(v);
}

/**
 * Resolve a raw `VITE_DATA_MODE` string.
 *
 * - unset / empty → the documented default, silently. Most developers never set
 *   it, and a warning on every default run would be noise that trains people to
 *   ignore warnings.
 * - a legal value → itself, no warning.
 * - anything else → the default PLUS a warning. Note it is not lower-cased or
 *   trimmed into shape first: silently accepting `'Mock'` or `' live'` is the
 *   same class of bug this module exists to prevent — the operator would believe
 *   a value works that a stricter consumer might reject.
 *
 * The warning names the offending value, lists the legal set, states the
 * consequence in operator language, and — the part that matters most — says that
 * UC-3 gateway data is a SEPARATE switch. Without that sentence the natural
 * "fix" for someone who wanted gateway data is to start disabling things.
 */
export function resolveDataMode(raw: string | undefined | null): DataModeResolution {
  if (raw === undefined || raw === null || raw === '') {
    return { mode: DEFAULT_DATA_MODE, warning: null };
  }
  if (isDataMode(raw)) return { mode: raw, warning: null };

  return {
    mode: DEFAULT_DATA_MODE,
    // Worded to be true at BOTH enforcement points: the build refuses this value,
    // while a bundle that somehow carries it runs on the fallback. Hence "would
    // fall back" rather than a past-tense claim about what already happened.
    warning:
      `VITE_DATA_MODE="${raw}" is not a recognised data mode. ` +
      `Valid values: ${DATA_MODES.join(' | ')}. ` +
      `An unrecognised value falls back to "${DEFAULT_DATA_MODE}", which means the vessel fleet, ` +
      `berths and marine KPIs would be SIMULATED, not real JNPA data. ` +
      `Note that UC-3 gateway data (shipping lines, vessel calls, pilotage, performance) is a ` +
      `separate switch, VITE_UC3_ENABLED, and is unaffected by this setting.`,
  };
}
