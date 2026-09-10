# DRIFT / design handoff

These are implementation specifications and original design artifacts, not a completed multiplayer upgrade. The existing runtime is deliberately untouched. Start with [Plan B](../PLAN-B-MULTIPLAYER.md) sections B0–B3 and the shared contract, then implement [Plan A](../PLAN-A-SHELL.md) against the same contract.

## Agreed release

Eight browser players on a Windows-hosted LAN; offline play with bots; a six-mission, host-saved cooperative campaign; two-team PvP; modular ships. Guests open a LAN URL or scan its QR. The Windows operator starts a launcher after one-time Bun setup. Internet matchmaking, voice chat, arbitrary construction, seamless host-machine migration and a full map editor are outside this release.

## Visual plan, reviewed before building

DRIFT is a flight instrument, not a dashboard. The memorable element is the physical ship against a deep, sunlit asteroid field. Instruments occupy the edges and answer immediate questions: where am I going, what threatens me, what can I fire, what does the crew need?

| Token | Value | Use |
| --- | --- | --- |
| Space | `#050b12` | Clear combat field |
| Instrument | `#122331` | Opaque readable controls |
| Ceramic | `#dfebe9` | Primary type and hull surfaces |
| Signal | `#83cbd3` | Selection, navigation, crew |
| Caution | `#e8b56e` | Resource limits and uncertainty |
| Threat | `#ef8782` | Confirmed damage and hostile contacts |

Barlow is the reading face; Barlow Condensed carries ship names, large instrument values and headings. Both are already local dependencies. Use sentence case, tabular numerals for telemetry, 16 px body text on menus and 14 px minimum essential HUD text. Alignment follows the edge nearest the instrument; central overlays are reserved for a short reticle or immediate objective interaction.

```text
Flight / desktop
┌ crew + objective ─────────────────────────── link / menu ┐
│                                                         │
│                 unobstructed flight field               │
│                    target / lead                        │
│                                                         │
│ radar       velocity / hull / propellant     weapons     │
└─────────────────────────────────────────────────────────┘

Hangar / desktop                  Portrait / paged menus
┌ back / ship / funds ─────────┐  ┌ back / screen / page ┐
│ hardpoint    physical ship  │  │ ship or crew preview │
│ selector    / shadow        │  │ current choice      │
│ part alternatives | effects │  │ effect / validation │
└ previous / next / fit ──────┘  └ previous / next / fit┘
```

Pre-build critique: a wall of bordered telemetry and a large permanent bottom ship schematic would reproduce the old UI's obstruction. Remove them. Show only four essential flight readings; details belong to a deliberate overlay. The hangar gets the technical drawing, the lobby gets a roster, and combat gets space. Use an alien relay's broken, offset rings as the one unusual visual motif; avoid neon grids and decorative hologram panels.

## Artifacts

- `index.html`, `prototype.css`, `prototype.js`: interactive flight, lobby and hangar review. Run `bun run dev -- --port 5173`, then open `http://127.0.0.1:5173/design/`. Requires the repository's installed dependencies. This prototype uses Three.js and local fonts, and its telemetry/network states are explicitly fixtures.
- `assets/witness-relay.svg`: original orthographic alien structure/material guide. Its solid ribs are collision geometry; light filaments are decorative. Plan A specifies the 3D conversion.
- `data/catalog.json`: initial modular ship/weapon balance, slot constraints and reference builds. Values are starting hypotheses, not measured balance.
- `contracts.ts`: canonical integration vocabulary and minimal client adapter. Copy to shared source at gate C0, then maintain one runtime definition; do not keep competing versions.
- `tools/validate.mjs`: structural catalog/contract checks.
- `tools/check-layout.mjs`: interactive prototype checks and screenshots. No physical LAN or phone-performance claim follows from a headless browser run.

The prototype is a composition and interaction reference, not a substitute for the full screen/state requirements in Plan A. Its miniature loadout calculator only demonstrates a subset of the catalog. Plan B is canonical for rules, persistence, units, timing and authority; Plan A is canonical for presentation, input and accessibility. When they conflict, resolve the shared contract before implementing either side.

## Handoff order

1. Freeze C0 contracts, units, content IDs, lifecycle and test fixtures together.
2. B repairs authority/protocol while A builds shell and screens against a mock adapter.
3. Integrate one lobby-to-match-to-rematch vertical slice before adding campaign content.
4. Complete combat/loadouts, persistence, six missions and UI feedback together.
5. Pass the physical Windows + Wi-Fi + phone matrix and publish the launcher/instructions.

Keep a short completion/evidence table in each plan as work lands. A feature is complete only when its authority, UI, save/load behavior and failure cases all pass their linked acceptance gates.

## Review evidence

- [Catalog check](evidence/catalog-check.json): 3 chassis, 23 parts, 7 weapon behaviors and 3 legal reference fits; confirms IDs, slot sizes, budget, initial wet mass and idle power. Includes illustrative bandwidth/replay/CCD calculations, not benchmarks.
- [Layout check](evidence/layout-check.json): 21 screen/page checks across 1440×900, 1366×768, 390×844, 844×390, 320×568 and 568×320; prototype readiness, pagination, fitting, connection and objective interactions. Zero reported browser errors. Shared contract passes standalone strict TypeScript checking.
- Screenshots: [flight desktop](evidence/flight-1440.png), [hangar desktop](evidence/hangar-1440.png), [lobby desktop](evidence/lobby-1440.png), [flight portrait](evidence/flight-390.png), [hangar portrait](evidence/hangar-390.png).

Post-build critique: reduced the portrait ship preview so fitting information no longer covers the hull; added a Mission page for phone lobbies instead of hiding mission content; reduced crew rows on short viewports while keeping every seat reachable. The flight field remains quiet and each weapon has a visible purpose/tradeoff. The prototype intentionally demonstrates three weapon choices; the catalog/Plan B specify the complete seven-behavior release.

Reproduce: `node design/tools/validate.mjs`, `node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 design/contracts.ts`, then start Vite and run `node design/tools/check-layout.mjs`. Browser check defaults to installed Windows Chrome; override `CHROME_PATH` and `DESIGN_URL` if needed. Screenshots use software WebGL: physical LAN, phone FPS, 200% text scaling, virtual-keyboard layouts and production touch controls remain required implementation gates, not verified claims of this prototype.
