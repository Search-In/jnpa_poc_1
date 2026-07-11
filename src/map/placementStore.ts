/**
 * placementStore — 3D-asset position overrides, seeded from the committed
 * `data/positions.json` and editable by dragging assets in the SceneView.
 *
 * Ported from the UC-2 (PoC_2) placement system so UC-1 shares the SAME surveyed
 * JNPA geography: `data/positions.json` carries the real-world lng/lat (and
 * optional heading) of each terminal's berthed vessel and reference assets, keyed
 * by a stable placement key (`vessel:BMCT`, `terminal:NSICT`, `pilot:PBG`, …).
 * The file is imported at BUILD TIME as the seed, so the scene opens with every
 * asset already on its real spot.
 *
 * Persistence model (source of truth = the committed JSON, not the browser):
 * edits live in memory for the session; "Export" downloads the updated
 * positions.json, "Import" previews one, "Reset" reverts to the seed. Commit the
 * exported file to make an edit permanent — no hidden localStorage state.
 */
import seededPlacements from '../../data/positions.json';

export interface Placement {
  lng: number;
  lat: number;
  /** Optional heading (deg true) if the asset was rotated. */
  heading?: number;
  /** Optional traced polyline of [lng,lat] waypoints (routes/channel edits). */
  path?: [number, number][];
}

export interface PlacementFile {
  version: 1;
  note?: string;
  placements: Record<string, Placement>;
}

type Listener = () => void;

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6; // ~0.1 m precision
}

/**
 * Validate + normalise a parsed positions.json. Tolerant: a malformed entry is
 * skipped, not thrown — the scene falls back to derived positions for any key it
 * can't read.
 */
function readPlacementFile(file: unknown): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  const f = file as Partial<PlacementFile> | null;
  if (!f || f.version !== 1 || typeof f.placements !== 'object' || f.placements == null) return out;
  for (const [k, v] of Object.entries(f.placements)) {
    if (v && typeof v.lng === 'number' && typeof v.lat === 'number') {
      const path = Array.isArray((v as Placement).path)
        ? (v as Placement)
            .path!.filter(
              (pt): pt is [number, number] =>
                Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number',
            )
            .map((pt) => [round(pt[0]), round(pt[1])] as [number, number])
        : undefined;
      out[k] = {
        lng: round(v.lng),
        lat: round(v.lat),
        ...(v.heading != null ? { heading: round(v.heading) } : {}),
        ...(path && path.length ? { path } : {}),
      };
    }
  }
  return out;
}

class PlacementStore {
  private map = new Map<string, Placement>();
  private listeners = new Set<Listener>();
  private readonly seed: Record<string, Placement>;

  constructor() {
    this.seed = readPlacementFile(seededPlacements as unknown);
    for (const [k, v] of Object.entries(this.seed)) this.map.set(k, v);
  }

  get(key: string): Placement | undefined {
    return this.map.get(key);
  }
  all(): Record<string, Placement> {
    return Object.fromEntries(this.map);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  count(): number {
    return this.map.size;
  }
  /** All keys of a given kind prefix (e.g. "vessel", "terminal"). */
  keysOfKind(kind: string): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(`${kind}:`));
  }

  set(key: string, p: Placement): void {
    this.map.set(key, {
      lng: round(p.lng),
      lat: round(p.lat),
      ...(p.heading != null ? { heading: Math.round(p.heading) } : {}),
      ...(p.path && p.path.length ? { path: p.path.map((pt) => [round(pt[0]), round(pt[1])] as [number, number]) } : {}),
    });
    this.emit();
  }

  setHeading(key: string, heading: number, base: [number, number]): void {
    const cur = this.map.get(key);
    const lng = cur?.lng ?? base[0];
    const lat = cur?.lat ?? base[1];
    this.set(key, { lng, lat, heading: ((heading % 360) + 360) % 360 });
  }

  nudge(key: string, dir: 'N' | 'S' | 'E' | 'W', metres: number, base: [number, number]): void {
    const cur = this.map.get(key);
    const lng = cur?.lng ?? base[0];
    const lat = cur?.lat ?? base[1];
    const dLat = metres / 110_574;
    const dLng = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
    const next = {
      N: { lng, lat: lat + dLat },
      S: { lng, lat: lat - dLat },
      E: { lng: lng + dLng, lat },
      W: { lng: lng - dLng, lat },
    }[dir];
    this.set(key, { ...next, ...(cur?.heading != null ? { heading: cur.heading } : {}) });
  }

  remove(key: string): void {
    if (this.map.delete(key)) this.emit();
  }

  resetKey(key: string): void {
    const s = this.seed[key];
    if (s) this.map.set(key, { ...s });
    else this.map.delete(key);
    this.emit();
  }

  clear(): void {
    this.map = new Map(Object.entries(this.seed).map(([k, v]) => [k, { ...v }]));
    this.emit();
  }

  loadJSON(file: PlacementFile): void {
    const placements = readPlacementFile(file);
    for (const [k, v] of Object.entries(placements)) this.map.set(k, v);
    this.emit();
  }

  toJSON(note?: string): PlacementFile {
    return { version: 1, note, placements: this.all() };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

/** Singleton shared by the scene builders and the edit UI. */
export const placementStore = new PlacementStore();

/** Prompt the user to pick a positions.json and load it (preview before commit). */
export function importPlacements(): Promise<number> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result)) as PlacementFile;
          const n = Object.keys(readPlacementFile(parsed)).length;
          if (n === 0) return reject(new Error('No valid placements in file'));
          placementStore.loadJSON(parsed);
          resolve(n);
        } catch (e) {
          reject(e instanceof Error ? e : new Error('Invalid JSON'));
        }
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    };
    input.click();
  });
}

/** Trigger a browser download of the current placements as positions.json. */
export function downloadPlacements(note?: string): void {
  const data = JSON.stringify(placementStore.toJSON(note), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'positions.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
