# PLAN A — DRIFT shell, HUD, ships and presentation

Implementation handoff, 2026-09-10. Replaces the earlier Plan A. Follow with [Plan B](PLAN-B-MULTIPLAYER.md), [design index](design/README.md), [interactive prototype](design/index.html), [shared contracts](design/contracts.ts), [parts catalog](design/data/catalog.json) and [original Witness relay](design/assets/witness-relay.svg). Plan B owns rules/units/protocol/saves; this plan owns presentation/input/accessibility. The original PLAN.md describes history, not this release's scope.

## A0. Outcome and audit

Build a modern viewport-fitted game: eight-player LAN co-op/PvP, offline bots, six-mission campaign, physical modular ships and quiet industrial instruments. The pilot should see the flight field first. No document, modal, roster, settings, inventory or mission-log scrolling: use deliberately sized pages, tabs and disclosures with persistent navigation. Never meet this requirement by clipping unreachable content or shrinking text to illegibility.

Preserve current lit Three.js ships, procedural rock surfaces, synth audio and pure simulation where useful. Existing defects: main.ts intertwines solo/network/render/UI state; dialogs interrupt input while server keeps old commands; mobile ship cards overflow; fixed minimum heights exceed short windows; fitted hull maxima can remain Kestrel defaults; debrief/rematch leaves stale state; lobby focus can drop updates; names enter innerHTML; no touch fire; fragment detail arrives after collider; scene lifecycle lacks complete resource disposal. Old screenshots show original solo game, not proof of current MP behavior. Existing 26 tests/typecheck pass but do not cover these failures.

The prototype is a visual/interaction fixture, not a working multiplayer client. Its compact demonstration does not replace any screen/state below. Game runtime remains unchanged by this planning task.

## A1. Architecture and agreement with B

A owns `src/ui/**`, `src/render/**`, `src/input/**`, `src/audio/**`, `src/settings.ts`, `main.ts` composition and associated browser tests. B owns shared content/derived stats/protocol, authority kernel, LAN/local SessionPort adapters, prediction and persistence. Migrate legacy scene/models/audio/style incrementally through adapters. No arbitrary line-count rule: modules split by responsibility and lifecycle, not a 300-line target.

At C0 agree exact shared DTOs and fixture events. `SessionPort` is the only gameplay boundary: `view/subscribe/events`, `command`, `setIntent`, `releaseControls`, `connect`, `dispose`. A does not parse sockets, calculate damage, grant currency, create campaign entities or reset a live world. A may preview shared pure fit derivation and render provisional feedback clearly. B owns tick scheduling/reconciliation; A owns render offsets/camera presentation through B's predicted view, with no duplicate flight loop.

Separate local Screen + Overlay from authority Phase, life, presence and link. “Menu open while live and reconnecting” is legal; do not force these into one giant mutually-exclusive state enum. Authority phase selects valid base screen; local navigation can inspect allowed overlays. Own a `SessionScope` for subscription cleanup, RAFs, worker, audio voices, input capture and GPU resource leases. Disposal is idempotent; cancel obsolete connect attempts by AbortSignal/generation. Error/close may arrive together, but UI tears down once.

| Composition module | Responsibility |
| --- | --- |
| main / app | Mount shell, create selected adapter, bind view/events and dispose session |
| ui/router | Screen/overlay transitions, focus return, unsaved drafts and confirmations |
| ui/screens | Title, LAN, lobby, campaign, hangar, debrief; paged layouts |
| ui/hud | Readonly self/crew/objective/contact instruments, throttled DOM updates |
| input/router | Device intent, remaps, touch ownership, release reasons |
| render/session-scene | Entity registry/LOD/camera/assets/context restore; no authority writes |
| audio/mixer | Buses, event deduplication, voice budgets and listener scope |

Temporary mocks must cover empty/full lobby, captain transfer, invalid fit, loading failure, alive/disabled/dead, packet stall, reconnect success/failure, score tie, settlement pending/failed and second match. First integrated vertical slice is title→LAN lobby→ready→match→disconnect/resume→debrief→second match, before campaign polish.

## A2. Complete shell and LAN flow

