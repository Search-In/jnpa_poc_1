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

**The arc flattens when your head is tracked** — 90 m on a monitor, 22 m in a
viewer (`sceneBudget.tourArcM`), and the idle drift on a held shot scales with
it. With the head tracked the inner ear reports standing still while the eyes
report a 90 m climb, and that disagreement is what makes people take a cardboard
headset off. The tour also **does not start until the scene has been revealed**:
a director flying the camera over a port that has not arrived is pointless, and
it keeps the basemap permanently streaming tiles for viewpoints it has already
left.

---

## Modes

| Mode | What it is |
| --- | --- |
| **3D** | Full screen, one camera. Drag to look, arrow keys / WASD to walk (hold Shift to stride), `Esc` to exit. |
| **VR** | Side-by-side stereo — two viewport passes over ONE canvas, cameras separated by the interpupillary distance, driven by `deviceorientation`. This is the phone-in-a-cardboard-holder presentation; it also works fullscreen in a headset's own browser. |

Both are drawn by the WebGL renderer described under **The renderer** below.
The Esri two-`SceneView` implementation is still in the tree behind
`?renderer=esri`.

### Field of view — why it used to look "zoomed in"

`Camera.fov` in ArcGIS is the **diagonal** field of view and defaults to
**55°** (verified in `@arcgis/core/Camera.js`; the diagonal→horizontal
conversion is `views/3d/webgl-engine/lib/fov.js`,
`fovd2fovx(d,w,h) = 2·atan(w·tan(d/2)/√(w²+h²))`).

55° diagonal is right for a map you look **at**. It is badly wrong for a scene
you look **through**. A cardboard viewer's lens presents roughly 80° of
horizontal field to each eye, so rendering at 55° hands the eye a world
magnified about 2× with none of the peripheral context the brain uses to accept
a stereo pair as a place — felt as "everything is zoomed in", and a documented
cause of viewer discomfort.

So the FOV is derived from the optics instead (`sceneBudget.stereoFovDeg`):

```
tan(diag/2) = √( tan(halfX)² + (tan(halfX)/aspect)² )      halfX = 40°
```

On a 20:9 handset held landscape each eye box is 1200 × 1080, giving **≈97°
diagonal** — which is what the lens is actually showing. Mono 3D uses 80°: wider
than the ArcGIS default because a first-person view needs the peripheral cues,
narrower than cardboard because a monitor at desk distance subtends far less
than a lens 40 mm from your eye.

Two consequences worth knowing:

- **The FOV must be written on every camera assignment.** `view.camera = {…}`
  *replaces* the camera object, so omitting `fov` silently restores 55° and the
  world snaps back to telephoto on the next head movement.
- **Both eyes must carry the same FOV.** A mismatch is not a subtle rendering
  difference; it is two different projections of one scene, which the brain
  cannot fuse.

The control strip carries a live `−  97° FOV  +` trim (click the number to
return to the derived default) because viewers differ and an operator with the
thing on their face is a better judge than a spec sheet.

### Head tracking (`useGyro.ts`, `headTracking.ts`, `oneEuro.ts`)

Five things the naive `addEventListener('deviceorientation')` gets wrong, all
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

5. **Rate-independent smoothing.** This is the one that made tracking feel
   "odd". The old filter blended each reading in at a fixed weight, which forces
   one compromise between two opposite requirements — heavy enough to kill the
   sensor's ±0.6° tremble at rest, light enough not to lag a head turn — and it
   cannot satisfy both. Worse, a fixed weight is applied *per event*, and
   `deviceorientation` fires anywhere between 15 Hz and 60 Hz depending on the
   handset, the battery saver and how busy the main thread is. The same setting
   therefore produced different smoothing on different phones, and different
   smoothing second to second on one phone under thermal throttling.

   It is replaced by a **1€ filter** (Casiez, Roussel & Vogel, CHI 2012), which
   estimates the signal's speed and widens its own cutoff with it — heavy when
   you hold still, nearly transparent when you turn — over the *measured*
   interval, so the behaviour is the same at 15 Hz and 60 Hz. Heading is
   unwrapped before filtering and re-wrapped after, so 359° → 1° is a 2° move
   rather than a −358° lurch. A capped, motion-gated one-frame prediction
   cancels the render pipeline's own lag.

   Measured against a synthetic phone (`gyroTrack.test.ts`), 0.6° of sensor
   noise:

   | | now | before |
   | --- | --- | --- |
   | residual jitter, head still | **0.035°** | 0.097° |
   | lag at 90°/s, sampling 60 Hz | **1.13°** | 1.2° |
   | lag at 90°/s, sampling 20 Hz | **1.08°** | 3.5° |
   | lag at 25°/s, sampling 60 Hz | **1.29°** | — |

   The last row of the middle two is the point: the lag no longer depends on how
   fast the phone happens to be sampling.

