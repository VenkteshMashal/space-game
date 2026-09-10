# Verification evidence

What has actually been run on this machine for the Plan A / Plan B implementation, what passed, and
what has not been verified. Measurements are from this workstation (Windows 11, AMD Ryzen 5 5500U,
Chrome 141 under software WebGL unless noted); they are not claims about arbitrary hardware.

## Automated suites

| Command | Result | Covers |
| --- | --- | --- |
| `bun test` | **363 pass, 0 fail** (18 files, ~7 s) | Kernel rules, protocol validation, binary codec, physics and CCD, campaign graphs **and the campaign through the room**, persistence and crash recovery, mock session, sessions, settings/input/audio, UI, server room |
| `bun run build` | clean (`tsc --noEmit` + Vite) | Types across `src`, `tests`, `server`; bundle: app 240 kB, three 536 kB, worker 90 kB, CSS 7 kB |
| `bun run test:outcome` | **passed at all six viewports** | The real app in Chrome: title, lobby, launch, live flight, join |
| `bun run test:lan` | **passed** | A real host process, operator claim, a guest joining, one live match |
| `node design/tools/validate.mjs` | passed | Reference fits, budget, 7 weapon behaviours, cross-references in the design docs |

`tests/*.test.ts` assert behaviour, not plumbing: conservation in rock fracture, momentum in the
impulse solver, protocol rejections by typed code, idempotent settlement, readiness invalidation,
spawn safety, bot cadence and reaction times, a full bot match replaying bit-identically, repair
stock spent one unit per hull point, a rescue tether hauling and parting past its break force, a
decoy bay spending one charge per activation, and a torpedo turning onto its locked contact.
`tests/campaign-live.test.ts` drives M1 through the real room: three archives recovered inside the
tolerance (each adding its mass), an out-of-range and a too-fast attempt refused with the campaign's
own reason, the stage completing 3/3, the berth docking, extraction, and a settlement that reports
`mission-complete`, the 120-credit reward and the next mission.

## Browser outcome checks (`scripts/outcome-check.mjs`)

Six viewports — 1440×900, 1366×768, 390×844, 844×390, 320×568, 568×320 — each asserting:

- boot reaches the title with no document overflow and no clipped control;
- `Tab` reaches only on-screen controls;
- **Play offline** reaches the lobby, readies, launches, and produces a live flight screen with the
  crew/objective/radar HUD regions and a sized WebGL canvas;
- `P` opens exactly one overlay layer, `Escape` closes exactly one, and the authority phase does not
  change;
- rotating the viewport keeps the live screen and still fits;
- a name containing markup stays text on the Join screen (no element created, no script executed);
- no unexpected console errors.

Screenshots: `artifacts/outcome-<viewport>-{title,flight,rotated,join}.png`, results in
`artifacts/outcome-results.json`.

## LAN match check (`scripts/lan-check.mjs`)

The check starts its own host on a spare port, reads the operator URL from its startup banner, and
drives two real browsers:

- the operator page opens the loopback URL **with its one-use claim fragment**, joins, and becomes
  the captain (a guest cannot start, which is asserted);
- a second browser joins the same room as a guest, both pilots ready up, the captain launches;
- both reach a live flight screen **in the same epoch** (`room-1-e1` in the recorded run) and both
  HUDs report `Crew 2 / 2`;
- neither console reports an error.

Screenshots: `artifacts/lan-{operator,guest}.png`, results in `artifacts/lan-results.json`.

This is the LAN vertical slice on one machine with two browser contexts. It does not exercise Wi-Fi,
a second physical device, or a firewall.

## Defects found and fixed during verification

Each of these was found by running the real application, not by the unit suites, and each has a
regression test where a unit-level test can express it:

1. **Binary snapshots were dropped in browsers.** WebSocket binary frames arrive as `Blob` unless
   `binaryType` is set, so every client ignored the world while still receiving metadata: a LAN match
   rendered an empty flight screen. Fixed in `src/client/session/lan.ts`; pinned by a Blob-delivery
   test.
2. **A match-start epoch change discarded all snapshots.** The adapter refused any snapshot whose
   epoch differed from the welcome's, so the new match epoch was dropped along with the world. It now
   adopts a newer epoch and resets per-match state.
