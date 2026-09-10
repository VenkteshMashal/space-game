# PLAN B — Authority, LAN, combat and the Quiet Signal campaign

Implementation handoff, 2026-09-10. Replaces the earlier Plan B. Read with [Plan A](PLAN-A-SHELL.md), [design index](design/README.md), [contracts](design/contracts.ts) and [catalog](design/data/catalog.json). The implemented `PLAN.md` is historical; its solo-only salvage, three-way PvP and seed-only moving rocks do not constrain this release.

## B0. Release and implementation audit

Deliver 1–8 human pilots in a six-mission cooperative campaign; offline campaign/skirmishes with bots; two-team deathmatch with up to 8 total combatants. Windows serves built assets and authority on one port; guests need only a browser. Host saves campaign, pilot fits and sector changes. PvP starts fresh with all parts available under a normalized 110-point budget. Internet matchmaking, voice, arbitrary construction, subnet scanning, seamless host-machine migration and a map editor are outside this release.

Co-op permits 8 humans plus at most 16 active enemies. Offline has 0–3 companion bots. PvP bot fill maintains a configured total of 2–8, balanced across teams. One active room/process and multiple selectable saved campaigns are enough. A campaign cannot have two writers.

Co-op companions occupy crew slots too: humans + companions ≤8, companions ≤3; human joins replace companions only at safe staging. Mission transports/escorts have a separate cap of 2, so the maximum active ship set is 8 crew +16 enemies +2 mission ships. New wave entries wait for capacity; a limit cannot delete a live objective ship.

Current baseline: pure flight, procedural ships, lit rocks, seeded maps, fractures, Bun WebSockets, lobby and initial prediction. Planning verification: 26 existing physics/world tests and TypeScript pass. This does not verify LAN stability or mobile performance.

| Existing location | Observed defect | Required regression |
| --- | --- | --- |
| server hello/start | Repeated hello refills/recreates players; readiness ignored; first arrival gets host | One handshake, operator claim, revision-locked launch |
| server input | Latest control held forever; sequence only checked as number | Finite safe integers and expiring input lease |
| net rocks | Collision-induced velocity changes never synchronized | Authoritative moving-rock state and baseline repair |
| main prediction | One 120 Hz replay step per ~60 Hz packet; interpolated ack | Tick history from latest authoritative self state |
| main lifecycle | Dead prediction, wrong fitted maxima, stale rematch state | Separate phase/life/presence and complete reset |
| server/UI | No capacity/schema/rate bounds; names interpolated into HTML | Bounded validation and text-only rendering |
| world collision | End-point bullets; background rocks block shots; no ship pairs | Swept relative-motion collision and layers |
| physics fit | Fractional defaults floor; inherited keys accepted | Exact own-ID membership and atomic validation |
| lobby | Focus drops updates, stale name/captain | Revision-driven state and isolated text drafts |

Reuse pure algorithms and models; do not create a second independent rules implementation. Update tests that currently assert obsolete boundary attraction or permissive fit clamping deliberately.

## B1. Ownership and shared state

B owns `src/shared/**`, `src/sim/**`, `src/server/**`, `src/client/session/**`, offline worker, persistence, launcher and simulation/protocol tests. Migrate physics/world/net/server through temporary re-exports. A owns main composition, UI, render, audio and device mapping. B must not edit A's render loop independently.

At gate C0 promote `design/contracts.ts` into the canonical shared source. Replace open event/prediction payloads with discriminated DTOs, and add runtime validators, exact binary codec, map and save schemas. Freeze field names, units, null behavior, revisions and error codes before parallel consumption. B supplies both SessionPort adapters and mock fixtures; A never reads a socket or mutates world state. Shared code imports no Bun/Three/DOM.

| State axis | Rules |
| --- | --- |
| Authority | lobby → loading → countdown → live → extraction (campaign only) → settlement → debrief → lobby |
| Local UI | Screen plus overlay; an overlay does not change authority phase |
| Pilot life | staged, alive, disabled, destroyed, respawning, spectating |
| Presence | connected, away, reconnecting, left; independent of life/captain |
| Link | idle, connecting, handshake, loading, online, reconnecting, failed |

Every match/mission has an opaque epoch; every body incarnation has a lifeId. Reject stale epoch/life commands. Lobby edits increment revision. Fit/team/map/mode/mission/rule changes invalidate affected ready acknowledgements; ping/presence updates do not. Start atomically checks captain, expected revision, all connected humans ready, valid fits, team rules and content. Duplicate request IDs return the original result. Captain can explicitly remove an unready seat, never silently mark it ready.

Loading deadline 30 seconds; failures see retry/leave. Captain can cancel or explicitly deploy without failed seats, who use late-join insertion later. Countdown is 3 seconds with neutral controls and no damage. Settlement stops combat, resolves result once, commits save and then shows debrief. Save failure blocks campaign advancement with retry/export. Captain advances LAN debrief; guests inspect/leave. Local offline pause freezes its authority; LAN menu only releases controls.

## B2. Windows launcher and Wi-Fi operation

Deliver `Start-DRIFT.cmd`, `scripts/start-host.ps1`, `Stop-DRIFT.cmd` and a short illustrated LAN guide. Resolve paths from script directory, including spaces/other working directories. Check pinned Bun, dependency/lockfile state and build/content hash. One-time setup installs/builds; prepared starts work without internet and never install on guests. Do not install dependencies on every launch.