| Screen | Content and actions | Important transitions |
| --- | --- | --- |
| Boot | Local asset/version readiness, retry, readable unsupported-WebGL message | No silent auto-connect or fallback to solo after 1.5 s |
| Title | Resume campaign, Play offline, Join LAN, Host guide, Settings; ship/sector background | Resume states exact save owner/location/date |
| Host setup | Launcher status, adapter/port, copy link, real QR, room code, public/private, campaign/PvP selection | Browser explains local launcher if process absent; cannot pretend to start Windows process |
| Join | Name, normalized address, optional room code, Connect, Cancel, recent hosts stored locally | Navigate host origin; typed timeout/full/code/version errors with retry/back |
| Lobby | Eight seats, captain, presence, ping quality, team/role/fit, mission/map, bot fill, ready and blockers | Full roster updates even while editing; text drafts preserve selection; ready tied to revision |
| Campaign | Sector route, current mission summary, choice history, shared credits, save status, Deploy | Locked/complete/current explicit; repeat story labeled training/no rewards |
| Hangar | One ship, selectable hardpoints, paged parts, effect comparison, fire groups/power priority, commit fit | Authority validates atomically; keep previous fit/draft on rejection |
| Loading/countdown | Mission/map, individual loading states and actionable failure | Captain cancel/deploy without failed seats; proxy readiness before control |
| Flight | Minimal HUD, contextual objectives/contact cues, accessible menu/map/score/crew commands | Server life/phase determines allowed actions |
| Debrief | Result, objective progress, credits/repair/item changes, personal/team stats, explicit save receipt | Captain Continue, guest Waiting/Leave; save failure Retry/Export |
| Settings/help | Paged categories, local settings, binding capture, short controls/flight lessons | LAN continues, controls released; offline pause freezes local authority |

Host display distinguishes “Room captain” from “This PC hosts the game”. Captain transfer is visible during play and lobby, without claiming server migration. Browser closure does not stop Windows process. Stop hosting button requires operator capability and reports checkpoint/shutdown progress; guests never see it. Private QR and code handling follow B2. Copy failure selects the address and says “Select and copy this address”; join validation never silently rewrites to localhost. No arbitrary subnet scan feature.

Lobby layout: desktop crew roster left, mission/sector center, selected pilot/fit and launch action right. Eight rows with 44 px minimum row action; phones show 4 seats/page and separate Mission / Crew / Fit tabs. A prominent Ready button and captain Start action show exact blockers (e.g. “Waiting for Iona”, “Your fit changed”). Captain settings edits revoke readiness visibly. Empty seats offer Add bot only to captain. Name drafts reconcile on blur/commit with revision conflict errors, never discard incoming roster. Ping is measured with unknown/stale state, not hardcoded green. Show room capacity including reserved reconnect seats.

No chat service is required. Add quick crew pings/orders through bounded typed commands: Regroup, Defend, Recover, Focus contact. Cooldown/rate limit and detected-contact validation belong to B. UI shows sender and expires the marker; touch wheel and keyboard access are equivalent. Full text chat is deferred, avoiding another moderation/persistence system.

## A3. Flight HUD and control behavior

Palette/type/layout tokens and initial critique are in design/README. Ship/world are the memorable element; instruments have opaque-enough backing for readable text against bright rocks. Ceramic type, cyan crew/navigation, amber uncertainty/resources, salmon threat; pair team color with shape/pattern. Barlow reading face, Barlow Condensed for names/large values; tabular numerals. Default essential HUD 14 px, menu body 16 px. No decorative all-caps microlabels, pervasive glow or permanently animated grids.

Desktop central 70% width ×60% height stays clear of persistent opaque panels. Top-left compact crew condition + current objective; top-right connection/menu; bottom-left compact radar; lower middle velocity/hull/fuel/thermal strip; lower-right selected weapons. Only immediate interaction, target reticle/lead and offscreen threat arrows enter flight field. Long story text, ship schematics and full objectives live in intentional overlays. Radar starts ~144 px desktop and can collapse. No permanent bottom 164 px wall.

| Instrument | Meaning and edge cases |
| --- | --- |
| Velocity / heading | Vector separate from facing, actual m/s, thrust/assist state; braking-distance marker only with finite thrust/fuel |
| Hull / fuel / heat | Current fitted maxima from authoritative derived fit, units/critical threshold, unknown while baseline absent |
| Power / capacitor | Show when fitting/charging/brownout matters, not constant twelve-bar dashboard |
| Weapons | Name/group, magazine/reserve, reload/charge/cooldown, blocked reason; server-confirmed shot/hit feedback |
| Target | Detected ID/shape, range, relative speed, lock progress/uncertainty; clear on expired contact/LOS loss |
| Objective | One immediate action/progress/distance; expand complete graph on demand |
| Crew | Compact alive/disabled/reconnecting count; distress pin opens rescue/order context |
| Link | Hidden when healthy except small quality indicator; latency/stale/reconnect notice when relevant |
| Boundary | Direction and 15-second return countdown near edge; no invisible force explanation |

