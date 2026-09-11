# DRIFT — flight HUD and system UI

Design direction and implementation plan. Companion to `PLAN.md`, written against the working tree with
Phases 0–3 of the combat plan landed.

## The subject

A working salvage corvette's canopy. The person reading this interface is a pilot doing a job in a vacuum,
not a user browsing a product. Every mark on the glass is either a live measurement or a bearing to a real
object in the world outside it. That sentence is the whole brief, and every decision below is answerable to it.

## What is wrong with the HUD today

Not taste — structure. Reading the current `style.css`:

- **Everything is a card.** `.mission-panel` and `.vessel-panel` are the same object: `border-radius: 9px`,
  the same `rgba(128,160,182,.13)` hairline, the same `backdrop-filter: blur(9px)`, the same
  `box-shadow: 0 18px 60px`. Two different kinds of information wearing one costume. `.radar-plate`,
  `.action-prompt`, `.map-legend` and `.stage-banner` repeat it. This is the SaaS-card kit in a spaceship.
- **The chrome tells.** `.section-label` is `text-transform: uppercase; letter-spacing: 1.4px` — the
  tracked-out eyebrow above content that does not need one. Meta strings are joined with middle dots
  (`5.2 × 4.2 km · grid 500 m`, `Newtonian flight · no speed limit`). Both appear on generated pages of every
  subject, which is how you know they are not choices.
- **Two grid rows are spent on furniture.** `.game-shell` is `66px / 1fr / 140px`. A fifth of a 1080p viewport
  is topbar and instrument deck, and the viewport is the game.
- **It shows everything, always.** Hull, propellant and heat are drawn identically at 100% and at 8%. Four
  contract stages are listed while three of them are not actionable. A weapons strip reads `Ready` forever.
  Nothing on the glass changes weight when it starts to matter, so nothing on the glass has weight.

The palette, the fonts and the 3D work are good and stay. The **form language** is what changes: from panels
to marks.

## Tokens

### Color

The scene's own materials already use these five values — `models.ts` paints hulls `#dce6e8`, the beacon halo
`#83b9b5`, the flame shader amber, the impact ring `#df8277`. Inventing a separate HUD palette would put the
instruments in a different world from the ship they measure. Kept deliberately, not by inertia:

| Token | Hex | Job |
| --- | --- | --- |
| `--void` | `#070d15` | The scene's ground. **The HUD never paints it.** No panel backgrounds. |
| `--etch` | `#dce6e8` | Hull ivory. Live numerals, the value you are acting on. |
| `--etch-dim` | `#8195a2` | Dormant marks and labels. Raised from today's `#526775`: with no panel behind it, the old faint grey loses to a lit asteroid. |
| `--nav` | `#83b9b5` | Sea glass. Navigation, target lock, resolved and confirmed states. |
| `--drive` | `#efb879` | Amber. Thrust, heat, and anything the pilot can act on now. |
| `--threat` | `#df8277` | Coral. Damage, hostiles, and limits being exceeded. |

One addition, and it is a texture not a colour: `--halo`, a `0 1px 8px #070d15, 0 0 2px #070d15` text-shadow
applied to every free-floating readout. It is what replaces the panel — type survives over a bright rock
because it carries its own shadow, not because it sits on a plate. `.marker-copy` already does this; it gets
promoted to the general rule.

### Type

**No new typeface.** Barlow and Barlow Condensed are bundled, and Condensed is a grotesque with proper tabular
figures — the right face for an instrument, currently used for exactly one thing (the wordmark). The
distinctive move is not a third family, it is giving Condensed the job it was built for.

| Role | Face | Size / weight | Notes |
| --- | --- | --- | --- |
| Primary readout | Barlow Condensed 500 | 46px / -0.5px tracking | Velocity. The largest thing on the glass. |
| Secondary readout | Barlow Condensed 500 | 25px | Heading, acceleration, range, credits. |
| Tertiary readout | Barlow Condensed 400 | 15px | Bar values, cooldowns, counts. |
| Object name | Barlow 500 | 13px | Contract title, target name, ship name. |
| Label | Barlow 400 | 10.5px, **sentence case** | Only where the shape alone is ambiguous. |
| Body | Barlow 400 | 14px / 1.55, max 68ch | Briefs and the manual, in menus only. |

