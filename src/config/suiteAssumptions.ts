/**
 * Suite-wide data-provenance register (A-01..A-06) — the SINGLE numbered register
 * the Methodology deck (slide 6) shows, shared verbatim by all three PoCs
 * (UC-1/UC-2/UC-3). Canonical source: PoC/suite/assumptions.json. This is a typed
 * mirror kept in-app so UC-1 renders the same A-0x rows the deck promises and the
 * cross-domain scenario can cite them (e.g. "under A-01/A-03").
 *
 * NOTE: distinct from UC-1's local calibration ASSUMPTIONS (config/assumptions.ts)
 * — those are public reference figures the sim is tuned to; THESE are the shared
 * data-availability assumptions with their post-award replacements.
 */

export interface SuiteAssumption {
  id: string;
  assumption: string;
  basis: string;
  replacedBy: string;
  usedBy: string[];
}

export const SUITE_ASSUMPTIONS: SuiteAssumption[] = [
  {
    id: 'A-01',
    assumption: '5-day forward berthing plan is synthesised from published vessel-call profiles',
    basis: 'JNPA berthing plan is not a public dataset; Appendix C permits a justified assumption',
    replacedBy: 'JNPA HMS / FOCUS 2.0 berthing plan feed',
    usedBy: ['UC-1'],
  },
  {
    id: 'A-02',
    assumption: 'Vessel draft & static particulars taken from AIS static messages',
    basis: 'AIS Msg 5 is authoritative for declared draft; open feed available',
    replacedBy: 'VTS + Pilotage declared drafts',
    usedBy: ['UC-1'],
  },
  {
    id: 'A-03',
    assumption: 'Channel depth derived from published soundings + satellite-derived bathymetry',
    basis: 'JNPA bathymetric surveys not public; Copernicus/S2Shores permitted by Appendix C',
    replacedBy: 'JNPA periodic hydrographic sounding data',
    usedBy: ['UC-1'],
  },
  {
    id: 'A-04',
    assumption: 'TOS gate events (CODECO, EDI 315/322) replayed from schema-conformant synthetic streams',
    basis: 'Five terminals (NSICT, NSIGT, GTIPL, BMCT, NSFT) run distinct TOS; no bidder access pre-award',
    replacedBy: 'Per-terminal TOS feed via JNPA-facilitated access',
    usedBy: ['UC-2'],
  },
  {
    id: 'A-05',
    assumption: 'ANPR/OCR evaluated on public Indian-plate corpora under simulated dust/night conditions',
    basis: 'No JNPA camera access pre-award; ≥95% accuracy is the contractual target, not a measured claim',
    replacedBy: '250 new + 360 existing JNPA cameras',
    usedBy: ['UC-2', 'UC-3'],
  },
  {
    id: 'A-06',
    assumption: 'Road network congestion modelled on the port → Karal Phata corridor from OSM geometry',
    basis: 'Loop-detector history unavailable; corridor geometry is public',
    replacedBy: 'JNPA traffic counts + live ANPR',
    usedBy: ['UC-3'],
  },
];