Lead indicator solves `|r + v*t| = muzzleSpeed*t`, where r = target−muzzle position and v = target velocity−ship velocity−muzzle angular tangential velocity. Choose smallest positive root within lifetime/range; handle near-linear coefficient, negative discriminant, no solution and obstruction. Beam shows actual aim/LOS, torpedo shows lock/seeker, mine shows release/arming envelope. Never present ballistic lead as a guaranteed torpedo impact or draw through first solid. A uses shared aim helper defined/tested by B.

Damage feedback: brief directional arc and localized material hit; confirmed hit marker only from authority. Predicted muzzle flash can be provisional but is deduplicated on shot receipt by life/weapon/action identity. No repeated flash from denial or full traffic pool. Radar uses B contacts, age/uncertainty circles, no omniscient enemies; scan pulses are manual and resource-aware. Friendly labels fade with distance, never fill screen; threat warnings prioritize imminent torpedo/collision/critical heat over nonurgent salvage.

Controls start from existing W/S thrust/reverse, A/D turn, Q/E strafe, X brake, Shift boost; mouse aim and primary/secondary groups, R reload, F interact, V assist, M map, Esc menu. Final conflict-free bindings and mouse aim mode freeze at C0. Offer keyboard-only fixed-gun aim, remapping and a concise tutorial. Tab remains navigation in menus; scoreboard uses hold key configured as G by default, ignores key repeat, closes on release. No global interception while editing a text field.

Release on blur, hidden tab, overlay, pointer cancel, connection/life change: clear all captured keys/pointers/fire and call adapter.releaseControls. The network adapter runs separately from render cadence; browser throttling is still covered by B's input lease. LAN body coasts and remains vulnerable. Never say pause stops a ship or set velocity zero. Resume needs fresh user press; held key from before overlay must not reactivate until released/repressed. Offline menu may actually pause its isolated authority and is labeled Paused.

Phones: landscape preferred but portrait playable. Left analog pad maps thrust/reverse/strafe with separate turn/aim behavior chosen in controls; right aim pad and two fire buttons, reachable brake/interact, boost hold, compact group switch. Allow simultaneous steering + aiming + firing with pointer IDs/capture; independent release per pointer. Essential touch hit areas ≥44 px (48 preferred), no hover-only info, safe-area insets, left-handed layout. Lock-to-visible-target option and angular assist use same server rules on every device; no hidden phone damage/aim advantage. A touch fire control is mandatory, unlike current implementation.

Gamepad is optional feature-detected on supported contexts; plain LAN HTTP may lack secure-context APIs. Do not block keyboard/touch waiting for it. [MDN gamepads](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getGamepads) Use standard mapping with dead zones, remappable axes/buttons, explicit connect/disconnect release; test real device before claiming support.

## A4. Hangar, original assets and rendering

One chassis at a time, central physical preview with selected hardpoint highlighted. Part list shows three choices/page desktop, one/two on phone; comparison area shows current→proposed mass, full-fuel acceleration, power, cooling, ammo role and invalid-build reasons. Tabs: Fit, Fire groups, Systems, Paint. Systems page includes power priority, module health and repair price. Fire groups can't assign PDC auto-defense and manual simultaneously. User-configured duplicate-exclusive utility or oversized gun rejected visibly; no hidden auto-spending or auto-removal. Commit uses expected fit/inventory revision; successful response updates model and ready state. Insufficient credits/instance reserved by teammate keeps draft and identifies conflict.

Loadout interactions to demonstrate: rail + pulse bank supports charge but raises mass; hot reactor supplies more but adds thermal load; radiator cools and reveals signature; heavy armor survives kinetics but brakes slowly; survey sensor improves scan/lock but draws power; rescue Mule carries/repairs while Needle scouts. Use catalog values/shared derived stats, not separate frontend arithmetic. Reference builds give a usable starting point with recoverable loaners.

Physical models need a coherent scale pass. Existing procedural ship meshes do not match declared metre lengths. Normalize root bounding dimensions to chassis length/beam and place hardpoints in physical coordinates, one canonical slot transform table owned with B. Do not scale physics per device. Add visible interchangeable barrels, rail rails/capacitor spine, torpedo pods, rear mine rack, radiator panels, sensor mast, drive bell and tether/grapple attachments. Silhouette must identify role at gameplay camera scale; details belong to hangar LOD. Selection outlines should apply to selected module only, not every edge.

Alien art uses the original Witness relay SVG: three offset incomplete ceramic/basalt rings, exposed dark joints and restrained cyan filament. Convert rings to instanced segmented 3D ribs with genuine open corridors; B owns matching collision proxies. Bright filaments are appearance only. Custodians reuse this material/silhouette language with tri-radial articulated forms and visible conventional thrusters. No familiar copyrighted spacecraft silhouettes or unexplained forcefield surfaces. Human Cinder ships reuse legal chassis modules with different paint/armor arrangements so content workload remains finite.

