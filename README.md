# DRIFT — Belt operations

A playable 2.5D spaceflight game built with **Bun, TypeScript, Vite and Three.js**. Fly a working corvette through a 5.2 × 4.2 km asteroid field: take contracts off Wayfarer's board, break rock for the refinery, clear raiders off a wreck, run a timed survey — and assemble your own hull in the shipyard when the stock three stop being enough.

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

## The flight deck

Flight is flown from marks, not panels. A hairline **bearing ring** sits around the ship: the velocity vector as an ivory notch, the selected target as an amber caret with its range, hostiles as coral ticks that lengthen as they close, contacts and ore as small dots, and the bottom arc as the drive — it fills with thrust, empties counter-clockwise on retro and turns coral with heat. The contract line and its progress rule sit top-left, the session clock and status dot top-right, hull, propellant, heat and hold as four thin bars bottom-left, guns and the two always-true numerals bottom-right, velocity and one contextual line under the ship. Readouts have three weights — dormant, live and critical — and take them from the value, so a nominal flight is nearly bare glass. The sector chart is a map-mode instrument (); the stage list lives in the pause screen () and the hangar brief.

## Startup sequence

1. **Title.** Animated wordmark over the live belt, with your best time on the first contract and your credit balance. Any key or click continues.
2. **Hangar.** Your ship on a lit turntable, the contract board under it and the selected job's brief, danger rating, pay, bonus and stage plan beside it. Pick a vessel, pick a contract, set a call sign, launch.
3. **Launch.** A camera pull from a close inspection of the hull to the flight framing, with the contract card. Any key or click skips it — control is handed over at the end.

`Esc` in the hangar returns to the title. In flight, `Esc` pauses and offers resume, return to hangar and the manual.

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
| Space | Fire the guns; resumes when paused |
| C / right mouse | Mining cutter |
| Esc | Pause or resume |
| M | Toggle the sector chart |
| V | Toggle cinematic view |
| H | Open the flight manual |
| Mouse wheel / zoom buttons | Adjust camera scale (`1.40×` default; the chart has its own scale) |

Open the pause screen (`Esc`) for the thrust limiter, the full stage list and the key guide.

Turrets follow the mouse inside their arc. The **Kill velocity** button maintains a braking burn until you stop. The **burn limiter** controls the maximum thrust commanded by W. On phones the instruments collapse to the screen edges and hold-to-burn, brake, fire and rotation pads sit under each thumb.

## Contracts

The board opens with **SR-084 — Ghosts in the belt** (salvage, 2,800 cr + 4,200 bonus) and **MN-210 — Quota run** (mining, 5,200 cr). Clearing SR-084 unlocks **BT-047 — Nest at Kite's End** (combat, 9,400 cr) and **SV-119 — Blackout survey** (timed survey, 7,100 cr, seven-minute window); clearing BT-047 unlocks **EC-005 — Walk the hauler home** (escort, 11,800 cr + 3,200 for an intact barge).

- **SR-084.** Hold station inside 145 m under 22 m/s to pull the relay telemetry. That resolves three archive contacts: resolve each one inside 130 m under 26 m/s, then close inside 75 m and press R. Scavengers arrive with the archives. The wreck of Kite's End still carries its black box — 125 m scan, then recover it — but only after the relay is awake.
- **MN-210.** Break eight rocks over 26 m across and collect 420 units of ore, then dock and unload. The refinery pays 4 cr per unit on top of the contract, and a full 700-unit hold earns the bonus.
- **BT-047.** Close to 700 m of the wreck, then destroy seven hostiles — turrets, raiders and interceptors.
- **SV-119.** Hold at three drop points, each under 14 m/s, with mines seeded around the first and interceptors waiting at the third, then dock before the window closes. Let the window lapse and the contract fails.
- **EC-005.** The ore barge Ceres Run is slow, unarmed and cannot dodge. Two flights of raiders are waiting on her route; stay with her, shoot them off, and see her inside 400 m of Wayfarer. Lose the barge and the contract fails with her; bring her in above 60% hull for the bonus.

Danger pips, pay and the bonus are on every card; locked work names the contract that opens it.

## Ships, shipyard and economy

- **Kestrel:** balanced independent corvette, 82 t dry mass, 1.66 g.
- **Mule:** heavier salvage tug with larger propellant reserves and stronger armor.
- **Needle:** lighter reconnaissance cutter with higher acceleration and faster attitude control.

The shipyard assembles a custom hull from three cores (Spar, Truss, Keel), twenty-four hardpoints and seventeen parts — engines, tanks, guns, ore pods, ablative tiles, radiator wings, RCS quads, a survey mast and an ore collector. Click a socket on the hull, fit a part, watch mass, thrust, acceleration, attitude authority, propellant, hull, hold size and cost move. Mirrored sockets take a pair. A build that cannot move, turn or carry propellant refuses to launch. Parts cost credits and are owned once bought: your starting 6,000 cr buys a workable first frame, not a good one.

Money in: contract payments, bonus objectives, ore sold on docking at 4 cr per unit and bounties for hostiles — bounties and ore bank **at the dock**, not at the kill. Money out: parts and cores. Profile, credits, owned parts, builds and best times persist in `localStorage` under a validated schema; `SR–084` written with an en-dash is migrated to `SR-084`.

## Ships and environment

- **Kestrel:** balanced independent corvette, 82 t dry mass, 1.66 g.
- **Mule:** heavier salvage tug with larger propellant reserves and stronger armor.
- **Needle:** lighter reconnaissance cutter with higher acceleration and faster attitude control.

