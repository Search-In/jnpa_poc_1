# Immersive port walkthrough — 3D & VR

A first-person view of the JNPA twin. You stand at a chosen point in the port and
watch the active what-if scenario play out around you, with every impacted asset
ringed and labelled in the scene.

**Where it appears.** A `Walkthrough` button in the dashboard header opens `#/vr`
in a new tab. It is a standalone route, like `#/simulator`.

---

## What it answers

This is the spec §B2.10 **WHERE** and **HOW** requirements rendered from inside
the port instead of from a top-down fly-to:

| Spec channel | In the walkthrough |
| --- | --- |
| **WHICH** factors are hit | The HUD's "Impacted assets" list, worst-first, each with range + bearing from where you stand |
| **WHERE** it lands | A ground ring on each impacted asset, a ring on every STS crane at an impacted terminal, and an auto-tour that flies you there |
| **HOW** it propagates | Dashed, mechanism-labelled edges between the causal chain's physical anchors, raised 55 m so they arc above the quays |
| Ambient state | Live tide / wind / sea / visibility / controlling depth in the top bar, with `PILOTAGE SUSPENDED` and `MOVEMENTS SUSPENDED` states called out |

---

## The scene reacts, not just the labels

The 3D objects themselves change state. Nothing here is decorative — an asset
only changes because the engine said its state changed (`src/vr/liveWorld.ts`,
all pure and unit-tested).

| What you see | Driven by |
| --- | --- |
| **Real rain, fog and cloud** rendered by the scene engine's own weather system | `visibilityNm` → fog, `rainMmHr` / `seaStateM` → rain + cloud. Visibility wins over rain, because visibility is what actually stops pilot transfer and the evaluator must SEE the stated reason |
| **Cranes gantry-travel** along the quay when working, and **stop dead and turn red** when their berth is out of service | `berthsOut`, berth `STATUS` |
| **Hulls make way** at their own SOG, or **stop and swing at anchor** with an ⚓ over them | `pilotageSuspended` / `movementsSuspended` |
| **Hulls float on the tide** and **heave, roll and pitch** with the sea running | live tide + `seaStateM` through a first-order seakeeping model |
| **Wakes** widen astern of every ship making way | SOG |
| **The sea rises and falls** over the channel and anchorages | live tide |

### Physics vs. glyphs

Motion that is cheap and honest to integrate **is** integrated: hulls make way at
their reported speed over ground, float on the live tide, and respond to the sea
state (roll ≈ 11 s period, pitch ≈ 7 s, heave ≈ 9 s, amplitudes scaled to
significant wave height and capped at what a laden box boat would actually see).

Motion that would need a real simulation — a crane hoist cycle, a mooring gang, a
pilot transfer — is represented by a **labelled icon at the right place on the
map** (`⬍` working crane, `⚠` blocked crane, `⚓` held ship) rather than faked in
3D. Inventing a hoist cycle time we do not have would be exactly the kind of
unsourced detail the integrity rules forbid.

### Cinematic auto-tour

On entering, the camera flies itself to each impacted asset **in the order the
disruption propagates** (the scenario's causal chain, not the impact list's own
ordering), with a lower-third caption naming the beat. Framing is per asset kind
— a berth is inspected from the apron, a channel reach from height, because the
thing that changed is a kilometre of water. The flight arcs upward through the
middle so the camera clears the cranes, and the tour loops so an unattended demo
keeps cycling the story.

Any manual look, walk or vantage choice **cancels** the tour — the operator is
never fighting the director for the camera. `▶/⏸ Auto-tour` toggles it.

Under `prefers-reduced-motion` the tour cuts between beats instead of flying, and
every animated asset holds still (the state colouring still reads).

---

## Modes

| Mode | What it is |
| --- | --- |
| **3D** | One `SceneView`, full screen. Drag to look, arrow keys / WASD to walk (hold Shift to stride), `Esc` to exit. |
| **VR** | **Two** `SceneView`s side by side sharing one `Map`, cameras separated by the interpupillary distance, driven by `deviceorientation`. This is the phone-in-a-cardboard-holder presentation; it also works fullscreen in a headset's own browser. |

### Head tracking (`useGyro.ts`)

Four things the naive `addEventListener('deviceorientation')` gets wrong, all
handled here — and the first one is usually the whole problem:

1. **Secure context.** Motion sensors are only exposed over HTTPS (or
   localhost). Opening the app on a phone via `http://192.168.x.x:5173` — the
   obvious thing to do — means the event *never fires*, with no error. That is
   detected up front and reported: run the dev server with `VITE_DEV_HTTPS=true`
   and use the `https://` address.