| Material/effect | Implementation and fallback |
| --- | --- |
| Human hull | Standard PBR rough metal/ceramic, authored panel mask + mild normal detail; per-instance paint/damage, shared base resources |
| Rocks | Seed/shape/material-aware cached geometry/texture, triplanar detail where useful, no seams at LOD switch |
| Engines/RCS | Instanced soft exhaust aligned to actual thrust/nozzle; reduced particles on low tier, never imply thrust while coasting |
| Rail/beam/torpedo | Distinct narrow trail / first-hit beam / burning motor then coast; gameplay readable without bloom |
| Witness | Basalt/ceramic PBR plus thin emissive groove phase; no expensive full-scene distortion required |
| Damage | Local decal/mask and short light; no shared-material emissive mutation affecting all ships |
| Space | Sparse stars with depth layers, subtle distant dust, single clear sun key; decorative Z bodies never collidable |
| Postprocess | High-tier subtle bloom/antialiasing; low tier direct render + built-in AA/resolution choice; no gameplay-hidden darkness |

Implement shader variants through bounded feature flags; compile/warm on loading screen with fallback material on failure. Correct sRGB texture/output handling, linear lighting, normals and transparent sorting. Avoid dynamic shader recompiles on hit or every paint change. Time uniforms use session visual clock; reduced motion stops unnecessary background movement, not projectiles. Procedural noise/texture generation workers/cache must include seed, shape, resolution and material version; caching solely by radius changes rock identity. Record build/texture costs before choosing expensive shader features.

Reuse geometry/material/texture ownership explicitly with reference counts or asset registry. Instancing for repeated static modules/rocks where geometry compatible; chunk bounds updated for culling, transformed instances have correct ray/proxy metadata. [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) Each dynamic entity keyed by ID+generation, registry lookup O(1), no per-frame `.find` cross-products. Immediate proxy first, detailed mesh queue prioritized near camera/target, bounded ≤64 pending jobs; cancel obsolete generation/epoch jobs. Pool projectiles/particles/impact lights; gameplay entities never disappear because a visual pool filled—use cheap fallback glyph.

Camera uses stable orthographic XY framing with mild 3D elevation, optional small velocity look-ahead capped to keep local hull visible. No camera rotation by default; ship may rotate freely. Zoom clamped so target/hazard contrast remains legible; mobile scales tactical view without changing physics or sensor range. Screen shake low/off by default, adjustable to zero; no forced roll/chromatic smear. Pause overlays keep LAN rendering/network active but may reduce decorative work.

## A5. Campaign, audio and accessible viewport layout

Campaign UI maps directly to B8's six graphs: one current action in HUD, mission page with progress/recovery state, journal pages for discoveries and prior decisions. Alien choice screen shows concrete stakes and countdown, eligible-vote count and conservative default; no hidden irreversible prompt. Late join receives current graph, cargo ownership, faction state and summary, not replayed reward popups. Critical cargo lost shows new recovery beacon; disabled transport exposes Tow objective; last human death offers checkpoint retry/return with voting deadline. PvP scoreboard shows departed pilots and immutable team total.

Debrief separates outcome, inventory/repair changes and narrative (pages on small devices). Show rewards only once with receipt; Saving/Saved timestamp/Save failed clearly distinct. Guest sees “Saved on host PC”; offline sees local device. Host stop/crash explains last checkpoint and recovery options. Export/import confirmation states new campaign copy; never suggests automatic cloud sync. Loaner/recovery is a first-class button, not buried when broke.

Audio: master/music/effects/UI/voice buses; user gesture unlocks AudioContext, default no autoplay error. Local synth engine pitch follows actual thrust, filter/cut on coast; spatial external combat is a restrained tactical sonification convention, not literal sound through vacuum. Distinct cue for confirmed impact, lock warning, thermal limit, objective completion, ally distress and save failure. Silence/chime priority prevents eight-player cacophony. Cap 32 effect voices/8 continuous engines; nearest/important events win, deduplicate authority events across replay. Destroy/suspend voices on session teardown, resume browser audio only after permitted interaction. Optional score uses original local synth motifs; subtitles/captions cover important information, no audio-only goals.

