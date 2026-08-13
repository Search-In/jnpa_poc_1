/**
 * The stereo rig: ONE canvas, ONE scene, ONE renderer, drawn twice.
 *
 * WHY THIS IS THE WHOLE FIX. The Esri version mounted two `SceneView`s. Each one
 * owns a separate WebGL context, a separate copy of every texture and mesh, a
 * separate tile cache and a separate render loop — so a phone paid for the port
 * twice and the two halves finished at different times. Measured on a throttled
 * handset profile that came out at **3.9 fps**, with 98.6% of frames over 100 ms.
 *
 * Here the scene graph, the GPU buffers and the frame are shared. Stereo is two
 * viewport passes inside one `requestAnimationFrame`: set the scissor to the
 * left half, draw with the left camera, set it to the right half, draw with the
 * right. That is a little under 2× the fragment cost of mono and *nothing*
 * extra in memory, uploads or state — and the two eyes are, by construction,
 * the same instant of the same world. The desync is not fixed; it is made
 * impossible.
 *
 * The rig owns no port content. It takes a scene and a pose and draws it.
 */
import * as THREE from 'three';
import { eyeCameras, type EyeCamera, type ViewerPose } from '../stereo';
import { toLocal } from './geo';

/** Convert ArcGIS's DIAGONAL field of view to the VERTICAL one three.js wants. */
export function diagonalToVerticalFov(diagonalDeg: number, width: number, height: number): number {
  // Esri's own conversion, from `views/3d/webgl-engine/lib/fov.js`:
  //   fovd2fovy(d, w, h) = 2·atan( h · tan(d/2) / √(w² + h²) )
  // Keeping the same formula means the WebGL walkthrough frames the port
  // identically to the Esri one at the same `fovDeg`, so the number the
  // operator trims in the HUD keeps meaning the same thing.
  const rad = (diagonalDeg * Math.PI) / 180;
  const denom = Math.hypot(Math.max(1, width), Math.max(1, height));
  return (2 * Math.atan((Math.max(1, height) * Math.tan(rad / 2)) / denom) * 180) / Math.PI;
}

/** Black bar between the lenses, CSS pixels — matches the Esri presentation. */
export const LENS_GUTTER_PX = 6;

export interface RigOptions {
  canvas: HTMLCanvasElement;
  /** Fraction of the device's pixels to rasterise. */
  renderScale: number;
  /** Cap on device pixel ratio; a phone at 3 is mostly wasted through a lens. */
  maxPixelRatio: number;
  antialias: boolean;
}

export class StereoRig {
  readonly renderer: THREE.WebGLRenderer;
  private readonly left = new THREE.PerspectiveCamera(60, 1, 1, 40_000);
  private readonly right = new THREE.PerspectiveCamera(60, 1, 1, 40_000);
  private readonly mono = new THREE.PerspectiveCamera(60, 1, 1, 40_000);
  private width = 1;
  private height = 1;

  constructor(private readonly opts: RigOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: opts.antialias,
      // The scene is opaque; skipping the alpha channel saves a per-pixel blend
      // over the whole screen, twice per frame in stereo.
      alpha: false,
      powerPreference: 'high-performance',
      // Nothing reads the buffer back, and preserving it forces the driver to
      // keep a second copy.
      preserveDrawingBuffer: false,
      stencil: false,
    });
    this.renderer.setClearColor(0x8fa6bd, 1);
    this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = false;
  }

  /** Resize to the container. Call on mount and on every layout change. */
  setSize(cssWidth: number, cssHeight: number): void {
    this.width = Math.max(1, Math.floor(cssWidth));
    this.height = Math.max(1, Math.floor(cssHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio) * this.opts.renderScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
  }

  /**
   * Draw one frame.
   *
   * In stereo the two passes share every GPU resource and every uniform upload
   * that is not view-dependent, which is why this is well under twice the cost
   * of mono rather than exactly twice.
   */
  render(scene: THREE.Scene, pose: ViewerPose, opts: { stereo: boolean; ipdM: number; fovDeg: number }): void {
    this.renderer.info.reset();
    const gl = this.renderer;

    if (!opts.stereo) {
      const aspect = this.width / this.height;
      applyPose(this.mono, pose, opts.fovDeg, aspect, this.width, this.height);
      gl.setScissorTest(false);
      gl.setViewport(0, 0, this.width, this.height);
      gl.render(scene, this.mono);
      return;
    }

    const half = Math.floor((this.width - LENS_GUTTER_PX) / 2);
    const aspect = half / this.height;
    const { left, right } = eyeCameras(pose, opts.ipdM, opts.fovDeg);
    applyPose(this.left, left, opts.fovDeg, aspect, half, this.height);
    applyPose(this.right, right, opts.fovDeg, aspect, half, this.height);

    gl.setScissorTest(true);
    gl.setViewport(0, 0, half, this.height);
    gl.setScissor(0, 0, half, this.height);
    gl.render(scene, this.left);

    const x = half + LENS_GUTTER_PX;
    gl.setViewport(x, 0, half, this.height);
    gl.setScissor(x, 0, half, this.height);
    gl.render(scene, this.right);
  }

  /** Draw-call and triangle counts for the last frame — the perf ground truth. */
  info(): { calls: number; triangles: number; programs: number; textures: number; geometries: number } {
    const m = this.renderer.info;
    return {
      calls: m.render.calls,
      triangles: m.render.triangles,
      programs: m.programs?.length ?? 0,
      textures: m.memory.textures,
      geometries: m.memory.geometries,
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

/** Any pose shape carrying a position and a look direction. */
type PoseLike = ViewerPose | EyeCamera;

function applyPose(
  camera: THREE.PerspectiveCamera,
  pose: PoseLike,
  fovDeg: number,
  aspect: number,
  width: number,
  height: number
): void {
  const p = 'position' in pose ? pose.position : pose;
  const local = toLocal(p.longitude, p.latitude, p.z);
  camera.position.set(local.x, local.y, local.z);

  camera.fov = diagonalToVerticalFov(fovDeg, width, height);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  // ArcGIS tilt: 0 = straight down, 90 = horizon, 180 = straight up. three.js
  // wants a look-at target, so the tilt is turned back into a direction rather
  // than composed as Euler angles — which is what keeps the two renderers
  // agreeing on where "level" is.
  const headingRad = (pose.heading * Math.PI) / 180;
  const pitchRad = ((pose.tilt - 90) * Math.PI) / 180;
  const horiz = Math.cos(pitchRad);
  camera.up.set(0, 1, 0);
  camera.lookAt(
    local.x + Math.sin(headingRad) * horiz * 100,
    local.y + Math.sin(pitchRad) * 100,
    local.z - Math.cos(headingRad) * horiz * 100
  );
}
