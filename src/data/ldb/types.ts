/**
 * Domain model for NLDS / LDB container tracking (SeaRates-shaped payload under
 * `/apigateway/track/cntr/`). Wire types stay in mapper.ts; UI consumes these.
 */

export type ContainerTransportMode = 'TRUCK' | 'VESSEL' | 'RAIL' | 'OTHER';

export interface ContainerLocation {
  id: number;
  name: string;
  countryCode: string;
  lat: number | null;
  lng: number | null;
}

export interface ContainerMilestone {
  id: string;
  title: string;
  description: string;
  locationName: string;
  countryCode: string;
  date: string | null;
  actual: boolean;
  transportType: ContainerTransportMode;
  vesselName: string | null;
  voyage: string | null;
}

export interface ContainerVesselLeg {
  vessel: string;
  voyage: string;
  loading: string;
  etd: string | null;
  discharge: string;
  eta: string | null;
}

export interface ContainerRoutePoint {
  lat: number;
  lng: number;
}

export interface ContainerTrackResult {
  containerNo: string;
  sizeType: string;
  status: string;
  carrierName: string;
  carrierCode: string;
  originName: string;
  originCountry: string;
  destinationName: string;
  destinationCountry: string;
  etd: string | null;
  eta: string | null;
  originLat: number | null;
  originLng: number | null;
  destinationLat: number | null;
  destinationLng: number | null;
  milestones: ContainerMilestone[];
  vessel: ContainerVesselLeg | null;
  routePath: ContainerRoutePoint[];
  demurrage: {
    freeDays: string;
    daysInCharge: string;
  };
}