Production binds `0.0.0.0`, default 8080, configurable 1024–65535. One port serves assets, `/health`, `/api/info`, bootstrap and `/ws`. Info exposes compatibility/availability, no tokens/roster/save paths. Static serving uses an absolute dist root and normalized containment checks; unknown assets return 404, supported UI routes return shell. Busy port produces a choice of another port; never kill its owner.

Enumerate IPv4 adapters with names, prefer physical Wi-Fi/Ethernet, flag VPN/virtual adapters, let operator choose. Do not assume first IPv4 is reachable. Advertise selected adapter while listening on all; regenerate displayed URL on address change. Show guest LAN URL and distinct operator loopback URL. QR uses a pinned local encoder, tested by decoding exact URL. No external QR service. Public QR never contains resume/operator secrets; private room code is included only through an explicit option. Manual select/copy is required where Clipboard write is unavailable on LAN HTTP. [MDN Clipboard](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)

Operator authority belongs to the Windows process, not first network arrival. Generate a random one-use operator claim in the local launch URL fragment, consume through a loopback connection, then erase fragment and never log it. Validate remote loopback address and allowed Origin; `Host: localhost` alone is insufficient. Claim assigns initial captain. Guests before claim cannot edit/start/kick. Captain transfers to oldest connected human with immediate roster update if captain disconnects; process and saves stay on Windows. Operator can reclaim control locally through a separate authenticated administrative session.

Guest seat admission remains closed with a Host preparing room response until operator claim/setup completes; otherwise eight early guests could prevent the operator obtaining a seat. Room codes grant admission only, never administration. LAN HTTP is a trusted-network deployment and does not encrypt credentials; internet/public-network hosting requires a separately configured HTTPS deployment, outside the launcher baseline.

Join accepts `host:port` or an http(s) origin; reject credentials, unsupported schemes, controls and arbitrary paths. Navigate to that origin before opening its same-origin socket. HTTP uses ws; HTTPS uses wss. Remove the dev client's hardcoded localhost socket; use an explicit dev proxy/same-host endpoint. Do not build a public HTTPS page that blindly probes LAN HTTP or WS. Browser private-network permissions evolve; prefer direct host navigation and explain permission failures, never disable browser security. [Chrome local network access](https://developer.chrome.com/blog/local-network-access)

| Failure | Recovery |
| --- | --- |
| Wrong Wi-Fi / isolated guest network | Bounded timeout; show same-network and AP-isolation guidance |
| Firewall | Local health works but guest fails; guide allowing executable on Private networks only; no blanket/admin change |
| Wrong NIC / VPN | Show alternatives and regenerate link/QR; no browser subnet scan |
| PC asleep / stopped | Bounded reconnect with last address; resume PC/start launcher |
| Full / bad code / incompatible build | Distinct pre-allocation rejection; reload only for build mismatch |
| Same pilot in two tabs | New authenticated generation replaces old; old close cannot delete new socket |
| Clipboard/gamepad/fullscreen unavailable | Manual copy, keyboard/touch, ordinary viewport remain usable |

No machine migration. Host crash resumes last committed checkpoint. Browser closure does not stop host process. Stop launcher calls authenticated loopback shutdown, waits for save acknowledgement and reports failure; never kills by executable name. Prevent two processes using the same data directory. Startup window can be visible for the operator's requested launcher; helpers started by implementation tools stay hidden.

## B3. Protocol and continuity

Use bounded JSON control and versioned compact binary snapshots behind a codec boundary. Pin tested Bun/runtime types and confirm installed API signatures. All control envelopes contain protocol version, type, roomId, epoch where applicable and requestId for mutations. Validate before allocation: own catalog IDs, exact enums, safe integer sequences, finite floats (including rejection of JSON `1e309`), bounded arrays/strings and actor/role. Normalize names NFC, 1–20 visible characters, ≤80 UTF-8 bytes, no control/bidi overrides; A uses text nodes. Reject malformed data; valid but incompatible/expensive fits return errors without silent changes.

Limits: 8 seats, 16 pending sockets, hello deadline 5 seconds, max client frame 16 KiB; input 80/s burst 120; commands 8/s burst 16; code/hello attempts 2/s per address with a bounded 60-second bucket that still admits eight guests behind one address; baseline requests 1/2 seconds per pilot. Repeated hello is invalid. Origin allowlist matches served origins and explicitly enabled dev origins. Production browser endpoint rejects absent Origin; diagnostics need separate authentication. Bind identity to connection generation, not client-supplied pilot ID. Never log secrets.

| Message | Required meaning |
| --- | --- |
| hello / welcome | Version/content hash, name, optional code/token → room/pilot/session IDs, rotated token, generation, phase, tick, roster |
| command / result | requestId, expected revision, typed intent → cached success or typed rejection |
| input / receipt | epoch, lifeId, seq, targetTick, complete intent → actual scheduled tick and applied ack |
| ping / pong | Echo nonce/monotonic timestamp plus server tick; client time never advances authority |
| baseline start/chunk/end/ready | Transfer ID/hash, epoch, tick T, map hash, delivery watermark, byte/count bounds; ready only after verified install |
| snapshot | Codec/epoch/baseline/state sequence/tick, own exact prediction state, entity sections |
| event | Recipient deliverySeq, stable eventId, epoch, tick, discriminated payload |
| resync / goodbye | Repair missing baseline/event continuity; typed single teardown/close reason |