2. **Absolute vs relative.** Plain `deviceorientation` on Android is often
   relative: `alpha` drifts and the port slowly rotates away under you.
   `deviceorientationabsolute` is preferred, with the relative feed as fallback,
   and once the absolute feed is alive the relative one is ignored so the two
   cannot fight over the heading.
3. **iOS's compass.** Safari does not put true north in `alpha`; it supplies
   `webkitCompassHeading`, which overrides the derived heading when present.
4. **The permission gesture.** iOS 13+ gates the sensors behind
   `DeviceOrientationEvent.requestPermission()`, which must be called from a user
   gesture — hence the "Enable look-around" button.

A watchdog covers the last case: permission granted, listener attached, still no
readings. Rather than a frozen horizon you get a message saying so.

**The tour and your head do not fight.** With tracking live the tour is demoted
to moving you *between* beats while your head owns heading and tilt
(`setTourPose(pose, positionOnly)`), which is how a real headset behaves.
`setGyroLook` deliberately does not cancel the tour the way manual input does.

### Lens format

In stereo each eye is masked into a rounded "lens" with a black surround and a
soft vignette — the cardboard presentation. A real viewer's lens is round, so
the corners of a full rectangle are never visible anyway and only leak light
between the eyes.

This is a **mask, not optical pre-warp**. Correcting for lens pincushion would
need a post-process barrel-distortion shader over the SceneView's own canvas,
which the Esri renderer does not expose.

### Why not native WebXR

