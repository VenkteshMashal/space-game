# DRIFT — design direction

A playable flight deck for a working corvette in the outer asteroid belt. Navigation is planar; vessels, rocks, salvage and stations are rendered as dimensional, physically lit objects. The centerpiece is a weathered ship with a visible drive assembly, surrounded by space large enough to feel indifferent to it.

## Tokens

- Deep space `#070d15`: main viewport.
- Deck steel `#111d29`: instruments and navigation.
- Hull ivory `#dce6e8`: primary type and ship armor.
- Sea glass `#83b9b5`: navigation, selection and operational state.
- Drive amber `#efb879`: thrust, mission actions and heat.
- Warning coral `#df8277`: dangerous closing speed and damage.
- Type: locally bundled Barlow for compact, legible controls and Barlow Condensed for the DRIFT wordmark and flight numbers. Tabular numerals serve instruments; monospace is unnecessary.

## Layout concepts

The viewport is the game. Four anchored clusters share the frame and nothing else competes for the centre:

```
+ brand / views ----------------------------------- session / controls +
| contract card                                    vessel card        |
|   progress, stages, one action                    hull / propellant  |
|                                                   heat, assist       |
|                    [ ship, markers,               sector radar       |
|                      trajectory ]                 target + zoom      |
+ velocity --------- heading --------- drive --------- assist / brake   +
+ key guide ------------------------------------- flight manual         +
```

The earlier build stacked a title block, a sector headline, a view-status strip, a six-row contact list, a vessel schematic and a payout row on top of that, which buried the viewport under roughly half the screen. That is rejected: a flight HUD earns its space by showing state a pilot acts on. Contact ranges moved onto the radar and the world markers; the mission paragraph and the payout moved to the hangar and the debrief; the schematic moved to the hangar where it is a real 3D model on a lit deck.

Startup is deliberately short and skippable. The title screen is a gate, not a marketing page: wordmark, one-line premise, three actions, best time. The hangar is a working bay — the ship on a turntable, the brief, the handling figures, a call sign — and the launch is a camera move from a close inspection of the hull to the flight framing. No fake loading bars, no decoration that does not exist in the simulation.

## Review before implementation

The original generic cyan HUD idea was revised to warmer instrument colors, ivory mechanical hulls and deliberately sparse overlays. No decorative scan lines, meaningless scrolling numbers or repetitive cards. The main visual ambition is the physically lit ship and terrain. Each annotation identifies a real object, control or simulation state. On small screens, collapse peripheral instruments and provide actual touch flight controls.

## Interaction and physics principles

No drag in vacuum. Main thrust follows heading, velocity remains independent of orientation, and stabilization consumes propellant. Attitude assist only damps angular velocity. A fixed simulation step avoids frame-dependent motion. Salvage and docking require low relative speed and proximity; a contact must be scanned before it can be recovered. System chart, ship selection, pause, sound, camera mode and the flight manual must work.

## The HUD rebuild: from cards to marks

The second pass on the flight HUD was structural, not cosmetic. The previous interface was a set of cards:
mission panel, vessel panel, radar plate and action prompt all shared one recipe — rounded corners, a
hairline border, a translucent fill, a blur and a drop shadow. Four kinds of information wearing one costume
is the signature of a default rather than a decision, so the surfaces were deleted rather than restyled.

What replaced them is one rule: **the HUD paints marks, never surfaces.** Every reading is anchored to the
screen edge it belongs to, carries its own text shadow instead of sitting on a plate, and has three weights —
dormant, live and critical — taken from the value rather than from where it sits. A nominal flight is almost
bare glass; a bad one lights up.

The instrument that carries the design is the **collar**: a hairline ring drawn on its own canvas around the
ship, which is always screen-centre in flight. Bearings and ranges from you, to everything — the velocity
vector as an ivory notch, the selected target as an amber caret with its range outside the ring, hostiles as
coral ticks whose length grows with proximity, resolved contacts and ore inside 900 m as small dots, and the
bottom 140° as the drive: it fills clockwise on thrust, counter-clockwise on retro, and bleeds amber to coral
with heat. A deliberate gap at the top keeps it off the contract line. It is drawn only where data exists, so
empty bearings are empty glass — that rule is what keeps it an instrument rather than a radial ornament, and
it replaces the radar plate, the threat strip, the off-screen marker arrows and the drive instrument.

The rest is four small clusters: the contract line and its progress rule top-left, the session clock and a
status dot top-right, hull/propellant/heat/hold bars bottom-left, guns and the two numerals that are always
true bottom-right, velocity and one contextual line under the ship. The system UI follows the same logic as a
spec sheet: label, dotted leader, right-aligned value, selection marked by a 2px bar on the row's left edge
rather than a filled box. The hangar, the contract board, the shipyard stat column and the debrief all use it.
The stage list left the flight HUD entirely — it belongs to the pause screen and the hangar brief, which is
where a pilot reads it.

## Review of the built game

Desktop screenshots showed overly faceted rocks and bright objects underneath mission copy. Revised the terrain to smooth geometry with baked crater and bump detail, strengthened the peripheral shading, and enlarged the corvette. Mobile review prompted offscreen target arrows and explicit accessible names for icon navigation. Kept engine plumes, live trajectory and camera response; removed recurring full-screen noise computation by baking the backdrop once.

The startup review replaced the instant drop into flight with the title → hangar → launch sequence, added a live ship bay instead of pre-rendered card images, and gave the sector a chart of its own: a true top-down fit of the whole 5.2 × 4.2 km volume with hazard field, contact glyphs and a scale bar, replacing the tilted three-times-zoom-out of the flight camera.

The clutter review cut the HUD to the four anchored clusters above. Off-screen marker labels now clamp to the viewport edge and flip inward so they can never land under a panel; the selected target, its range and the stopping distance live in one block under the radar; the contextual prompt only appears when an action or a warning exists.

The flight-feel review added the effects that were missing: a two-bell exhaust plume with a trailing wake, retro and maneuvering puffs, hull venting below 45% integrity, spark bursts and shockwave rings on impact with camera shake and a coral vignette, a recovery animation that flies the container into the hull, dock pulses on the station ring, and an amber scan arc with a progress ring on the marker being resolved.

## Combat, contracts, shipyard and economy

The guns made the HUD honest about threat, so the vessel card grew a threat strip and the frame grew a cursor-following aim reticle with a live bearing arc. Ore is drawn as instanced chunks with a collector envelope, so the vessel card carries a **hold** row — units against capacity — because cargo is now a resource with a number attached.

Contracts turned one hardcoded mission into data. The HUD's stage rows are generated from the active contract: the current stage shows each objective with its own progress, later stages show their labels, finished stages read *Complete*. The head chip carries the stage count, or the time left on a timed contract. The action button names the contract's own next waypoint rather than a fixed relay. Nothing in the panel is specific to the first contract.

The hangar became a working board rather than a single brief: four compact cards under the ship bay — kicker, name, kind, pay, bonus, danger pips, and a lock badge naming the contract that opens them — with the selected job's brief, numbered stages and bonus in the side column. Ship tabs and contract cards are visually separated by section labels because two identical four-up rows stacked read as one grid.

The shipyard is a screen, not a dialog. The hull turns on the same lit bay as the hangar with one gizmo per hardpoint: a teal diamond for an empty socket, an amber ring for a filled one, with a hidden disc inside the ring so the thin torus is a fair pointer target from either side. Selecting a socket dims the other markers, the panel offers only the parts that fit it, and the stat column moves as parts land. Purchases spend credits through the profile, and the build column refuses to launch a frame that cannot move, turn or carry propellant — the first problem becomes the button's tooltip.