Every numeral is `font-variant-numeric: tabular-nums`. **No uppercase anywhere in the game**, including the
existing `.section-label` and `.dialog-kicker`. `DRIFT` stays uppercase because it is a wordmark, not a label.

### Layout

Full-bleed viewport. `.game-shell` stops being a three-row grid and becomes a single surface with the canvas
behind everything; the topbar and the instrument deck are dissolved into marks anchored to the edges. That is
206px of vertical viewport returned to the game at 1080p.

**Alignment rule:** every readout aligns to the screen edge it is anchored to — left cluster left-aligned,
right cluster right-aligned, collar numerals aligned to their own arc. Nothing is centred except the
velocity numeral directly under the ship, because the ship is centred.

```
  DRIFT                                                        T+ 04:12 ●

  SR-084  Resolve and recover
  ──────────────────────  2 of 3


                              ·  ╱        ╲  ·
                           ╱                    ╲
                        ·           ▲              ·      ← the collar:
                        |         ship            |         bearings only
                        ·                          ·
                           ╲     128.4 m/s      ╱
                              ╲──────▁▁▁──────╱
                                 drive arc

  hull   ▊▊▊▊▊▊▊▊▎                                      ◆ ◆ ◇     1.42 g
  prop   ▊▊▊▊▊▎                                     AC-20  cutter
  heat   ▊▎                                                       036°
```

Nothing in that frame has a border, a fill or a corner radius.

## The hero: the collar

One instrument carries the design. It is a hairline ring drawn on canvas at a fixed screen radius around the
ship — which is always screen-centre in flight, since `scene.render` lerps the camera onto the ship. The ring
is the pilot's frame: **bearing and range from you, to everything.**

What lives on it:

| Mark | Meaning |
| --- | --- |
| Bright ivory notch | Velocity vector. Where you are actually going, which in a Newtonian sim is rarely where you point. |
| Amber caret, range numeral outside the ring | Selected target. |
| Coral tick, length by proximity | A hostile. Off-screen threats become findable without a list. |
| Small nav dot | A resolved contact or ore inside 900 m. |
| Thickened bottom arc | The drive. Fills clockwise on thrust, counter-clockwise on retro, bleeds amber to coral with heat. |
| Gap at the top | Deliberate. Keeps the ring off the contract line and stops it reading as a decorative circle. |

This single element replaces the radar plate, the threat strip, the off-screen marker arrows and the drive
instrument. Four pieces of furniture become one instrument that is also more useful than any of them, because
bearing and range are the two things a pilot actually navigates by.

**What it is not:** no rotating dashed rings, no corner brackets, no scan lines, no concentric ornament.
The ring is drawn only where there is data; empty bearings are empty glass. If a segment is lit, something is
there. That rule is what separates this from the radial sci-fi HUD that ships on every space game.

## Principles

1. **The HUD paints marks, never surfaces.** If something needs separating, use space or one hairline.
   No card, no fill, no blur, no radius. The `--halo` shadow is how type stays legible.
2. **Data sits where its subject is.** Bearings on the collar, range on the world marker, contract state in
   the corner it never flies through. A panel is what you build when you have not decided where something
   belongs.
3. **Attention drives weight.** Every readout has three states: dormant at `--etch-dim` and 0.4 opacity, live
   at `--etch` and full, critical at `--threat` with a slow pulse. A nominal flight is nearly bare glass; a bad
   one lights up. This is the anti-clutter mechanic — not fewer elements, but quieter ones.
4. **Structure encodes information.** The rule under the contract line is not a divider; its length is the
   progress. Tick length on the collar is proximity. Bar fill is a resource. Nothing is drawn to decorate.
5. **Spend boldness once.** The collar is the memorable thing. Everything else is quiet, aligned and small.

## Review against the brief

The skill asks whether this is a choice or a default. Working the brief cold — "modern dark space game HUD" —
produces: near-black ground, one cyan accent, glassmorphic panels with `backdrop-filter`, rounded cards per
instrument, tracked-out uppercase micro-labels, middle-dot meta strings. **That is precisely what the codebase
already has**, which is the strongest possible evidence it was a default rather than a decision. Three things
were revised out of the first pass:

- **Cards were removed rather than restyled.** The instinct was to keep the panels and lighten their borders.
  That still reads as a web layout floating over a game. Removing the surface entirely and anchoring marks to
  the viewport edge is the change the brief actually asked for.
