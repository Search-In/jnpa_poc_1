/**
 * Localisation scaffold (spec O-5). UI strings are externalised here so Hindi /
 * Marathi catalogues can be added without touching components. English (`en`) is
 * the only complete catalogue today; `hi` / `mr` are stubs that fall back to
 * English per-key, so the app is fully functional now and translation is a
 * data-only task later.
 *
 * `t(key)` returns the active-locale string, falling back to English, then to
 * the key itself. Keys are dotted namespaces. Dates/times are always IST with an
 * explicit "IST" label and DD-MM-YYYY convention (see util/format.ts).
 */

export type Locale = 'en' | 'hi' | 'mr';

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिन्दी (Hindi)' },
  { id: 'mr', label: 'मराठी (Marathi)' },
];

type Catalogue = Record<string, string>;

const en: Catalogue = {
  'app.title': 'JNPA · Vessel Traffic Management & Optimisation',
  'app.subtitle': 'Digital Twin PoC · Use Case 1',
  'role.label': 'Role',
  'role.readonly': 'READ-ONLY',
  'tab.kpis': 'KPI Wall',
  'tab.gantt': '5-Day Berthing',
  'tab.plan': 'Plan Import',
  'tab.dukc': 'DUKC / RTUKC',
  'tab.craft': 'Port Craft',
  'tab.scenarios': 'What-If',
  'tab.workflows': 'Workflows',
  'tab.analytics': 'Analytics & JIT',
  'tab.connectors': 'Connectors',
  'tab.reports': 'Reports',
  'tab.methodology': 'Methodology',
  'plan.import': 'Import CSV / XLSX-as-CSV',
  'plan.addByHand': 'Add a call by hand',
  'workflow.compose': 'Compose a new rule',
  'connectors.headline': 'System complete · awaiting {n} credentials',
  'provenance.simulated': 'SIMULATED',
};

// Stubs — intentionally empty; keys fall back to English until translated.
const hi: Catalogue = {};
const mr: Catalogue = {};

const CATALOGUES: Record<Locale, Catalogue> = { en, hi, mr };

let activeLocale: Locale = 'en';

export function setLocale(l: Locale): void {
  activeLocale = l;
}
export function getLocale(): Locale {
  return activeLocale;
}

/**
 * Translate a key for the active locale (fallback: en → key). Supports simple
 * `{name}` interpolation from `vars`.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = CATALOGUES[activeLocale][key] ?? en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

/** Count of untranslated keys per non-English locale (for a coverage badge). */
export function translationCoverage(): Record<Locale, number> {
  const total = Object.keys(en).length;
  return {
    en: total,
    hi: Object.keys(hi).length,
    mr: Object.keys(mr).length,
  };
}
