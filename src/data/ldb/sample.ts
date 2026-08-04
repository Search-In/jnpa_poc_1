/**
 * Bundled demo track for CCLU7468361 — mirrors the NLDS / SeaRates UI the PoC
 * is modelled on (JNPT → Shanghai, OOCL / XIN SHANGHAI). Used ONLY for this
 * demo id when the live LDB gateway is unreachable — never stamped onto other
 * container numbers (that made every search look identical).
 */

import type { ContainerTrackResult } from './types';

/** The only container id that may receive the bundled offline sample. */
export const SAMPLE_CONTAINER_NO = 'CCLU7468361';

/** Approximate India → SE Asia → China sea path (lat, lng) for the sample map. */
const SAMPLE_PATH: Array<{ lat: number; lng: number }> = [
  { lat: 18.95, lng: 72.95 },
  { lat: 15.5, lng: 73.8 },
  { lat: 8.1, lng: 77.5 },
  { lat: 5.9, lng: 80.2 },
  { lat: 5.8, lng: 95.3 },
  { lat: 3.0, lng: 100.5 },
  { lat: 1.3, lng: 104.0 },
  { lat: 5.5, lng: 108.0 },
  { lat: 14.0, lng: 112.5 },
  { lat: 22.3, lng: 114.2 },
  { lat: 26.0, lng: 120.5 },
  { lat: 31.23, lng: 121.47 },
];

export function sampleContainerTrack(): ContainerTrackResult {
  const no = SAMPLE_CONTAINER_NO;
  return {
    containerNo: no,
    sizeType: "40' High Cube Dry",
    status: 'In-Transit',
    carrierName: 'Orient Overseas Container Line (OOCL)',
    carrierCode: 'OOLU',
    originName: 'Jawaharlal Nehru',
    originCountry: 'IN',
    destinationName: 'Shanghai',
    destinationCountry: 'CN',
    etd: '2026-08-03 01:00:00',
    eta: '2026-08-28 11:00:00',
    originLat: 18.95,
    originLng: 72.95,
    destinationLat: 31.23,
    destinationLng: 121.47,
    milestones: [
      {
        id: 'm6',
        title: 'ZHANGJIAGANG, CN',
        description: 'Arrival At Destination',
        locationName: 'Zhangjiagang',
        countryCode: 'CN',
        date: '2026-09-04 12:00:00',
        actual: false,
        transportType: 'VESSEL',
        vesselName: 'XIN SHANGHAI',
        voyage: '162E',
      },
      {
        id: 'm5',
        title: 'SHANGHAI, CN',
        description: 'Vessel arrival at final POD',
        locationName: 'Shanghai',
        countryCode: 'CN',
        date: '2026-08-28 11:00:00',
        actual: false,
        transportType: 'VESSEL',
        vesselName: 'XIN SHANGHAI',
        voyage: '162E',
      },
      {
        id: 'm4',
        title: 'JAWAHARLAL NEHRU, IN',
        description: 'Vessel departure from first POL',
        locationName: 'Jawaharlal Nehru',
        countryCode: 'IN',
        date: '2026-08-03 01:00:00',
        actual: true,
        transportType: 'VESSEL',
        vesselName: 'XIN SHANGHAI',
        voyage: '162E',
      },
      {
        id: 'm3',
        title: 'Container Received by Carrier',
        description: 'Container Received by Carrier',
        locationName: 'Jawaharlal Nehru',
        countryCode: 'IN',
        date: '2026-07-31 11:31:00',
        actual: true,
        transportType: 'TRUCK',
        vesselName: null,
        voyage: null,
      },
      {
        id: 'm2',
        title: 'Container pickup at shipper',
        description: 'Container pickup at shipper',
        locationName: 'Jawaharlal Nehru',
        countryCode: 'IN',
        date: '2026-07-29 06:00:00',
        actual: true,
        transportType: 'TRUCK',
        vesselName: null,
        voyage: null,
      },
      {
        id: 'm1',
        title: 'Empty Container to shipper',
        description: 'Empty Container to shipper',
        locationName: 'Jawaharlal Nehru',
        countryCode: 'IN',
        date: '2026-07-28 06:00:00',
        actual: true,
        transportType: 'TRUCK',
        vesselName: null,
        voyage: null,
      },
    ],
    vessel: {
      vessel: 'XIN SHANGHAI',
      voyage: '162E',
      loading: 'Jawaharlal Nehru, IN',
      etd: '2026-08-03 01:00:00',
      discharge: 'Shanghai, CN',
      eta: '2026-08-28 11:00:00',
    },
    routePath: SAMPLE_PATH,
    demurrage: { freeDays: 'TBA', daysInCharge: 'TBA' },
    fromSample: true,
  };
}
