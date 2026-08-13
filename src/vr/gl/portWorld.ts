/**
 * The port, as a three.js scene graph, built from the SAME surveyed geometry the
 * Esri scene uses — `portGeometry.ts` for the quays, channel and anchorages,
 * `positions.json` (via `placementStore`) for every crane, yard block and gate.
 *
 * There is no second model of the port here. Every coordinate comes from the
 * files the dashboard already draws from, so the walkthrough cannot drift away
 * from the twin; only the RENDERER is different.
 *
 * WHAT MAKES IT CHEAP, in the order that matters:
 *
 *  1. **One ground image, not a tile pyramid.** The imagery is a single
 *     `export` request for the port's bounding box, painted on one plane. On a
 *     3G link that is one round trip instead of dozens, and there is no LOD
 *     machinery paging tiles in and out as the camera moves.
 *  2. **Instanced meshes.** 60 yard blocks and 22 cranes are two draw calls, not
 *     82 — and the container stacks are one buffer, not 210 objects.
 *  3. **Flat ground.** JNPA is tidal flats; there is nothing for an elevation
 *     service to add, so there is no elevation service.
 *  4. **No globe.** A 12 km scene in a local metric frame needs none of the
 *     ECEF, origin-rebasing or horizon-culling work a world renderer carries.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ANCHORAGES,
  CHANNEL,
  PILOT_STATION,
  TERMINALS,
  TERMINAL_QUAYS,
  offsetMeters,
} from '@/map/portGeometry';
import { placementStore } from '@/map/placementStore';
import { tokens } from '@/theme/tokens';
import { WORLD_IMAGERY_URL } from '@/map/basemapFallback';
import { ORIGIN, SCENE_RADIUS_M, headingToYaw, headingToYawAlongX, toLocal } from './geo';

const MODELS = '/models';

/** Half-width of the imagery plane, degrees — the area the camera can reach. */
const GROUND_HALF_DEG = 0.09;

/** Pixels along the longest side of the single imagery request. */
const GROUND_TEXTURE_PX = 2048;

/** Deck height of the wharf above the imagery plane, metres. */
const DECK_H = 6;

/**
 * Height the water sits at when the tide is at its mean, metres.
 *
 * The imagery plane at y = 0 already depicts the sea, so the animated water is
 * a translucent surface a little above it. That offset is what keeps the tide
 * visible in both directions — at low water the surface drops toward the
 * imagery instead of vanishing beneath it — while the quay's 6 m wall still
 * stands clear above it at every state of tide.
 */
const WATER_BASE_Y = 1.6;

/** How far the surface may travel from `WATER_BASE_Y`, metres. */
export const WATER_SWING_M = 1.3;

/**
 * Where the water surface sits for a given tide.
 *
 * `waterSurfaceZ` is metres relative to mean tide, which can be negative; this
 * maps that onto the scene's visible band so the movement reads without the
 * surface ever sinking under the imagery.
 */
export function waterY(surfaceRelM: number): number {
  const swing = Math.max(-WATER_SWING_M, Math.min(WATER_SWING_M, surfaceRelM));
  return WATER_BASE_Y + swing;
}

/** Handles onto the parts of the scene that change while the demo runs. */
export interface PortWorld {
  scene: THREE.Scene;
  /** The sea surface, re-levelled with the tide. */
  water: THREE.Group;
  /** One crane per placement key, in `placementStore` order. */
  cranes: CraneHandle[];
  /** Slots for the live fleet, reused rather than reallocated. */
  hullPool: SceneInstance[];
  /** Fog, driven by visibility and weather. */
  fog: THREE.Fog;
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  dispose: () => void;
}

/**
 * One slot of an `InstancedMesh`, with an explicit API.
 *
 * An instance is a matrix in a shared buffer, not a node in the scene graph, so
 * there is no render-time traversal that would pick up a mutated `position`.
 * Writing the transform in one call keeps that honest — and folds the update
 * down to a single `setMatrixAt`, with nothing allocated per frame.
 */
export interface SceneInstance {
  /** Place it. Angles in radians; `yaw` is about +Y. */
  setPose: (x: number, y: number, z: number, yaw: number, pitch?: number, roll?: number) => void;
  /** Instances cannot be culled individually, so hiding is a zero-scale matrix. */
  setVisible: (visible: boolean) => void;
}