A watchdog covers the permission case: granted, listener attached, still no
readings. Rather than a frozen horizon you get a message saying so.

**Readings are published once per animation frame.** The sensor fires up to 60
times a second; the scene draws 20–30 in stereo on a phone. Applying a camera
per reading queued two or three pose changes for every frame actually drawn, all
but the last discarded, paid for out of the same main-thread budget the renderer
was already short of. Filtering happens at sensor rate (the filter wants every
sample); publishing is coalesced to `requestAnimationFrame`
(`frameCoalesce.ts`), which also guarantees both eyes are written from one pose
in one task.

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
| `src/vr/stereo.ts` | Pure: IPD eye split, `deviceorientation` → heading/tilt, walk, range/bearing |
| `src/vr/oneEuro.ts` | Pure: 1€ adaptive filter, wrap-aware angle filter, motion-gated prediction |
| `src/vr/headTracking.ts` | Pure: one `deviceorientation` reading → a filtered look direction |
| `src/vr/sceneBudget.ts` | Pure: device + link profile → every quality, scenery, tile and FOV decision |
| `src/vr/warmup.ts` | Pure + fetch: the model catalogue, its byte cost, and the priority-ordered prefetch |
| `src/vr/vrBasemap.ts` | Imagery over a bundled ground underlay — one tile service, never a white world |
| `src/vr/viewReady.ts` | The reveal gate: waits on the asset layer views, with a deadline |
| `src/vr/sceneBoot.ts` | Pure: the eye-startup ordering (sequential on a thin link, parallel otherwise) |
| `src/vr/frameCoalesce.ts` | One camera write per drawn frame, from two independent producers |
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

- **The ArcGIS view stylesheet is injected by `useEsriViewStylesheet`.** The rest
  of the app receives it as a side effect of instantiating Esri widgets (zoom,
  Legend, LayerList); this view has none (`ui.components: []`, so nothing floats
  inside an eye box), so it asks for the stylesheet itself — as a ref-counted
  `<link>`, not a module import, which would go global and restyle the
  dashboard. Without it `.esri-view-root` is unstyled and the view collapses to
  its intrinsic canvas height instead of filling the eye box.
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
  the dashboard's 3D scene has always worked without one. A blank ground in this
  view means tiles have not been fetched yet — most often because the tab is
  hidden and the render loop is stalled — not an auth failure. Since the ground
  underlay was added there should be no white-ground state at all.
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

## The renderer

The immersive view is drawn by **one WebGL canvas** (`src/vr/gl/`), not by Esri
SceneViews. `?renderer=esri` — before the hash or inside it — puts the old path
back for an instant A/B on a real device.

### Why it was changed

Stereo on two `SceneView`s means two WebGL contexts, two copies of every mesh
and texture, two tile pyramids and two render loops. Measured on an emulated
iQOO Neo 7 (8 cores, 8 GB, dpr 3, 800×360 landscape) with 6× CPU throttling,
in VR mode:

| | Esri · two SceneViews | WebGL · one canvas |
| --- | --- | --- |
| mean frame rate | **2.6 fps** | **118.8 fps** |
| median frame | 392 ms | 8.3 ms |
| frames over 100 ms | **97.3%** | **0%** |
| WebGL contexts | 2 | 1 |
| draw calls / frame | — | 20 |
| JS heap, in scene | ~157 MB | **~51 MB** |

That first column is the freezing. It is not a tuning problem — the architecture
spends the whole budget twice.

### What makes it cheap

1. **One canvas, two viewport passes.** Stereo is a scissor rect and a second
   `render()` inside the same frame: a little under 2× the fragment cost and
   *nothing* extra in memory, uploads or state. The two eyes are the same
   instant of the same world, so left/right desync is not fixed — it is
   impossible.
