/**
 * Cross-identifier search for the marine investigation screens. PRESENTATION ONLY.
 *
 * One search box that matches ANY vessel identifier the backend already returned —
 * vessel name, VCN, VIA, IMO, voyage, rotation. It filters rows the API sent; it never
 * asks the backend anything new and never reshapes a record.
 *
 * WHY SUBSTRING, CASE- AND SPACE-INSENSITIVE
 * ------------------------------------------
 * These identifiers are typed by hand off a manifest or a phone call, and the corpus
 * itself is inconsistent about them: a VIA appears as `S0814` and as `HHYS0520`, a full
 * VCN embeds its VIA (`INNSA1NS0S0814`), pilot codes carry an internal space (`JP 91`).
 * An investigator typing `s0814` or `jp91` must still find the row. Substring matching
 * therefore also makes VCN searchable by its VIA tail, which is the behaviour an
 * operator expects rather than an accident.
 *
 * Matching is deliberately NOT fuzzy: no edit distance, no token scoring. A hit is a
 * literal containment, so a result can always be explained by pointing at the field.
 */

/** Lowercase, trimmed, spaces removed — the form both needle and haystack compare in. */
function norm(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Does any of `fields` contain `needle`?
 *
 * An empty needle matches everything — an empty search box is not a filter. Null,
 * undefined and blank fields simply never match, so a record missing an identifier is
 * skipped rather than treated as a wildcard.
 */
export function matchesIdentity(needle: string, fields: readonly unknown[]): boolean {
  const n = norm(needle);
  if (!n) return true;
  for (const f of fields) {
    const h = norm(f);
    if (h && h.includes(n)) return true;
  }
  return false;
}

/**
 * The identifiers this build can search on, and where each one comes from.
 *
 * Kept next to the matcher so the help text under the search box and the audit of what
 * is actually available can never drift apart. `available: false` means no module in
 * this application returns the field — it is listed so its absence is explicit rather
 * than looking like an oversight.
 */
export const SEARCHABLE_IDENTIFIERS: readonly {
  label: string; available: boolean; note: string;
}[] = [
  { label: 'Vessel Name', available: true, note: 'both modules' },
  { label: 'VIA', available: true, note: 'both modules, complete' },
  { label: 'IMO', available: true, note: 'both modules' },
  { label: 'VCN', available: true, note: 'sparse — pilot memos and a few active calls only' },
  { label: 'Voyage No', available: false, note: 'not returned by either endpoint' },
  { label: 'Rotation No', available: false, note: 'not returned by either endpoint' },
  { label: 'IGM No', available: false, note: 'not modelled on the marine side at all' },
];

/** Human summary of what the box searches, for the hint line under it. */
export function searchHint(): string {
  return SEARCHABLE_IDENTIFIERS.filter((i) => i.available).map((i) => i.label).join(' · ');
}