export interface CraneHandle {
  key: string;
  terminalId: string;
  /** The moving gantry — travels along the quay. */
  instance: SceneInstance;
  /** Home position, metres in the local frame. */
  home: THREE.Vector3;
  /** Direction the crane travels along the quay (unit, local frame). */
  along: THREE.Vector3;
  setTint: (hex: number | null) => void;
}

/** Aspect of the ground image: wider than tall, because the port is. */
const GROUND_ASPECT = 1.6;

/** The imagery bbox, centred on the port — the SAME centre `toLocal` uses. */
function groundBbox(): { west: number; south: number; east: number; north: number } {
  const d = GROUND_HALF_DEG;
  return {
    west: ORIGIN[0] - d * GROUND_ASPECT,
    south: ORIGIN[1] - d,
    east: ORIGIN[0] + d * GROUND_ASPECT,
    north: ORIGIN[1] + d,
  };
}

/**
 * The port's imagery as ONE request instead of a tile pyramid.
 *
 * A tiled basemap fetches dozens of tiles for the first frame and keeps paging
 * as the camera moves — the thing that made the Esri view crawl on 3G, twice
 * over in stereo. The whole port at 2048 px is a single ~730 KB JPEG, measured,
 * and once it is there the camera can go anywhere inside it for free.
 *
 * `px` is the long edge; a handset gets half the resolution, which is a quarter
 * of the bytes and indistinguishable through a cardboard lens.
 */
export function groundImageUrl(px: number = GROUND_TEXTURE_PX): string {
  const b = groundBbox();
  const params = new URLSearchParams({
    bbox: [b.west, b.south, b.east, b.north].join(','),
    bboxSR: '4326',
    imageSR: '4326',
    size: `${px},${Math.round(px / GROUND_ASPECT)}`,
    format: 'jpg',
    f: 'image',
  });
  return `${WORLD_IMAGERY_URL}/export?${params.toString()}`;
}

/** Extent of the ground plane in local metres, matching `groundImageUrl` exactly. */
export function groundExtent(): { halfX: number; halfZ: number } {
  const b = groundBbox();
  const sw = toLocal(b.west, b.south);
  const ne = toLocal(b.east, b.north);
  return { halfX: Math.abs(ne.x - sw.x) / 2, halfZ: Math.abs(ne.z - sw.z) / 2 };
}

/** A flat polygon at height `y` from a ring of [lng,lat]. */
function polygonMesh(ring: [number, number][], y: number, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape();
  ring.forEach(([lng, lat], i) => {
    const p = toLocal(lng, lat);
    if (i === 0) shape.moveTo(p.x, p.z);
    else shape.lineTo(p.x, p.z);
  });
  const geo = new THREE.ShapeGeometry(shape);
  // ShapeGeometry builds in the XY plane; lay it flat and face it up.
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = y;
  return mesh;
}

/** A flat ribbon of width `halfW` along a polyline of [lng,lat]. */
function ribbonMesh(
  path: [number, number][],
  halfW: number,
  y: number,
  material: THREE.Material
): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = toLocal(path[i][0], path[i][1]);
    const b = toLocal(path[i + 1][0], path[i + 1][1]);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * halfW;
    const nz = (dx / len) * halfW;
    const base = positions.length / 3;
    positions.push(
      a.x + nx, y, a.z + nz,
      a.x - nx, y, a.z - nz,
      b.x + nx, y, b.z + nz,
      b.x - nx, y, b.z - nz
    );
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

const hex = (css: string): number => new THREE.Color(css).getHex();

/**
 * Build the whole port.
 *
 * `onProgress` reports asset loading so the reveal gate can hold until the
 * scene is actually there rather than guessing.
 */