Viewport rules: root `height:100dvh` with `100vh` fallback, safe-area padding, grid tracks `minmax(0,1fr)`, no fixed minimum height exceeding viewport. Hide document overflow only after every screen has adaptive content/navigation. Desktop 1366×768/1440×900; phone 390×844/844×390; small 320×568 and 568×320; test 200% text zoom with re-pagination. Page count calculated from available height and readable row size, preserving selection as pages change. At exceptionally short visualViewport from keyboard, enter dedicated single-field editing page with fixed Done/Cancel and return to previous focus. Do not clip CTA under keyboard. Fullscreen optional; gameplay still fits normal browser chrome.

Settings categories are separate pages: Flight, Controls, Audio, Graphics, Accessibility, Storage. Store versioned local settings and migrate safe defaults. Sliders have numeric value/keyboard input, quality offers Auto/Low/Medium/High, controls can reset per category. Help is paged short lessons, not a scroll manual. At 200% zoom reduce optional preview size and rows/page before reducing type. Overflow audits inspect children as well as body; `overflow:hidden` must not hide a failed layout.

Keyboard: visible focus, semantic buttons, focus trap only true modal, restore initiating focus, Escape closes one layer; do not hijack browser keys unnecessarily. Dynamic roster updates preserve focus/caret. ARIA live region only important state changes at polite rate, never 30 Hz telemetry. Distinguish unavailable/loading/error states with text and icons. Colorblind patterns/shapes for teams, readable contrast, reduced motion, configurable flash/shake, subtitles, large controls. Avoid rapid flashing above three times/second in UI; repeated gunfire effects remain subtle and adjustable.

## A6. Budgets, tests and integration gates

Initial targets, requiring measurement: desktop 1080p 60 FPS, midrange phone 30 FPS sustained. Desktop p95 frame ≤16.7 ms, phone ≤33.3 ms; render JS budget ~4/6 ms respectively, leaving GPU/DOM/sim time. Low tier ≤100 draw calls /150k visible triangles /128 MiB estimated GPU resources; medium ≤180/350k/192 MiB; high ≤250/700k/256 MiB. Shared resources counted once. Actual WebGL memory is not fully observable; report estimate plus context loss/process trends. Asset transfer target ≤15 MiB initial compressed build, no external CDNs/fonts.

Dynamic resolution checks rolling p95 every 2 seconds; step down after 3 bad windows, up after 10 good windows, DPR cap low 1 / medium 1.5 / high 2. Never alter hitboxes, obstacle visibility, contact eligibility or server step. UI DOM telemetry updates ≤10 Hz, frame-reticle canvas/Three as needed, roster only on revision. Handle WebGL context lost with status/released controls; restore assets/proxies and request fresh baseline before input resumes. No busy resource recreation during loss.

| A gate | Work and acceptance | B gate |
| --- | --- | --- |
| A1 | Shell/state/scope, mock fixtures, viewport token implementation | C0 contracts |
| A2 | All LAN screens, ready blockers, operator distinction, release/reconnect, rematch | C1 transport |
| A3 | Flight/touch/target/hazard HUD, predictable camera, baseline proxies | C2 collision/state |
| A4 | Physical modules, shared fit preview, weapon/resource feedback, audio | C2 gameplay |
| A5 | Campaign/votes/recovery, debrief/save/error, all settings/accessibility pages | C3/C4 persistence/story |
| A6 | LOD/shaders/profiling/device layouts, launcher guide and release evidence | C5 real LAN |

Automated browser tests must prove meaningful outcomes: every screen/page CTA reachable with no overflow at all listed sizes; keyboard traverses menus; touch two-pointer steer+fire and pointercancel release; resize/orientation/keyboard preserves active state; escape/blur stops input without stopping momentum on LAN; name markup stays text; focus survives roster edits; invalid fit preserves draft; HUD uses Mule/Needle fitted maxima; stale/dead/reconnecting views never show false target/respawn; score/debrief/save result survives duplicate events; second match has one RAF/subscription set and fresh epoch. Test 200% text scaling with actual larger text/layout, not merely a smaller screenshot. Use screenshot review for overlap/contrast and focus traces for reachability.

Run normal build/typecheck and existing meaningful tests after integration. Test shaders/WebGL on physical devices; software-rendered screenshots establish layout only. Perform B's Windows/Wi-Fi/Android/iOS matrix, 30-minute soak and 20 rematches, record FPS/draw calls/resources/listeners/errors and network context. Exercise full gameplay on Low to ensure cues remain visible. If hardware unavailable, record unverified gate explicitly.

Implementing agent records each gate's commit, linked B contract revision, screenshots at desktop/portrait/landscape, automated results, physical measurements and remaining failures. Done means a guest can scan a real QR, ready a legal fit, play/lose/reconnect, finish a mission or PvP round, see durable results and play again without stuck input, hidden controls or stale state.