3. **The Join screen could never connect.** Typing a callsign or address updated the draft but never
   re-rendered, so the Connect control stayed disabled with its "Enter a callsign" blocker. Fixed in
   `src/ui/shell.ts`.
4. **`LocalSession.view()` threw before connect**, violating the `SessionPort` contract, which left
   the title control spinning with no message when offline play started. It now returns a
   disconnected view, and the shell reports a factory failure as a typed error instead of hanging.
5. **Escape was bound to the shell root**, so after any re-render (focus back on `<body>`) keyboard
   users lost the menu key. Now bound to the document.
6. **The phone lobby could not be launched at 320×568.** The generic three-row screen template gave
   its flexible row to the wrong child, collapsing the tab strip to zero height and putting the Fit
   tab — which owns Ready — out of reach. Fixed with the lobby's own row template.
7. **The canvas pushed the document wider after rotating.** The renderer pins its drawing surface in
   device pixels; the composition now clears that inline size so the canvas fills its host.
8. **Ship-versus-rock collisions only damaged the ship**, so asteroids never broke on impact. Contacts
   now damage both sides, and a friendly ram still cannot earn score.
9. **The Host screen's Configure action posted to a route that did not exist** (`/api/host/configure`
   404 in the console) while the shell's effect carried no values at all, so public/private and mode
   selection changed nothing anywhere. The settings now travel to the host process over loopback with
   an Origin check, the room applies them, and the operator check asserts the authority's own
   `joinPolicy` changed rather than the page's opinion. `stop` answers a typed refusal instead of a
   4xx, and `start`/`claim` explain that the launcher owns them.
10. **Campaign objectives never reached the client.** The runtime counted recoveries correctly, but a
    completion only existed in the room: the view is published on roster and phase changes, so nothing
    announced it. The room now publishes when the objective signature moves, and a lost carrier's
    archive is left at a beacon pulled back inside the arena instead of past the boundary where
    nobody could reach it.

## Not verified here

- **Physical LAN and phone matrix** (`PLAN-B` C5): a second Windows PC, a real Android Chrome and an
  iOS Safari client, screen lock and backgrounding, a 30-minute combat soak and 20 lobby/match
  cycles, Wi-Fi impairment profiles, and firewall/VPN failure paths. `docs/LAN.md` documents the
  procedure; the evidence above is one machine with two browser contexts.
- **Frame-rate and draw-call budgets** on real GPU hardware. The tier controller's rolling p95 logic
  is unit-tested and the app renders under software WebGL, but no measurement on physical desktops or
  phones has been taken, so the A6 performance targets remain optimistic by construction.
- **200% text zoom and virtual-keyboard layouts**: the phone layouts are checked at the listed
  viewport sizes, but not with browser text scaling doubled.
- **Playtest balance** (C2): weapon, resource, sensor and bot numbers are the catalog's documented
  hypotheses. They are internally consistent and tested for invariants, not tuned against human play.
- **A second physical Xbox/PlayStation controller.** Gamepad input is feature-detected, mapped and
  released on disconnect in tests, but no physical pad was attached.

## Known implementation gaps

These are specified but not yet built. They are listed here rather than implied complete:

- **Per-part ship visuals** (`PLAN-A` A4). A hull is built from its chassis class and paint; the
  fitted barrels, rail spines, torpedo pods, mine racks, radiator panels, sensor masts and
  tether attachments named in A4 are not modelled per part yet.
- **Purchases, repairs and the shop.** `inventory` and `recovery` are still answered with
  `unsupported`: credits, reservations and repair prices are modelled in the persistence layer and the
  campaign view, but no room command spends them yet, so a pilot cannot buy or repair in a match.
- **Campaign flown in a browser.** The authority path is tested end to end
  (`tests/campaign-live.test.ts`), the campaign view now carries the host's real record (credits,
  inventory, mission chain, decisions) and the debrief carries the mission's reward and successor, but
  no browser run yet flies M1: the campaign *screen* has unit coverage only.

## Reproducing

```sh
bun install
bun test
bun run build
bun run dev &                      # then, with the dev server up:
bun run test:outcome
bun run test:lan                   # spawns its own host on port 8099
```

`CHROME_PATH` selects another Chrome installation; `APP_URL` points the outcome check at a host
serving the built assets instead of Vite.
