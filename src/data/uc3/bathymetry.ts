/**
 * UC-3 Marine bathymetry connector — chart surveys + their depth soundings.
 *
 * Reads `/api/marine/bathymetry*` and maps the gateway's wire rows onto the UC-1 domain
 * types. Structured like seaChannels.ts / portCraft.ts: endpoint constants, typed *wire*
 * interfaces, exported PURE mappers, I/O last — unit-testable with no network.
 *
 * Backing store: `core.bathymetry_survey` + `core.bathymetry_sounding`, populated by the
 * SHARED marine upload endpoints (`/api/marine/upload`) from a chart PDF or the canonical
 * bathymetry JSON — both route through `document_type=BATHYMETRY` and land in the same
 * canonical model, so this connector is unchanged whichever source is used.
 *
 * TWO THINGS THAT DIFFER FROM EVERY OTHER MARINE CONNECTOR — read before adding a caller:
 *
 *  1. SCALE. A survey holds 15k-30k soundings and the corpus is ~190k. `survey_id` is
 *     therefore REQUIRED on the soundings endpoint and the server caps `limit` at 500.
 *     Never try to pull a whole survey into the browser: use `fetchSurveyStats` for
 *     counts and depth extents (aggregated in SQL) and page soundings deliberately.
 *  2. NULLABLE COORDINATES. Charts whose page->UTM grid could not be fitted return
 *     soundings with easting/northing/lat/lon all null and only page coordinates. That is
 *     valid data, not an error — `soundingsWithPosition()` exists so a map overlay filters
 *     them out explicitly rather than plotting nulls at 0/0.
 */

import type {
  BathymetryBBox,
  BathymetrySounding,
  BathymetrySurvey,
  BathymetrySurveyStats,
} from '@/types/domain';
import { http } from './client';

export const BATHYMETRY_SURVEYS_PATH = '/marine/bathymetry/surveys';
export const BATHYMETRY_SOUNDINGS_PATH = '/marine/bathymetry/soundings';
/** Surveys are few (~12), so one page is the whole register. */
export const BATHYMETRY_SURVEY_PAGE_LIMIT = 100;
/** Soundings page size. MUST NOT exceed the gateway cap. */
export const BATHYMETRY_SOUNDING_PAGE_LIMIT = 200;
/** Server-side hard ceiling (`_MAX_SOUNDING_LIMIT` in marine_bathymetry.py). */
export const BATHYMETRY_SOUNDING_MAX_LIMIT = 500;

/* ----------------------------------------------------------------- wire shapes */

/** One survey row exactly as the gateway returns it. Snake_case wire shape. */
export interface BathymetrySurveyWire {
  survey_id: number | null;
  drawing_no: string | null;
  section_label: string | null;
  design_depth_m: number | null;
  survey_start: string | null;
  survey_end: string | null;
  survey_vessel: string | null;
  file_path: string | null;
  sounding_count: number | null;
}