Baseline captures immutable state after tick T: map descriptor, proxies, bodies/transforms/velocities/HP, cargo, objectives/timers, visible contacts, roster, own fit/resources and event watermark. Maximum 32 × 32 KiB chunks (1 MiB); authored limits must fit. Hash/count verification precedes install. Keep post-T events and recent snapshots during transfer; ignore ≤T state already included, replay later events in order, then newer snapshots. Ready means immediate collider meshes are available, not decorative texture completion. If log retention expires, cancel/restart at newer T. Never mix seed time and moving-rock time.

Critical replay log cap 4 MiB or 10 seconds per room, with recipient cursors. Event IDs deduplicate; per-recipient delivery sequence avoids false gaps from sensor filtering. Resync slow clients before eviction. WebSocket order does not guarantee continuity across reconnect. Creation/destruction/roster/objective/results are never dropped to prefer newer events: a complete verified baseline may replace old history. Only sparks/audio can be discarded.

At C0 finalize exact codec byte offsets and golden fixtures: little-endian fixed header magic/version/type/length/epoch-table-ID/baseline-ID/state-seq/tick/event-watermark/counts; entity key uint32 ID + uint16 generation + uint16 field mask. Wire positions/velocities/angular state float32; simulation JS numbers. Declare scale/error for any health/resource quantization. Keep required self prediction values lossless until replay tests prove otherwise. Do not round every numeric field to two decimals. Test truncated frames, excessive counts, unknown version, length overflow; begin a new epoch before tick/seq uint32 wrap. Fit/name metadata travels once with revision, not every frame.