2. **One ground image, not a tile pyramid.** The whole port is a single
   `export` request (~730 KB, measured) painted on one plane. One round trip
   instead of dozens, and no LOD machinery paging tiles as the camera moves.
3. **Merged, instanced geometry.** The crane asset is ~60 separate meshes; 22 of
   them cloned is ~1,300 objects and **796 draw calls**. Merged into one
   geometry and instanced, the whole crane fleet is *one* draw call, with
   per-instance colour so a blocked crane still turns red. Same for hulls and
   the yard. Total: **20 draw calls**. Draw calls, not triangles, are what binds
   a mobile GPU — the scene is only ~475k triangles.
4. **A local metric frame.** 12 km of port in flat local metres needs none of
   the ECEF, origin-rebasing or horizon culling a globe renderer carries. At
   this scale it is also *more* accurate: flat-earth error is under a metre.

### What is shared with the Esri path

Everything above the renderer: the same `impactModel`, `liveWorld`, `cinematic`,
`vrStore`, `useGyro`, `sceneBudget` and `useVrData`. This swaps a renderer, not
a feature — which is why the walkthrough still cannot contradict the dashboard.
The port geometry comes from the same `portGeometry.ts` and `positions.json`, so
there is no second model of JNPA.

### Two traps worth remembering

- **`BufferGeometry.scale()` rewrites the cached bounding box.** It routes
  through `applyMatrix4`, which recomputes `boundingBox` when one exists. Read
  `min.y` out *before* scaling; holding the reference and reading afterwards
  applies the scale twice and floats the model. That put the hulls 900 m over
  the port and the yard 470 m up, visible as specks in the sky.
- **Two rotation conventions, a quarter turn apart.** `headingToYaw` turns a
  −Z-facing glTF model to a bearing; `headingToYawAlongX` turns a `BoxGeometry`
  whose long axis is +X. A quay is the second kind. Using the first laid every
  wharf across the water at right angles to where it belongs.

---

## Performance and the network

Every quality, scenery, tile and camera decision is made in one pure function,
`sceneBudget(profile, stereo)`, from a measured `DeviceProfile` (pointer type,
cores, `deviceMemory`, `navigator.connection.effectiveType`, `saveData`). That
is what makes it testable — `sceneBudget.test.ts` walks the whole device ×
network matrix — rather than scattered through `VrScene`.

There are **two independent bottlenecks** and they need different levers.

### The frame budget

Stereo renders the whole port twice, on a phone, at `devicePixelRatio` 3.

| Lever | Where it bites |
| --- | --- |
| **Render scale** — the SceneView gets a 0.6-size container, CSS-scaled back up | 36% of the pixels. The biggest single win. Aspect ratio is preserved, because the FOV is derived from it. |
| **Yard thinning** — `definitionExpression: 'tier <= 0'` | 60 blocks × 2–5 tiers ≈ **210 glTF instances → 60**, and in stereo every one was loaded and drawn twice. |
| **Truck queues dropped** | 25 more instances, 50 in stereo, carrying no what-if state. |
| **Shadows off** as soon as a second view exists | The most expensive lighting option. |
| **20 Hz animation / 20 Hz tour** on a handset | Nothing here — a gantry crane at walking pace, a hull at 9 knots, a tide — needs 60 updates a second. |
| **One camera write per drawn frame** | The head tracker and the tour director both move the camera; coalescing to `rAF` removes two thirds of the writes and keeps the eyes in step. |

**Never** on that list: `atmosphereEnabled`. In a global SceneView the
atmosphere *is* the sky — switching it off does not buy a cheaper sky, it buys
the black of space, and `starsEnabled` defaults on, which is what once turned
the walkthrough into night on mobile.

### The link

On 3G a phone gets roughly 40–60 KB/s with a 200 ms round trip, and the scene
wants ~1.2 MB of glTF before it reads as JNPA — `sts-crane.glb` alone is 542 KB.

- **A bundled ground underlay** (`vrBasemap.ts`) — one flat estuarine-toned
  polygon as the first base layer, so the ground is a plausible colour from the
  first frame and the imagery paints over it as it streams. Zero requests. It is
  not a substitute for imagery; it is what stops the *absence* of imagery
  reading as a broken view.