- **Uppercase labels and dot-joined meta strings are gone.** `.section-label`, `.dialog-kicker` and every
  `A · B · C` string. Where a label survives it is sentence case; most do not survive, because a bar labelled
  `hull` next to a bar labelled `prop` is legible from position and colour alone.
- **The radial HUD needed a defence.** A ring around the ship is a sci-fi cliché on its own. It earns its
  place here only under the rule that it is drawn exclusively where live data exists, and only because it
  deletes four other elements. If it ever becomes decorative, it should be cut.

One thing deliberately not revised: the palette. It is shared with the 3D materials, and the instruments
measuring a ship should be the same colour as the ship.

---

# Implementation

## Constraints that are not negotiable

**Keep these ids and attributes.** `scripts/browser-check.mjs` and `scripts/mission-run.mjs` drive the real UI
and will fail silently-then-loudly if they move:

`#title-begin` `#launch-sortie` `#hangar-viewport` `#shipyard-bay` `#dialog-content` `#dialog-title`
`#manual-close` `#next-sortie` `#space-canvas` `#radar-canvas` `#toast` `#pause-button` `#resume-button`
`#assist-button` `#brake-button` `#camera-button` `#sound-button` `#help-button` `#zoom-in`
`.game-shell` `.map-legend` `.touch-controls` `.bay-tab[data-ship]` `[data-view]` `[data-ship]`
and the accessible names `Mute cabin audio` / `Enable cabin audio`.

Elements may move, restyle or become icon-only — they must keep their id and their `aria-label`.
Run `bun run test:browser` after each step of the rebuild, not at the end.

**Accessibility floor.** A canvas collar is invisible to assistive technology, so it is mirrored by a
visually-hidden `role="status"` region announcing hull, propellant and threat changes on crossing a threshold —
not every frame. Focus-visible outlines stay. `prefers-reduced-motion` disables the critical pulse and the
collar's sweep, leaving static marks. Contrast: `--etch-dim` on the belt's brightest surface was the reason it
moved from `#526775` to `#8195a2`; verify against the moon, which is the worst case in the scene.

## H1 — Strip the furniture

Delete before adding. This step alone gets most of the way to the brief and it is almost entirely subtraction.

- `.game-shell` becomes `position: relative; height: 100svh` with `#space-canvas` at `inset: 0` and every HUD
  element `position: absolute`. Remove `grid-template-rows`, `.topbar`'s background and border, and the
  `<footer class="instrument-deck">` wrapper.
- Delete from `style.css`: the panel recipe on `.mission-panel`, `.vessel-panel`, `.radar-plate`,
  `.action-prompt`, `.map-legend`, `.stage-banner`, `.nav-console` — every `border`, `border-radius`,
  `background`, `backdrop-filter` and `box-shadow` on a HUD container. Keep the elements, keep the ids.
- Add one shared rule: `.hud-mark { text-shadow: 0 1px 8px #070d15, 0 0 2px #070d15; }` and put it on every
  free-floating readout.
- `.section-label` loses `text-transform` and `letter-spacing`. Replace the two dot-joined strings in the map
  legend and the controls bar with plain sentences or nothing.
- The footer's four instruments are dismantled: velocity and heading move to the collar cluster, the drive
  instrument is absorbed by the drive arc, and the assist/brake buttons move to the bottom-left stack as two
  text toggles. The `#throttle` limiter moves into the pause screen — it is set once, not flown with.

After H1 the game should look unstyled and slightly bare. That is correct; H2 and H3 put the information back
as marks rather than as boxes.

## H2 — The collar

New `src/collar.ts`, following `radar.ts`'s structure exactly — DPR-aware `resize()`, a `draw(frame)` entry,
private `draw*` methods. Do not extend `Radar`: the radar is a sector projection and the collar is a bearing
ring; sharing a class would mean a mode flag threaded through 500 lines.

```ts
export type CollarMark = {
  bearing: number;        // radians, world frame
  range: number;          // metres
  kind: 'velocity' | 'target' | 'hostile' | 'contact' | 'ore';
  strength: number;       // 0..1 — drives tick length and opacity
};

export type CollarFrame = {
  marks: CollarMark[];
  thrust: number;         // -0.28..1.65, signed
  heat: number;           // 0..1
  radius: number;         // screen px; 0.29 * min(viewport) clamped to 150..260
  reducedMotion: boolean;
};

export class Collar {
  draw(frame: CollarFrame): void;   // clearRect, ring gap, marks, drive arc
}
```