export function buildPortWorld(opts: {
  lowPower: boolean;
  includeYard: boolean;
  onProgress?: (done: number, total: number) => void;
}): PortWorld {
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // --- sky, light and haze ---------------------------------------------------
  // A daytime port. The Esri version got its sky from the globe's atmosphere;
  // here it is a clear-colour plus fog, which costs nothing and cannot be
  // switched off by accident into the black of space.
  const fog = new THREE.Fog(0x9fb4c7, 2_000, SCENE_RADIUS_M * 0.9);
  scene.fog = fog;
  scene.background = new THREE.Color(0x8fa6bd);

  const ambient = new THREE.HemisphereLight(0xdfeaf5, 0x5a6152, 1.15);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
  // Noon-ish at JNPA: high and a little to the south, matching the Esri scene's
  // fixed sun date so a rehearsed run looks the same in either renderer.
  sun.position.set(1200, 3000, 900);
  scene.add(sun);

  // --- ground: ONE imagery request ------------------------------------------
  const { halfX, halfZ } = groundExtent();
  const groundMat = track(
    new THREE.MeshLambertMaterial({ color: 0x687068, depthWrite: true })
  );
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(halfX * 2, halfZ * 2)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  // The bundled tone above is drawn immediately; the imagery replaces it when
  // it arrives, so there is never a white world — the same reasoning as the
  // Esri ground underlay, for one request instead of a pyramid.
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    // Half resolution on a handset: a quarter of the bytes, and through a
    // cardboard lens the difference is not visible.
    groundImageUrl(opts.lowPower ? GROUND_TEXTURE_PX / 2 : GROUND_TEXTURE_PX),
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = opts.lowPower ? 1 : 4;
      groundMat.map = tex;
      groundMat.color.set(0xffffff);
      groundMat.needsUpdate = true;
      track(tex);
    },
    undefined,
    () => {
      /* imagery unavailable — the bundled tone stays, which is the point of it */
    }
  );

  // --- water: the charted channel and anchorages -----------------------------
  // NOT a sheet over the whole scene. The imagery already shows where the water
  // is; what a sheet adds is a hard edge across the terminals and, once the tide
  // falls below chart datum, a surface that disappears under the imagery
  // entirely. So the water IS the charted geometry — the channel reaches and the
  // two anchorages — lifted and lowered as a group with the tide, which is the
  // part the viewer is meant to see.
  const waterMat = track(
    new THREE.MeshLambertMaterial({
      color: 0x1c5c94,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    })
  );
  const water = new THREE.Group();
  for (const seg of CHANNEL) water.add(ribbonMesh(seg.path, 150, 0, waterMat));
  for (const a of ANCHORAGES) water.add(polygonMesh(a.ring, 0, waterMat));
  water.position.y = WATER_BASE_Y;
  scene.add(water);

  // --- terminal decks + quay walls ------------------------------------------
  const deckMat = track(new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }));
  const quayMat = track(new THREE.MeshLambertMaterial({ color: 0x6f757b }));
  for (const t of TERMINALS) {
    const q = TERMINAL_QUAYS[t.id];
    if (!q) continue;
    const mid = toLocal(q.mid[0], q.mid[1]);
    // A wharf LIP, not a slab. An apron 320 m deep buries the imagery — and the
    // imagery is the terminal: the real yard, roads and buildings are already in
    // it. What the geometry has to add is the 6 m step the imagery cannot show,
    // so the quay reads as an edge you stand above rather than a painted line.
    const depth = 70;
    const deck = new THREE.Mesh(track(new THREE.BoxGeometry(q.lengthM, DECK_H, depth)), deckMat);
    const landCentre = offsetMeters(q.mid, q.landward, depth / 2);
    const lc = toLocal(landCentre[0], landCentre[1]);
    deck.position.set(lc.x, DECK_H / 2, lc.z);
    deck.rotation.y = headingToYawAlongX(q.bearingDeg);
    scene.add(deck);

    // A darker face on the waterline so the quay reads as an edge, not a step.
    const wall = new THREE.Mesh(track(new THREE.BoxGeometry(q.lengthM, DECK_H + 1, 8)), quayMat);
    wall.position.set(mid.x, (DECK_H + 1) / 2, mid.z);
    wall.rotation.y = headingToYawAlongX(q.bearingDeg);
    scene.add(wall);
  }

  // --- pilot station marker --------------------------------------------------
  const pilot = new THREE.Mesh(
    track(new THREE.CylinderGeometry(14, 14, 3, 12)),
    track(new THREE.MeshBasicMaterial({ color: hex(tokens.warn), transparent: true, opacity: 0.7 }))
  );
  const ps = toLocal(PILOT_STATION.lng, PILOT_STATION.lat);
  pilot.position.set(ps.x, 1.5, ps.z);
  scene.add(pilot);

  // --- glTF assets ------------------------------------------------------------
  const craneKeys = placementStore.keysOfKind('crane');
  const yardKeys = opts.includeYard ? placementStore.keysOfKind('yard') : [];
  const cranes: CraneHandle[] = [];
  const hullPool: SceneInstance[] = [];

  const gltf = new GLTFLoader();
  let done = 0;
  const total = 2;
  const step = () => opts.onProgress?.(++done, total);

  gltf.load(
    `${MODELS}/sts-crane.glb`,
    (asset) => {
      const geo = mergedGeometry(asset.scene, 68);
      if (!geo) return step();
      track(geo);
      const mat = track(new THREE.MeshLambertMaterial({ color: 0xc8ccd2 }));
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, craneKeys.length));
      // Per-instance colour is what lets a single draw call still show one crane
      // stopped and red while its neighbours keep working.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(Math.max(1, craneKeys.length) * 3).fill(1),
        3
      );
      mesh.frustumCulled = false;
      scene.add(mesh);

      let i = 0;
      for (const key of craneKeys) {
        const p = placementStore.get(key);
        if (!p) continue;
        const terminalId = key.split(':')[1];
        const q = TERMINAL_QUAYS[terminalId];
        const local = toLocal(p.lng, p.lat, DECK_H);
        const alongRad = ((q?.bearingDeg ?? 0) * Math.PI) / 180;
        const yaw = headingToYaw(p.heading ?? q?.bearingDeg ?? 0);
        const instance = makeInstance(mesh, i);
        instance.setPose(local.x, DECK_H, local.z, yaw);
        cranes.push({
          key,
          terminalId,
          instance,
          home: new THREE.Vector3(local.x, DECK_H, local.z),
          along: new THREE.Vector3(Math.sin(alongRad), 0, -Math.cos(alongRad)),
          setTint: instanceTinter(mesh, i),
        });
        i += 1;
      }
      mesh.count = i;
      step();
    },
    undefined,
    step
  );

  gltf.load(
    `${MODELS}/container-ship.glb`,
    (asset) => {
      const geo = mergedGeometry(asset.scene, 26);
      if (!geo) return step();
      track(geo);
      const mat = track(new THREE.MeshLambertMaterial({ color: 0xb4bcc4 }));
      // A fixed pool of instances: hulls are shown or hidden as the roster
      // changes, never allocated per frame.
      const mesh = new THREE.InstancedMesh(geo, mat, HULL_SLOTS);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(HULL_SLOTS * 3).fill(1),
        3
      );
      mesh.frustumCulled = false;
      mesh.count = HULL_SLOTS;
      scene.add(mesh);
      for (let i = 0; i < HULL_SLOTS; i++) {
        const instance = makeInstance(mesh, i);
        instance.setVisible(false);
        hullPool.push(instance);
      }
      step();
    },
    undefined,
    step
  );

  // Yard blocks: ONE instanced mesh for every container in the port.
  if (yardKeys.length) {
    gltf.load(`${MODELS}/yard-container-blue.glb`, (asset) => {
      const geo = firstGeometry(asset.scene);
      if (!geo) return;
      const scaled = geo.clone();
      scaled.computeBoundingBox();
      // Same trap as `mergedGeometry`: read before scaling, because `scale()`
      // rewrites the cached bounding box.
      const bb = scaled.boundingBox!;
      const minY = bb.min.y;
      const s = 5.8 / Math.max(0.001, bb.max.y - bb.min.y);
      scaled.scale(s, s, s);
      scaled.translate(0, -minY * s, 0);

      const mat = track(new THREE.MeshLambertMaterial({ color: 0x3f6f9f }));
      const mesh = new THREE.InstancedMesh(scaled, mat, yardKeys.length * 2);
      const m = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      const scaleV = new THREE.Vector3(1, 1, 1);
      let n = 0;
      for (const key of yardKeys) {
        const p = placementStore.get(key);
        if (!p) continue;
        const local = toLocal(p.lng, p.lat);
        quat.setFromEuler(new THREE.Euler(0, headingToYaw(p.heading ?? 0), 0));
        // Two tiers reads as a container yard from any distance a viewer
        // stands at, and it is one buffer either way.
        for (let tier = 0; tier < 2; tier++) {
          m.compose(new THREE.Vector3(local.x, tier * 5.8, local.z), quat, scaleV);
          mesh.setMatrixAt(n++, m);
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      track(scaled);
    });
  }

  return {
    scene,
    water,
    cranes,
    hullPool,
    fog,
    sun,
    ambient,
    dispose: () => {
      for (const d of disposables) d.dispose();
      scene.clear();
    },
  };
}

/**
 * Flatten a loaded glTF into ONE geometry, scaled to `heightM` and seated on
 * y = 0.
 *
 * WHY MERGE. The crane asset is about sixty separate meshes — a gantry, legs,
 * rails, a spreader, cables. Cloned as a hierarchy, 22 cranes is ~1,300 objects
 * and, measured, **796 draw calls per frame**. Draw calls are the binding
 * constraint on a mobile GPU, far more than triangles: this whole scene is only
 * 16k triangles, which a phone eats without noticing.
 *
 * Merged, a crane is one geometry, and 22 of them are one `InstancedMesh` — one
 * draw call. The cost is the model's own per-part materials, replaced by a
 * single colour. At the distance a viewer ever stands from a crane that reads
 * as the same object, and it is the difference between a slideshow and a scene.
 */
function mergedGeometry(root: THREE.Object3D, heightM: number): THREE.BufferGeometry | null {
  root.updateWorldMatrix(true, true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    // Merging requires an identical attribute set on every part; the glTF parts
    // vary (some carry tangents, colours, second UVs), so reduce to the three
    // attributes the material actually samples.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    parts.push(g.index ? g.toNonIndexed() : g);
  });
  if (!parts.length) return null;

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;

  merged.computeBoundingBox();
  // Read the numbers out BEFORE scaling. `BufferGeometry.scale()` goes through
  // `applyMatrix4`, which RECOMPUTES `boundingBox` in place when one is already
  // cached — so holding a reference to it and reading `min.y` afterwards gives
  // the post-scale value, and seating the model then applies the scale twice.
  // That is what left the hulls floating 900 m over the port and the yard 470 m
  // up, as specks in the sky.
  const bb = merged.boundingBox!;
  const minY = bb.min.y;
  const height = Math.max(0.001, bb.max.y - bb.min.y);
  const s = heightM / height;
  merged.scale(s, s, s);
  merged.translate(0, -minY * s, 0);
  merged.computeBoundingSphere();
  return merged;
}