- **One tile service.** The dashboard's `'hybrid'` adds a reference service for
  place names, and `ground: 'world-elevation'` adds Terrain3D — three services,
  each fetched by each eye. The label overlay is dropped unconditionally (labels
  are screen-space, so in a first-person scene they hang in the sky, and through
  a lens they are unreadable); Terrain3D is dropped on a constrained link, JNPA
  being tidal flats with ~0 m of relief.
- **Model warm-up during setup** (`warmup.ts`). The setup screen is dead time —
  a dropdown and two buttons — so the models are fetched then, in priority order
  (cranes and hulls, the assets a scenario *changes*, before the scenery), one
  at a time.
- **Sequential eye startup** (`sceneBoot.ts`). Two SceneViews resolve their own
  meshes and share only the HTTP cache. Started together on a thin pipe they
  interleave requests for the *same* bytes, both finish late, and they finish at
  *different times* — which is exactly "the left side renders later than the
  right". Starting the second once the first has drawn makes its fetches cache
  hits.
- **A reveal gate.** Neither eye is shown until both have their assets, so the
  viewer never watches the port assemble itself at two different rates. It waits
  on the asset **layer views**, not on `view.updating` — that is permanently
  true here, because the animator rewrites geometry 20×/s and the tour keeps the
  camera moving. There is always a deadline; a walkthrough that refuses to start
  with the phone already in the holder is worse than one that starts
  half-textured, and a badge says which happened.

Modelled on a fair-share 3G link over the real byte counts
(`slowNetwork.test.ts`):

| | before | now |
| --- | --- | --- |
| bytes over the link, stereo cold start | 2.4 MB (fetched twice) | **1.2 MB** |
| wait after pressing Enter, warm | ~48 s | **~0 s** (warmed during setup) |
| wait after pressing Enter, cold | ~48 s | **~26 s** |
| crane mesh arrives at | ~24 s | **~11 s** |

**Concurrency is 1 on a constrained link, and that is deliberate.** Everything
in flight shares the same bytes per second, so N parallel fetches all finish
together — late — and the priority order stops meaning anything. Measured: at
*two* in flight the 542 KB crane was requested first and still arrived after the
26 KB gate mesh. Serialising costs one round trip per asset, about 5% of the
total, to halve the wait for the asset the viewer is there to see.

**Deployment note.** `deploy/nginx.conf` now caches `*.glb` for 30 days. Without
it the meshes are served uncacheable and the whole 1.2 MB is re-fetched on every
entry into the immersive view. Not `immutable`, unlike the content-hashed
bundles: these keep their filenames across builds. The service worker also holds
them (same-origin, cache-first), so the *second* run opens instantly.

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
- **Tile budget.** Three tile services normally feed this scene — imagery, the
  label overlay `hybrid` adds on top, and Terrain3D for the ground — and stereo
  requests from all three twice. On a low-power device the basemap drops to
  `satellite` (one service; a place label is unreadable through a cardboard lens
  anyway) and the ground goes flat (Terrain3D gone; JNPA is tidal flats with
  ~0 m relief). Verified: 2 base layers + 1 ground layer → **1 base layer +
  0 ground layers**.
- **Scenery budget — the biggest single cost.** The yard is 60 blocks stacked
  2–5 containers high: **210 glTF instances**, every one of them loaded and drawn
  twice in stereo, once per view. That is what made a phone crawl, and because
  each view resolves its own copies it is also why one eye finished before the
  other. On a low-power device the yard is thinned to its bottom tier via
  `definitionExpression: 'tier <= 0'` (**210 → 60, 71% fewer**; it still reads as
  a container yard from any distance a viewer stands at) and the truck queues are
  dropped. Nothing that answers WHICH/WHERE/HOW is touched — cranes, berths,
  channel and hulls all stay.
- **Render scale.** The SceneView is handed a container at 62% linear size and
  CSS-scaled back up, so it rasterises **38% of the pixels** per eye. Measured on
  a stereo eye box at devicePixelRatio 2: 934×970 device px instead of
  1506×1566. Through a cardboard lens — already soft and magnified — the
  difference is not visible. The lens mask lives on a wrapper OUTSIDE the scaled
  subtree, or the transform would magnify the mask too and the eyes would stop
  matching.
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
