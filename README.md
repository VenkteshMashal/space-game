# DRIFT — Belt operations

A playable 2.5D spaceflight game built with **Bun, TypeScript, Vite and Three.js**. Fly a working corvette through an asteroid field, recover three lost survey archives and return to Wayfarer station — or host a LAN deathmatch with breakable asteroids and guns.

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
| Space | Fire the cannon (multiplayer) |
| P | Pause or resume |
| M | Toggle the local system map |
| V | Toggle cinematic view |
| H | Open the flight manual |
| Tab | Scoreboard (multiplayer) |
| Mouse wheel / zoom buttons | Adjust camera zoom |

The **Kill velocity** button maintains a braking burn until you stop. The **burn limiter** controls the maximum thrust commanded by W. Mobile devices get hold-to-burn, brake and rotation controls. Navigation markers point toward a selected target when it is outside the viewport.

Collect each archive within **75 m** and below **12 m/s**. Dock at Wayfarer within **115 m** and below **8 m/s**. Docking repairs the hull and refills propellant. Deliver all three archives to finish the contract and record your best flight time locally.

## Ships and environment

- **Kestrel:** balanced independent corvette, 82 t dry mass.
- **Mule:** heavier salvage tug with larger propellant reserves and stronger armor.
- **Needle:** lighter reconnaissance cutter with higher acceleration and faster attitude control.

Switch ships in the shipyard to begin a new sortie. Ships, engine bells, armor, radiators, point defense housings, maneuvering jets, station and containers are built as 3D geometry. Asteroids and the distant moon use procedurally baked color and bump textures. Fonts ship locally; the game makes no third-party asset requests at runtime. Optional synthesized cabin audio is enabled with the speaker control.

## LAN multiplayer

```sh
bun run host      # builds, then serves the game and the match server on 0.0.0.0:8080
```

The host prints two addresses. Give other players the **LAN** one; they open it in a browser and land in the lobby. The host plays from `http://localhost:8080` like everyone else — hosting grants no advantage beyond the launch button.

- Pick a callsign, a team (Blue fleet, Red fleet, or Pirates) and a hull. Pirates are hostile to both fleets; the two fleets are hostile to each other and friendly within themselves.
- Loadout points are capped at **10** across hull, thrust, propellant and agility. The server sanitizes every loadout, so a tampered client is spent down to the budget rather than trusted.
- The host picks the arena (Drift Belt, The Quarry, Open Expanse) and launches once pilots are ready. **Tab** shows the scoreboard; **End match** returns everyone to the lobby with a debrief.
- Death is a five second respawn on your team's spawn point. The arena boundary pulls you back and tears the hull if you ignore it for too long.
- Matchmaking, accounts and persistence do not exist. A match runs until the host ends it.

Rocks are generated from the arena seed on every machine instead of being sent over the wire, so a match costs roughly 7 KB per snapshot. If a client and the host ever disagree about the field you will see invisible walls, which is why `tests/world.test.ts` guards that generation.

Windows Firewall prompts on the first launch. Allow Bun on private networks, or the other PCs cannot reach port 8080.

## Physics scope

The ship moves in a two-dimensional local inertial frame. A fixed **120 Hz** simulation integrates thrust, current wet mass, angular acceleration, propellant consumption and collision response. There is no linear drag or arbitrary velocity cap. Releasing thrust preserves velocity; turning the ship does not steer existing momentum. Attitude assist uses fuel to arrest rotation. Braking applies opposing force and consumes propellant.

This is a playable Newtonian salvage scenario inspired by hard science fiction. It does not model planetary orbital gravity, relativity, structural stresses, or weapon combat. The background moon and rocks behind the navigation plane are visual scenery. Planar asteroids use circular collision proxies, and ship models are enlarged for readability.

## Check and build

```sh
bun test
bun run build
bun run preview
```

`bun test` checks the physical invariants, the shared world simulation, determinism, weapons, fractures and loadout validation.

With the development server running, `bun run test:browser` checks actual WebGL rendering, keyboard thrust, coasting, rotation, braking, pause, map, assist, ship selection, zoom, cinematic mode and mobile input. `bun run test:mission` flies a whole sortie through ordinary keyboard events, recovers all three archives, docks and starts a fresh sortie. Both exercise the **single-player** path, so stop the host first: a client that finds a server on port 8080 joins the lobby instead.

With the host running, `bun run test:mp` opens three browsers against it and checks the lobby, host election, team picking, the host-only arena picker, loadout round trips, launch, three interpolated ships, an identical rock field on every client, local prediction, bullets over the wire, latency, the scoreboard, the debrief, and that one client leaving does not disturb the match.

The browser checks use the Chrome installation on this machine; adjust `executablePath` in `scripts/browser-check.mjs` and `scripts/mp-check.mjs` for another installation. Screenshots and results are written to `artifacts/`.

WebGL 2 is required. Enable browser hardware acceleration for smooth flight. The game pauses when its tab is hidden and while a dialog is open. Reduced-motion settings disable ambient object rotation and soften camera behavior.

## Source layout

| File | Purpose |
| --- | --- |
| `src/main.ts` | Flight HUD, input, mission, dialogs and main loop |
| `src/physics.ts` | Deterministic physics and interaction boundaries |
| `src/world.ts` | Shared multiplayer simulation, arenas and wire protocol |
| `src/net.ts` | WebSocket client, snapshot interpolation, local prediction |
| `src/lobby.ts` | Lobby dialog markup and handlers |
| `server.ts` | Headless host: static files, lobby, 120 Hz world, 30 Hz snapshots |
| `src/scene.ts` | Camera, lighting, rendering and navigation vectors |
| `src/models.ts` | Ship, asteroid, cargo and station geometry |
| `src/textures.ts` | Baked rocky surfaces and space backdrop |
| `src/audio.ts` | Synthesized cabin sound |
| `src/style.css` | Responsive flight deck and dialogs |
| `DESIGN.md` | Design direction and visual rationale |

Stack references: [Bun with Vite](https://bun.sh/guides/ecosystem/vite), [Three.js orthographic camera](https://threejs.org/docs/pages/OrthographicCamera.html), [Three.js physically based standard material](https://threejs.org/docs/pages/MeshStandardMaterial.html).