`SceneView` owns its WebGL context and exposes no hook to render into an
`XRWebGLLayer`, so an `immersive-vr` session cannot drive it. Rendering the port
in a separate WebXR engine would mean leaving the Esri stack, which requirement
**R-8** forbids ("feature layers/streams on the Esri stack — not iframes or
bolt-on canvases beside the map"), and would fork the geometry into a second
model that could drift from the twin.

So stereo is produced by two Esri views instead. `navigator.xr.isSessionSupported`
is still probed, and the setup screen reports the device's real capability rather
than implying a session that is never opened.

---

## Integrity — one story, two views

The walkthrough introduces **no new causal logic**. `impactModel.ts` delegates
every judgement to the existing engine, so the immersive view cannot contradict
the dashboard:

| Question | Delegated to |
| --- | --- |
| Is pilotage suspended? | `sim/derive.pilotageSuspended(weatherAt(...))` |
| Which channel segments are shut? | `sim/derive.channelSegmentsClosed()` |
| What is the controlling depth / UKC? | `sim/derive.controllingDepthM()`, `corridorUkc()` |
| Are movements suspended? | `sim/derive.incidentSuspendsMovements()` |
| Which berths are out? | `levers.berthsOut`, and berths read through `SimAdapter` |
| What is the causal chain? | `whatif/causalGraph` + `sim/scenarios[].chain` |
| Where is an asset? | `map/scene3d.asset3dPosition()` — the same resolver the 2D map and the dashboard's 3D ring use |

It is also strictly **read-only** on the simulator. It never bumps
`simStore.version` (that cascades a refetch through every dashboard panel); it
only calls `loadScenario` / `clearScenario` when the operator picks a scenario,
exactly as the dashboard does. Because the sim store broadcasts across tabs, a
scenario started in the dashboard is already running when you walk in.

---

## Placement

- **Click the map** on the setup screen to drop yourself anywhere.
- **Vantage points** — a berth apron and a crane cab per terminal, plus the VTS
  tower. All derived from the surveyed `data/positions.json` quay geometry, so a
  preset can never drift off the assets.
- **Eye height** 1–160 m, **facing** 0–359°.

---

## Files

| File | Role |
| --- | --- |
| `src/vr/impactModel.ts` | Pure: levers + clock + berths → impacted assets, labels, causal edges, environment |
| `src/vr/liveWorld.ts` | Pure: weather choice, water level, hold state, crane states, hull motion, seakeeping |
| `src/vr/cinematic.ts` | Pure: shot list from the causal chain, framing, easing, playback |
| `src/vr/stereo.ts` | Pure: IPD eye split, `deviceorientation` → heading/tilt, smoothing, walk, range/bearing |
| `src/vr/sceneAnim.ts` | The `requestAnimationFrame` loop: mutates the animated layers, applies weather |
| `src/vr/impactLayers.ts` | Esri `GraphicsLayer`s for rings, floating labels, mechanism-labelled edges |
| `src/vr/VrScene.tsx` | Mounts one or two `SceneView`s; drives cameras; pushes the impact model in |
| `src/vr/VrPage.tsx` | Setup screen + immersive HUD + tour director |
| `src/vr/PlacePicker.tsx` | Top-down `MapView` for planting the viewer |
| `src/vr/vrStore.ts` | Viewer pose + mode (separate from `useSimStore`) |
| `src/vr/useVrData.ts` | Read-only feed through `getAdapter()` |

`PortScene.tsx` and the rest of `src/map/` are **not modified** — the walkthrough
builds its own scene from the same pure layer builders. The only edits outside
`src/vr/` are the `#/vr` route in `main.tsx` and the header button in `App.tsx`.

---

## Notes & limits

- **The ArcGIS view stylesheet is imported by `VrScene.tsx`.** The rest of the app
  receives it as a side effect of instantiating Esri widgets (zoom, Legend,
  LayerList); this view has none (`ui.components: []`, so nothing floats inside
  an eye box), so it imports
  `@arcgis/core/assets/esri/themes/light/main.css` itself. Without it
  `.esri-view-root` is unstyled and the view collapses to its intrinsic canvas
  height instead of filling the eye box.
- **Stereo drops one quality tier** (`qualityProfile: 'medium'`, shadows off)
  because two views double the draw cost — the 45+ fps budget is per frame, not
  per view.
- **Severity is never carried by hue alone**: every ring is paired with a text
  label prefixed by a glyph (`▲` critical, `●` warning, `·` info), satisfying the
  CVD-safe rule in the edge-case register.
- **Vessels do not yet interpolate along a scenario timeline.** The engine has no
  per-timestep state history — it exposes instantaneous `Vessel` positions plus
  `BerthingPlanEntry` intervals. Vessels move with the existing mock stream and
  react to `extraArrivals`/spawn levers, but a scrubber-driven replay of a whole
  scenario would need a timeline model added to the engine first.
- **No ArcGIS API key is required**, here or anywhere else in the app. Esri's
  World_Imagery tiles and the Terrain3D elevation service both answer
  anonymously (verified: HTTP 200 with real tile bytes, no token), which is why
  the dashboard's 3D scene has always worked without one. The basemap and ground
  setup here is deliberately identical to `PortScene`'s. A blank ground in this
  view means tiles have not been fetched yet — most often because the tab is
  hidden and the render loop is stalled — not an auth failure.
- **Tour shots sit near the horizon (80–88° tilt), not top-down.** A steep shot
  fills the frame with ground and reads as a map rather than a place.
- **Gyro look-around needs a secure context.** `VITE_DEV_HTTPS=true` serves the
  dev server over https for phone testing; iOS additionally gates the sensors
  behind the "Enable look-around" button (a user gesture).
- **Fullscreen is requested from the click handler**, not from an effect. It
  needs a user gesture; asking after mount is outside the gesture and the
  browser refuses it silently — which is why the view never went fullscreen.
  Landscape is locked at the same moment for stereo, and a screen wake lock
  keeps the phone from dimming inside a holder nobody can reach into.

---

## PWA

The app is installable, which is what gives the walkthrough the whole screen
without browser chrome.

| File | Role |
| --- | --- |
| `public/manifest.webmanifest` | `display: fullscreen`, theme/background colour, maskable SVG icon, and shortcuts straight to `#/vr` and `#/simulator` |
| `public/icon.svg` | Single scalable icon (any + maskable), artwork inside the central 80% safe zone |
| `public/sw.js` | Service worker — installability plus an offline launch |
| `index.html` | Manifest link, theme colour, and the iOS-specific `apple-mobile-web-app-*` meta (iOS ignores the manifest's display mode) |

**The service worker is deliberately conservative.** This app reads a gateway, a
model service and Esri's tile CDN, and serving a stale berth plan or vessel
position from cache would be an integrity failure, not a feature. So only
same-origin built assets are cached (stale-while-revalidate; Vite content-hashes
them so builds never collide). Every `/api`, `/ml-api`, `/aishub-proxy` and
`/incois-proxy` call and every cross-origin request goes straight to the network.
Navigations are network-first and fall back to the cached shell only when the
network fails, so an offline launch opens instead of showing a browser error.

It registers in **production builds only** — in dev a worker caching the shell
fights Vite's HMR and serves stale modules, which looks exactly like a broken
build. Test it with `npm run build && npx vite preview`, not `npm run dev`.
- **Nothing in the frame loop allocates a graphic that outlives the frame.**
  This is the rule that keeps the walkthrough stable over a long session, and it
  was learned the hard way: an earlier version rebuilt the wake and glyph layers
  (`removeAll` + `addMany`) every frame, re-assigned each hull's glTF symbol 8×/s,
  and tore down and rebuilt the nine sea-surface polygons every time the tide
  moved 2 cm — which, with the sim clock running, is about twenty times a second.
  Together that churned thousands of `Graphic`, geometry, symbol and text-texture
  objects per second and grew the tab to ~2.5 GB before it froze and crashed.

  The rule now, for every animated layer: **geometry is written per frame**
  (cheap, and it is the thing that moves), **`visible` is toggled per frame**
  (free), and a **symbol is only touched when a discrete state changes** — a
  hull's held/running state, a crane's state, or the quantised sea band. Hull
  attitude (roll/pitch) therefore comes from `seaBand`/`staticHeel` rather than
  the instantaneous wave phase; continuous motion is carried by heave, which
  rides on the geometry. Verified: graphic counts stay pinned at 9/22/10/10/17
  across hundreds of frames and the heap oscillates in a ~70–78 MB band
  (rises and falls — GC reclaiming) instead of climbing.
- **The scene budgets itself by device** (`device.ts`), because stereo renders
  the whole port twice and a phone is not a demo laptop. On a low-power handset
  the walkthrough drops to `qualityProfile: 'low'`, turns shadows off, animates
  at 20 Hz instead of 30, and caps rain/fog *intensity* — never the weather TYPE,
  because the type is the evidence (fog is *why* pilotage stopped). Probes are
  capability-based (pointer type, cores, `deviceMemory`), not UA sniffing.
- **`atmosphereEnabled` is ALWAYS true — never a performance dial.** In a global
  scene the atmosphere *is* the sky: switching it off does not buy a cheaper sky,
  it gives you the black of space, and with `starsEnabled` defaulting on you get
  a starfield. That is exactly how an earlier mobile-perf pass turned the
  walkthrough into night. Stars are explicitly off; this is a daytime port.
- **Tile budget is where the mobile savings actually come from.** Three tile
  services normally feed this scene — imagery, the label overlay `hybrid` adds
  on top, and Terrain3D for the ground — and stereo requests from all three
  twice. On a low-power device the basemap drops to `satellite` (one service; a
  place label is unreadable through a cardboard lens anyway) and the ground goes
  flat (Terrain3D gone; JNPA is tidal flats with ~0 m relief). Verified: 2 base
  layers + 1 ground layer → **1 base layer + 0 ground layers**.
- **The sun is fixed at 2026-06-16T06:30Z = 12:00 noon IST at JNPA** — midday,
  deliberately. If the scene ever looks like night, check `atmosphereEnabled`
  before you touch the date.
- **Cloud cover is capped at 0.75.** The renderer draws near-total overcast as a
  BRIGHT dome, so a monsoon pushed toward 1.0 whites the sky out and reads as a
  broken view rather than a storm.
- **The animator and the tour director both run at 30 Hz** (20 Hz stereo on
  mobile), not display rate.
  A gantry crane at walking pace, a hull at 9 knots and a tide do not need 60
  updates a second, and halving the update rate leaves the remaining frame
  budget to the renderer — which is what the 45+ fps target actually measures.
- **glTF graphics are created once and mutated, never rebuilt.** Removing and
  re-adding an object graphic makes the renderer re-resolve the model resource;
  doing that at 60 Hz across 22 cranes and 10 hulls is a frame-budget disaster
  and can stop the models finishing their load at all. Position (including tidal
  heave) is a `.geometry` write every frame; the symbol — which carries roll and
  pitch — is refreshed at ~8 Hz, which is ample for an 11-second roll period.
  Flat geometry (wakes, water) and text (glyphs) are cheap and are rebuilt freely.
- **The animation pauses in a hidden tab**, because the browser stops
  `requestAnimationFrame` there. That is deliberate — an unattended walkthrough
  must not burn a core, and it satisfies the "no runaway CPU over a 30–45 minute
  run" QA item. It does mean an automated browser session (where the tab is never
  foregrounded) cannot drive the animation, so `startSceneAnimation` exposes a
  dev-only `window.__vrAnim.step(ts)` / `.counts()`, and `VrScene` exposes
  `window.__vrViews`. Both are behind `import.meta.env.DEV` and are verified
  absent from production bundles.