Sizing: `radius = clamp(Math.min(width, height) * 0.29, 150, 260)`. At 1.4× zoom the ship is roughly 110px
across, so the ring clears it and clears the nearest rocks. The canvas is `inset: 0; pointer-events: none`
above `#space-canvas` and below the DOM marks.

**Feeding it.** `main.ts` builds `marks` once per HUD tick (85ms, not per frame) from state it already has:
the velocity vector, `getTarget()`, `hostiles`, `contacts()` and `ore` filtered to 900 m. `strength` is
`1 - range / maxRange` for hostiles and contacts, and 1 for velocity and target. No new state, no new
bookkeeping — the collar is a view of data the game already computes.

**Drive arc.** The bottom 140° of the ring, drawn at 3px against the 1px ring. Thrust fills from
bottom-centre clockwise; retro fills counter-clockwise; the stroke lerps `--drive` to `--threat` across
`heat`. At heat > 0.92 it pulses, unless reduced motion is set.

**What this deletes:** `.radar-plate` and `.nav-console` from flight (the canvas stays for map mode, where it
is the chart and is genuinely the right tool), `#threat-strip`, the off-screen arrow logic in `updateLabels`,
and the `.drive-instrument` block. Net line count should go **down**.

## H3 — The four corners

Everything else on the glass, in four small clusters. All DOM, all updated on the existing 85ms HUD tick.

**Top left — the contract.** Two lines and a rule. `SR-084` in `--etch-dim`, the current objective in
`--etch`, and beneath them a 1px rule whose width is stage progress. No stage list: the other three stages are
not actionable in flight and belong to the pause screen and the hangar brief, which is where a pilot reads.
`#objective-button` survives as the objective text itself being clickable, keeping its id and label.

**Top right — the session.** `T+ 04:12` and a 4px status dot: nav when nominal, drive when paused, threat when
under fire. `#sound-button`, `#pause-button`, `#help-button` sit beside it as icons at 0.5 opacity, full on
hover or focus. The `DRIFT` wordmark goes top-left above the contract at 18px, and the `[data-view]` nav
becomes three icon buttons next to the session marks — the labels are in the manual, and `M` and `V` are on
the keys.

**Bottom left — the vessel.** Three 2px horizontal bars, 64px wide, stacked 9px apart, labelled in 10.5px
sentence case: `hull`, `prop`, `heat`. The numeral appears **only when it matters**: hull under 60%,
propellant under 35%, heat over 55%. Otherwise the bar alone carries it. Below them, ship name and the two
toggles (`flight assist`, `kill velocity`) as plain text with their `kbd` hints, keeping
`#assist-button` and `#brake-button`.

Bar colour follows principle 3: `--nav` dormant, `--drive` when working, `--threat` when critical.

**Bottom right — the guns, and what you are doing.** One diamond glyph per mount: filled when ready, hollow
while cooling, coral when overheated, with the weapon name in 10.5px under the row. Beside them the two
numerals that are always true and never urgent: acceleration in g and heading in degrees. Ore held appears
here only while it is non-zero.

**Centre, under the ship.** Velocity at 46px, and directly under it the one contextual line the game already
has (`#flight-tip` / `#interact-button`). Everything else clears the centre.

## H4 — The system UI

Menus are documents about ships, so they are set as a spec sheet, not a page of cards.

**The through-line:** a live 3D object on the left, a specification column on the right, values right-aligned
in a numeric column with a hairline leader running from label to value. Selection is a 2px `--drive` bar on
the row's left edge, never a filled or outlined box. This one pattern covers the hangar, the shipyard, the
builder's stat column and the debrief.

```
  Kestrel                                    Truss frame
  Independent corvette

  dry mass  ·······························  41.2 t
  thrust    ·······························  1.96 MN
  accel     ·······························  1.43 g
  turn      ·······························  1.12 rad/s²
  propellant ······························  17.6 t
  hull      ·······························  126
  ▌ cargo   ·······························  320
```

**The contract board is a manifest, not cards.** One row per contract: id, title, danger as a 3-segment bar,
payout right-aligned. A locked row dims and names its prerequisite inline rather than showing a padlock.
Rows are separated by a hairline at 8% opacity, and the selected row takes the same left-edge bar.

