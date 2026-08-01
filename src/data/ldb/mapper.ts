/**
 * Map LDB / SeaRates track wire JSON → ContainerTrackResult.
 *
 * LDB's `/apigateway/track/cntr/` surfaces SeaRates-shaped tracking (the public
 * UI lives under `/ldb/searate/…`). Payloads vary slightly (direct SeaRates
 * envelope vs nested `data`), so the mapper is defensive.
 */

import type {
  ContainerLocation,
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pull the SeaRates `data` object out of common LDB / SeaRates envelopes. */
export function unwrapTrackData(raw: unknown): WireData | null {
  const root = asRecord(raw);
  if (!root) return null;

  // SeaRates: { status, message, data: { … } }
  const level1 = asRecord(root.data) ?? root;
  if (level1.locations || level1.containers || level1.metadata) {
    return level1 as WireData;
  }
  // Some gateways nest again: { data: { data: { … } } }
  const level2 = asRecord(level1.data);
  if (level2 && (level2.locations || level2.containers || level2.metadata)) {
    return level2 as WireData;
  }
  return null;
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

function locMap(locations: WireLocation[] | undefined): Map<number, ContainerLocation> {
  const m = new Map<number, ContainerLocation>();
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

function placeLabel(loc: ContainerLocation | undefined): string {
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
  locations: Map<number, ContainerLocation>,
  route: WireData['route'],
): ContainerVesselLeg | null {
  const events = [...(container.events ?? [])].sort((a, b) => (a.order_id ?? 0) - (b.order_id ?? 0));
  const sea = events.filter((e) => e.vessel != null || transportMode(e.transport_type) === 'VESSEL');
  const withVessel = sea.find((e) => e.vessel != null) ?? sea[0];
  if (!withVessel && !route?.pol && !route?.pod) return null;

  const vesselId = withVessel?.vessel ?? null;
  const vesselName =
    vessels.find((v) => v.id === vesselId)?.name ??
    vessels[0]?.name ??
    '—';
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
  locations: Map<number, ContainerLocation>,
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

/**
 * Pure mapper. Returns null when the payload has no usable container payload.
 */
export function mapTrackResponse(
  raw: unknown,
  requestedContainer: string,
  fromSample = false,
): ContainerTrackResult | null {
  const data = unwrapTrackData(raw);
  if (!data) return null;

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
  // Fallback path: origin → destination when route_data is absent.
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