Ships, engine bells, armor, radiators, point defense housings, maneuvering jets, station, relay buoy, derelict hulk and cargo containers are built as 3D geometry. Asteroids and the distant moon use procedurally baked color and bump textures. Fonts ship locally; the game makes no third-party asset requests at runtime. Optional synthesized cabin audio is enabled with the speaker control.

The flight HUD stays deliberately sparse: contract card top-left, vessel card and sector radar on the right rail, flight instruments along the bottom, and one contextual prompt when an action is available. Marker labels clamp to the viewport edge and flip inward so they never land under a panel.

## Physics scope

The ship moves in a two-dimensional local inertial frame. A fixed **120 Hz** simulation integrates thrust, current wet mass, angular acceleration, propellant consumption and collision response. There is no linear drag or arbitrary velocity cap. Releasing thrust preserves velocity; turning the ship does not steer existing momentum. Attitude assist uses fuel to arrest rotation. Braking applies opposing force and consumes propellant. Collisions shake the camera, spark and cost hull; below 45% the hull vents.

This is a playable Newtonian salvage and combat scenario inspired by hard science fiction. It does not model planetary orbital gravity, relativity or structural stresses. The background moon and rocks behind the navigation plane are visual scenery. Planar asteroids use circular collision proxies, ships collide as measured hull boxes, and ship models are enlarged for readability.

## Check and build

```sh
bun test
bun run build
bun run preview
```

`bun test` checks the physical invariants, collision and solid-body boundaries, weapon and ore behaviour, shipyard derivation and validation, the contract objective system and the profile's trust boundary. With the development server running, `bun run test:browser` drives the real startup flow — title, hangar, launch — then checks actual WebGL rendering, keyboard thrust, coasting, rotation, braking, pause, sector chart, radar, assist, ship selection, zoom, cinematic mode, the shipyard (socket picking, purchases, refusals, saving and flying a custom hull) and mobile input. The browser check uses the Chrome installation on this machine; adjust `executablePath` in `scripts/browser-check.mjs` for another installation. Screenshots and results are written to `artifacts/`.

`bun run test:mission` flies all of SR-084 through ordinary keyboard events: relay download, three scanned archives, the optional black box, station dock, the completion screen and a relaunch from the hangar. It uses a separate test pilot; the game contains no automatic flight controller or writable test hooks.

WebGL 2 is required. Enable browser hardware acceleration for smooth flight. The game pauses when its tab is hidden and while a dialog is open. Reduced-motion settings disable ambient rotation, camera shake and HUD entrances.

## Source layout

The fleet now uses three separate silhouettes: an armored Kestrel corvette, a four-engine Mule cargo tug, and a narrow Needle interceptor. Static hull plates are batched by material; gun barrels point along the firing axis, recoil follows cooldown, and exhaust stays anchored to stock and custom engine nozzles. Collision bounds are measured from the fitted hull, excluding exhaust effects.

Weapons resolve the first impact along their full movement segment. Player shots hit enemies, enemy shots can damage escorts, and the Swarm rack fires guided missiles. Selected threats show hull integrity and weapon range, with a visible hit confirmation. Ships also collide with one another using relative velocity and mass.

The shipyard offers Balanced, Mining, and Combat starter fits with prices shown before purchase. Owned components can be reused; each missing core or part is purchased once. Saved drafts remain editable, and only valid, owned builds can launch. Survey masts shorten archive scans; collectors extend ore pickup range. Mining quotas count ore collected across station unloads, so smaller holds can make multiple trips.

Survey holds remain complete on the return journey, bounty contracts count approach kills, and escort completion requires the living barge to reach Wayfarer and the pilot to dock. Relaunch restores the asteroid field and cargo models. The debrief pays each bonus once.

| File | Purpose |
| --- | --- |
| `src/main.ts` | Startup flow, flight HUD, contract board, input, dialogs and main loop |
| `src/physics.ts` | Deterministic physics, world constants, interaction boundaries |
| `src/contracts.ts` | Contracts as data, objective evaluation, navigation suggestions |
| `src/combat.ts` | Weapon catalogue, round pool, hostile kinds and their AI |
| `src/parts.ts` | Cores, hardpoints and the part catalogue |
| `src/build.ts` | Build derivation, validation and model assembly |
| `src/builder.ts` | The shipyard screen: socket picking, refits and the stat column |
| `src/save.ts` | The validated `localStorage` profile and the economy |
| `src/collar.ts` | The bearing ring: velocity, targets, hostiles, contacts and the drive arc |
| `src/scene.ts` | Camera modes, lighting, chart camera, navigation vectors and effects |
| `src/effects.ts` | Particle plumes, sparks, venting gas and shockwave rings |
| `src/radar.ts` | Canvas sector radar and chart projection |
| `src/hangar.ts` | Live 3D ship bay used by the hangar screen and the shipyard |
| `src/models.ts` | Ship, asteroid, cargo, station, relay and derelict geometry |
| `src/fleet.ts` | Distinct stock hulls, engine nozzles and batched armor geometry |
| `src/sortie.ts` | Shared projectile target roster and debrief accounting |
| `src/textures.ts` | Baked rocky surfaces and space backdrop |
| `src/audio.ts` | Synthesized cabin sound |
| `src/style.css` | Responsive flight deck, startup flow, shipyard and dialogs |
| `DESIGN.md` | Design direction and visual rationale |

Stack references: [Bun with Vite](https://bun.sh/guides/ecosystem/vite), [Three.js orthographic camera](https://threejs.org/docs/pages/OrthographicCamera.html), [Three.js physically based standard material](https://threejs.org/docs/pages/MeshStandardMaterial.html).