export interface BathymetrySurveyPage {
  items: BathymetrySurveyWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

export interface BathymetryBBoxWire {
  min_easting_m: number | null;
  max_easting_m: number | null;
  min_northing_m: number | null;
  max_northing_m: number | null;
}

export interface BathymetrySurveyStatsWire {
  survey_id: number | null;
  drawing_no: string | null;
  design_depth_m: number | null;
  sounding_count: number | null;
  above_design_count: number | null;
  georeferenced_count: number | null;
  min_depth_m: number | null;
  max_depth_m: number | null;
  avg_depth_m: number | null;
  bbox: BathymetryBBoxWire | null;
}

export interface BathymetrySoundingWire {
  sounding_id: number | null;
  survey_id: number | null;
  easting_m: number | null;
  northing_m: number | null;
  lat: number | null;
  lon: number | null;
  depth_m: number | null;
  above_design: boolean | null;
  page_x_pt: number | null;
  page_y_pt: number | null;
  import_file_id: number | null;
}

export interface BathymetrySoundingPage {
  items: BathymetrySoundingWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

/* ----------------------------------------------------------------- filters */

export interface BathymetrySurveyFilters {
  drawingNo?: string;
  section?: string;
  vessel?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

export interface BathymetrySoundingFilters {
  /** True = shoal only, false = normal only, undefined = both. */
  aboveDesign?: boolean;
  minDepth?: number;
  maxDepth?: number;
  /** True = only soundings carrying easting/northing. */
  georeferenced?: boolean;
  sort?: string;
  direction?: 'asc' | 'desc';
}

/* ----------------------------------------------------------------- helpers */

function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}
function nullableNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function num(v: number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/* ----------------------------------------------------------------- mappers */

/** Map one survey wire row onto the domain type. Pure. Drops a row with no `survey_id`. */
export function mapBathymetrySurvey(w: BathymetrySurveyWire): BathymetrySurvey | null {
  const surveyId = nullableNum(w?.survey_id);
  if (surveyId === null) return null;
  return {
    surveyId,
    drawingNo: str(w.drawing_no),
    sectionLabel: str(w.section_label),
    designDepthM: nullableNum(w.design_depth_m),
    surveyStart: str(w.survey_start),
    surveyEnd: str(w.survey_end),
    surveyVessel: str(w.survey_vessel),
    soundingCount: num(w.sounding_count),
  };
}

/** Map a whole survey page, dropping unusable rows, preserving server order. Pure. */
export function parseBathymetrySurveyPage(raw: unknown): BathymetrySurvey[] {
  const items = (raw as BathymetrySurveyPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapBathymetrySurvey).filter((s): s is BathymetrySurvey => s !== null);
}

function mapBBox(w: BathymetryBBoxWire | null | undefined): BathymetryBBox | null {
  if (!w) return null;
  const bbox = {
    minEastingM: nullableNum(w.min_easting_m),
    maxEastingM: nullableNum(w.max_easting_m),
    minNorthingM: nullableNum(w.min_northing_m),
    maxNorthingM: nullableNum(w.max_northing_m),
  };
  // A bbox with no usable extent is no bbox — a page-space-only survey returns nulls.
  return bbox.minEastingM === null && bbox.minNorthingM === null ? null : bbox;
}

/** Map the stats payload. Pure. Returns null when the response carries no `survey_id`. */
export function mapBathymetryStats(raw: unknown): BathymetrySurveyStats | null {
  const w = raw as BathymetrySurveyStatsWire | null;
  const surveyId = nullableNum(w?.survey_id);
  if (w === null || w === undefined || surveyId === null) return null;
  return {
    surveyId,
    drawingNo: str(w.drawing_no),
    designDepthM: nullableNum(w.design_depth_m),
    soundingCount: num(w.sounding_count),
    aboveDesignCount: num(w.above_design_count),
    georeferencedCount: num(w.georeferenced_count),
    minDepthM: nullableNum(w.min_depth_m),
    maxDepthM: nullableNum(w.max_depth_m),
    avgDepthM: nullableNum(w.avg_depth_m),
    bbox: mapBBox(w.bbox),
  };
}

/**
 * Map one sounding wire row. Pure. Drops a row with no `sounding_id` or no depth —
 * depth is the measurement; a row without it carries nothing.
 */
export function mapBathymetrySounding(w: BathymetrySoundingWire): BathymetrySounding | null {
  const soundingId = nullableNum(w?.sounding_id);
  const depthM = nullableNum(w?.depth_m);
  if (soundingId === null || depthM === null) return null;
  return {
    soundingId,
    surveyId: num(w.survey_id),
    eastingM: nullableNum(w.easting_m),
    northingM: nullableNum(w.northing_m),
    lat: nullableNum(w.lat),
    lon: nullableNum(w.lon),
    depthM,
    aboveDesign: w.above_design === true,
    pageXPt: nullableNum(w.page_x_pt),
    pageYPt: nullableNum(w.page_y_pt),
  };
}

/** Map a whole sounding page, dropping unusable rows, preserving server order. Pure. */
export function parseBathymetrySoundingPage(raw: unknown): BathymetrySounding[] {
  const items = (raw as BathymetrySoundingPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapBathymetrySounding).filter((s): s is BathymetrySounding => s !== null);
}

/**
 * Soundings that can actually be placed on a map. Pure.
 *
 * Explicit rather than implicit: an ungeoreferenced chart yields soundings with null
 * lat/lon, and plotting those unfiltered would drop the whole survey at 0/0 in the Gulf
 * of Guinea. Callers drawing an overlay MUST route through this.
 */
export function soundingsWithPosition(soundings: BathymetrySounding[]): BathymetrySounding[] {
  return soundings.filter((s) => s.lat !== null && s.lon !== null);
}

/* ----------------------------------------------------------------- queries */

function params(): URLSearchParams {
  return new URLSearchParams();
}
function put(q: URLSearchParams, k: string, v: string | number | boolean | undefined): void {
  if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`);
}

/** Build the survey-list query string. Pure. */
export function bathymetrySurveyQuery(
  filters: BathymetrySurveyFilters = {},
  limit = BATHYMETRY_SURVEY_PAGE_LIMIT,
  offset = 0,
): string {
  const q = params();
  put(q, 'drawing_no', filters.drawingNo);
  put(q, 'section', filters.section);
  put(q, 'vessel', filters.vessel);
  put(q, 'sort', filters.sort);
  put(q, 'direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${BATHYMETRY_SURVEYS_PATH}?${q.toString()}`;
}

/**
 * Build the sounding-list query string. Pure.
 *
 * `surveyId` is REQUIRED — the gateway refuses an unscoped sounding scan — and `limit` is
 * clamped to the server ceiling so a caller cannot provoke a 422 by asking for more.
 */
export function bathymetrySoundingQuery(
  surveyId: number,
  filters: BathymetrySoundingFilters = {},
  limit = BATHYMETRY_SOUNDING_PAGE_LIMIT,
  offset = 0,
): string {
  const q = params();
  q.set('survey_id', String(surveyId));
  if (filters.aboveDesign !== undefined) q.set('above_design', String(filters.aboveDesign));
  if (filters.georeferenced !== undefined) q.set('georeferenced', String(filters.georeferenced));
  put(q, 'min_depth', filters.minDepth);
  put(q, 'max_depth', filters.maxDepth);
  put(q, 'sort', filters.sort);
  put(q, 'direction', filters.direction);
  q.set('limit', String(Math.min(Math.max(1, limit), BATHYMETRY_SOUNDING_MAX_LIMIT)));
  q.set('offset', String(offset));
  return `${BATHYMETRY_SOUNDINGS_PATH}?${q.toString()}`;
}

/* ----------------------------------------------------------------- fetchers */

/** Fetch the survey register (small — ~12 rows — so one page suffices). */
export async function fetchBathymetrySurveys(
  filters: BathymetrySurveyFilters = {},
  limit = BATHYMETRY_SURVEY_PAGE_LIMIT,
  offset = 0,
): Promise<BathymetrySurvey[]> {
  const page = await http<BathymetrySurveyPage>(bathymetrySurveyQuery(filters, limit, offset));
  return parseBathymetrySurveyPage(page);
}

/** Fetch one survey's aggregates. Counts are computed server-side — never derive them
 *  by paging soundings. */
export async function fetchBathymetrySurveyStats(
  surveyId: number,
): Promise<BathymetrySurveyStats | null> {
  const raw = await http<BathymetrySurveyStatsWire>(
    `${BATHYMETRY_SURVEYS_PATH}/${surveyId}/stats`,
  );
  return mapBathymetryStats(raw);
}

/** Fetch ONE page of soundings for a survey. There is deliberately no fetch-all. */
export async function fetchBathymetrySoundings(
  surveyId: number,
  filters: BathymetrySoundingFilters = {},
  limit = BATHYMETRY_SOUNDING_PAGE_LIMIT,
  offset = 0,
): Promise<BathymetrySounding[]> {
  const page = await http<BathymetrySoundingPage>(
    bathymetrySoundingQuery(surveyId, filters, limit, offset),
  );
  return parseBathymetrySoundingPage(page);
}

/** Fetch a sounding page WITH its envelope, for a paginated table that shows a total. */
export async function fetchBathymetrySoundingPage(
  surveyId: number,
  filters: BathymetrySoundingFilters = {},
  limit = BATHYMETRY_SOUNDING_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: BathymetrySounding[]; total: number; limit: number; offset: number }> {
  const page = await http<BathymetrySoundingPage>(
    bathymetrySoundingQuery(surveyId, filters, limit, offset),
  );
  return {
    items: parseBathymetrySoundingPage(page),
    total: Number(page?.total ?? 0),
    limit: Number(page?.limit ?? limit),
    offset: Number(page?.offset ?? offset),
  };
}