Backpressure retains one unsent replaceable snapshot/client, ≤256 KiB pending critical data and ≤512 KiB socket buffered data. Already queued Bun bytes cannot be replaced: stop sending until drain. Bun send return -1 means enqueued; do not resend. Treat zero according to the pinned API as unsent/failed. Drain resumes newest state; >2 seconds congestion triggers recovery baseline or typed slow-client close. Configure max payload/idle timeout explicitly; heartbeat every 5 seconds in lobby, stale after 15 seconds. [Bun WebSockets](https://bun.com/docs/runtime/http/websockets)

Resume tokens have ≥128 random bits, hashed server-side, scoped to room/pilot. Rotate on resume; previous token valid for 10 seconds to recover a lost welcome while generation permits only one active connection. Session storage default, explicit remember-device opt-in for persistence; clear on leave. Control commands additionally have monotonic per-session command sequence: retain ≤1024 result receipts/pilot for 10 minutes and reject already-processed sequences outside retention as Receipt expired, never reapply. Financial/mission receipts remain durable for campaign and are queried by request ID.

Persistent pilot ownership is distinct from short-lived room resume. On first campaign enrollment mint a host-scoped pilot credential, store its hash with pilot ID in the database and offer remember-device or a one-time recovery code. A returning pilot authenticates it after process restart to reclaim reservations/loadouts, then gets a fresh room token/baseline. Display names never authenticate ownership. If credential lost, operator can explicitly reassign a pilot while revoking old credentials; otherwise guest gets a new loaner identity. Changing host address/browser origin requires recovery code or operator reassignment; do not promise browser storage follows IP changes.

Disconnect reserves seat/body for 60 seconds. Clear input at detection; lease covers undetected loss. Body coasts, collides, remains vulnerable and retains score/cargo/death outcomes. No invulnerable freeze, free heal or bot rescue during grace. After grace, campaign abandonment uses ordinary recovery/tow cost; PvP resolves an abandonment death with ordinary recent-attacker credit, removes that body through the authoritative destruction event, then permits fresh bot/human insertion. This keeps the 8-combatant cap and cannot create two bodies for a returning pilot. Already destroyed bodies incur no second death. Explicit leave forfeits grace; A confirms live departure.

Retry with jitter 0.5/1/2/4/5 seconds until grace ends, cancellable, new baseline before control. Error/close/timeout use one idempotent teardown. All co-op humans absent: resolve 60-second vulnerable interval, checkpoint and pause authority; no logout exploit while others fight. Empty PvP after grace ends no-contest. Sleep/stall >2 seconds invokes resync, not hundreds of catch-up steps.

## B4. Timing, prediction and visibility

120 Hz authority, 60 Hz input, 30 Hz ship snapshots, 10 Hz moving rocks. Monotonic time, maximum 8 catch-up steps/loop, overload telemetry. Under temporary overload simulation time slows consistently; never enlarge physics timestep or let clients choose clocks. Overload >3 seconds warns operator and blocks new deployments. Reduce render/AI planning work, not physical correctness.

Input algorithm is mandatory:

1. State(T) includes tick T. Client estimates authority time from ping/snapshots, sends full intent at most once per two ticks, but records prediction **every tick**, including held controls.
2. Server schedules monotonic seq at max(targetTick,currentTick+1), rejects >12 ticks future or >30 ticks old; returns actual applyAtTick. Highest seq wins same-tick conflict; superseded frames receive receipts. Queue ≤16. Never run extra steps for client elapsed time.
3. Apply scheduled intents then hold until next or 30-tick lease expiry, based on accepted arrival time. Expiry clears thrust/turn/strafe/brake/boost/fire. Angular-assist setting may remain, with real fuel cost. Explicit release applies next tick and cancels older queued frames. Coasting does not mean zero velocity.
4. Own snapshot at T contains body, module health, ammo/cooldown/charge/resources, active input/apply tick, future accepted queue, highest received and applied seq. Received is not applied. Discrete interactions require request-ID confirmation.
5. Reconcile every newer **authoritative** snapshot, even unchanged ack, never interpolated render state. Replay T+1…predicted present using authoritative held/queued intent plus pending frames at known/provisional schedule; receipts correct late scheduling. Keep 256 ticks, reset if history insufficient. Correct velocity/angle/angular velocity/fuel/heat/assist as well as position.
6. Predict only own flight and provisional cosmetic shots, never score/damage/inventory. Known obstacle response is provisional; remote outcomes correct it. Life/epoch/teleport/baseline resets history; dead bodies cannot run local flight.
7. Correct physical state immediately; separate visual offset decays ~100 ms for small error, snaps beyond 25 m/life/teleport/collision discontinuity. No invisible corrected colliders while mesh remains far away.

Remote history has 64 server-tick snapshots. Start delay 100 ms, adapt 50–150 ms to jitter with hysteresis. Extrapolate ≤100 ms then show stale/hold. Interpolation cannot overshoot known solid geometry; use linear fallback near collision. This is latency tradeoff, not zero-latency LAN. [Snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/)

Moving rocks send authority transforms at 10 Hz plus immediate collision/split changes, with a 2-second known-rock reconciliation sweep. Static distant rocks use baseline/versioned mutation. Interest region includes view plus speed × timing horizon and one hull length; include intersecting large objects even if center outside. Hash ordered IDs/fields at common tick, and repair mismatch with baseline; loose aggregate hash/logging is insufficient.

Do not include every ordinary bullet transform in every snapshot. Ballistic visuals reconstruct a confirmed spawn tick/position/velocity/TTL until authoritative impact/despawn; no client hit decisions. Late visibility/late join gives current trajectory plus original shot identity. Torpedoes get 30 Hz guided motion, drifting mines 10 Hz; changing trajectories get explicit correction. Beams receive authoritative first-hit endpoint updates while active. Baseline includes every relevant live projectile. This rate split is necessary for the 6 KiB state target at high fire rates; benchmark event bytes together with snapshot bytes, not just one channel.

Sensors govern enemy information. Exact hidden enemy transforms/locks are not sent then merely hidden in UI. Friendly ships and physically visible silhouettes are public; farther detections use uncertainty/age. Nearby unseen solids may expose anonymous collision proxies without identity/target eligibility. Clear expired contacts. Client graphics quality changes neither detection nor collision eligibility.

## B5. Physics, maps in motion and collision

XY is gameplay, Z appearance only; one unit = one metre. Angle zero faces +Y, forward `(-sin θ, cos θ)`, radians counterclockwise. Model length/beam must match declared physical extent; camera scaling is separate. No air drag or magical boundary attraction. Angular assist uses RCS; brake deliberately consumes fuel to cancel velocity. Translation changes only through thrust, recoil, tether and collision impulses. Accessible tuning is intentional, not an engineering-grade spacecraft simulator.

Wet mass = chassis + modules + remaining fuel + cargo + ammunition. Add round mass to catalog at C0. Inertia uses hull approximation and parallel-axis contributions from slot positions. Recoil acts at hardpoint, changing both linear/angular momentum. Projectile muzzle velocity inherits ship velocity plus angular tangential velocity before ejection velocity. Torpedoes/mines inherit drift before propulsion. Mass changes cannot create unexplained impulses.

Initial flight coefficients: reverse 0.28, lateral 0.22, brake 0.65 of available torch force; boost 1.65 with proportionate reaction mass and extra heat. RCS torque budget Needle 4, Kestrel 8, Mule 12 MN·m, divided by current inertia for angular acceleration. Full-turn RCS costs 1.2 kg/s, lateral 3 kg/s, brake up to 16 kg/s, added to catalog main-drive consumption. Use hull inertia `m × (length² + beam²) / 12` plus part offsets as the initial approximation without counting part mass twice. Freeze measured turn/stopping response at C2 playtest; zero fuel means no powered assist.

Choose a documented oriented capsule or 2–3 convex hull polygons at C0; use same proxy for CCD, debug draw and hangar. Rocks have conservative class-specific convex/circle proxies. Station ribs are solid, docking/relay openings are genuine gaps, not one giant circular collider. Background scenery is a separate non-colliding layer.

| Pair | Collision rule |
| --- | --- |
| Ship–ship/rock/station | Solid impulse and speed-dependent damage; team-independent |
| Projectile–ship/rock/station | Earliest swept hit; consume unless explicitly penetrative (no rail penetration in v1) |
| Projectile–projectile | PDC/flak may destroy torpedoes/mines; no all-bullet pairwise checks |
| Beam | Nearest solid hit at bounded range each damage tick |
| Cargo/tether | Physical mass, low restitution, capped forces; no teleport |
| Z scenery/sparks | Never physics or objective targets |

Spatial hash uses swept AABBs, multi-cell insertion, pair deduplication and stable ID order. Benchmark 64/128/256 m cells, start 128 m; large station proxies use a separate static index. Bullet CCD solves relative motion/earliest TOI including moving/rotating targets, overlap and grazing. Fast ships/rocks also require swept broadphase and conservative advancement. Up to 4 TOI contacts/body/tick; exhaustion stops unresolved movement at last safe contact and logs a counter, never silently tunnels/deletes. Test inherited speed, opposing motion, zero relative motion, spawned-inside rounds, rotating hulls, simultaneous hits and ties.

Impulse solver uses inverse mass/inertia, lever arm, contact normal, low restitution (initial 0.15 ships / 0.25 rocks), slop correction and bounded friction. Collision damage is a tuned function of lost impact energy, not an extra physical impulse. Server ordering must be repeatable; cross-browser bitwise lockstep is unnecessary.

Fracture children inherit COM/angular motion and equal/opposite kick impulses; dust explicitly carries missing mass/momentum. Verify finite radii and conservation including dust. Maximum 256 physical rocks including fragments. If split would exceed cap, retain visibly cracked coarse body with reduced HP until safe to fragment. Never remove an active obstacle merely to meet render budget. Small settled fragments may visibly decay only when not overlapping/holding objectives. Every new collider immediately gets a cheap visible mesh; detailed mesh generation can lag.

Safe spawn scores authored positions for occupancy, swept projectile hazards, LOS, enemy distance and escape space; seeded tie-break, then fallback ring search. If none safe, stage in visible insertion corridor. PvP respawn 5 seconds; 2 seconds visibly marked weapon-damage protection ending early on fire or exit. Collision remains solid/damaging, so protection cannot become ram immunity. Clear all old triggers on life change. Co-op late join inserts at carrier/checkpoint with same safety checks.

Boundary: warn at 90% radius; outside starts 15-second return timer cancelled on re-entry. No invisible pull. PvP expiry records one death with recent-attacker credit, then respawn. Campaign emergency-tows to carrier, consumes ordinary recovery allowance, leaves optional cargo at reachable beacon and restores critical cargo at a reachable anchor. Never allow an objective to drift permanently out of bounds.

## B6. Modular fits, weapons and interacting resources

[Catalog](design/data/catalog.json) supplies initial hypotheses: three chassis, seven weapons, alternative drives/reactors/armor/sensors and six utilities. Exactly one engine/reactor/armor/sensor; weapon slots `w1…` sized by hull; optional utility slots `u1…`. At least one weapon, at most one of each utility. Fixed guns have ±15° gimbal, PDC ±160° with hull occlusion, mines eject aft. Two fire groups; auto-defense PDC cannot also fire manually in the same tick.

Campaign fit reserves unique module instances. Validate full transaction against revision, ownership, sizes, wet-mass limit, budget and finite derived stats. Invalid edits return exact errors and leave previous build intact. Fit only in lobby or authority-confirmed docked intermission. Destroyed modules retain reservation until repair/replacement. Paint/custom names are validated cosmetics; no uploaded textures/scripts.

Derivation order: additive chassis/part values → physical mass/inertia → named multiplicative effects once in sorted ID order → documented clamps → dependent stats. At C0 express effects through typed `add`/`multiply`/condition operators, never eval. Duplicate exclusive effects invalid; resistance cap 35%, minimum cooldown 0.06 s. Canonical hash includes catalog version/sorted slots. UI/server use same function. Show full-fuel acceleration, stopping distance, sustained heat balance and simultaneous fire-group demand, not only upgrade bars.

Auxiliary reactor MW is electrical service power; torch thrust uses its own drive energy/reaction mass. Do not claim a few MW electrically produce meganeutons. MW × seconds = MJ. Hull base idle 0.5 MW; activeMW is additional to idle. Idle demand must fit supply. Peak demand may exceed supply: fixed player-configurable priority allocates life support/flight first, then groups/utilities, boosted sensor and capacitor charging; low-priority action visibly browns out, never silently changes the fit.

Capacitor uses surplus supply capped at 2 MW base plus pulse-bank chargeLimitMW. Rail reserves full energy at charge start, spends on shot, returns unused reserved energy on cancellation while retaining generated heat. Loss of fire/power/valid target cancels charge. Heat integrates continuous reactor/drive/beam power + shot heat − cooling, floored at ambient zero. Warn at 85%, block boost/hot weapons at 100%, recover below 70%; essential RCS/recovery remains usable. Radiators increase cooling and detection signature. Module health <30% gives 50% output, zero disables; penalties applied from base, not compounded each tick.

| Weapon | Behavior and counter |
| --- | --- |
| Rivet 30 | Ballistic stream, inherited velocity, magazine/reload; armor and cover counter |
| Warden PDC | Server chooses detected incoming torpedo/mine by time-to-impact within LOS/range; finite ammo, no arbitrary bullet erasure |
| Lance rail | Charge/capacitor/recoil, fast swept projectile, telegraphed charge and thin trail; no penetration |
| Halo flak | One shell with arming delay/proximity fuse, LOS/falloff blast; cosmetic fragments rather than dozens of physics bullets |
| Pilgrim torpedo | Finite burn then coast, turn limit, seeker/LOS, PDC/ECM counter; lost lock flies last course without hidden coordinates |
| Anchor mines | Inherit drift, 2-second arming plus owner clearance, six/owner, finite TTL; detected hazards clearly marked |
| Suture cutter | Short first-solid-hit beam, continuous power/heat, strong rock damage/modest ship damage |

Authority owns ammo, reload, cooldown, charge, resources and module damage; saves them. Reload begins explicitly or on empty trigger, pauses when module disabled, cancels on replacement. Validate life/phase/muzzle clearance/resources/entity admission before spending. Maximum 512 projectiles, 64 slots reserved for torpedo/mine class; six mines and four torpedoes per owner. On admission failure return “Weapon traffic limit” without spending ammo/energy, never splice oldest live rounds. Beams use no projectile slot. Tune normal eight-player fire to rarely encounter the cap.

Friendly weapon damage defaults off, but allies still block shots/beams. Blasts spare allies in that setting. Owner damage possible after arming; team IDs captured at fire time. Module hit zone determined by impact point, never client claim. Begin with four hull zones mapped to slots in hangar. No firing inside station service volumes; dock denied if hostile within 300 m or damaged in last 5 seconds. Dock clearance/queue still physically applies.

Repair consumes stock one unit/hull point, ≤4 hull/s within 100 m. Tether applies equal/opposite capped spring-damper force and breaks at catalog limit. Every hull has slow 30-second emergency beacon/tow, so a purchased utility is never mandatory. Grapple improves optional cargo/speed; every ship collects quest archives. ECM spends charge, makes a seeded seeker/decoy contest, not guaranteed invisibility. Active scan reveals emitter to sensors within active radius. Ability timers use authority ticks.

Sensor starting rules: unobstructed visual silhouettes within 700 m are public; passive detection range scales catalog passiveRange by target signature clamped 0.5–1.5 (coast 0.6, normal burn 1, boost 1.4, radiator multiplier). Active scans reveal eligible LOS targets to catalog activeRange and expose the emitter. Occluded contacts age to uncertain last-known positions for 3 seconds, then expire; cannot lock/fire guided weapons on uncertain contact. Torpedo lock takes 1 second continuous LOS/detection, interrupted after 0.25-second gap. ECM contest begins at 60% decoy chance versus standard seeker, reduced to 40% by survey support, sampled once per torpedo/decoy activation; losing seeker flies last course for 1 second before reacquisition. These are explicit initial balance values to tune through C2, never client-side hidden advantages.

## B7. Rules for every player, bots and recoverable loss

### PvP

Two teams ≤4 each; score 30, time 10 minutes, respawn 5 seconds. All parts under 110-point budget; no campaign advantage. Same immutable arena per seed. Team difference ≤1; captain balances only before readiness. Live join enters smaller team at safe spawn. Human replacing bot waits for its life to end or removes it at safe staging, never inherits its health/score.

Team score is an append-only match ledger, independent of present roster. Hostile kill +1; environment/suicide 0 unless hostile damage within 10 seconds. Most recent eligible attacker gets kill; other attackers with ≥10% victim max-hull damage in window get assists. Friendly collision cannot farm score. Departed pilots remain in debrief. Resolve all hits at winning tick before evaluating result. Timeout tie → 90-second sudden death; first unequal end-of-tick score wins; still tied is draw. One empty team after grace forfeits; both empty no-contest. No PvP mutation of campaign maps/inventory.

### Bots

Bots use ordinary intent/interaction commands, never write health/ammo/position. Stagger strategy at 10 Hz, steering at 30 Hz, physics 120 Hz. Separate seeded RNG streams for mission, fracture and each bot. Roles escort/scout/suppress/rescue; all can finish critical objectives. Finite reaction delay easy 350 ms / normal 220 / hard 120, bounded aim error and same sensor/LOS/lock rules. Hard improves planning, not damage or omniscience.

Steering uses relative velocity, arrival speed, `v²/(2a)` stopping distance and swept avoidance corridor. Stuck 8 seconds reroutes, 20 seconds requests ordinary tow. Bots dock/resupply/rescue/recover archives. Crew commands: focus, defend, recover, regroup, available by touch. Bot votes never outweigh humans. Do not delete active enemies under load; defer new waves or change planning frequency within budgets. Co-op late joins scale only future waves: `ceil(base × (1 + 0.45 × (activeHumans−1)))`, at most 16 active enemies, never rescale existing HP.

### Campaign economy and life

Shared credits/inventory/mission receipts; pilot fits reserve instances. Start 200 credits and free loaner fits for every admitted pilot. Shop price part cost ×10 credits; repair 1 credit/hull, documented ammo/restock prices. Loaner deployment gets free baseline fuel/ammo/repair so insolvency cannot block play. Rewards paid once to shared wallet, never multiplied by player count. Late joins get loaner and participation, not duplicate credits.

At zero hull emit one destruction, create recoverable wreck, eject non-combat rescue beacon, spectate. Redeploy loaner after 15 seconds at carrier/checkpoint. First recovery/pilot/mission free, subsequent 20 credits when affordable; with no credits permit loaner but forfeit optional cargo. Unrecovered owned modules return as damaged inventory with 25% replacement-price repair; never delete last usable fit. Critical cargo atomically transfers to reachable recovery beacon and cannot be sold/permanently destroyed. Wreck salvage cannot duplicate reserved modules.

All humans destroyed: choose retry checkpoint or return carrier, 20-second human vote default retry; bots cannot auto-complete objectives alone. Reset attempt resources/optional loot to checkpoint while retaining already committed receipts, preventing farming. Solo never requires simultaneous switches or a specialized paid part. Explicit restart abandons uncommitted optional loot.

## B8. The Quiet Signal campaign

The Wayfarer salvage cooperative keeps an isolated settlement alive. Cinder raiders seek an archive containing a nonhuman maintenance protocol. The Witness Array is ancient machinery obeying a repair mandate: initially neutral, reacting to intrusion, understandable through play. Alien effects use existing mechanical/thermal/signature rules, not unexplained invincible shields. [Relay visual guide](design/assets/witness-relay.svg).

Linear M1→M2→M3→M4→M5→M6 with two recorded choices; branches reconverge with equal power access. Target 8–15 minutes/mission on normal, subject to playtesting. Data definitions include objective graph, triggers, spawn groups, subtitle IDs, success/failure/recovery transitions and reward receipts. Locally bundled subtitle-first dialogue is interruptible/replayable; no runtime content generation or internet dependency.

| Mission / sector | Exact objective sequence | Recovery / committed result |
| --- | --- | --- |
| M1 Ghosts in the belt / belt | recover-a,b,c in any order → return-archives. Teach drift/brake; raider pair after second archive. | Archives become reachable beacons if lost; wipe retries. 120 credits, archive receipt, wreck removals; unlock M2. |
| M2 Borrowed light / quarry | rendezvous-vesper → escort-leg-1 → clear-route → escort-leg-2 → dock-vesper. Fuel transport and repair stop. | Zero hull disables transport; tow-vesper alternative, emergency tug after 45 s. 160 credits, resupply upgrade and route change. |
| M3 Listening stone / relay | scan-north,south,core (3 s each, <120 m, relative speed <15 m/s) → translate (10 s) → withdraw. Custodians warn once on attack, defend on rib destruction. | Backup nodes preserve scan route. 180 credits, discovered relay/hostility flag. |
| M4 Terms of silence / relay | recover-survivors (two pods) → decide-shelter-or-harvest → defend-tender OR extract-sample → return. | Lost pods become beacons. Shelter gives M5 escort; harvest +60 credits/cosmetic scan pattern. Both same parts/progression; base reward 180. |
| M5 Closed circuit / conduit | deliver-cell-a → repair-a → deliver-cell-b → repair-b → hold-relay (60 s) → extract. Sequentially solo-solvable. | Lost cells return at carrier after 20 s; finite waves ≤16 active. 220 credits, repaired conduits and safe corridor. |
| M6 A long way home / homebound | escort-evacuation → break-blockade → decide-broadcast-or-seal → charge-gate (45 s, repairable couplers) → extract-crew. Prior choice changes ally/dialogue. | Destroyed transports leave pods, lose optional bonus only. 300 credits once, ending/sector dressing, repeatable contracts. |

Objectives locked/active/complete/failed have stable IDs and idempotent predicates. Count unique item IDs, not button presses. Interaction checks distance, LOS, relative speed, alive state and exclusive ownership. Concurrent recovery gives one success and one Already recovered. Shared scan/repair progress caps at 2× solo rate; departure does not erase work. Dock requires <10 m/s and within 30° berth heading, clear berth, visible queue for simultaneous arrivals.

Votes snapshot connected eligible humans at start, one vote/pilot, 30 seconds, majority of cast votes; tie/no votes uses displayed conservative default shelter/seal. Reconnect may vote before deadline; late join spectates current vote. No captain override after decision. Commit decision ID once. Place story choices at safe windows; dialogue never freezes an individual LAN body.

Extraction allowed only by completed graph, requested by human and confirmed captain, 45-second return window. All surviving humans docked ends early. Expiry tows remaining crew under standard recovery, returns quest cargo and settles once; optional loose loot stays in sector. Failure never advances story. Completed-story replay is simulation/training with no first-completion reward or map mutation. Postgame contracts get unique IDs, 60–100 credit rewards and bounded generated objectives using validated authored anchors.

## B9. Map storage, campaign saves and crash consistency

Map descriptor: schema/map/content/generator versions, uint32 seed, coordinate bounds, collision layers, authored proxies/static bodies, spawn sets, docking volumes, objective anchors, navigation corridors, baseline hash. Preserve belt/quarry/expanse identity; ≤160 initial physical rocks, extra quarry detail decorative. Add relay/conduit/homebound overrides. Validate clearance/reachability for largest hull at every spawn/critical anchor. IDs derive from version/seed/index; children parent+generation/index, never reuse ID within epoch.

Persist immutable baseline plus deltas: tombstones, moved transforms/velocities, fractures, unique recovered cargo, station repairs, faction state, mission flags. Materialize initial generated geometry/proxies when campaign starts so a generator update cannot change saved space. Old data migrates with explicit mapping or uses materialized baseline; unsupported saves preserve original bytes and show error.

Host database default `%LOCALAPPDATA%\DRIFT\host`, explicitly configurable, outside OneDrive project. SQLite tables: campaigns, pilots, module_instances, fit_reservations, sectors, checkpoints, mission_attempts, objective_receipts, reward_receipts, decisions, schema_migrations. Unique first-completion reward per campaign/mission; unique collection per attempt/objective/item; unique instance reservation. Transaction commits inventory/reward/objective/sector changes together. Use WAL and a bounded writer-worker queue of immutable checkpoint DTOs; synchronous database work must not stall 120 Hz. Profile serialization on main loop too. [Bun SQLite](https://bun.com/docs/runtime/sqlite)

Checkpoint every 15 seconds, at safe objective transitions, deployment and settlement; retain latest plus two verified predecessors. Save tick, RNG streams, mission graph/timers, body transforms/velocities/HP, module health/ammo/cooldowns/charge, items/ownership, score ledger, pending deterministic actions and baseline revision. No sockets/DOM/Three/wall-clock timers. Capture coherent tick boundary. Coalesce periodic pending snapshots, never settlement transactions. Saved requires commit acknowledgement. Crash loss bounded by last acknowledged checkpoint, whose timestamp is visible if writer delayed.

Full disk/permission failure retains memory state, blocks new campaign transition, offers retry/export/explicit unsaved exit. No unbounded retry or duplicate grants. Startup checks integrity/version, falls back to prior verified checkpoint, retains corrupt file. Before migration use SQLite-safe backup, not copying live main DB without its WAL. Export known DTOs to bounded JSON/zip; import ≤16 MiB validates count/enum/coordinates/IDs/hash and safe archive paths, no executable content/external URLs, imports new campaign ID rather than merging untrusted receipts.

Offline runs same kernel/DTOs in worker with IndexedDB transactions, separate campaign namespace. Prepared assets run without internet while local launcher/static server runs. Do not promise cold reload of an unhosted page or LAN-HTTP service worker. Export/import explicitly transfers campaigns; divergent timelines never merge automatically.

## B10. Budgets, sequencing and proof

Targets to measure, not claims: representative 4-core Windows laptop, p95 tick ≤3 ms, p99 <8.33 ms, host process <512 MiB excluding browser. Ship snapshots ≤6 KiB/client ×30 Hz plus rocks ≤4 KiB ×10 Hz = ~220 KiB/s/client, 1.72 MiB/s (~14.4 Mbit/s) for eight before TCP/Wi-Fi overhead. Target aggregate steady payload <2 MiB/s; measure actual busy traffic/uplink, reduce redundant fields/interest frequency if missed. Inputs <20 KiB/s/client; baseline bursts scheduled separately. Eight tabs on localhost are not Wi-Fi evidence.

Benchmark spatial hash alternatives, serialization/allocation, eight simultaneous mixed weapons, cap-level fractures, 8 crew+16 enemies, slow client and baseline during battle. Network profiles: 10–40 ms healthy RTT; 80/150 ms RTT with ±30 ms jitter, retransmission loss, bandwidth cap and 2-second stall. WebSocket TCP loss causes head-of-line delay; do not model it as independent unordered UDP packets. Label synthetic delay proxy limits and test real impairment before release.

| Gate | Deliverable/proof | A dependency |
| --- | --- | --- |
| C0 | Typed DTOs/codecs/validators, units, map/save schemas, catalog derivation, mock SessionPort | A1 shell fixtures |
| C1 | Operator/lobby/bootstrap/lease/prediction/reconnect | A2 lobby→flight→loss→resume |
| C2 | CCD, rocks, spawn, all weapons/resources, score ledger, bots | A3/A4 combat/hangar |
| C3 | Host/local saves, transactions/crash recovery, import/export, network budget | A5 save/error/debrief |
| C4 | All six graphs/choices and solo/late-join recovery paths | A5 campaign polish |
| C5 | Launcher, physical LAN/phones, impairment/load/soak and final presentation | A6 acceptance |

Mandatory outcome tests:

- Multiple packet cadences and delayed receipts apply the intended number of ticks; unchanged ack still reconciles. Lease/blur/background clears thrust/fire while momentum persists; dead/new life rejects old actions.
- Repeated hello, Infinity, malformed binary counts, inherited IDs, forged actor, stale revision, 9th seat, 17th pending socket and bad Origin bounded/rejected. UI cannot render name markup.
- Baseline during fracture/join, duplicate/gapped events, collision-moving rocks, congested queue and reconnect recover authoritative per-entity state at a common tick; no loose aggregate tolerance.
- Variable FPS/input Hz, 150 ms delay, interrupted history and server sleep correct velocity/angle/resources without runaway replay. Browser timer throttling is covered by server lease.
- CCD pairs/grazes/rotation/overlap, scenery exclusion, blast LOS, arming, PDC contention, fracture conservation/cap and occupied spawns match rules.
- Captain transfer, bot replacement, reconnect death, simultaneous winning kills, departed score, finite sudden death, empty team and 20 rematches preserve lifecycle.
- Concurrent salvage/purchase/dock, repeated settlement, crash before/after commit, disk full, corrupt checkpoint, generator upgrade/import preserve ownership and never double-pay.
- Complete all six missions solo loaner, eight humans, late join at each objective and critical item/carrier/crew loss. Both branches end and unlock contracts. Automate graph outcomes, playtest pacing/clarity.

Physical release matrix: Windows operator, two desktop browsers, physical Android Chrome and iOS Safari, expand to eight seats and disclose real-device/headless mix. Test portrait/landscape, screen lock/call/background, steering+fire, QR decoding, room code, guest-network failure, firewall guide, VPN/two adapters, occupied port, host browser close, PC sleep, process kill/restart and graceful stop. Run 30-minute combat soak and 20 lobby/match cycles; A measures GPU/DOM/listeners, B tick/queues/bytes/entities/save. If devices unavailable, C5 stays explicitly unverified.

Implementing agent records per gate: commit, contract changes, tests, hardware/browser/network measurements, unresolved failures and linked A gate. Finish launcher, local dependency assets, operator guide, save backup/import instructions and reproducible release build. A feature is complete only when authority, UI, persistence and failure paths all pass.
