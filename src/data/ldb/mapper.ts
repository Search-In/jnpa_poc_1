/**
 * Map LDB / SeaRates track wire JSON → ContainerTrackResult.
 *
 * Live LDB guest searate returns `{ responseData: { cntr_info_data, … } }`.
 * Older / SeaRates-shaped envelopes are still supported as a fallback.
 */

import type {
  ContainerMilestone,
  ContainerRoutePoint,
  ContainerTrackResult,
  ContainerTransportMode,
  ContainerVesselLeg,
} from './types';

interface WireLocation {
  id?: number;
  name?: string;
  country?: string;
  country_code?: string;
  lat?: number | null;
  lng?: number | null;
  lon?: number | null;
}

interface WireVessel {
  id?: number;
  name?: string;
}

interface WireEvent {
  order_id?: number;
  location?: number | null;
  description?: string;
  date?: string | null;
  actual?: boolean | null;
  transport_type?: string | null;
  vessel?: number | null;
  voyage?: string | null;
}

interface WireContainer {
  number?: string;
  size_type?: string;
  status?: string;
  events?: WireEvent[];
  demurrage?: { free_days?: string | number | null; days_in_charge?: string | number | null };
}

interface WireRouteNode {
  location?: number | null;
  date?: string | null;
  actual?: boolean | null;
}

interface WireData {
  metadata?: {
    number?: string;
    sealine?: string;
    sealine_name?: string;
    status?: string;
  };
  locations?: WireLocation[];
  vessels?: WireVessel[];
  containers?: WireContainer[];
  route?: {
    pol?: WireRouteNode;
    pod?: WireRouteNode;
    prepol?: WireRouteNode;
    postpod?: WireRouteNode;
  };
  route_data?: {
    route?: Array<{ path?: Array<[number, number] | number[]> }>;
    ais?: { lat?: number; lng?: number } | null;
  };
}

