# PLAN — AstraWars / DRIFT: LAN multiplayer, combat, breakable asteroids

Audience: the implementing agent. Written after reading every file in `src/`, `tests/`, `scripts/`.
Style rule for this repo: **laziest thing that actually works.** Reuse `src/physics.ts`, do not rewrite it.

---

## 1. How the game works today

Stack: Bun + TypeScript + Vite + Three.js. No backend. No framework. ~1600 lines total.

| File | Lines | What it actually does |
| --- | --- | --- |
| `src/physics.ts` | 147 | **Pure, deterministic, DOM-free, Three-free.** `SHIPS` stat table, `ShipState`, `stepShip()`, `Obstacle`, `createObstacles()`, `resolveCollision()`, `canRecover()`, `canDock()`, `randomSeed()` PRNG. This is already a headless simulation core. It is the load-bearing file for multiplayer. |
| `src/main.ts` | 414 | Injects the whole HUD as one `innerHTML` template, holds **module-level singleton game state** (`let state`, `cargos`, `obstacles`, `elapsed`, `paused`…), keyboard/pointer input, the fixed-step loop `frame()`, dialogs (`openDialog`/`closeDialog`), toasts, contacts list, world-space label markers. |
| `src/scene.ts` | 210 | `SpaceScene` class. Orthographic camera, lights, starfield, moon, baked dust backdrop. **Builds all rocks and cargo once in the constructor and indexes them by array position.** `render(state, cargos, target, dt, time)` takes exactly one ship. `project()` maps world→screen for HTML markers. |
| `src/models.ts` | 217 | Procedural Three.js geometry: `buildShip(shipClass)` (hardcoded hull/armor/engine boxes, `wide` scalar per class), `buildAsteroid(radius, seed)`, `buildStation()`, `buildCargo()`, `disposeObject()`. One shared `asteroidMaterial` singleton. |
| `src/textures.ts` | 64 | Canvas-baked rocky + backdrop textures. |
| `src/audio.ts` | 43 | One oscillator through a lowpass. Optional. |
| `src/previews.ts` | 26 | Offscreen render of ship cards for the shipyard dialog. |
| `src/icons.ts` | 24 | Inline SVG strings. |
| `tests/physics.test.ts` | 93 | `bun test`. Newtonian invariants + collision/recovery boundaries. **These must keep passing.** |
| `scripts/browser-check.mjs` | 104 | Playwright smoke test against the dev server, writes `artifacts/`. |
| `scripts/mission-run.mjs` | 102 | Playwright full-mission run. |

### The simulation loop today (`main.ts:frame`)

```
requestAnimationFrame(frame)
delta = min((now - lastFrame)/1000, 0.25)
accumulator += delta
while (accumulator >= 1/120):
    stepShip(state, input, 1/120)
    elapsed += 1/120
    for rock of obstacles: resolveCollision(state, rock)   // O(rocks) every tick, 90 rocks
    accumulator -= 1/120
scene.render(...); updateLabels(); updateHUD() (throttled to ~12 Hz); sound.update()
```

Input is read straight off a `Set<string>` of key codes into a `FlightInput` literal each frame.

### What is already right for multiplayer

- `stepShip` is a pure function of `(state, input, dt)`. Fixed 120 Hz. No `Math.random`, no `Date`, no DOM.
- `FlightInput` is already 5 tiny fields — it *is* the wire input packet.
- `randomSeed(seed)` is a seeded PRNG, so `createObstacles()` is reproducible on server and client.
- Rendering is fully separated from simulation.

### What blocks multiplayer

1. **Singleton state.** `main.ts` has one `state`, one `cargos`. There is no concept of "entity" or "player id".
2. **Scene is static.** `SpaceScene` builds rocks in the constructor with no add/remove path, and `render()` takes one `ShipState`.
3. **No weapons at all.** Nothing fires, nothing takes damage except hull-vs-rock.
4. **Rocks are immovable and indestructible.** `Obstacle` has no velocity, no hp, no id. `resolveCollision` assumes infinite rock mass.
5. **No bounds.** Space is infinite; a player can fly away forever.
6. **Ships are a frozen 3-entry const.** No customization surface.
7. **No transport, no server, no lobby.**

---

## 2. Scope decisions (read before writing any code)

We are building **basic LAN multiplayer + breakable asteroids + guns + teams + lobby**. Every line below is a deliberate "no" that keeps the diff small. Do not silently re-add these.

| Tempting | Decision | Add it when |
| --- | --- | --- |
| socket.io / colyseus / geckos.io / WebRTC | **No.** Bun has a built-in WebSocket server. TCP is fine at LAN RTT (~1 ms). | Never, for LAN. Only if internet play is ever wanted. |
| Binary/bitpacked wire format | **No.** JSON with 2-decimal rounding. ~10 KB/snapshot at 8 players. | Snapshot exceeds ~64 KB or profiler shows JSON cost. |
| ECS library | **No.** Three plain arrays and a `Map`. | Never at this entity count. |
| Rollback / lag compensation / server reconciliation with rewind | **No.** LAN. Simple prediction + snap in Phase 6. | Internet play. |
| Spatial hash / quadtree broadphase | **No.** O(ships × rocks) and O(bullets × rocks). At 8 ships, 250 rocks, 120 bullets, 120 Hz that is ~44k checks/tick worst case, single-digit ms. | Rock count exceeds ~600. Mark with a `ponytail:` comment. |
| Rock↔rock collision | **No.** Fragments drift through each other. Real debris fields overlap. Halves the collision budget and removes an entire stability problem. | Someone complains it looks wrong. |
| Mouse-aimed turrets | **No.** The ship rotates; the ship *is* the aim. Guns fire along heading. | Phase 8+, as a loadout option. |
| AI pirates | **No.** "Pirates" is a **team slot players pick** in the lobby. | After human teams work. |
| Visual part-by-part ship builder | **No.** Point-budget stat sliders + hull colour + chassis width reusing existing `buildShip` geometry. | The stat customization is proven fun. |
| Separate lobby page/route | **No.** Reuse `openDialog()` from `main.ts`. | Never. |
| Matchmaking, accounts, persistence | **No.** LAN. Name is typed in a text field. | Never. |
| Cargo/salvage mission carried into MP | **Keep single-player mission as-is.** MP is a separate game mode; cargo is not simulated in MP v1. | Wanted as a team objective mode. |