**The builder** keeps its 3D-first split from `PLAN.md` §3.7 and drops the panel chrome: the parts list for a
selected socket is a plain list with prices right-aligned, the problem list is coral text under the stats with
no alert box, and `Launch` is a text button that dims when the build is invalid.

**Title screen.** The wordmark sits over the live belt with the ship drifting behind it — it already does.
Remove the `.title-meta` dot-joined string; best time becomes one plain line. Three actions as text with a
hairline over the primary one, not three filled buttons.

**Motion.** One orchestrated moment only: the launch camera pull that already exists. Cut every entrance
animation on HUD elements. Motion that answers an action stays — the collar mark appearing when a target is
selected, a bar changing state, a dialog opening. Nothing animates because the screen loaded.

## H5 — States and edges

The readout state machine, applied uniformly. One CSS class set, one helper in `main.ts`:

```ts
type Weight = 'dormant' | 'live' | 'critical';

/** Every readout gets its weight from the value, not from where it sits. */
function weigh(element: HTMLElement, weight: Weight) {
  element.classList.toggle('is-live', weight === 'live');
  element.classList.toggle('is-critical', weight === 'critical');
}
```

```css
.hud-mark { opacity: .4; color: var(--etch-dim); transition: opacity .2s, color .2s; }
.hud-mark.is-live { opacity: 1; color: var(--etch); }
.hud-mark.is-critical { opacity: 1; color: var(--threat); animation: caution 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .hud-mark.is-critical { animation: none; } }
```

Thresholds, so they live in one place rather than scattered through `updateHUD`:

| Readout | Live when | Critical when |
| --- | --- | --- |
| Hull | under 60% | under 25% |
| Propellant | under 35% | under 12% |
| Heat | over 55% | over 92% |
| Velocity | over 0.5 m/s | stopping distance exceeds target range |
| Target range | a target is selected | inside an action envelope |
| Guns | a mount is cooling | overheated |
| Contract | always | a timed contract is inside 60 s |

**Mobile.** The collar radius clamp already handles small viewports; below 720px it drops to 0.33 of the
short edge and the corner clusters tighten to 12px insets. The existing `.touch-controls` pads stay and keep
their `data-key` attributes. On a phone the four corners collapse to two: vessel bars bottom-left above the
rotation pad, and guns plus velocity bottom-right above the burn pad. The contract line moves to a single
truncated row at the top.

## Order of work

| # | Step | Shape | Risk |
| --- | --- | --- | --- |
| H1 | Strip the furniture | mostly deletion, `style.css` and the `.game-shell` grid | low — but run the browser check after it |
| H2 | The collar | new `src/collar.ts`, ~180 lines; removes more than it adds | medium — sizing and legibility over the belt |
| H3 | The four corners | `main.ts` markup and `updateHUD` | low |
| H4 | System UI | `style.css`, hangar, builder, board, title | medium — the largest surface, but no new logic |
| H5 | States, thresholds, mobile | one helper, one CSS block | low |

Do H1 first and completely. Restyling panels before deleting them is how a card layout survives a redesign.

## Checks

- `bun run test:browser` after **every** step. It clicks the real ids listed above and screenshots to
  `artifacts/`; a broken selector shows up immediately rather than three steps later.
- `bun run test:mission` still flies a full sortie through real keyboard events. The HUD rebuild must not
  touch its path.
- Screenshot review at 1920×1080, 1440×900 and 390×844, in flight, in map mode, in the hangar and in the
  builder. Compare against `artifacts/analysis/` to confirm the viewport actually gained space.
- One legibility pass with the ship parked in front of the moon, which is the brightest surface in the
  scene and the only place `--etch-dim` and the `--halo` shadow can fail.

## Not building

- **A HUD density setting.** Principle 3 already makes a nominal flight quiet. A preference here would be a
  config knob standing in for a design decision.
- **A new typeface.** Two bundled families, one of them under-used. Range comes from the scale, not a package.
- **An SVG or DOM collar.** Thirty-odd live marks redrawn on a tick is what canvas is for, and `radar.ts`
  already establishes the pattern in this codebase.
- **Keeping the radar plate in flight.** It duplicates the collar at a coarser resolution. It stays as the
  chart in map mode, which is where a sector view belongs.
