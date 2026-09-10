# DRIFT — Belt operations

A playable 2.5D spaceflight game built with **Bun, TypeScript, Vite and Three.js**. Fly a working corvette through an asteroid field, recover three lost survey archives and return to Wayfarer station.

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

## Fly

| Control | Action |
| --- | --- |
| W / S or ↑ / ↓ | Main drive / reverse thrusters |
| A / D or ← / → | Rotate the ship |
| Q / E | Strafe left / right |
| Shift + W | Hard burn; increases fuel use and drive heat |
| X | Hold to brake with RCS |
| F | Toggle attitude assist |
| R | Recover nearby cargo or dock |
| Space | Pause or resume |
| M | Toggle the local system map |
| V | Toggle cinematic view |
| H | Open the flight manual |
| Mouse wheel / zoom buttons | Adjust camera zoom |

The **Kill velocity** button maintains a braking burn until you stop. The **burn limiter** controls the maximum thrust commanded by W. Mobile devices get hold-to-burn, brake and rotation controls. Navigation markers point toward a selected target when it is outside the viewport.

Collect each archive within **75 m** and below **12 m/s**. Dock at Wayfarer within **115 m** and below **8 m/s**. Docking repairs the hull and refills propellant. Deliver all three archives to finish the contract and record your best flight time locally.

## Ships and environment

- **Kestrel:** balanced independent corvette, 82 t dry mass.
- **Mule:** heavier salvage tug with larger propellant reserves and stronger armor.
- **Needle:** lighter reconnaissance cutter with higher acceleration and faster attitude control.

Switch ships in the shipyard to begin a new sortie. Ships, engine bells, armor, radiators, point defense housings, maneuvering jets, station and containers are built as 3D geometry. Asteroids and the distant moon use procedurally baked color and bump textures. Fonts ship locally; the game makes no third-party asset requests at runtime. Optional synthesized cabin audio is enabled with the speaker control.

## Physics scope

The ship moves in a two-dimensional local inertial frame. A fixed **120 Hz** simulation integrates thrust, current wet mass, angular acceleration, propellant consumption and collision response. There is no linear drag or arbitrary velocity cap. Releasing thrust preserves velocity; turning the ship does not steer existing momentum. Attitude assist uses fuel to arrest rotation. Braking applies opposing force and consumes propellant.

This is a playable Newtonian salvage scenario inspired by hard science fiction. It does not model planetary orbital gravity, relativity, structural stresses, or weapon combat. The background moon and rocks behind the navigation plane are visual scenery. Planar asteroids use circular collision proxies, and ship models are enlarged for readability.

## Check and build

```sh
bun test
bun run build
bun run preview
```

`bun test` checks the physical invariants and collision/recovery boundaries. With the development server running, `bun run test:browser` checks actual WebGL rendering, keyboard thrust, coasting, rotation, braking, pause, map, assist, ship selection, zoom, cinematic mode and mobile input. The browser check uses the Chrome installation on this machine; adjust `executablePath` in `scripts/browser-check.mjs` for another installation. Screenshots and results are written to `artifacts/`.

`bun run test:mission` flies an entire sortie through ordinary keyboard events, recovers all three archives, docks, checks the completion screen and starts a fresh sortie. It uses a separate test pilot; the game contains no automatic flight controller or writable test hooks.

WebGL 2 is required. Enable browser hardware acceleration for smooth flight. The game pauses when its tab is hidden and while a dialog is open. Reduced-motion settings disable ambient object rotation and soften camera behavior.

## Source layout

| File | Purpose |
| --- | --- |
| `src/main.ts` | Flight HUD, input, mission, dialogs and main loop |
| `src/physics.ts` | Deterministic physics and interaction boundaries |
| `src/scene.ts` | Camera, lighting, rendering and navigation vectors |
| `src/models.ts` | Ship, asteroid, cargo and station geometry |
| `src/textures.ts` | Baked rocky surfaces and space backdrop |
| `src/audio.ts` | Synthesized cabin sound |
| `src/style.css` | Responsive flight deck and dialogs |
| `DESIGN.md` | Design direction and visual rationale |

Stack references: [Bun with Vite](https://bun.sh/guides/ecosystem/vite), [Three.js orthographic camera](https://threejs.org/docs/pages/OrthographicCamera.html), [Three.js physically based standard material](https://threejs.org/docs/pages/MeshStandardMaterial.html).
