# DRIFT

Eight browser players on a Windows-hosted LAN, offline play with bots, a six-mission cooperative
campaign and two-team PvP, flown with physical modular ships. Built with **Bun, TypeScript, Vite and
Three.js**.

`PLAN-A-SHELL.md` (presentation, input, accessibility) and `PLAN-B-MULTIPLAYER.md` (rules, units,
protocol, saves) are the specifications this code implements; `PLAN.md` is the earlier solo game and
is kept as history. `design/` holds the frozen review record: the shared contract, the parts catalog,
the interactive prototype and the alien relay art.

## Run it

```sh
bun install
bun run dev          # development server on http://127.0.0.1:5173
```

Open the printed URL. The title screen offers **Resume campaign**, **Play offline**, **Join LAN**,
**Host guide** and **Settings**. Nothing connects until you choose a mode — there is no silent
fallback to a solo game.

## Host a LAN game

```sh
bun run host         # builds, then serves assets, /health, /api/info and /ws on one port (8080)
```

The host prints two addresses and a QR code:

- **Operator** (`http://localhost:8080/#op=…`) — open this one on the hosting PC. The fragment is a
  one-use claim: it makes that browser the room captain, is consumed over loopback, and is erased
  from the address bar immediately.
- **Guests** (`http://<your-wi-fi-address>:8080`) — anyone on the same network opens this, picks a
  callsign and joins. Handheld players can scan the QR.

Windows Firewall prompts on the first launch; allow Bun on **private** networks or other PCs cannot
reach port 8080. `docs/LAN.md` covers the firewall, adapter selection, VPN conflicts, room codes and
how to stop the host safely, and `Start-DRIFT.cmd` / `Stop-DRIFT.cmd` wrap the whole flow for the
operator.

A match: pick a fleet, spend a 110-point build budget, ready up, and the captain launches. Two teams
to 30 kills or ten minutes; respawn after five seconds. `P` opens the menu, `Escape` closes one layer,
`Tab` is menu navigation, `M` the map, `V` cinematic, `H` the flight manual, `G` (hold) the
scoreboard.

## Fly

| Control | Action |
| --- | --- |
| W / S or ↑ / ↓ | Main drive / reverse thrusters |
| A / D or ← / → | Rotate the ship |
| Q / E | Strafe left / right |
| Shift + W | Hard burn; more fuel and heat |
| X | Hold to brake with RCS |
| Space | Fire the active weapon group |
| F | Interact (dock, recover, scan, rescue) |
| R | Reload |
| P | Pause / menu |
| M | System map |
| V | Cinematic view |
| H | Flight manual |
| G (hold) | Scoreboard |
| Escape | Close one layer |

Controls are remappable in Settings → Controls, and released on blur, hidden tab, overlay and pointer
cancel. Touch devices get a left drive pad, a turn strip, a right aim pad and fire buttons; essential
targets are at least 44 px and nothing depends on hover.

## Ships

Three chassis (`needle`, `kestrel`, `mule`) and 23 parts: seven weapon behaviours (ballistic,
point-defence, rail, flak, torpedo, mine, beam), three drives, two reactors, three armour sets, two
sensors and six utilities. Fits are validated atomically — power, mass, slots, budget, exclusive
utilities — and a rejected build keeps the previous one. `deriveFit` in `src/shared/catalog.ts` is
the single derivation used by the authority, the hangar and the HUD.

## Check and build

```sh
bun test             # 337 tests: kernel rules, protocol, codec, physics, campaign, persistence, UI
bun run build        # typecheck, then bundle
bun run test:outcome # six viewports through the real app: screens, layout, keyboard, offline match
bun run test:lan     # starts a host, claims operator, joins a guest, plays a live match
bun run dev:server   # host only, for LAN development against the Vite client
```

`test:outcome` and `test:lan` drive Chrome through Playwright; override `CHROME_PATH` for another
installation. Screenshots and JSON results land in `artifacts/`. `docs/EVIDENCE.md` records what has
been verified on this machine, on which browsers, and what is still unverified.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/shared/**` | Contract, validators, catalog derivation, protocol, codec, balance, ids, RNG |
| `src/sim/**` | Authority kernel: world step, motion, physics, spatial hash, weapons, fracture, sensors, spawn, score, lobby, bots, campaign |
| `src/server/**` | Room loop, baselines, operator claim, one-port server, SQLite persistence, QR |
| `src/client/session/**` | `SessionPort` adapters: LAN sockets, offline worker, prediction, mock fixtures |
| `src/ui/**` | Shell, router, screens, HUD, settings pages, styles and tokens |
| `src/render/**` | Entity registry, LOD and detail queue, pools, camera, quality tiers, scene |
| `src/input/**` | Bindings, intent router, touch layout and capture |
| `src/audio/**` | Five-bus mixer, cue recipes, voice budgets |
| `src/models.ts`, `src/textures.ts` | Procedural ship and asteroid geometry, baked surfaces |
| `src/main.ts` | Composition root: settings, audio, input, scene and shell over one session |
| `design/**` | Frozen design contract, catalog, prototype and evidence from the design pass |

Stack references: [Bun WebSockets](https://bun.com/docs/runtime/http/websockets),
[Bun SQLite](https://bun.com/docs/runtime/sqlite),
[Three.js orthographic camera](https://threejs.org/docs/pages/OrthographicCamera.html).
