# DRIFT — Belt operations

A playable 2.5D spaceflight game built with **Bun, TypeScript, Vite and Three.js**. Fly a working corvette through a 5.2 × 4.2 km asteroid field, pull the last telemetry from a dead survey relay, resolve and recover three flight archives, dock at Wayfarer station — and pick up the black box still aboard the wreck of Kite’s End if you want the bonus.

## Run locally

```sh
bun install
bun run dev
```

Open the local URL printed by Vite, normally http://127.0.0.1:5173.

On this Windows machine, Bun is installed at `C:\Users\venkteshmashal\.bun\bin\bun.exe`. If your shell does not include Bun in its PATH, use:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" install
& "$env:USERPROFILE\.bun\bin\bun.exe" run dev
```

## Startup sequence

1. **Title.** Animated wordmark over the live belt, with your best flight time. Any key or click continues.
2. **Hangar.** Your ship on a lit turntable: pick Kestrel, Mule or Needle from the bay strip, read the contract brief and the ship’s handling figures, set a call sign, then launch.
3. **Launch.** A camera pull from a close inspection of the hull to the flight framing, with the contract card. Any key or click skips it — control is handed over at the end.

`Esc` in the hangar returns to the title. In flight, pause (`Space`) offers resume, return to hangar and the manual.

## Fly

| Control | Action |
| --- | --- |
| W / S or ↑ / ↓ | Main drive / reverse thrusters |
| A / D or ← / → | Rotate the ship |
| Q / E | Strafe left / right |
| Shift + W | Hard burn; increases fuel use and drive heat |
| X | Hold to brake with RCS |
| F | Toggle attitude assist |
| R | Scan, recover or dock |
| Space | Pause or resume |
| M | Toggle the sector chart |
| V | Toggle cinematic view |
| H | Open the flight manual |
| Mouse wheel / zoom buttons | Adjust camera scale (`1.40×` default; the chart has its own scale) |

The **Kill velocity** button maintains a braking burn until you stop. The **burn limiter** controls the maximum thrust commanded by W. On phones the instruments collapse to the screen edges and hold-to-burn, brake and rotation pads sit under each thumb.

### Contract SR–084, staged

1. **Relay telemetry.** Reach the Nereid relay and hold station inside 145 m at under 22 m/s. The download resolves the three archive contacts on your chart — before that they are simply unresolved contacts.
2. **Resolve and recover.** Each archive must first be resolved: hold inside 130 m at under 26 m/s until the scan completes. Then close inside 75 m, slow under 12 m/s and press R to bring it aboard.
3. **Optional salvage.** The wreck of Kite’s End still carries its black box: hold inside 125 m, then recover it for 4,200 credits on top of the contract.
4. **Dock.** Wayfarer accepts approach inside 115 m at under 8 m/s. Docking repairs the hull and refills propellant at any point in the sortie.

The contract pays 3,200 credits per archive plus 2,800 on delivery — 16,600 credits for a perfect run. Best flight time is recorded locally.

## Ships and environment

- **Kestrel:** balanced independent corvette, 82 t dry mass, 1.66 g.
- **Mule:** heavier salvage tug with larger propellant reserves and stronger armor.
- **Needle:** lighter reconnaissance cutter with higher acceleration and faster attitude control.

Ships, engine bells, armor, radiators, point defense housings, maneuvering jets, station, relay buoy, derelict hulk and cargo containers are built as 3D geometry. Asteroids and the distant moon use procedurally baked color and bump textures. Fonts ship locally; the game makes no third-party asset requests at runtime. Optional synthesized cabin audio is enabled with the speaker control.

The flight HUD stays deliberately sparse: contract card top-left, vessel card and sector radar on the right rail, flight instruments along the bottom, and one contextual prompt when an action is available. Marker labels clamp to the viewport edge and flip inward so they never land under a panel.

## Physics scope

The ship moves in a two-dimensional local inertial frame. A fixed **120 Hz** simulation integrates thrust, current wet mass, angular acceleration, propellant consumption and collision response. There is no linear drag or arbitrary velocity cap. Releasing thrust preserves velocity; turning the ship does not steer existing momentum. Attitude assist uses fuel to arrest rotation. Braking applies opposing force and consumes propellant. Collisions shake the camera, spark and cost hull; below 45% the hull vents.

This is a playable Newtonian salvage scenario inspired by hard science fiction. It does not model planetary orbital gravity, relativity, structural stresses, or weapon combat. The background moon and rocks behind the navigation plane are visual scenery. Planar asteroids use circular collision proxies, and ship models are enlarged for readability.

## Check and build

```sh
bun test
bun run build
bun run preview
```

`bun test` checks the physical invariants, collision/recovery boundaries and the staged mission rules (relay gating, scan decay, recovery gating, optional salvage, docking payout). With the development server running, `bun run test:browser` drives the real startup flow — title, hangar, launch — then checks actual WebGL rendering, keyboard thrust, coasting, rotation, braking, pause, sector chart, radar, assist, ship selection, zoom, cinematic mode and mobile input. The browser check uses the Chrome installation on this machine; adjust `executablePath` in `scripts/browser-check.mjs` for another installation. Screenshots and results are written to `artifacts/`.

`bun run test:mission` flies an entire sortie through ordinary keyboard events: relay download, three scanned archives, the optional black box, station dock, the completion screen and a relaunch from the hangar. It uses a separate test pilot; the game contains no automatic flight controller or writable test hooks.

WebGL 2 is required. Enable browser hardware acceleration for smooth flight. The game pauses when its tab is hidden and while a dialog is open. Reduced-motion settings disable ambient rotation, camera shake and HUD entrances.

## Source layout

| File | Purpose |
| --- | --- |
| `src/main.ts` | Startup flow, flight HUD, input, mission handling, dialogs and main loop |
| `src/physics.ts` | Deterministic physics, world constants, interaction boundaries |
| `src/mission.ts` | Contract stages, scan specs, recovery and payout rules |
| `src/scene.ts` | Camera modes, lighting, chart camera, navigation vectors and effects |
| `src/effects.ts` | Particle plumes, sparks, venting gas and shockwave rings |
| `src/radar.ts` | Canvas sector radar and chart projection |
| `src/hangar.ts` | Live 3D ship bay used by the hangar screen and the shipyard dialog |
| `src/models.ts` | Ship, asteroid, cargo, station, relay and derelict geometry |
| `src/textures.ts` | Baked rocky surfaces and space backdrop |
| `src/audio.ts` | Synthesized cabin sound |
| `src/style.css` | Responsive flight deck, startup flow and dialogs |
| `DESIGN.md` | Design direction and visual rationale |

Stack references: [Bun with Vite](https://bun.sh/guides/ecosystem/vite), [Three.js orthographic camera](https://threejs.org/docs/pages/OrthographicCamera.html), [Three.js physically based standard material](https://threejs.org/docs/pages/MeshStandardMaterial.html).