/** The first mesh geometry in a loaded asset, for instancing. */
function firstGeometry(root: THREE.Object3D): THREE.BufferGeometry | null {
  let found: THREE.BufferGeometry | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
  });
  return found;
}

/** How many hulls the fleet pool can show at once. */
const HULL_SLOTS = 12;

/**
 * Bind one slot of an `InstancedMesh` to an explicit pose API.
 *
 * The scratch matrix, quaternion and vectors are created once per slot and
 * reused, so driving a whole fleet costs no allocation at all — the same rule
 * the Esri animator had to learn after a 2.5 GB crash.
 */
function makeInstance(mesh: THREE.InstancedMesh, index: number): SceneInstance {
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let visible = true;

  const write = () => {
    mesh.setMatrixAt(index, visible ? m : hidden);
    mesh.instanceMatrix.needsUpdate = true;
  };

  return {
    setPose(x, y, z, yaw, pitch = 0, roll = 0) {
      pos.set(x, y, z);
      euler.set(pitch, yaw, roll, 'YXZ');
      quat.setFromEuler(euler);
      m.compose(pos, quat, one);
      write();
    },
    setVisible(v) {
      if (visible === v) return;
      visible = v;
      write();
    },
  };
}

/**
 * Tint one instance, or restore it.
 *
 * `instanceColor` multiplies the material's own colour per instance, so a crane
 * turning red is a three-float write into a buffer — no material swap, no
 * shader recompile, and the whole layer is still one draw call.
 */
function instanceTinter(mesh: THREE.InstancedMesh, index: number): (hexColor: number | null) => void {
  const c = new THREE.Color();
  let current: number | null | undefined;
  return (hexColor) => {
    if (current === hexColor) return;
    current = hexColor;
    if (hexColor == null) c.setRGB(1, 1, 1);
    else c.setHex(hexColor);
    mesh.setColorAt(index, c);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
}