/** LDB `/apigateway/track/cntr/` guest response (`responseData`). */
interface LdbResponseData {
  is_valid?: number | boolean;
  cntr_info_data?: {
    number?: string;
    size_type?: string;
    status?: string;
    sealine_name?: string;
    source_name?: string;
    dest_name?: string;
    source_etd_or_atd?: string | null;
    dest_eta_ata?: string | null;
  };
  demurrage?: { free_days?: string | number | null; days_in_charge?: string | number | null };
  vessel_event_details?: Array<{
    vessel_name?: string;
    voyage_name?: string;
    loading?: string;
    discharge?: string;
    vessel_etd_atd?: string | null;
    /** LDB typo in production JS */
    veseel_eta_ata?: string | null;
    vessel_eta_ata?: string | null;
  }>;
  event_detail_info?: Array<{
    location_name?: string;
    event_details?: Array<{ id?: number; event?: string; event_time?: string | null }>;
  }>;
  route_details?: Array<{
    transport_type?: string;
    path?: Array<[number, number] | number[]>;
  }>;
  currentLocation?: { latitude?: number; longitude?: number };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function humanStatus(raw: string | undefined): string {
  if (!raw) return 'Unknown';
  return raw
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function transportMode(raw: string | null | undefined): ContainerTransportMode {
  const t = (raw ?? '').toUpperCase();
  if (t.includes('TRUCK') || t.includes('ROAD')) return 'TRUCK';
  if (t.includes('RAIL')) return 'RAIL';
  if (t.includes('VESSEL') || t.includes('SEA') || t.includes('FEEDER')) return 'VESSEL';
  return 'OTHER';
}

function splitPlace(name: string | undefined): { name: string; country: string } {
  if (!name) return { name: '—', country: '' };
  const m = name.match(/^(.*?)(?:,\s*([A-Z]{2}))?$/);
  if (!m) return { name, country: '' };
  return { name: m[1].trim() || name, country: (m[2] ?? '').toUpperCase() };
}

/** Map LDB guest `responseData` (the shape ldb.co.in searate actually uses). */
export function mapLdbResponseData(
  data: LdbResponseData,
  requestedContainer: string,
  fromSample = false,
): ContainerTrackResult | null {
  const info = data.cntr_info_data;
  if (!info && !(data.event_detail_info && data.event_detail_info.length)) return null;

  const want = requestedContainer.trim().toUpperCase();
  const origin = splitPlace(info?.source_name);
  const dest = splitPlace(info?.dest_name);

  const milestones: ContainerMilestone[] = [];
  for (const loc of data.event_detail_info ?? []) {
    const events = [...(loc.event_details ?? [])].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    for (const ev of events) {
      milestones.push({
        id: `ldb-${loc.location_name}-${ev.id ?? milestones.length}`,
        title: (loc.location_name ?? ev.event ?? 'Event').toUpperCase(),
        description: ev.event ?? loc.location_name ?? '—',
        locationName: loc.location_name ?? '—',
        countryCode: '',
        date: ev.event_time ?? null,
        actual: true,
        transportType: 'OTHER',
        vesselName: null,
        voyage: null,
      });
    }
  }

  const v0 = data.vessel_event_details?.[0];
  const vessel: ContainerVesselLeg | null = v0
    ? {
        vessel: v0.vessel_name ?? '—',
        voyage: v0.voyage_name ?? '—',
        loading: v0.loading ?? origin.name,
        etd: v0.vessel_etd_atd ?? info?.source_etd_or_atd ?? null,
        discharge: v0.discharge ?? dest.name,
        eta: v0.vessel_eta_ata ?? v0.veseel_eta_ata ?? info?.dest_eta_ata ?? null,
      }
    : null;

  const routePath: ContainerRoutePoint[] = [];
  for (const seg of data.route_details ?? []) {
    for (const pair of seg.path ?? []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lat = Number(pair[0]);
      const lng = Number(pair[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) routePath.push({ lat, lng });
    }
  }
  if (
    routePath.length === 0 &&
    data.currentLocation?.latitude != null &&
    data.currentLocation.longitude != null
  ) {
    routePath.push({
      lat: Number(data.currentLocation.latitude),
      lng: Number(data.currentLocation.longitude),
    });
  }

  const free =
    data.demurrage?.free_days != null && data.demurrage.free_days !== ''
      ? String(data.demurrage.free_days)
      : 'TBA';
  const charged =
    data.demurrage?.days_in_charge != null && data.demurrage.days_in_charge !== ''
      ? String(data.demurrage.days_in_charge)
      : 'TBA';

  return {
    containerNo: (info?.number ?? want).toUpperCase(),
    sizeType: info?.size_type ?? '—',
    status: humanStatus(info?.status),
    carrierName: info?.sealine_name ?? '—',
    carrierCode: '',
    originName: origin.name,
    originCountry: origin.country,
    destinationName: dest.name,
    destinationCountry: dest.country,
    etd: info?.source_etd_or_atd ?? null,
    eta: info?.dest_eta_ata ?? null,
    originLat: routePath[0]?.lat ?? null,
    originLng: routePath[0]?.lng ?? null,
    destinationLat: routePath.length ? routePath[routePath.length - 1].lat : null,
    destinationLng: routePath.length ? routePath[routePath.length - 1].lng : null,
    milestones,
    vessel,
    routePath,
    demurrage: { freeDays: free, daysInCharge: charged },
    fromSample,
  };
}

function asLdbResponseData(raw: unknown): LdbResponseData | null {
  const root = asRecord(raw);
  if (!root) return null;
  const rd = asRecord(root.responseData) ?? (root.cntr_info_data ? root : null);
  if (!rd) return null;
  if (rd.cntr_info_data || rd.event_detail_info || rd.route_details) {
    return rd as LdbResponseData;
  }
  return null;
}

/** Pull the SeaRates `data` object out of common envelopes. */
export function unwrapTrackData(raw: unknown): WireData | null {
  const root = asRecord(raw);
  if (!root) return null;
  const level1 = asRecord(root.data) ?? root;
  if (level1.locations || level1.containers || level1.metadata) {
    return level1 as WireData;
  }
  const level2 = asRecord(level1.data);
  if (level2 && (level2.locations || level2.containers || level2.metadata)) {
    return level2 as WireData;
  }
  return null;
}

function locMap(locations: WireLocation[] | undefined) {
  const m = new Map<
    number,
    { id: number; name: string; countryCode: string; lat: number | null; lng: number | null }
  >();
  for (const loc of locations ?? []) {
    if (loc.id == null) continue;
    m.set(loc.id, {
      id: loc.id,
      name: loc.name ?? `Location ${loc.id}`,
      countryCode: (loc.country_code ?? '').toUpperCase(),
      lat: typeof loc.lat === 'number' ? loc.lat : null,
      lng: typeof loc.lng === 'number' ? loc.lng : typeof loc.lon === 'number' ? loc.lon : null,
    });
  }
  return m;
}

function placeLabel(loc: { name: string; countryCode: string } | undefined): string {
  if (!loc) return '—';
  return loc.countryCode ? `${loc.name}, ${loc.countryCode}` : loc.name;
}

function formatRoutePath(data: WireData): ContainerRoutePoint[] {
  const segments = data.route_data?.route ?? [];
  const out: ContainerRoutePoint[] = [];
  for (const seg of segments) {
    for (const pair of seg.path ?? []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lat = Number(pair[0]);
      const lng = Number(pair[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
    }
  }
  return out;
}

function pickVesselLeg(
  container: WireContainer,
  vessels: WireVessel[],
  locations: ReturnType<typeof locMap>,
  route: WireData['route'],
): ContainerVesselLeg | null {
  const events = [...(container.events ?? [])].sort((a, b) => (a.order_id ?? 0) - (b.order_id ?? 0));
  const sea = events.filter((e) => e.vessel != null || transportMode(e.transport_type) === 'VESSEL');
  const withVessel = sea.find((e) => e.vessel != null) ?? sea[0];
  if (!withVessel && !route?.pol && !route?.pod) return null;

  const vesselId = withVessel?.vessel ?? null;
  const vesselName = vessels.find((v) => v.id === vesselId)?.name ?? vessels[0]?.name ?? '—';
  const voyage = withVessel?.voyage ?? sea.find((e) => e.voyage)?.voyage ?? '—';
  const pol = route?.pol?.location != null ? locations.get(route.pol.location) : undefined;
  const pod = route?.pod?.location != null ? locations.get(route.pod.location) : undefined;

  return {
    vessel: vesselName,
    voyage: voyage || '—',
    loading: placeLabel(pol),
    etd: route?.pol?.date ?? null,
    discharge: placeLabel(pod),
    eta: route?.pod?.date ?? null,
  };
}

function milestonesFrom(
  container: WireContainer,
  locations: ReturnType<typeof locMap>,
  vessels: WireVessel[],
): ContainerMilestone[] {
  const events = [...(container.events ?? [])].sort((a, b) => (b.order_id ?? 0) - (a.order_id ?? 0));
  return events.map((ev, i) => {
    const loc = ev.location != null ? locations.get(ev.location) : undefined;
    const vesselName =
      ev.vessel != null ? (vessels.find((v) => v.id === ev.vessel)?.name ?? null) : null;
    const title = loc
      ? `${loc.name.toUpperCase()}${loc.countryCode ? `, ${loc.countryCode}` : ''}`
      : (ev.description ?? `Event ${i + 1}`);
    return {
      id: `ev-${ev.order_id ?? i}`,
      title,
      description: ev.description ?? title,
      locationName: loc?.name ?? '—',
      countryCode: loc?.countryCode ?? '',
      date: ev.date ?? null,
      actual: Boolean(ev.actual),
      transportType: transportMode(ev.transport_type),
      vesselName,
      voyage: ev.voyage ?? null,
    };
  });
}

function mapSearatesWire(
  data: WireData,
  requestedContainer: string,
  fromSample: boolean,
): ContainerTrackResult | null {
  const locations = locMap(data.locations);
  const vessels = data.vessels ?? [];
  const want = requestedContainer.trim().toUpperCase();
  const container =
    (data.containers ?? []).find((c) => (c.number ?? '').toUpperCase() === want) ??
    (data.containers ?? [])[0];
  if (!container) return null;

  const polId = data.route?.pol?.location ?? null;
  const podId = data.route?.pod?.location ?? null;
  const pol = polId != null ? locations.get(polId) : undefined;
  const pod = podId != null ? locations.get(podId) : undefined;

  const path = formatRoutePath(data);
  if (path.length === 0 && pol?.lat != null && pol.lng != null && pod?.lat != null && pod.lng != null) {
    path.push({ lat: pol.lat, lng: pol.lng }, { lat: pod.lat, lng: pod.lng });
  }

  const free =
    container.demurrage?.free_days != null && container.demurrage.free_days !== ''
      ? String(container.demurrage.free_days)
      : 'TBA';
  const charged =
    container.demurrage?.days_in_charge != null && container.demurrage.days_in_charge !== ''
      ? String(container.demurrage.days_in_charge)
      : 'TBA';

  return {
    containerNo: (container.number ?? want).toUpperCase(),
    sizeType: container.size_type ?? '—',
    status: humanStatus(container.status ?? data.metadata?.status),
    carrierName: data.metadata?.sealine_name ?? data.metadata?.sealine ?? '—',
    carrierCode: data.metadata?.sealine ?? '',
    originName: pol?.name ?? '—',
    originCountry: pol?.countryCode ?? '',
    destinationName: pod?.name ?? '—',
    destinationCountry: pod?.countryCode ?? '',
    etd: data.route?.pol?.date ?? null,
    eta: data.route?.pod?.date ?? null,
    originLat: pol?.lat ?? null,
    originLng: pol?.lng ?? null,
    destinationLat: pod?.lat ?? null,
    destinationLng: pod?.lng ?? null,
    milestones: milestonesFrom(container, locations, vessels),
    vessel: pickVesselLeg(container, vessels, locations, data.route),
    routePath: path,
    demurrage: { freeDays: free, daysInCharge: charged },
    fromSample,
  };
}

/**
 * Pure mapper. Prefers LDB `responseData`, then SeaRates envelopes.
 */
export function mapTrackResponse(
  raw: unknown,
  requestedContainer: string,
  fromSample = false,
): ContainerTrackResult | null {
  const ldb = asLdbResponseData(raw);
  if (ldb) {
    const mapped = mapLdbResponseData(ldb, requestedContainer, fromSample);
    if (mapped) return mapped;
  }
  const data = unwrapTrackData(raw);
  if (!data) return null;
  return mapSearatesWire(data, requestedContainer, fromSample);
}
