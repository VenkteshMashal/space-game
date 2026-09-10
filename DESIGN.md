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

Selected: the viewport fills the window, with left-aligned mission and ship instruments at its edges. Flight instruments sit in a low strip so the middle remains a navigable space.

```
+ brand / Flight deck   System map   Shipyard ------- session +
| mission              orbital landscape            vessel |
| objective              [ waypoint ]               systems |
|                                                         |
| contacts                 /ship/                  compass |
|                     planned vector                      |
+ velocity / heading -------- thrust ------- flight controls+
```

Rejected: a hangar landing page with a large promotional heading and a start button. It hides the game and makes the spaceship an advertisement. The flight deck is immediately playable, with a short optional flight manual.

## Review before implementation

The original generic cyan HUD idea was revised to warmer instrument colors, ivory mechanical hulls and deliberately sparse overlays. No decorative scan lines, meaningless scrolling numbers or repetitive cards. The main visual ambition is the physically lit ship and terrain. Each annotation identifies a real object, control or simulation state. On small screens, collapse peripheral instruments and provide actual touch flight controls.

## Interaction and physics principles

No drag in vacuum. Main thrust follows heading, velocity remains independent of orientation, and stabilization consumes propellant. Attitude assist only damps angular velocity. A fixed simulation step avoids frame-dependent motion. Salvage requires low relative speed and proximity; docking requires a safe approach. System map, ship selection, pause, sound, camera mode and the flight manual must work.

## Review of the built game

Desktop screenshots showed overly faceted rocks and bright objects underneath mission copy. Revised the terrain to smooth geometry with baked crater and bump detail, strengthened the peripheral shading, and enlarged the corvette. Mobile review prompted offscreen target arrows and explicit accessible names for icon navigation. Kept engine plumes, live trajectory and camera response; removed recurring full-screen noise computation by baking the backdrop once.