**Non-negotiable (do not simplify away):** server validates every input and every loadout (never trust a client's stats), fixed-step determinism, existing `bun test` suite stays green, keyboard accessibility of the lobby dialog.

---

## 3. Target architecture

```
                 HOST PC                                    CLIENT PC
  ┌──────────────────────────────────┐              ┌────────────────────────┐
  │  bun server.ts   (headless)      │              │  browser               │
  │  ├─ Bun.serve  :8080             │              │                        │
  │  │   ├─ static  dist/            │◄─ HTTP ──────┤  http://<hostip>:8080  │
  │  │   └─ ws      /ws              │◄─ WS ───────►│  src/net.ts            │
  │  ├─ World (src/world.ts)         │              │  ├─ snapshot buffer    │
  │  │   stepWorld() @ 120 Hz        │              │  ├─ interpolation      │
  │  │   uses stepShip/resolveColl.  │              │  └─ input @ 60 Hz      │
  │  └─ broadcast snapshot @ 30 Hz   │              │  SpaceScene renders    │
  └──────────────────────────────────┘              │  N ships + bullets     │
            ▲                                       └────────────────────────┘
            │ WS (localhost)
  ┌─────────┴────────────────────────┐
  │ host's own browser — a normal    │   The host is NOT special in the browser.
  │ client on http://localhost:8080  │   It is just the PC running the process.
  └──────────────────────────────────┘
```

**Host-authoritative, dumb clients.** The server owns the world. Clients send input and render what they are told. The host player is an ordinary client connected over loopback — this avoids two code paths and is why the server is headless.

### New / changed files

| File | New? | ~Lines | Purpose |
| --- | --- | --- | --- |
| `src/world.ts` | **new** | ~280 | Multi-entity sim + wire types. Pure: no DOM, no Three, no Bun APIs. Imported by both server and client. |
| `server.ts` (repo root) | **new** | ~200 | Bun entry point. `Bun.serve` static + WebSocket, connection/lobby management, 120 Hz world loop, 30 Hz broadcast. |
| `src/net.ts` | **new** | ~150 | Browser WS client: connect, send input, snapshot ring buffer, interpolation, event application. |
| `src/lobby.ts` | **new** | ~140 | Lobby dialog markup + handlers. Uses `openDialog` passed in as a callback (no circular import). |
| `src/physics.ts` | edit | +60/-15 | `Obstacle`→`Rock` with `id/vx/vy/hp/mass`, two-body collision impulse, `specFor(loadout)`, spec on `ShipState`. |
| `src/main.ts` | edit | ~+120 | Mode switch (`solo` \| `mp`), MP loop path, HUD for team/kills, weapon key. Single-player path untouched. |
| `src/scene.ts` | edit | ~+130 | `addShip/removeShip` map, dynamic rock add/remove, bullet renderer, camera follows a chosen ship. |
| `src/models.ts` | edit | ~+40 | `buildShip(loadout)` — colour + chassis width + gun pods. `buildBulletMesh()`. |
| `tests/world.test.ts` | **new** | ~90 | Determinism, splitting, bullet hits, friendly fire, budget validation. |
| `tsconfig.json` | edit | +1 | add `server.ts` to `include`. |
| `package.json` | edit | +3 | `host`, `serve`, `dev:server` scripts. |

Total new code ≈ 950 lines. No new dependencies.

---

## 4. Wire protocol

All messages are JSON, `{ t: <type>, ... }`. Floats rounded via a `JSON.stringify` replacer:
`(k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v` — one line, roughly halves payload.

### Client → Server

```ts
type C2S =
  | { t: 'hello';  name: string; }                                  // first message
  | { t: 'lobby';  team: TeamId; loadout: Loadout; ready: boolean }  // lobby edits
  | { t: 'start' }                                                  // host only, ignored from others
  | { t: 'input';  seq: number; i: PackedInput }                     // 60 Hz while playing
  | { t: 'respawn' }                                                // after death timer expires
  | { t: 'ping';   c: number };

// FlightInput + fire, packed to keep the 60 Hz message tiny.
type PackedInput = {
  th: number;   // thrust  -0.28..1
  tu: number;   // turn    -1..1
  st: number;   // strafe  -1..1
  b: 0 | 1;     // brake
  bo: 0 | 1;    // boost
  f: 0 | 1;     // fire
};
```

### Server → Client

```ts
type S2C =
  | { t: 'welcome'; you: string; mapSeed: number; mapId: string; tickRate: 120; you_is_host: boolean }
  | { t: 'lobby';   phase: 'lobby'; players: LobbyPlayer[]; mapId: string }
  | { t: 'begin';   mapSeed: number; mapId: string; players: PlayerMeta[]; startTick: number }
  | { t: 'snap';    k: number; ack: number; p: WirePlayer[]; b: WireBullet[] }   // 30 Hz
  | { t: 'ev';      k: number; e: WorldEvent[] }                                  // only when non-empty
  | { t: 'pong';    c: number }
  | { t: 'bye';     id: string };

type WirePlayer = {
  id: string; x: number; y: number; vx: number; vy: number; a: number; av: number;
  hp: number; fu: number; ht: number; th: number; rcs: 0|1; dead: 0|1;
};
type WireBullet = { id: number; x: number; y: number; vx: number; vy: number; tm: number };

type WorldEvent =
  | { e: 'rockSplit';  id: number; children: Rock[] }   // parent removed, children added
  | { e: 'rockGone';   id: number }
  | { e: 'kill';       killer: string; victim: string }
  | { e: 'hit';        id: string; dmg: number; x: number; y: number }  // for sparks/sound
  | { e: 'spawn';      id: string; x: number; y: number }
  | { e: 'join';       player: PlayerMeta }
  | { e: 'leave';      id: string };
```

**Rocks are never sent in a snapshot.** Both sides generate the identical field from `mapSeed` via `createRocks(mapSeed, mapParams)` — the existing `randomSeed` PRNG makes this exact. Only `rockSplit` / `rockGone` events mutate it after that. This removes the single largest chunk of bandwidth.

Bandwidth sanity check, 8 players: `snap` ≈ 8×14 + 120×6 ≈ 830 numbers ≈ 7 KB JSON, at 30 Hz = **~210 KB/s per client**, ~1.7 MB/s total on the host uplink. Gigabit LAN: irrelevant.

### Timing contract

- Sim tick: `1/120 s`, tick counter `k` increments every step. Server never skips ticks; it catches up with an accumulator identical to `main.ts:frame`.
- Broadcast every 4th tick (30 Hz).
- Client input every 60 Hz with a monotonic `seq`. Server stores the newest input per player and reuses it for every tick until a new one arrives (input is level-triggered, not edge-triggered — this is why `fire` is a held flag with a server-side cooldown, not an event).
- Server echoes the last applied `seq` as `ack` for Phase 6 prediction.

---

## 5. `src/physics.ts` changes

Keep the file pure. Keep every existing export working so `tests/physics.test.ts` stays green.

### 5.1 `Obstacle` → `Rock`

```ts
export type Rock = {
  id: number;
  x: number; y: number;
  vx: number; vy: number;   // NEW — 0 for pristine field rocks
  radius: number;
  hp: number;               // NEW
  mass: number;             // NEW — derived, cached
  seed: number;
  z: number;                // unchanged: z !== 0 means background scenery, no collision
};
export type Obstacle = Rock;   // keep the old name as an alias; nothing else to change in tests
```

Derived constants (put them at the top of the file, they are the tuning knobs):

```ts
export const ROCK_DENSITY = 900;      // kg per m^2 of cross-section. 20 m rock ~ 1.1e6 kg.
export const ROCK_HP_K    = 0.9;      // hp = radius^2 * ROCK_HP_K. 20 m rock = 360 hp.
export const ROCK_MIN_R   = 7;        // below this a rock is dust: destroy, do not split.
export const ROCK_SPLIT_R = 0.62;     // child radius factor (2-3 children ~ conserves area)
export const RESTITUTION  = 0.3;      // matches today's 1.3x closing-speed reflection

export const rockMass = (r: number) => Math.PI * r * r * ROCK_DENSITY;
export const rockHp   = (r: number) => r * r * ROCK_HP_K;
```

### 5.2 Two-body collision

Replace `resolveCollision`. Today it does `v -= 1.3 * closingSpeed * n`, i.e. restitution 0.3 against an infinitely massive rock. Generalise it — the old behaviour falls out when the rock is much heavier, which it is for any rock above ~15 m.

```ts
/** Impulse-based ship↔rock response. Returns hull damage dealt to the ship. */
export function resolveCollision(state: ShipState, rock: Rock): number {
  if (rock.z !== 0) return 0;                       // background scenery, unchanged
  const dx = state.position.x - rock.x, dy = state.position.y - rock.y;
  const dist = Math.hypot(dx, dy);
  const clearance = rock.radius * 0.83 + state.spec.length * 0.33;   // was hardcoded 14
  if (dist >= clearance) return 0;
  const nx = dist > 0.001 ? dx / dist : 1, ny = dist > 0.001 ? dy / dist : 0;

  const shipMass = state.spec.mass + state.fuel;
  const rockMassV = rock.mass;
  const total = shipMass + rockMassV;

  // Positional de-overlap, split by inverse mass so a small rock is pushed, not the ship.
  const push = clearance - dist;
  state.position.x += nx * push * (rockMassV / total);
  state.position.y += ny * push * (rockMassV / total);
  rock.x -= nx * push * (shipMass / total);
  rock.y -= ny * push * (shipMass / total);

  const rvx = state.velocity.x - rock.vx, rvy = state.velocity.y - rock.vy;
  const closing = rvx * nx + rvy * ny;
  if (closing >= 0) return 0;

  const j = -(1 + RESTITUTION) * closing / (1 / shipMass + 1 / rockMassV);
  state.velocity.x += j * nx / shipMass;  state.velocity.y += j * ny / shipMass;
  rock.vx -= j * nx / rockMassV;          rock.vy -= j * ny / rockMassV;

  const damage = Math.max(0, -closing - 2) * 1.5;   // unchanged curve
  state.hull = Math.max(0, state.hull - damage);
  rock.hp -= damage * 4;                            // ramming chips rocks; caller checks hp <= 0
  return damage;
}
```

**Test-compatibility check:** the existing test rams a 20 m rock at 25 m/s. `rockMass(20) = 1.13e6` vs ship `98e3`. Ship keeps ~92 % of the old rebound, so `velocity.x > 0` and `position.x > 30` still hold, and `hull < 100` still holds. The two velocity/position assertions are inequalities, not exact values — verify by running `bun test`, and if `position.x > 30` becomes marginal, note that `clearance` changed from `14` to `spec.length*0.33 = 13.86` for the Kestrel; keep `14` as a floor: `Math.max(14, spec.length * 0.33)`.

### 5.3 Splitting

```ts
/** Fracture a rock into 2-3 children. Momentum is preserved; area is approximately preserved. */
export function splitRock(rock: Rock, impactAngle: number, nextId: () => number): Rock[] {
  if (rock.radius * ROCK_SPLIT_R < ROCK_MIN_R) return [];      // dust, caller emits rockGone
  const n = rock.radius > 26 ? 3 : 2;
  const cr = rock.radius * (n === 3 ? 0.577 : 0.707) * 0.95;   // area-conserving, minus mass loss
  const kick = 6 + 40 / rock.radius;                            // small rocks fly apart harder
  const out: Rock[] = [];
  for (let i = 0; i < n; i++) {
    const a = impactAngle + Math.PI / 2 + i / n * Math.PI * 2;
    out.push({
      id: nextId(),
      x: rock.x + Math.cos(a) * cr * 1.05,
      y: rock.y + Math.sin(a) * cr * 1.05,
      vx: rock.vx + Math.cos(a) * kick,
      vy: rock.vy + Math.sin(a) * kick,
      radius: cr, hp: rockHp(cr), mass: rockMass(cr),
      seed: (rock.seed * 31 + i * 7) % 100000, z: 0,
    });
  }
  return out;
}
```

Note: the outward kicks of `n` evenly spaced children sum to ~0, so linear momentum is conserved to within float error. Good enough; do not add a correction term.

### 5.4 Ship spec on state (enables customization)

```ts
export type ShipSpec = { name: string; role: string; mass: number; thrust: number; fuel: number; torque: number; hull: number; length: number };

export type ShipState = {
  /* ...existing fields... */
  spec: ShipSpec;      // NEW — stepShip reads this instead of SHIPS[state.shipClass]
};

export function createShip(shipClass: ShipClass = 'kestrel', loadout?: Loadout): ShipState {
  const spec = loadout ? specFor(loadout) : { ...SHIPS[shipClass] };
  return { /* ...as today... */, fuel: spec.fuel, hull: spec.hull, shipClass, spec };
}
```

Then in `stepShip`, replace `const spec = SHIPS[state.shipClass]` with `const spec = state.spec`. Nothing else in the function changes. Every existing test constructs via `createShip(...)`, so they all keep working.

---

## 6. `src/world.ts` — the shared simulation

Pure module. **No imports from `three`, no `document`, no `Bun`.** Runs identically on server and (for prediction) in the browser.

```ts
import { stepShip, resolveCollision, splitRock, createShip, rockHp, rockMass, randomSeed,
         clamp, length, type ShipState, type FlightInput, type Rock } from './physics';

export type TeamId = 'blue' | 'red' | 'pirate';
export const TEAMS: TeamId[] = ['blue', 'red', 'pirate'];

export type Loadout = {
  chassis: 'kestrel' | 'mule' | 'needle';
  hullPts: number; thrustPts: number; fuelPts: number; torquePts: number;  // 0..5 each
  color: string;   // one of PALETTE, validated server-side
};
export const LOADOUT_BUDGET = 10;   // hullPts + thrustPts + fuelPts + torquePts must be <= 10
export const PALETTE = ['#dce6e8', '#83b9b5', '#efb879', '#df8277', '#8fa4c8', '#a8c08a'];

export type Player = {
  id: string; name: string; team: TeamId; loadout: Loadout;
  ship: ShipState;
  dead: boolean; respawnAt: number;   // world seconds
  kills: number; deaths: number;
  cooldown: number;                   // seconds until next shot
  input: FlightInput & { fire: boolean };
  lastSeq: number;
  connected: boolean;
};

export type Bullet = { id: number; x: number; y: number; vx: number; vy: number;
                       ttl: number; owner: string; team: TeamId; damage: number };

export type World = {
  tick: number; time: number;
  phase: 'lobby' | 'playing';
  map: MapDef;
  players: Map<string, Player>;
  rocks: Map<number, Rock>;
  bullets: Bullet[];
  events: WorldEvent[];    // drained by the server every broadcast
  nextEntityId: number;
};
```

### 6.1 Weapon and match constants (all tuning lives here)

```ts
export const GUN = {
  speed: 420,        // m/s muzzle, ADDED to ship velocity (Newtonian - this matters)
  cooldown: 0.16,    // seconds between shots
  damage: 9,         // vs hull
  rockDamage: 26,    // vs rock hp
  ttl: 3.2,          // seconds
  offset: 26,        // spawn distance ahead of ship centre, avoids self-hit
  radius: 1.5,
};
export const RESPAWN_DELAY = 5;
export const SHIP_RADIUS = (s: ShipState) => s.spec.length * 0.42;
```

### 6.2 `stepWorld(world, dt)` — one 120 Hz tick, in this exact order

```
1. time += dt; tick++
2. for each player:
     if dead: if time >= respawnAt -> respawn(world, player); continue
     stepShip(player.ship, player.input, dt)              // existing, unchanged
     applyArenaBounds(player.ship, world.map, dt)         // soft boundary, see 6.3
     cooldown = max(0, cooldown - dt)
     if input.fire && cooldown === 0 && ship.hull > 0:
         spawnBullet(world, player); cooldown = GUN.cooldown
3. for each rock: rock.x += rock.vx*dt; rock.y += rock.vy*dt
     (no rock-vs-rock collision - deliberate, see section 2)
4. ship vs rock: for each alive player, for each rock:
     dmg = resolveCollision(player.ship, rock)
     if dmg > 0 and rock.hp <= 0: fracture(world, rock, atan2(ship.y-rock.y, ship.x-rock.x))
     if player.ship.hull <= 0: killPlayer(world, player, null)     // killed by the belt
5. bullets: iterate backwards so splice is safe:
     b.x += b.vx*dt; b.y += b.vy*dt; b.ttl -= dt
     if b.ttl <= 0 -> remove
     vs rocks:   hypot(b - rock) < rock.radius ->
                     rock.hp -= GUN.rockDamage; emit hit; remove bullet
                     if rock.hp <= 0 -> fracture(world, rock, atan2(b.vy, b.vx))
     vs players: skip if p.dead, p.id === b.owner, or p.team === b.team
                 hypot(b - p.ship.position) < SHIP_RADIUS(p.ship) ->
                     p.ship.hull -= b.damage; emit hit; remove bullet
                     if p.ship.hull <= 0 -> killPlayer(world, p, b.owner)
6. if bullets.length > 400, drop from the front. Cheap runaway guard.
```

Bullet steps are discrete points, not swept segments: at 420 m/s and `dt = 1/120` a bullet moves 3.5 m per tick, while the smallest collidable radius is `ROCK_MIN_R = 7`. No tunnelling. If `GUN.speed` is ever raised above ~800, segment-vs-circle sweeping becomes necessary. Put a `ponytail:` comment on the constant saying exactly that.

Firing is level-triggered from a held flag plus a server-side cooldown, never an edge event. That is what makes a dropped or duplicated input packet harmless.

### 6.3 Arena bounds (replaces "infinite space")

```ts
// ponytail: soft radial boundary. A hard wall or a wrapping torus are both bigger changes.
export function applyArenaBounds(ship: ShipState, map: MapDef, dt: number) {
  const d = Math.hypot(ship.position.x, ship.position.y);
  if (d < map.radius) return;
  const nx = ship.position.x / d, ny = ship.position.y / d;
  const pull = Math.min(60, (d - map.radius) * 0.35);   // inward accel, grows with excess
  ship.velocity.x -= nx * pull * dt;
  ship.velocity.y -= ny * pull * dt;
  if (d > map.radius * 1.25) ship.hull = Math.max(0, ship.hull - 14 * dt);
}
```

Client shows a HUD warning when `d > map.radius`. One `textContent` line, no new element needed.

### 6.4 fracture, killPlayer, respawn, spawnBullet

```ts
function fracture(world: World, rock: Rock, impactAngle: number) {
  world.rocks.delete(rock.id);
  const children = splitRock(rock, impactAngle, () => world.nextEntityId++);
  if (children.length === 0) { world.events.push({ e: 'rockGone', id: rock.id }); return; }
  for (const c of children) world.rocks.set(c.id, c);
  world.events.push({ e: 'rockSplit', id: rock.id, children });
}

function killPlayer(world: World, p: Player, killerId: string | null) {
  if (p.dead) return;
  p.dead = true; p.deaths++; p.respawnAt = world.time + RESPAWN_DELAY;
  const killer = killerId ? world.players.get(killerId) : undefined;
  if (killer && killer.id !== p.id) killer.kills++;
  world.events.push({ e: 'kill', killer: killerId ?? '', victim: p.id });
}

function respawn(world: World, p: Player) {
  const pt = spawnPoint(world.map, p.team, world.tick + p.name.length);
  p.ship = createShip(p.loadout.chassis, p.loadout);    // fresh hull, fuel, heat
  p.ship.position = { ...pt };
  p.ship.angle = Math.atan2(-pt.x, pt.y);               // face the arena centre
  p.dead = false; p.cooldown = 0;
  world.events.push({ e: 'spawn', id: p.id, x: pt.x, y: pt.y });
}

function spawnBullet(world: World, p: Player) {
  const s = p.ship;
  const fx = -Math.sin(s.angle), fy = Math.cos(s.angle);   // same forward vector as stepShip
  world.bullets.push({
    id: world.nextEntityId++,
    x: s.position.x + fx * GUN.offset,
    y: s.position.y + fy * GUN.offset,
    vx: s.velocity.x + fx * GUN.speed,
    vy: s.velocity.y + fy * GUN.speed,
    ttl: GUN.ttl, owner: p.id, team: p.team, damage: GUN.damage,
  });
}
```

`forward = { x: -sin(angle), y: cos(angle) }` must match `stepShip` exactly, or shots will not go where the plume points.

### 6.5 Maps

```ts
export type MapDef = {
  id: string; name: string; seed: number; radius: number;
  rockCount: number; spreadX: number; spreadY: number; rockMin: number; rockMax: number;
  spawns: Record<TeamId, { x: number; y: number }[]>;
};

export const MAPS: MapDef[] = [
  { id: 'belt', name: 'Drift Belt', seed: 4712, radius: 1500, rockCount: 110,
    spreadX: 2600, spreadY: 2100, rockMin: 9, rockMax: 71,
    spawns: {
      blue:   [{ x: -900, y: -700 }, { x: -1040, y: -480 }],
      red:    [{ x:  900, y:  700 }, { x:  1040, y:  480 }],
      pirate: [{ x:    0, y: 1150 }, { x:     0, y: -1150 }],
    } },
  { id: 'quarry', name: 'The Quarry', seed: 9031, radius: 1100, rockCount: 190,
    spreadX: 1900, spreadY: 1900, rockMin: 7, rockMax: 38,
    spawns: {
      blue:   [{ x: -760, y: -240 }, { x: -760, y:  240 }],
      red:    [{ x:  760, y:  240 }, { x:  760, y: -240 }],
      pirate: [{ x:    0, y:  820 }, { x:     0, y: -820 }],
    } },
  { id: 'expanse', name: 'Open Expanse', seed: 2255, radius: 2200, rockCount: 55,
    spreadX: 3800, spreadY: 3200, rockMin: 14, rockMax: 95,
    spawns: {
      blue:   [{ x: -1500, y: -1100 }, { x: -1700, y: -800 }],
      red:    [{ x:  1500, y:  1100 }, { x:  1700, y:  800 }],
      pirate: [{ x:     0, y:  1800 }, { x:     0, y: -1800 }],
    } },
];

export function spawnPoint(map: MapDef, team: TeamId, salt: number) {
  const list = map.spawns[team];
  return list[Math.abs(salt) % list.length];
}

/** Deterministic on both server and client. This is what lets us skip sending rocks. */
export function createRocks(map: MapDef): Map<number, Rock> {
  const rand = randomSeed(map.seed);
  const spawnList = TEAMS.flatMap(t => map.spawns[t]);
  const out = new Map<number, Rock>();
  for (let i = 0; i < map.rockCount; i++) {
    const x = (rand() - 0.5) * map.spreadX;      // every rand() call is unconditional
    const y = (rand() - 0.5) * map.spreadY;      // and always in this order
    const radius = map.rockMin + Math.pow(rand(), 2) * (map.rockMax - map.rockMin);
    const back = rand();
    const z = i % 5 === 0 ? -100 - back * 170 : 0;
    if (z === 0 && spawnList.some(s => Math.hypot(s.x - x, s.y - y) < radius + 190)) continue;
    out.set(i, { id: i, x, y, vx: 0, vy: 0, radius,
                 hp: rockHp(radius), mass: rockMass(radius), seed: i + 12, z });
  }
  return out;
}
```

Determinism rules, both are load-bearing:

1. Every `rand()` call happens unconditionally and in a fixed order. The `continue` runs **after** all four draws. Reordering or short-circuiting them makes the client and server fields differ, and rocks then appear in different places on different PCs.
2. `world.nextEntityId` starts at `map.rockCount + 1000` so fracture ids never collide with generated ids.

### 6.6 Loadout validation — server side, never trust the client

```ts
export function sanitizeLoadout(raw: unknown): Loadout {
  const l = (raw ?? {}) as Partial<Loadout>;
  const pt = (v: unknown) => clamp(Math.floor(Number(v) || 0), 0, 5);
  const chassis = (['kestrel', 'mule', 'needle'] as const).includes(l.chassis as never)
    ? l.chassis! : 'kestrel';
  const out: Loadout = {
    chassis,
    hullPts: pt(l.hullPts), thrustPts: pt(l.thrustPts),
    fuelPts: pt(l.fuelPts), torquePts: pt(l.torquePts),
    color: PALETTE.includes(l.color as string) ? l.color! : PALETTE[0],
  };
  // Spend down rather than reject: a stale or hostile client stays playable instead of erroring.
  const keys = ['torquePts', 'fuelPts', 'thrustPts', 'hullPts'] as const;
  let spent = keys.reduce((s, k) => s + out[k], 0);
  for (const k of keys) {
    if (spent <= LOADOUT_BUDGET) break;
    const take = Math.min(out[k], spent - LOADOUT_BUDGET);
    out[k] -= take; spent -= take;
  }
  return out;
}
```

```ts
// in physics.ts, next to SHIPS
/** Points scale the base chassis by at most 25% either way, so nothing dominates. */
export function specFor(l: Loadout): ShipSpec {
  const base = SHIPS[l.chassis];
  const f = (pts: number) => 1 + (pts - 2.5) * 0.10;   // 0 pts -> 0.75x, 5 pts -> 1.25x
  return {
    ...base,
    hull:   Math.round(base.hull * f(l.hullPts)),
    thrust: Math.round(base.thrust * f(l.thrustPts)),
    fuel:   Math.round(base.fuel * f(l.fuelPts)),
    torque: Number((base.torque * f(l.torquePts)).toFixed(3)),
  };
}
```

`specFor` lives in `physics.ts` because it needs `SHIPS`. `Loadout` and `sanitizeLoadout` live in `world.ts`. Import direction is only `world.ts -> physics.ts`; never the reverse, or the module graph cycles. If TypeScript complains about `Loadout` in `physics.ts`, declare the type in `physics.ts` and re-export it from `world.ts`.

---

## 7. `server.ts` — the host process

Repo root, run with `bun server.ts`. Zero dependencies. Never imports `three` or touches the DOM.

```ts
import { MAPS, createRocks, stepWorld, sanitizeLoadout, TEAMS, type World, type TeamId } from './src/world';
import { createShip } from './src/physics';

const PORT = Number(process.env.PORT ?? 8080);
const TICK = 1 / 120;
const BROADCAST_EVERY = 4;            // 30 Hz
const DIST = './dist';

const world: World = { tick: 0, time: 0, phase: 'lobby', map: MAPS[0],
                       players: new Map(), rocks: new Map(), bullets: [],
                       events: [], nextEntityId: MAPS[0].rockCount + 1000 };

type Sock = { id: string; name: string; ready: boolean; isHost: boolean };
let hostId: string | null = null;     // first connection to send hello becomes host
```

### 7.1 Serving

```ts
const server = Bun.serve<Sock>({
  hostname: '0.0.0.0',                // MUST be 0.0.0.0, not 127.0.0.1, or LAN cannot reach it
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      return srv.upgrade(req, { data: { id: crypto.randomUUID().slice(0, 8), name: '', ready: false, isHost: false } })
        ? undefined : new Response('upgrade failed', { status: 400 });
    }
    // Static files out of dist/, SPA fallback to index.html.
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(DIST + p);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(DIST + '/index.html'));
  },
  websocket: {
    open(ws)          { /* wait for hello */ },
    message(ws, raw)  { onMessage(ws, JSON.parse(String(raw))); },
    close(ws)         { onLeave(ws.data.id); },
  },
});
console.log(`AstraWars host on http://${localIPv4()}:${PORT}`);
```

`localIPv4()`: `Object.values(require('node:os').networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost'`. Print it big — it is the only thing the other players need to type.

### 7.2 Message handling

- `hello`: assign id, sanitize the name (trim, 16 chars, strip control characters), create a lobby entry with a default loadout, set `hostId` if unset, reply `welcome`, broadcast `lobby`.
- `lobby`: only accepted while `world.phase === 'lobby'`. Apply `team` (must be in `TEAMS`), `sanitizeLoadout(loadout)`, `ready`. Broadcast `lobby`.
- `start`: **only if `ws.data.id === hostId`**. Requires at least one player. Builds the world, broadcasts `begin`, sets `phase = 'playing'`.
- `input`: ignored unless playing. Drop if `msg.seq <= player.lastSeq` (out-of-order arrival). Clamp every field server-side — `thrust` to `[-0.28, 1]`, `turn`/`strafe` to `[-1, 1]`, booleans coerced. Store on `player.input`, set `lastSeq`.
- `respawn`: no-op; respawn is automatic on the timer. Keep the message accepted-and-ignored so an old client cannot desync the server.
- `ping`: reply `pong` with the same `c`. Client uses it for a HUD latency readout only.

Late join while playing: allowed. Create the player, spawn them, send `begin` (so they build the map) followed by the current rock diff. **Simplest correct approach:** on late join, send `begin` plus a synthetic `rockSplit`/`rockGone` replay is fragile — instead send a one-off `{ t: 'rocksFull', rocks: [...world.rocks.values()] }` message to that socket only. It is a few KB, once, per late joiner. Cheaper than tracking a diff log.

### 7.3 The loop

```ts
let acc = 0, last = performance.now();
setInterval(() => {
  const now = performance.now();
  acc += Math.min((now - last) / 1000, 0.25);   // same 0.25 s clamp as main.ts
  last = now;
  while (acc >= TICK) {
    if (world.phase === 'playing') stepWorld(world, TICK);
    acc -= TICK;
    if (world.tick % BROADCAST_EVERY === 0) broadcast();
  }
}, 4);   // 250 Hz timer, the accumulator does the real pacing
```

`broadcast()` builds one `snap` string with `JSON.stringify(payload, roundFloats)` and calls `server.publish('game', str)` — Bun pub/sub, so the payload is serialized once for all clients. Subscribe each socket to `'game'` on `open`. Events are drained into a separate `ev` message and only sent when `world.events.length > 0`.

`ack` is per-player, so either send `ack` inside each `WirePlayer` entry (simplest, costs one number per player) or send the whole snapshot with per-socket `ws.send`. **Take the first option** — one number per player in a shared payload beats N serializations.

---

## 8. `src/net.ts` — the browser client

```ts
export type NetHandlers = {
  onLobby(msg): void; onBegin(msg): void; onEvents(evs): void; onBye(id): void;
};

export class Net {
  you = ''; isHost = false; latency = 0;
  private ws: WebSocket;
  private buf: Snapshot[] = [];        // ring of the last 3 snapshots, ordered by tick
  private seq = 0;
  private serverTimeOffset = 0;

  constructor(url: string, name: string, h: NetHandlers) { /* connect, wire onmessage */ }

  sendInput(i: PackedInput) { this.ws.send(JSON.stringify({ t: 'input', seq: ++this.seq, i })); }
  sendLobby(team, loadout, ready) { /* ... */ }
  start() { this.ws.send('{"t":"start"}'); }

  /** Interpolated view of the world, called once per animation frame. */
  view(nowMs: number): { players: RenderPlayer[]; bullets: WireBullet[] } { /* see below */ }
}
```

### 8.1 Interpolation

```
INTERP_DELAY = 100 ms            // ~3 snapshot intervals at 30 Hz; survives one dropped packet
renderAt = nowMs - INTERP_DELAY
find a, b in buf with a.recvAt <= renderAt <= b.recvAt
t = (renderAt - a.recvAt) / (b.recvAt - a.recvAt)         // guard divide-by-zero
position/velocity: plain lerp
angle: shortest-arc lerp -> a + wrapPi(b - a) * t   where wrapPi(x) = ((x + PI) mod 2PI) - PI
scalars (hull, fuel, heat): lerp
booleans (dead, rcs): take b
```

If `renderAt` is newer than the last snapshot (a stall), hold the last snapshot rather than extrapolating. Extrapolation on a stall produces ships that lurch and snap back; holding produces a brief freeze, which reads as network lag and is what players expect.

Timestamp with local `performance.now()` at receive time. Do **not** try to sync clocks — there is no need, because interpolation only cares about intervals between locally observed arrivals.

### 8.2 Rocks on the client

Built once on `begin` with `createRocks(map)` — identical to the server. Then:

- `rockSplit`: remove `id` from the local map and from the scene, add each child, spawn a debris puff.
- `rockGone`: remove and puff.
- `rocksFull` (late join only): replace the whole map.

Rocks also need to be **integrated locally** every frame (`x += vx*dt`) so drifting fragments move smoothly between the 30 Hz events. They are never corrected — fragment velocity is constant with no rock-vs-rock collision, so client and server stay in agreement without any traffic. This is the payoff for skipping rock-vs-rock collision.

---

## 9. Rendering changes — `src/scene.ts` and `src/models.ts`

### 9.1 Multiple ships

Replace the single `ship: ShipModel` field with `ships = new Map<string, ShipModel>()`.

```ts
addShip(id: string, loadout: Loadout, team: TeamId) {
  const model = buildShip(loadout, team);
  model.group.scale.setScalar(1.3);
  this.scene.add(model.group);
  this.ships.set(id, model);
}
removeShip(id: string) {
  const m = this.ships.get(id);
  if (m) { disposeObject(m.group); this.ships.delete(id); }
}
```

`disposeObject` already exists and already traverses. It disposes geometry but not materials — that is fine because materials in `models.ts` are module-level singletons, except the new per-loadout hull colour material, which **must** be disposed. Add `if (child.material?.userData.owned) child.material.dispose()` to `disposeObject` and set `userData.owned = true` on the per-ship material.

`render()` signature becomes:

```ts
render(view: RenderView, localId: string, dt: number, time: number)
```

The camera follows `view.players.find(p => p.id === localId)`. The existing follow/lerp/tactical logic is unchanged, it just reads that ship's position instead of the singleton. Trajectory line, velocity vector, selection brackets and orbit rings all follow the **local** ship only — remote ships get a hull and engine plume, nothing else. That keeps the frame budget flat as players are added.

Ship colour per team on the selection bracket: blue `#83b9b5`, red `#df8277`, pirate `#efb879`. Reuses the existing token palette from `DESIGN.md`; no new colours.

### 9.2 Dynamic rocks

```ts
private rockMeshes = new Map<number, THREE.Mesh>();

addRock(r: Rock)      { const m = buildAsteroid(r.radius, r.seed); m.position.set(r.x, r.y, r.z);
                        m.rotation.set(r.seed, r.seed * 0.4, r.seed * 0.7);
                        this.rockMeshes.set(r.id, m); this.scene.add(m); }
removeRock(id: number) { const m = this.rockMeshes.get(id);
                        if (m) { disposeObject(m); this.rockMeshes.delete(id); } }
```

Per frame, update positions of rocks that are moving only:
`for (const r of rocks.values()) if (r.vx || r.vy) rockMeshes.get(r.id)?.position.set(r.x, r.y, r.z)`.
Pristine rocks have `vx === vy === 0` and are skipped entirely, so this loop costs nothing until something breaks.

`buildAsteroid` builds an `IcosahedronGeometry` and deforms it per vertex — roughly 1–2 ms each. A rock splitting into 3 is 3 builds in one frame, which is a visible hitch when several break at once. **Fix cheaply:** keep a small pool keyed by rounded radius, or build fragments over the next few frames from a queue. Start with a queue: push new rocks into `pendingRocks[]`, build at most 2 per frame. Twelve lines, no pooling machinery.

### 9.3 Bullets

One `THREE.Points` with a preallocated 400-vertex buffer, same shader trick already used by `buildStars()`.

```ts
private bulletPoints: THREE.Points;   // 400 vertices, draw range set per frame
updateBullets(bullets: WireBullet[]) {
  const pos = this.bulletPoints.geometry.attributes.position;
  const n = Math.min(bullets.length, 400);
  for (let i = 0; i < n; i++) pos.setXYZ(i, bullets[i].x, bullets[i].y, 4);
  pos.needsUpdate = true;
  this.bulletPoints.geometry.setDrawRange(0, n);
}
```

Bullets are also integrated locally between snapshots (`x += vx*dt`) for smooth tracers; they are replaced wholesale by the next snapshot. A bullet that the server deleted on impact simply stops appearing — no removal event needed.

Muzzle flash and impact sparks: reuse the existing `hit` event, spawn a short-lived scaled sprite. Optional; skip in Phase 4, add in Phase 7 if it feels flat.

### 9.4 `buildShip(loadout, team)`

Currently `buildShip(shipClass)` with `const wide = shipClass === 'mule' ? 1.3 : shipClass === 'needle' ? 0.72 : 1`. Change to:

```ts
export function buildShip(loadout: Loadout, team: TeamId = 'blue'): ShipModel {
  const wide = loadout.chassis === 'mule' ? 1.3 : loadout.chassis === 'needle' ? 0.72 : 1;
  const skin = new THREE.MeshStandardMaterial({ color: loadout.color, roughness: 0.52, metalness: 0.4 });
  skin.userData.owned = true;                 // so disposeObject frees it
  // replace the `lightArmor` argument in the two outer hull() calls with `skin`
  // ...existing geometry, unchanged...
  // gun pods: one small box + barrel per side, scaled by thrustPts so a fitted ship looks fitted
}
```

Keep `buildShip('kestrel')` working for the single-player path by accepting a `ShipClass` string as well: `typeof loadout === 'string' ? defaultLoadout(loadout) : loadout`. One line, and it avoids touching `previews.ts` at all.

Visual variety comes from three cheap levers already in the geometry: chassis width (`wide`), hull colour (`skin`), and the number of gun pods. That is the whole customization surface for v1. **Do not** build a part-assembly system.

---

## 10. Lobby — `src/lobby.ts`

Reuses `openDialog(content, wide)` from `main.ts`. Export a function that takes the dialog helpers so there is no circular import:

```ts
export function showLobby(deps: {
  open(html: string, wide?: boolean): void;
  close(): void;
  net: Net;
  state: { players: LobbyPlayer[]; mapId: string; isHost: boolean; you: string };
}) { /* render + wire handlers */ }
```

Content, all inside the existing `<dialog>`:

1. **Host address**, big: `http://192.168.x.x:8080` with a copy button. Only shown to the host.
2. **Player list**: name, team pill, ready tick. Re-rendered on every `lobby` message.
3. **Team picker**: three buttons — Blue Fleet, Red Fleet, Pirates. Pirates are hostile to both fleets and to nobody else; that is the entire pirate rule, and it needs no code beyond the existing `p.team === b.team` friendly-fire check.
4. **Loadout**: chassis radio (3), four `<input type="range" min=0 max=5>` sliders with a live "Points spent 7 / 10" counter, and a colour swatch row. Disable increments once the budget is spent; the server sanitizes anyway.
5. **Map picker**: host only, three cards.
6. **Ready** toggle for everyone, **Launch** button for the host, enabled when at least one player is ready.

Accessibility, not optional: the dialog is already a native `<dialog>` with `showModal()`, so focus trapping and Escape are free. Give every range input a `<label>`, give team buttons `aria-pressed`, and keep the existing `#dialog-title` id wiring for `aria-labelledby`. Native `<input type="range">` and `<input type="radio">` — do not build custom sliders.

Debrief screen at match end reuses the same dialog with the scoreboard, exactly like the existing `Contract SR-084 complete` panel.

---

## 11. `src/main.ts` changes

Add one module-level `mode: 'solo' | 'mp'`. **Do not delete the single-player mission.** It is the fallback when no server is reachable, and the two Playwright scripts depend on it.

```
boot()
  |- try connect to ws://<location.host>/ws   (or ws://127.0.0.1:8080/ws under vite dev)
  |    success -> mode = 'mp',   showLobby(...)
  |    failure -> mode = 'solo', existing behaviour, unchanged
```

`frame()` gains a branch:

```ts
if (mode === 'solo') {
  /* ...the existing accumulator loop, byte-for-byte unchanged... */
} else {
  net.sendInput(packInput());                     // throttled to 60 Hz
  const view = net.view(now);
  integrateLocalRocks(dt); integrateLocalBullets(dt);
  scene.render(view, net.you, stopped ? 0 : delta, elapsed);
}
```

Input packing adds one key. Bind fire to **Space**, and move pause to **P**, because Space is the only comfortable fire key and pause matters far less in multiplayer. Update the manual dialog, the README control table, and the `flightKeys` array together. `scripts/browser-check.mjs` presses Space for pause and needs the same edit.

HUD additions, all reusing existing markup patterns:

- Team pill and kill/death counters next to `#player-name`.
- Small scoreboard, toggled with **Tab**, built from the last lobby and snap payloads.
- `#flight-tip` shows a leaving-the-area warning outside `map.radius`, and a respawn countdown while dead.
- Latency readout in the top bar from the ping/pong round trip.

The mission panel, contacts list, cargo markers and the shipyard button are hidden in mp mode with a single `.game-shell.mp-mode` CSS class rather than removed. Cheapest possible split, and it keeps the solo path from rotting.

---

## 12. Phases, each ending at a runnable committable state

Do them in order. Do not start a phase before the previous one runs.

| # | Goal | Files | Done when |
| --- | --- | --- | --- |
| **1** | Physics groundwork, no networking. `Rock` type, two-body `resolveCollision`, `splitRock`, `spec` on `ShipState`, `specFor`. | `physics.ts`, `tests/physics.test.ts` | `bun test` green, `bun run dev` plays as before, and small rocks now recoil when nudged. |
| **2** | `src/world.ts` and its tests. No server, no rendering. | `world.ts`, `tests/world.test.ts` | `bun test` green. Two worlds stepped from the same seed and inputs match exactly after 600 ticks. |
| **3** | `server.ts` and `src/net.ts`. Two ships flying, nothing else: no guns, no lobby, hardcoded map and loadout. | `server.ts`, `net.ts`, `main.ts`, `scene.ts` | Two tabs on the host, then a second PC on the LAN, each see the other ship move smoothly. |
| **4** | Guns and damage. Bullets render, hulls drop, players die and respawn. | `world.ts`, `scene.ts`, `models.ts`, `main.ts` | You can shoot the other ship and it respawns after 5 s. |
| **5** | Asteroid breaking. Split and gone events, client applies them, fragments drift. | `world.ts`, `net.ts`, `scene.ts` | Shooting a large rock splits it into three on **both** PCs, identically. |
| **6** | Lobby, teams, pirates, loadouts, map picker. | `lobby.ts`, `server.ts`, `main.ts` | Three players pick teams, friendly fire is off within a team, pirates are hostile to both fleets. |
| **7** | Feel pass. Local prediction (see 12.1), impact sparks, muzzle flash, scoreboard, latency readout, host script. | `net.ts`, `main.ts`, `scene.ts`, `package.json` | Local ship responds with no perceptible delay and a full match is playable end to end. |

### 12.1 Client-side prediction, Phase 7, and only if it feels bad without it

Everything before Phase 7 renders the local ship straight from interpolated server state: about `INTERP_DELAY` plus half a snapshot interval, so roughly 115 ms of input lag. On a LAN that is playable but noticeably soft. The fix is small because `stepShip` is pure:

```
keep pending: { seq, input }[] for every input sent
on snap:
    local = clone(snapshot.you)                    // authoritative
    drop pending entries with seq <= snap.ack
    for each remaining pending entry: stepShip(local, entry.input, 1/120)
    if distance(local, predicted) > 25 m: hard snap, else ease predicted toward local at 0.2 per frame
each frame: stepShip(predicted, currentInput, dt) and render predicted for the local ship only
```

Remote ships stay interpolated. Rocks and bullets stay interpolated. **Do not** predict collisions or damage: mispredicted damage looks far worse than late damage.

If input lag feels fine without this, delete the section and keep the 40 lines.

---

## 13. Tests

`tests/physics.test.ts` keeps all nine existing tests passing. Add two:

```ts
test('a light rock is pushed by a heavy ship while a heavy rock is not', ...)
test('splitting conserves momentum and roughly conserves area', ...)
  // sum of child mass*velocity is within 1% of parent mass*velocity
  // sum of child radius squared is between 0.75x and 1.0x the parent radius squared
```

`tests/world.test.ts` is new, and it is the one that actually protects multiplayer:

```ts
test('two worlds from the same seed and inputs are identical after 600 ticks')
  // deep-equal the serialized snapshot. THIS is the determinism guard.
test('createRocks returns identical fields for two calls with the same map')
test('a bullet damages an enemy and passes through a teammate')
test('a pirate bullet damages both fleets')
test('killing a player increments killer kills and schedules a respawn')
test('a rock destroyed below ROCK_MIN_R emits rockGone and produces no children')
test('sanitizeLoadout clamps a 20 point cheat loadout down to the budget')
test('a ship outside map.radius is pulled inward and takes hull damage past 1.25x')
```

No test framework, no fixtures, no mocks. `bun:test` and plain asserts, matching the existing file.

Browser checks: `scripts/browser-check.mjs` and `scripts/mission-run.mjs` exercise the **solo** path and must keep passing, so keep solo mode reachable when no server answers. Their only required edit is the pause key moving from Space to P.

Manual LAN check, required before calling Phase 3 or Phase 7 done:

1. `bun run host` on PC A.
2. PC A opens `http://localhost:8080`, PC B opens `http://<A-lan-ip>:8080`.
3. Windows Firewall prompts on first run. Allow Bun on private networks. If PC B cannot connect, that prompt is the cause almost every time; verify with `netsh advfirewall firewall show rule name=all | findstr 8080`.
4. Both fly, shoot, break a rock, die, respawn. Close PC B mid-match; PC A must keep running and emit a leave event.

---

## 14. Scripts and config

`package.json` gains three scripts:

```json
"dev:server": "bun --watch server.ts",
"host": "bun run build && bun server.ts",
"serve": "bun server.ts"
```

`tsconfig.json`: add `"server.ts"` to `include`.

Vite dev flow: run `bun run dev` on 5173 and `bun run dev:server` on 8080 together. The client falls back to `ws://127.0.0.1:8080/ws` when `location.port === '5173'`. One ternary in `net.ts`, no proxy config.

`vite.config.ts` needs no change: `server.ts` sits at the repo root and is not in the Vite entry graph.

LAN production flow: `bun run host` on one PC, everyone else opens the printed URL. Same origin, so the WebSocket URL is just `ws://` plus `location.host` plus `/ws`.

---

## 15. Deferred on purpose

Tracked here so each stays a decision instead of an oversight. Put a `ponytail:` comment at the matching line in code so `/ponytail-debt` can harvest them.

| Deferred | Trigger to build it |
| --- | --- |
| Spatial hash broadphase | Rock count above ~600, or the tick budget exceeds 4 ms. |
| Rock vs rock collision | Overlapping fragments actually read as wrong in play. |
| Binary wire format | Snapshot exceeds ~64 KB, or JSON shows up in a profile. |
| Swept bullet collision | GUN.speed raised above ~800 m/s. |
| Rollback and lag compensation | Anyone plays over the internet rather than a LAN. |
| AI pirates | Human teams are proven fun and someone wants a solo skirmish. |
| Mouse aimed turrets | A second weapon slot is added. |
| Visual part by part shipyard | Stat customization is proven fun and players ask for looks. |
| Cargo and objective modes in MP | Deathmatch gets boring. |
| Match timer, rounds, win conditions | After Phase 7. Until then a match runs until the host stops it. |
| Reconnect with state restore | Someone drops mid match often enough to be annoying. |

---

## 16. The three things most likely to go wrong

1. **Rock field divergence.** Client and server generate rocks independently. Any conditional `rand()` call, or any change to `createRocks` applied on one side only, puts rocks in different places on different PCs. That surfaces as invisible walls, not as an obvious error. The Phase 2 determinism test is the guard; never touch `createRocks` without rerunning it.

2. **Fire treated as an edge event.** If fire is sent as a one shot message instead of a held flag, a dropped packet eats a shot and a duplicated packet double fires. Keep it level triggered with a server side cooldown.

3. **Binding the server to 127.0.0.1.** The existing dev scripts bind loopback, which is right for them and fatal for the host server. Bind 0.0.0.0 in `server.ts`, and expect the Windows Firewall prompt on first launch.
