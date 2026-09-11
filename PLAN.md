# DRIFT — combat, shipbuilding and contracts

Implementation plan for an agent. Written against the build at `24bed9f`.

## Locked design decisions

| Question | Decision |
| --- | --- |
| Weapons | Guns damage asteroids (fracture into children + ore) **and** hostile ships that shoot back |
| Customization | **Full modular shipbuilder** — core + bolt-on parts, mass/thrust/hull/torque derived from parts |
| Missions | **Contract board** with several job types, all driven by one data-defined objective system |
| Progression | **Persists** — credits, owned parts, saved builds and completed contracts in `localStorage` |

## Guiding constraints

1. **Keep the base models.** `buildShip`, `buildAsteroid`, `buildStation`, `buildBeacon`, `buildDerelict`,
   `buildCargo` stay exactly as they are. Kestrel / Mule / Needle remain hand-modelled **stock ships** with a
   fixed stat block and a fixed weapon loadout. Custom builds are a *separate*, additive path rendered from parts.
   Never derive a stock ship's stats from parts — one source of truth per ship, or the art and the numbers drift apart.
2. **Everything that affects the outcome runs inside the 120 Hz fixed step.** Projectiles, AI, rock damage and
   objective progress all step in `stepSimulation`, never in `frame`. Determinism is what makes any of it testable.
3. **One spatial grid, shared.** Ship↔rock, projectile↔rock, AI line-of-sight and pickup collection all query the
   same static grid. The existing per-step loop over 460 rocks is already the hot path; the grid fixes it.
4. **No new runtime dependencies.** Three.js and the DOM cover all of it.

## File map

| File | Status | Purpose |
| --- | --- | --- |
| `src/physics.ts` | edit | Adds `Body`, rock HP/fracture, the spatial grid, solid-body collision |
| `src/combat.ts` | **new** | Projectile pool, weapon specs, firing, damage resolution, hostile AI |
| `src/parts.ts` | **new** | Part catalogue: data + geometry builder per part, cores and their hardpoints |
| `src/build.ts` | **new** | `Build` type, derived stats, validation, `buildFromParts()` model assembly |
| `src/builder.ts` | **new** | Shipyard screen: 3D hardpoint picking, install/remove, live stats |
| `src/contracts.ts` | **new** | Objective system + the contract catalogue (replaces `mission.ts` internals) |
| `src/save.ts` | **new** | Validated `localStorage` profile |
| `src/mission.ts` | edit | Thin compatibility layer over `contracts.ts`, or deleted in P4 — see Phase 4 |
| `src/models.ts` | edit | Adds raider, turret, mine, ore chunk, hauler. Existing builders untouched |
| `src/effects.ts` | edit | Adds `TracerPool`, `BeamPool`, `explode()` |
| `src/scene.ts` | edit | Dynamic rock add/remove, hostile models, projectile rendering, `unproject()` |
| `src/radar.ts` | edit | Hostile and ore contact kinds |
| `src/main.ts` | edit | Wiring: fire input, cursor aim, combat HUD, board and builder screens |
| `src/style.css` | edit | Builder screen, contract board, weapon/ammo instruments |

Six new files, all with distinct jobs. Resist splitting further — `combat.ts` deliberately holds projectiles *and*
AI because the AI's only job is to produce a `FlightInput` and pull a trigger.

---

# Phase 0 — Spatial grid and solid bodies

**Why first:** it fixes a bug that exists today and it is the substrate every later phase queries.
Today `stepSimulation` loops all 460 rocks at 120 Hz, and the station, relay and derelict are not solid —
you fly straight through them.

### 0.1 Give obstacles identity and health

In `src/physics.ts`, extend `Obstacle` and add `Body`:

```ts
export type Obstacle = {
  id: number;            // NEW — stable identity for scene add/remove
  x: number; y: number; radius: number; seed: number; z: number;
  hp: number;            // NEW
  maxHp: number;         // NEW
  vx?: number; vy?: number;  // NEW — only fragments move; undefined means static
};

/** Anything solid that is not an asteroid: the station core, the relay mast, the wreck. */
export type Body = { id: string; x: number; y: number; radius: number; restitution: number };

export const SOLID_BODIES: Body[] = [
  { id: 'station', x: STATION.x, y: STATION.y, radius: 78, restitution: 1.15 },
  { id: 'relay',   x: RELAY.x,   y: RELAY.y,   radius: 22, restitution: 1.0 },
  { id: 'derelict', x: DERELICT.x, y: DERELICT.y, radius: 64, restitution: 1.1 },
];

/** Rock integrity scales with cross-section: a 70 m boulder is not a 10 m pebble. */
export const rockHP = (radius: number) => Math.round(14 + radius * radius * 0.42);
```

In `createObstacles`, assign `id: rocks.length`, `hp: rockHP(radius)`, `maxHp: rockHP(radius)`.
Bump the loop counter to a separate `id` counter so ids stay dense after the `continue` skips.

### 0.2 The grid

```ts
const CELL = 260;  // ~3x the largest rock radius; tune with the ponytail note below
const key = (cx: number, cy: number) => cx * 8192 + cy;

export class SpatialGrid {
  private cells = new Map<number, Obstacle[]>();
  constructor(obstacles: Obstacle[]) { for (const o of obstacles) this.insert(o); }

  private insert(o: Obstacle) {
    // ponytail: a rock is filed by centre only, and CELL > 2 * maxRadius guarantees
    // a 3x3 neighbourhood query can never miss it. Re-derive CELL if radii grow.
    const k = key(Math.floor(o.x / CELL), Math.floor(o.y / CELL));
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(o); else this.cells.set(k, [o]);
  }

  remove(o: Obstacle) {
    const bucket = this.cells.get(key(Math.floor(o.x / CELL), Math.floor(o.y / CELL)));
    const i = bucket?.indexOf(o) ?? -1;
    if (i >= 0) bucket!.splice(i, 1);
  }

  add(o: Obstacle) { this.insert(o); }

  /** Every rock whose cell touches the 3x3 neighbourhood of (x, y). */
  near(x: number, y: number, out: Obstacle[] = []): Obstacle[] {
    out.length = 0;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const bucket = this.cells.get(key(cx + i, cy + j));
      if (bucket) for (const o of bucket) out.push(o);
    }
    return out;
  }
}
```

Fragments that move must be re-filed: on each step, if a moving rock crosses a cell boundary,
`grid.remove(rock); rock.x = …; grid.add(rock)`. Only fragments move, so this is a handful of calls.

### 0.3 Solid-body collision

`resolveCollision` already does exactly the right thing for a circle. Generalise it rather than copying it —
this is the root-cause fix, one function all callers route through:

```ts
export function resolveCircle(state: ShipState, cx: number, cy: number, clearance: number, bounce: number): number {
  const dx = state.position.x - cx, dy = state.position.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist >= clearance) return 0;
  const nx = dist > 0.001 ? dx / dist : 1, ny = dist > 0.001 ? dy / dist : 0;
  state.position.x = cx + nx * clearance;
  state.position.y = cy + ny * clearance;
  const closing = state.velocity.x * nx + state.velocity.y * ny;
  if (closing >= 0) return 0;
  state.velocity.x -= bounce * closing * nx;
  state.velocity.y -= bounce * closing * ny;
  const damage = Math.min(42, Math.max(0, -closing - 4) * 0.9);
  state.hull = Math.max(0, state.hull - damage);
  return damage;
}

export function resolveCollision(state: ShipState, rock: Obstacle): number {
  if (rock.z !== 0 || rock.hp <= 0) return 0;
  return resolveCircle(state, rock.x, rock.y, rock.radius * 0.83 + 14, 1.3);
}

export function resolveBodies(state: ShipState, docked: boolean): number {
  let damage = 0;
  for (const body of SOLID_BODIES) {
    // Docking clearance opens the station collar; everything else stays solid.
    if (docked && body.id === 'station') continue;
    damage += resolveCircle(state, body.x, body.y, body.radius, body.restitution);
  }
  return damage;
}
```

### 0.4 Rewire `stepSimulation`

```ts
const nearby: Obstacle[] = [];
grid.near(state.position.x, state.position.y, nearby);
for (const rock of nearby) resolveCollision(state, rock);
resolveBodies(state, dockable(mission, state));
```

**Verify:** `tests/physics.test.ts` gains — a grid query returns every rock within one cell radius and never a
duplicate; a ship driven at the station centre at 30 m/s ends up outside radius 78 with reduced hull.

---

# Phase 1 — Guns, asteroid destruction, ore

The headline feature. Playable on its own; ship it before parts or contracts.

> **Skills to load:** `threejs-geometry` (InstancedMesh, BufferGeometry), `threejs-interaction`
> (Raycaster, plane picking), `threejs-postprocessing` (selective bloom), `threejs-shaders` (dissolve).

## 1.1 Controls — a real change, update every surface that documents it

| Key | Before | After |
| --- | --- | --- |
| `Space` | Pause | **Fire primary** |
| `Esc` | Back / close | **Pause** in flight, back elsewhere |
| Mouse move | — | Aim; turreted mounts track the cursor inside their arc |
| Left click | — | Fire primary |
| Right click / `C` | — | Fire secondary (mining cutter) |
| `Tab` | — | Cycle hostile target |

Space is the universal fire key, and leaving pause on it means the player pauses every time they shoot.
Change `flightKeys`, the `keydown` handler, the footer keyboard guide, `showHelp()` and the README table
in one commit, or the manual lies.

## 1.2 Cursor aiming — screen to the navigation plane

`scene.project()` exists; it needs its inverse. The flight camera is tilted, so this is a ray/plane
intersection, not a scale factor. Straight out of `threejs-interaction`:

```ts
// src/scene.ts
private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
private readonly raycaster = new THREE.Raycaster();
private readonly ndc = new THREE.Vector2();
private readonly hit = new THREE.Vector3();

/** Screen pixel -> the z = 0 navigation plane. */
unproject(screenX: number, screenY: number): Vec2 {
  this.ndc.set((screenX / this.lastWidth) * 2 - 1, 1 - (screenY / this.lastHeight) * 2);
  this.raycaster.setFromCamera(this.ndc, this.camera);
  this.raycaster.ray.intersectPlane(this.aimPlane, this.hit);
  return { x: this.hit.x, y: this.hit.y };
}
```

`main.ts` keeps one `aim: Vec2`, refreshed on `pointermove` over the canvas. Before the pointer ever moves —
and on touch — it defaults to 600 m along the nose, so keyboard-only and mobile play still work.

## 1.3 Weapon catalogue

```ts
// src/combat.ts
export type WeaponKind = 'kinetic' | 'beam' | 'missile';
export type WeaponSpec = {
  id: string; name: string; kind: WeaponKind;
  damage: number;   // per hit; per second for a beam
  rof: number;      // shots per second; beams ignore it
  speed: number;    // m/s at the muzzle
  range: number;    // metres before the round expires
  spread: number;   // radians, half-angle
  heat: number;     // drive heat added per shot (per second for a beam)
  draw: number;     // propellant per shot (per second for a beam)
  arc: number;      // radians of traverse off the hull axis; 0 = fixed forward
  rockBonus: number;// damage multiplier vs asteroids — mining tools are poor anti-ship guns
  mass: number; cost: number;
};

export const WEAPONS: Record<string, WeaponSpec> = {
  ac20:   { id: 'ac20',   name: 'AC-20 autocannon', kind: 'kinetic', damage: 14,  rof: 5.5,  speed: 620,  range: 900,  spread: 0.018, heat: 0.006, draw: 1.4, arc: 0.38, rockBonus: 1,   mass: 1400, cost: 900 },
  ac70:   { id: 'ac70',   name: 'AC-70 breaker',    kind: 'kinetic', damage: 58,  rof: 1.1,  speed: 480,  range: 1150, spread: 0.006, heat: 0.030, draw: 6.0, arc: 0.22, rockBonus: 2.4, mass: 3900, cost: 2600 },
  gauss:  { id: 'gauss',  name: 'Gauss lance',      kind: 'kinetic', damage: 130, rof: 0.42, speed: 1400, range: 2200, spread: 0.001, heat: 0.110, draw: 14,  arc: 0.08, rockBonus: 1.6, mass: 6200, cost: 7400 },
  cutter: { id: 'cutter', name: 'Mining cutter',    kind: 'beam',    damage: 46,  rof: 0,    speed: 0,    range: 210,  spread: 0,     heat: 0.340, draw: 9,   arc: 0.50, rockBonus: 3.2, mass: 2100, cost: 1800 },
  swarm:  { id: 'swarm',  name: 'Swarm rack',       kind: 'missile', damage: 85,  rof: 0.7,  speed: 240,  range: 1800, spread: 0.120, heat: 0.020, draw: 4,   arc: 1.20, rockBonus: 0.6, mass: 2800, cost: 4100 },
};
```

Implement **`kinetic` and `beam` in this phase**. `swarm` stays in the table but unguided rounds are not
shipped — a homing round needs a per-round steering integrator and buys nothing until there is something to
chase. Phase 2 turns it on.

## 1.4 Round pool

A ring buffer of typed arrays, stepped inside the 120 Hz loop. No allocation per shot.

```ts
export const MAX_ROUNDS = 640;
export type Faction = 0 | 1;   // 0 player, 1 hostile

export class Rounds {
  readonly x = new Float32Array(MAX_ROUNDS);
  readonly y = new Float32Array(MAX_ROUNDS);
  readonly vx = new Float32Array(MAX_ROUNDS);
  readonly vy = new Float32Array(MAX_ROUNDS);
  readonly life = new Float32Array(MAX_ROUNDS);
  readonly damage = new Float32Array(MAX_ROUNDS);
  readonly bonus = new Float32Array(MAX_ROUNDS);
  readonly faction = new Uint8Array(MAX_ROUNDS);
  private cursor = 0;

  spawn(x: number, y: number, vx: number, vy: number, spec: WeaponSpec, faction: Faction) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_ROUNDS;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = spec.range / spec.speed;
    this.damage[i] = spec.damage; this.bonus[i] = spec.rockBonus; this.faction[i] = faction;
  }
}
```

`MAX_ROUNDS = 640` is a hard ceiling: the oldest live round is overwritten when the buffer wraps. At the
fastest catalogue rate that is roughly nine seconds of continuous fire, so it never shows.
Mark it: `// ponytail: fixed ring buffer, oldest round is dropped on wrap. Grow MAX_ROUNDS if a build ever out-fires it.`

## 1.5 Mounts and firing

A mount is a weapon bolted at a hull-local position. Stock ships hardcode theirs to match the existing art;
custom builds derive them from hardpoints in Phase 3. Both produce `Mount[]`, so one firing function serves both.

```ts
export type Mount = { spec: WeaponSpec; lx: number; ly: number; cooldown: number; bearing: number };

/** The Kestrel model already carries point-defence housings at (+/-10 * wide, 9, 15). Mount there. */
export const STOCK_MOUNTS: Record<ShipClass, { weapon: string; lx: number; ly: number }[]> = {
  kestrel: [{ weapon: 'ac20', lx: -10, ly: 9 }, { weapon: 'ac20', lx: 10, ly: 9 }],
  mule:    [{ weapon: 'ac70', lx: 0, ly: 16 }, { weapon: 'cutter', lx: 0, ly: -4 }],
  needle:  [{ weapon: 'ac20', lx: -7, ly: 14 }, { weapon: 'ac20', lx: 7, ly: 14 }, { weapon: 'gauss', lx: 0, ly: 6 }],
};

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Advances cooldowns and fires held mounts. Runs inside the fixed step. */
export function fireMounts(
  mounts: Mount[], state: ShipState, aim: Vec2, trigger: boolean, rounds: Rounds,
  faction: Faction, scale: number, dt: number,
  onShot?: (mx: number, my: number, angle: number, spec: WeaponSpec) => void,
) {
  const cos = Math.cos(state.angle), sin = Math.sin(state.angle);
  // stepShip's forward is (-sin, cos): the hull axis is angle + PI/2 in world bearing terms.
  const hullBearing = state.angle + Math.PI / 2;
  for (const mount of mounts) {
    mount.cooldown = Math.max(0, mount.cooldown - dt);
    const mx = state.position.x + (mount.lx * cos - mount.ly * sin) * scale;
    const my = state.position.y + (mount.lx * sin + mount.ly * cos) * scale;
    const wanted = Math.atan2(aim.y - my, aim.x - mx);
    const offset = clamp(wrapAngle(wanted - hullBearing), -mount.spec.arc, mount.spec.arc);
    mount.bearing = offset;                       // the model reads this to swing the barrel
    if (mount.spec.kind === 'beam') continue;     // beams are continuous, see 1.7
    if (!trigger || mount.cooldown > 0) continue;
    if (state.fuel < mount.spec.draw || state.heat > 0.98) continue;

    const angle = hullBearing + offset + (Math.random() - 0.5) * 2 * mount.spec.spread;
    // Rounds inherit ship velocity. A Newtonian sim that skips this feels wrong the moment you strafe.
    rounds.spawn(mx, my,
      state.velocity.x + Math.cos(angle) * mount.spec.speed,
      state.velocity.y + Math.sin(angle) * mount.spec.speed,
      mount.spec, faction);
    mount.cooldown = 1 / mount.spec.rof;
    state.fuel = Math.max(0, state.fuel - mount.spec.draw);
    state.heat = clamp(state.heat + mount.spec.heat, 0, 1);
    onShot?.(mx, my, angle, mount.spec);
  }
}
```

Heat is the rate limiter, not an ammo counter: overheating already has meaning in this sim (`stepShip` blocks
boost above 0.95) and it reuses an instrument the HUD already draws. No second resource bar.

## 1.6 Stepping rounds and resolving hits

```ts
export type Hit =
  | { kind: 'rock'; rock: Obstacle; x: number; y: number; damage: number; destroyed: boolean }
  | { kind: 'ship'; target: ShipState; x: number; y: number; damage: number }
  | { kind: 'expire'; x: number; y: number };

const SHIP_RADIUS = 34;   // circular proxy; models are drawn larger than they collide

export function stepRounds(rounds: Rounds, grid: SpatialGrid, targets: { state: ShipState; faction: Faction }[], dt: number): Hit[] {
  const hits: Hit[] = [];
  const nearby: Obstacle[] = [];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (rounds.life[i] <= 0) continue;
    rounds.life[i] -= dt;
    const px = rounds.x[i] + rounds.vx[i] * dt;
    const py = rounds.y[i] + rounds.vy[i] * dt;
    rounds.x[i] = px; rounds.y[i] = py;
    if (rounds.life[i] <= 0) { hits.push({ kind: 'expire', x: px, y: py }); continue; }

    let struck = false;
    for (const target of targets) {
      if (target.faction === rounds.faction[i] || target.state.hull <= 0) continue;
      if (Math.hypot(px - target.state.position.x, py - target.state.position.y) > SHIP_RADIUS) continue;
      const damage = rounds.damage[i];
      target.state.hull = Math.max(0, target.state.hull - damage);
      hits.push({ kind: 'ship', target: target.state, x: px, y: py, damage });
      struck = true; break;
    }
    if (struck) { rounds.life[i] = 0; continue; }

    grid.near(px, py, nearby);
    for (const rock of nearby) {
      if (rock.z !== 0 || rock.hp <= 0) continue;
      if (Math.hypot(px - rock.x, py - rock.y) > rock.radius * 0.9) continue;
      const damage = rounds.damage[i] * rounds.bonus[i];
      rock.hp -= damage;
      hits.push({ kind: 'rock', rock, x: px, y: py, damage, destroyed: rock.hp <= 0 });
      rounds.life[i] = 0; break;
    }
  }
  return hits;
}
```

**A round moves up to ~12 m per step at 1400 m/s and the smallest rock is 8 m, so tunnelling is possible.**
Do not add a swept-circle solver for it. The lazy correct fix: a round faster than 700 m/s is substepped twice
inside `stepRounds`. Two point tests beat a segment/circle intersection in both code size and readability.
Mark it: `// ponytail: point test with a 2x substep above 700 m/s. Swept test only if a faster weapon lands.`

## 1.7 Fracture and ore

In `src/physics.ts`:

```ts
export type Ore = { id: number; x: number; y: number; vx: number; vy: number; amount: number; life: number };

/**
 * Breaks a rock. Returns the fragments it left behind; the caller adds them to the grid and the scene.
 * Below 20 m a rock simply vanishes: fragments smaller than that are noise the player cannot hit.
 */
export function fractureRock(rock: Obstacle, nextId: () => number, rand = Math.random): { fragments: Obstacle[]; ore: Ore[] } {
  rock.hp = 0;
  const fragments: Obstacle[] = [];
  const ore: Ore[] = [];
  const pieces = rock.radius >= 20 ? (rock.radius > 48 ? 3 : 2) : 0;
  for (let i = 0; i < pieces; i++) {
    const angle = (i / pieces) * Math.PI * 2 + rand() * 0.8;
    // Conserve area, not radius: r_child = r_parent / sqrt(pieces) keeps the mass roughly honest.
    const radius = Math.max(9, rock.radius / Math.sqrt(pieces) * (0.78 + rand() * 0.22));
    const push = 14 + rand() * 22;
    const id = nextId();
    fragments.push({
      id, seed: id * 7 + 3, z: 0,
      x: rock.x + Math.cos(angle) * rock.radius * 0.5,
      y: rock.y + Math.sin(angle) * rock.radius * 0.5,
      radius, hp: rockHP(radius), maxHp: rockHP(radius),
      vx: Math.cos(angle) * push, vy: Math.sin(angle) * push,
    });
  }
  const drops = 1 + Math.floor(rock.radius / 26);
  for (let i = 0; i < drops; i++) {
    const angle = rand() * Math.PI * 2, push = 8 + rand() * 26;
    ore.push({
      id: nextId(), x: rock.x + Math.cos(angle) * rock.radius * 0.4, y: rock.y + Math.sin(angle) * rock.radius * 0.4,
      vx: Math.cos(angle) * push, vy: Math.sin(angle) * push,
      amount: Math.round(6 + rock.radius * 0.9), life: 90,
    });
  }
  return { fragments, ore };
}

export const ORE_PICKUP_RADIUS = 62;

/** Drifting ore, collected on proximity — no scan, no keypress. Returns the amount taken this step. */
export function stepOre(ore: Ore[], state: ShipState, dt: number): number {
  let taken = 0;
  for (let i = ore.length - 1; i >= 0; i--) {
    const chunk = ore[i];
    chunk.x += chunk.vx * dt; chunk.y += chunk.vy * dt;
    chunk.vx *= 0.995; chunk.vy *= 0.995;
    chunk.life -= dt;
    const range = Math.hypot(chunk.x - state.position.x, chunk.y - state.position.y);
    if (range < ORE_PICKUP_RADIUS) {
      // Inside the collector envelope it is drawn in, so pickup reads as a deliberate scoop.
      const pull = (1 - range / ORE_PICKUP_RADIUS) * 260 * dt;
      chunk.x += (state.position.x - chunk.x) * Math.min(1, pull / Math.max(range, 1));
      chunk.y += (state.position.y - chunk.y) * Math.min(1, pull / Math.max(range, 1));
    }
    if (range < 26 || chunk.life <= 0) {
      if (range < 26) taken += chunk.amount;
      ore.splice(i, 1);
    }
  }
  return taken;
}
```

Moving fragments must be re-filed in the grid whenever they cross a cell boundary — `grid.remove` then
`grid.add`. Only fragments and nothing else ever move, so this stays a handful of calls per step.

## 1.8 The mining cutter (beam)

A beam has no round. Each step it raycasts along its bearing against the grid and applies
`damage * rockBonus * dt` to the first rock it meets. One function, no pool:

```ts
export type BeamHit = { mount: Mount; x: number; y: number; ex: number; ey: number; rock?: Obstacle; destroyed: boolean };

export function stepBeams(mounts: Mount[], state: ShipState, grid: SpatialGrid, trigger: boolean, scale: number, dt: number): BeamHit[] {
  const out: BeamHit[] = [];
  const nearby: Obstacle[] = [];
  const cos = Math.cos(state.angle), sin = Math.sin(state.angle);
  const hullBearing = state.angle + Math.PI / 2;
  for (const mount of mounts) {
    if (mount.spec.kind !== 'beam' || !trigger) continue;
    if (state.fuel < mount.spec.draw * dt || state.heat > 0.99) continue;
    const mx = state.position.x + (mount.lx * cos - mount.ly * sin) * scale;
    const my = state.position.y + (mount.lx * sin + mount.ly * cos) * scale;
    const angle = hullBearing + mount.bearing;
    const dx = Math.cos(angle), dy = Math.sin(angle);

    // 12 samples over a 210 m beam is a 17 m step — finer than the smallest rock we let survive.
    let hitRock: Obstacle | undefined, ex = mx + dx * mount.spec.range, ey = my + dy * mount.spec.range;
    for (let s = 1; s <= 12 && !hitRock; s++) {
      const px = mx + dx * mount.spec.range * (s / 12), py = my + dy * mount.spec.range * (s / 12);
      grid.near(px, py, nearby);
      for (const rock of nearby) {
        if (rock.z !== 0 || rock.hp <= 0) continue;
        if (Math.hypot(px - rock.x, py - rock.y) > rock.radius * 0.95) continue;
        hitRock = rock; ex = px; ey = py; break;
      }
    }
    state.fuel = Math.max(0, state.fuel - mount.spec.draw * dt);
    state.heat = clamp(state.heat + mount.spec.heat * dt, 0, 1);
    let destroyed = false;
    if (hitRock) {
      hitRock.hp -= mount.spec.damage * mount.spec.rockBonus * dt;
      destroyed = hitRock.hp <= 0;
    }
    out.push({ mount, x: mx, y: my, ex, ey, rock: hitRock, destroyed });
  }
  return out;
}
```

The cutter is short-ranged, thirsty and heats fast on purpose: it is the tool that turns rock into money, and
it should force the player to sit still next to a boulder with hostiles inbound. That tension is the game.

## 1.9 Models — ore chunk and gun barrels

New geometry for `src/models.ts`. The existing builders are untouched; these follow their conventions
(shared module-level materials, `box`/`cylinder` helpers, `castShadow` on).

```ts
const oreShell = new THREE.MeshStandardMaterial({ color: '#6a6258', roughness: 0.95, metalness: 0.12 });
const oreVein = new THREE.MeshBasicMaterial({ color: '#efb879' });

/** One shared low-poly chunk geometry, instanced by the scene. Ore is decoration around a number. */
export function oreGeometry() {
  const geometry = new THREE.IcosahedronGeometry(7, 0);
  const position = geometry.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    p.multiplyScalar(0.72 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.5);
    position.setXYZ(i, p.x, p.y, p.z * 0.7);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function buildOre() {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(oreGeometry(), oreShell);
  shell.castShadow = true;
  group.add(shell);
  const vein = new THREE.Mesh(new THREE.IcosahedronGeometry(4.4, 0), oreVein);
  group.add(vein);   // the glowing core reads at 1.4x zoom where the rock silhouette does not
  return group;
}

/** A traversing barrel assembly. `pivot.rotation.z` is driven from Mount.bearing each frame. */
export function buildGunMount(weapon: 'ac20' | 'ac70' | 'gauss' | 'cutter' | 'swarm') {
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  cylinder(group, dark, 3.4, 4.2, 3, [0, 0, 0], 10);           // barbette
  if (weapon === 'ac20') {
    for (const side of [-1, 1]) {
      const barrel = cylinder(pivot, metal, 0.7, 0.9, 13, [side * 1.5, 6, 1.6], 8);
      barrel.rotation.x = Math.PI / 2;
    }
    box(pivot, armor, [6.4, 6, 3.4], [0, 1, 1.6]);
  } else if (weapon === 'ac70') {
    const barrel = cylinder(pivot, metal, 1.9, 2.4, 21, [0, 9, 2], 10);
    barrel.rotation.x = Math.PI / 2;
    cylinder(pivot, dark, 2.9, 2.9, 3, [0, 17, 2], 10).rotation.x = Math.PI / 2;   // muzzle brake
    box(pivot, armor, [9, 9, 4.6], [0, 0, 2]);
  } else if (weapon === 'gauss') {
    const rail = box(pivot, dark, [3.2, 34, 3.2], [0, 15, 2.4]);
    for (let i = 0; i < 7; i++) box(rail, copper, [4.6, 1.4, 4.6], [0, -14 + i * 4.6, 0]);
    box(pivot, metal, [8, 8, 5], [0, -2, 2.4]);
  } else if (weapon === 'cutter') {
    const head = cylinder(pivot, metal, 2.6, 3.4, 7, [0, 5, 2], 8);
    head.rotation.x = Math.PI / 2;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(2.3, 12), new THREE.MeshBasicMaterial({ color: '#ff9d6b' }));
    lens.position.set(0, 8.6, 2); lens.rotation.x = -Math.PI / 2; pivot.add(lens);
  } else {
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
      box(pivot, i % 2 ? armor : dark, [3, 9, 3], [side * 3.4, 2, 1 + i * 3.2]);
    }
  }
  group.add(pivot);
  return { group, pivot };
}
```

## 1.10 Rendering rounds — one draw call

From `threejs-geometry`: do **not** make a Mesh per round. A pooled `LineSegments` with two vertices per
round is one draw call, one buffer upload per frame, and gives tracers their stretched look for free.

```ts
// src/effects.ts
export class TracerPool {
  readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;

  constructor(private readonly max: number) {
    this.positions = new Float32Array(max * 6);
    this.colors = new Float32Array(max * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
  }

  /** Each live round becomes a short segment trailing its own velocity. Dead rounds collapse to a point. */
  sync(rounds: Rounds) {
    const player = new THREE.Color('#cfe9ff'), hostile = new THREE.Color('#ff8f72');
    for (let i = 0; i < this.max; i++) {
      const o = i * 6;
      if (rounds.life[i] <= 0) { this.positions.fill(0, o, o + 6); continue; }
      const tail = 0.022;   // seconds of travel drawn behind the round
      this.positions[o] = rounds.x[i]; this.positions[o + 1] = rounds.y[i]; this.positions[o + 2] = 6;
      this.positions[o + 3] = rounds.x[i] - rounds.vx[i] * tail;
      this.positions[o + 4] = rounds.y[i] - rounds.vy[i] * tail;
      this.positions[o + 5] = 6;
      const c = rounds.faction[i] ? hostile : player;
      this.colors[o] = c.r; this.colors[o + 1] = c.g; this.colors[o + 2] = c.b;
      this.colors[o + 3] = c.r * 0.2; this.colors[o + 4] = c.g * 0.2; this.colors[o + 5] = c.b * 0.2;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  dispose() { this.lines.geometry.dispose(); (this.lines.material as THREE.Material).dispose(); }
}
```

Beams get their own tiny pool: one stretched, additive plane per active beam, rebuilt each frame from the
`BeamHit` list. Two beams is the realistic maximum, so a `THREE.Mesh` each is cheaper than any pooling scheme.

Ore renders as an `InstancedMesh` over `oreGeometry()` — `setMatrixAt` per live chunk, `instanceMatrix.needsUpdate`
once, `count` set to the live total so retired chunks cost nothing.

## 1.11 Destruction feedback, and the rock geometry cache

`scene.ts` gains:

```ts
spawnRock(obstacle: Obstacle)      // build, position, add, record in this.rocks keyed by id
removeRock(id: number)             // dispose geometry, remove from scene and from this.rocks
explode(x: number, y: number, radius: number)   // sparks + dust + ring + a pooled point light
hitFlash(x: number, y: number, colour: string)  // 4 sparks, no shake — every round should feel felt
syncOre(ore: Ore[])                // InstancedMesh update
```

`explode()` composes what already exists: `this.sparks.emit` x (10 + radius), a `this.vent.emit` dust puff,
two `this.waves.pulse` rings at different radii and speeds, camera shake scaled by radius and by distance to
the ship. Reuse, do not write a new particle system.

**A geometry cache is required here, not optional.** `buildAsteroid` builds a unique subdivided icosahedron
per rock — at radius > 46 that is subdivision 5, about 10k vertices. Fracture spawns new rocks at runtime;
without a cache a long mining session allocates unbounded geometry. Key on quantised radius and seed:

```ts
const rockCache = new Map<string, THREE.BufferGeometry>();

export function cachedAsteroid(radius: number, seed: number) {
  // 12 radius buckets x 16 seeds = at most 192 distinct geometries, and they all get reused.
  const bucket = Math.max(1, Math.round(radius / 8));
  const key = `${bucket}:${seed % 16}`;
  let geometry = rockCache.get(key);
  if (!geometry) { geometry = buildAsteroid(bucket * 8, seed % 16).geometry; rockCache.set(key, geometry); }
  const mesh = new THREE.Mesh(geometry, asteroidMaterial!);
  mesh.scale.setScalar(radius / (bucket * 8));   // exact radius from a shared shape
  return mesh;
}
```

Switch the constructor's rock loop to `cachedAsteroid` too — it cuts startup geometry work for the existing
460 rocks by roughly the same factor, which is a free win on the load time the game already has.
`removeRock` must **not** dispose a cached geometry; only remove the mesh. Add a comment saying so, because
`disposeObject` does dispose geometry and pointing it at a shared rock would blank every rock on screen.

## 1.12 Selective bloom

Guns, beams, explosions and engine bells want glow. From `threejs-postprocessing`: add an `EffectComposer`
with `RenderPass` + `UnrealBloomPass(resolution, strength 0.55, radius 0.4, threshold 0.82)` and render with
`composer.render()` in place of `renderer.render()`. The high threshold means only the already-bright
additive materials bloom; the lit hulls do not wash out.

Guard it: keep `renderer.render()` on a `lowSpec` flag, set when `devicePixelRatio * width * height` is large
or when the user prefers reduced motion. Bloom is the first thing to drop on a weak GPU.
Add `composer.setSize` to the existing `resize()`.

**Verify Phase 1:** new `tests/combat.test.ts` — a round fired at a stationary rock reduces its HP by exactly
`damage * rockBonus`; a round fired past it does not; `fractureRock` on a 60 m rock returns 3 fragments whose
areas sum to within 25% of the parent and at least 3 ore drops; a 1400 m/s round crossing a 9 m rock still
registers (the substep); `stepOre` collects a chunk inside 26 m and never twice.

---

# Phase 2 — Hostiles

> **Skills:** `threejs-animation` (procedural — smooth damping, spring, oscillation for turret tracking and
> recoil), `threejs-materials`, `threejs-lighting` (pooled point light per explosion).

## 2.1 Reuse the ship simulation

A hostile is a `ShipState` plus an AI that writes a `FlightInput`. That is the whole trick: enemies obey the
same integrator, the same mass, the same fuel and the same collision response as the player, so they behave
plausibly for free and every physics fix fixes them too. Do not write a second movement model.

```ts
// src/combat.ts
export type HostileKind = 'raider' | 'interceptor' | 'turret' | 'mine';
export type AIMode = 'patrol' | 'attack' | 'flee';

export type Hostile = {
  id: number; kind: HostileKind;
  state: ShipState;
  mounts: Mount[];
  mode: AIMode;
  home: Vec2;          // patrol anchor
  alertRange: number;
  preferred: number;   // the range it tries to hold
  reaction: number;    // seconds of decision lag; keeps it from being a perfect aimbot
  bounty: number;
  cooldown: number;
};

export const HOSTILES: Record<HostileKind, { ship: ShipClass; hull: number; weapons: string[]; alert: number; preferred: number; reaction: number; bounty: number }> = {
  raider:      { ship: 'kestrel', hull: 90,  weapons: ['ac20', 'ac20'], alert: 900,  preferred: 380, reaction: 0.34, bounty: 1400 },
  interceptor: { ship: 'needle',  hull: 55,  weapons: ['ac20'],         alert: 1200, preferred: 260, reaction: 0.20, bounty: 1900 },
  turret:      { ship: 'mule',    hull: 140, weapons: ['ac70'],         alert: 700,  preferred: 0,   reaction: 0.45, bounty: 1100 },
  mine:        { ship: 'needle',  hull: 20,  weapons: [],               alert: 150,  preferred: 0,   reaction: 0,    bounty: 300 },
};
```

Turrets and mines are hostiles with their thrust zeroed before `stepShip` — no separate code path, no separate
update loop. A turret that cannot translate but can rotate and shoot is exactly a raider with `thrust: 0`.

## 2.2 The AI

Four states, one switch, target-leading fire discipline. Around 70 lines, and that is the ceiling.

```ts
/** Where to shoot so a round at `speed` meets a target moving at `tv`. One iteration is plenty at these ranges. */
function leadPoint(from: Vec2, target: Vec2, tv: Vec2, speed: number): Vec2 {
  const range = Math.hypot(target.x - from.x, target.y - from.y);
  const t = range / speed;
  return { x: target.x + tv.x * t, y: target.y + tv.y * t };
}

export function stepHostile(h: Hostile, player: ShipState, rounds: Rounds, grid: SpatialGrid, dt: number): void {
  if (h.state.hull <= 0) return;
  const toPlayer = { x: player.position.x - h.state.position.x, y: player.position.y - h.state.position.y };
  const range = Math.hypot(toPlayer.x, toPlayer.y);
  const hullRatio = h.state.hull / HOSTILES[h.kind].hull;

  h.cooldown -= dt;
  if (h.cooldown <= 0) {                    // decisions are made at ~3 Hz, not 120 Hz
    h.cooldown = h.reaction;
    if (hullRatio < 0.28) h.mode = 'flee';
    else if (range < h.alertRange && player.hull > 0) h.mode = 'attack';
    else if (h.mode !== 'flee') h.mode = 'patrol';
  }

  const spec = h.mounts[0]?.spec;
  const aim = spec ? leadPoint(h.state.position, player.position, player.velocity, spec.speed) : player.position;
  const wantBearing = h.mode === 'flee'
    ? Math.atan2(-toPlayer.y, -toPlayer.x)
    : Math.atan2(aim.y - h.state.position.y, aim.x - h.state.position.x);

  // stepShip's hull axis is angle + PI/2; turn toward the wanted bearing with a damped proportional law.
  const error = wrapAngle(wantBearing - (h.state.angle + Math.PI / 2));
  const turn = clamp(error * 2.4 - h.state.angularVelocity * 0.7, -1, 1);

  let thrust = 0, strafe = 0;
  if (h.preferred > 0 && h.mode !== 'patrol') {
    const gap = range - h.preferred;
    thrust = clamp(gap / 260, -0.28, 1) * (h.mode === 'flee' ? -1 : 1);
    if (h.mode === 'flee') thrust = 1;                 // nose is already pointed away
    // Orbit rather than sit still: a stationary target is no fun to fight and no threat to fly past.
    else if (Math.abs(gap) < 140) strafe = Math.sin(h.id * 1.7 + performance.now() / 2600) > 0 ? 1 : -1;
  } else if (h.mode === 'patrol' && h.preferred > 0) {
    const drift = Math.hypot(h.home.x - h.state.position.x, h.home.y - h.state.position.y);
    thrust = drift > 500 ? 0.35 : 0;
  }

  const aligned = Math.abs(error) < 0.16 && range < (spec?.range ?? 0) * 0.85;
  const input: FlightInput = { thrust, turn, strafe, brake: h.mode === 'patrol' && thrust === 0, boost: false };
  stepShip(h.state, input, dt);
  const nearby: Obstacle[] = [];
  grid.near(h.state.position.x, h.state.position.y, nearby);
  for (const rock of nearby) resolveCollision(h.state, rock);   // hostiles hit rocks too, and it shows
  if (h.mounts.length) {
    fireMounts(h.mounts, h.state, aim, h.mode === 'attack' && aligned, rounds, 1, 1.3, dt);
  }
}
```

`reaction` is the difficulty knob and the fairness valve: raiders lag a third of a second behind the player's
manoeuvres, which reads as a pilot rather than a turret solution. Expose it per contract, not per enemy type,
so a contract can say "veteran raiders" by dropping reaction to 0.18.
`// ponytail: 3 Hz decisions and a proportional turn law. Behaviour trees only if a contract needs coordination.`

Mines never call `stepHostile`: they drift, and detonate for area damage inside 150 m. Ten lines in `main.ts`.

## 2.3 Models — raider, turret, mine

Hostiles must read as hostile at a glance from a top-down 1.4x zoom: **dark, angular, coral-lit**, against the
player's ivory-and-amber. Silhouette does the work; colour confirms it.

```ts
const hostilePlate = new THREE.MeshStandardMaterial({ color: '#2c2a33', roughness: 0.72, metalness: 0.7 });
const hostileTrim = new THREE.MeshStandardMaterial({ color: '#6d3b38', roughness: 0.6, metalness: 0.75 });
const hostileLamp = new THREE.MeshBasicMaterial({ color: '#df8277' });

export type HostileModel = { group: THREE.Group; flames: THREE.Mesh[]; lamp: THREE.Mesh; turrets: THREE.Group[] };

export function buildRaider(kind: 'raider' | 'interceptor'): HostileModel {
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [];
  const turrets: THREE.Group[] = [];
  const wide = kind === 'interceptor' ? 0.74 : 1;

  // A forward-swept dart: the mirror of the player's blunt, working corvette.
  const shape = new THREE.Shape();
  shape.moveTo(0, 42); shape.lineTo(14 * wide, 4); shape.lineTo(21 * wide, -18);
  shape.lineTo(9 * wide, -30); shape.lineTo(-9 * wide, -30); shape.lineTo(-21 * wide, -18);
  shape.lineTo(-14 * wide, 4); shape.closePath();
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 11, bevelEnabled: true, bevelSize: 1.2, bevelThickness: 1, bevelSegments: 1 }), hostilePlate);
  body.position.z = -5.5; body.castShadow = true; group.add(body);

  box(group, hostileTrim, [7 * wide, 26, 4], [0, 6, 6]);
  box(group, black, [4.5 * wide, 2, 0.6], [0, 22, 8.4]);                 // canopy slit
  for (const side of [-1, 1]) {
    box(group, hostilePlate, [3, 34, 5], [side * 17 * wide, -6, 1], side * 0.22);
    box(group, hostileTrim, [8, 3, 1.4], [side * 13 * wide, 12, 6]);
    const mount = buildGunMount(kind === 'interceptor' ? 'ac20' : 'ac20');
    mount.group.position.set(side * 11 * wide, 9, 7);
    group.add(mount.group); turrets.push(mount.pivot);
    const bell = cylinder(group, metal, 3.4, 5, 10, [side * 8 * wide, -33, 0]);
    bell.rotation.z = 0;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(4, 30, 14, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 vUv; void main(){float a=pow(1.-vUv.y,1.5);vec3 c=mix(vec3(.72,.22,.18),vec3(1.,.84,.6),a);gl_FragColor=vec4(c,a*.8);}',
    }));
    flame.rotation.z = Math.PI;
    flame.position.set(side * 8 * wide, -52, 0);
    flame.visible = false; group.add(flame); flames.push(flame);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 8), hostileLamp);
  lamp.position.set(0, 38, 5); group.add(lamp);
  return { group, flames, lamp, turrets };
}
```

`turrets[i].rotation.z` is driven each frame from `hostile.mounts[i].bearing`, damped —
`threejs-animation`'s smooth-damping pattern, so barrels swing rather than snap:
`pivot.rotation.z += (target - pivot.rotation.z) * (1 - Math.exp(-dt * 9))`. Apply the same to the
player's mounts. One line, and it is most of what makes guns feel mechanical.

```ts
export function buildTurret(): HostileModel {
  const group = new THREE.Group();
  const turrets: THREE.Group[] = [];
  cylinder(group, dark, 15, 19, 6, [0, 0, -4], 10);                  // anchored base
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    box(group, metal, [3.4, 18, 2.4], [Math.cos(a) * 15, Math.sin(a) * 15, -4], -a);
  }
  cylinder(group, hostilePlate, 9, 12, 9, [0, 0, 3], 10);
  const head = buildGunMount('ac70');
  head.group.position.set(0, 0, 9);
  group.add(head.group); turrets.push(head.pivot);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 8), hostileLamp);
  lamp.position.set(0, 0, 15); group.add(lamp);
  return { group, flames: [], lamp, turrets };
}

export function buildMine(): HostileModel {
  const group = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(7, 1), hostilePlate);
  core.castShadow = true; group.add(core);
  // Spikes on the icosahedron's own vertex directions: the shape supplies its own layout.
  const directions = new THREE.IcosahedronGeometry(1, 0).attributes.position;
  const seen = new Set<string>();
  const v = new THREE.Vector3();
  for (let i = 0; i < directions.count; i++) {
    v.fromBufferAttribute(directions, i).normalize();
    const key = v.toArray().map(n => n.toFixed(2)).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(1.1, 6, 6), hostileTrim);
    spike.position.copy(v).multiplyScalar(9);
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    group.add(spike);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(2.1, 10, 10), hostileLamp);
  lamp.position.set(0, 0, 8); group.add(lamp);
  return { group, flames: [], lamp, turrets: [] };
}
```

The mine's lamp blinks faster as the player closes — `lamp.visible = Math.sin(time * (3 + 14 * proximity)) > 0`.
That single line is the entire warning system and it needs no HUD element.

## 2.4 Scene and HUD wiring

- `scene.addHostile(h)` / `removeHostile(id)`, keeping a `Map<number, HostileModel>`; drive position, angle,
  flames (from `state.thrustLevel`) and turret bearings in `render()` exactly as the player ship is driven.
- On death: `explode()` at scale 2, drop ore or a salvage container, `removeHostile`, credit the bounty.
- `radar.ts` gains a `'hostile'` kind drawn as a coral triangle pointing along its heading, plus a
  `'ore'` kind as a small amber dot. Both go in `RadarContact`; the existing draw switch grows two cases.
- HUD: a threat strip under the vessel panel listing live hostiles with range and a hull pip. `Tab` cycles
  `targetId` through them. When any hostile is in `attack` mode, the contract card's stage chip turns coral
  and reads `Under fire` — reuse the existing damage vignette for incoming hits.
- Audio: `FlightAudio` gains `shot(kind)` and `boom()` — two more oscillator-and-envelope functions in the
  shape of the existing `ping()`. Do not reach for a sample library for five sounds.

**Verify Phase 2:** `tests/combat.test.ts` — a hostile at 2 km stays `patrol`; inside its alert range it goes
`attack`; at 20% hull it goes `flee` and its thrust points away; `leadPoint` on a target crossing at 40 m/s at
600 m returns a point ahead of it; a hostile round damages the player and a player round never damages a
hostile teammate.

---

# Phase 3 — The modular shipbuilder

> **Skills:** `threejs-fundamentals` (Object3D hierarchy, local vs world transforms, layers),
> `threejs-interaction` (raycasting onto gizmos, layer filtering, throttled hover),
> `threejs-geometry`, `threejs-materials`.

## 3.1 The shape of a build

A build is **a core plus parts bolted to the core's hardpoints**. The core is the spine: it carries the
cockpit, the structural mass and the hardpoint layout. Everything else — engines, tanks, guns, cargo, wings,
armour, RCS — is a part you bolt on, and every flight number is derived from what is bolted on.

```ts
// src/build.ts
export type Build = { id: string; name: string; core: string; slots: Record<string, string | null> };
```

`slots` maps hardpoint id to part id. That is the entire save format: two strings and a flat map. It diffs,
it migrates, and an unknown part id is dropped on load rather than corrupting the build.

**Stock ships are not builds.** Kestrel / Mule / Needle keep their hand-built models and their `SHIPS` stat
block untouched. The hangar offers "Stock hulls" and "Your builds" as two lists. One source of truth per ship;
never derive a stock ship's numbers from parts, or the art and the figures drift apart the first time
someone retunes a tank.

## 3.2 Hardpoints and cores

```ts
// src/parts.ts
export type PartCategory = 'engine' | 'tank' | 'weapon' | 'cargo' | 'armor' | 'wing' | 'rcs' | 'utility';

export type Hardpoint = {
  id: string;
  x: number; y: number; z: number;   // hull-local, same frame as buildShip
  angle: number;                     // mount rotation about z
  accepts: PartCategory[];
  scale?: number;                    // some sockets take a bigger part than others
  mirrorOf?: string;                 // the other half of a left/right pair
  label: string;                     // what the builder calls it
};

export type Core = {
  id: string; name: string; blurb: string;
  mass: number; hull: number; torque: number;  // structural contribution before any part
  cost: number;
  hardpoints: Hardpoint[];
  build: (root: THREE.Group) => void;
};
```

Three cores, deliberately different silhouettes rather than three sizes of the same thing:

| Core | Mass | Hardpoints | Reads as |
| --- | --- | --- | --- |
| `spar` | 18 t | 2 engine, 2 tank, 4 weapon, 2 wing, 2 rcs | a bare girder — fast, fragile, cheap |
| `truss` | 34 t | 3 engine, 3 tank, 6 weapon, 2 cargo, 4 armor, 2 wing, 4 rcs | the workhorse |
| `keel` | 62 t | 4 engine, 4 tank, 6 weapon, 4 cargo, 8 armor, 4 rcs | a slab you bolt a refinery to |

Mirrored sockets (`port-gun-1` / `star-gun-1`) install and remove **as a pair** in the UI. One click fits both
sides. Anything else is tedium the player will resent by the third build.

## 3.3 Part definitions

```ts
export type Part = {
  id: string; name: string; category: PartCategory; blurb: string;
  mass: number;          // kg, dry
  cost: number;
  thrust?: number;       // N, engines
  torque?: number;       // rad/s^2 contribution before mass normalisation, rcs and engines
  fuel?: number;         // kg of propellant, tanks
  hull?: number;         // integrity, armour and structure
  cargo?: number;        // ore capacity, cargo pods
  cooling?: number;      // heat shed per second, wings and radiators
  weapon?: string;       // key into WEAPONS
  build: (root: THREE.Group) => void;
};

export const PARTS: Record<string, Part> = {
  // ENGINES — thrust per kg is the whole tradeoff; the big bell is not simply better.
  'eng-d4':  { id: 'eng-d4',  name: 'D4 drive',       category: 'engine', mass: 5200,  cost: 1400, thrust: 420000,  torque: 0.10, blurb: 'Compact, thrifty, unremarkable.', build: enginePod(0.8) },
  'eng-d9':  { id: 'eng-d9',  name: 'D9 drive',       category: 'engine', mass: 11400, cost: 3600, thrust: 980000,  torque: 0.14, blurb: 'The standard haul engine.',       build: enginePod(1) },
  'eng-k12': { id: 'eng-k12', name: 'K12 torch',      category: 'engine', mass: 19800, cost: 9200, thrust: 1880000, torque: 0.08, blurb: 'Enormous thrust, enormous thirst.', build: enginePod(1.35) },
  // TANKS
  'tnk-s':   { id: 'tnk-s',   name: 'Bladder tank',   category: 'tank', mass: 900,  cost: 320,  fuel: 4200,  blurb: 'Cheap volume.',                   build: tankPod(0.8) },
  'tnk-m':   { id: 'tnk-m',   name: 'Standard tank',  category: 'tank', mass: 1600, cost: 700,  fuel: 8800,  blurb: 'Balanced.',                        build: tankPod(1) },
  'tnk-l':   { id: 'tnk-l',   name: 'Long-range tank',category: 'tank', mass: 3100, cost: 1650, fuel: 17500, blurb: 'Dead weight until you need it.',   build: tankPod(1.3) },
  // WEAPONS — one part per WEAPONS entry; the part carries the mount geometry.
  'wpn-ac20':  { id: 'wpn-ac20',  name: 'AC-20 turret',  category: 'weapon', mass: 1400, cost: 900,  weapon: 'ac20',   blurb: 'Fast, forgiving, weak on rock.', build: gunPart('ac20') },
  'wpn-ac70':  { id: 'wpn-ac70',  name: 'AC-70 breaker', category: 'weapon', mass: 3900, cost: 2600, weapon: 'ac70',   blurb: 'Splits boulders.',               build: gunPart('ac70') },
  'wpn-gauss': { id: 'wpn-gauss', name: 'Gauss lance',   category: 'weapon', mass: 6200, cost: 7400, weapon: 'gauss',  blurb: 'One shot, long reach, hot.',     build: gunPart('gauss') },
  'wpn-cutter':{ id: 'wpn-cutter',name: 'Mining cutter', category: 'weapon', mass: 2100, cost: 1800, weapon: 'cutter', blurb: 'Short, thirsty, eats asteroids.',build: gunPart('cutter') },
  'wpn-swarm': { id: 'wpn-swarm', name: 'Swarm rack',    category: 'weapon', mass: 2800, cost: 4100, weapon: 'swarm',  blurb: 'Fire and forget.',               build: gunPart('swarm') },
  // HULL AND UTILITY
  'crg-pod': { id: 'crg-pod', name: 'Ore pod',        category: 'cargo',   mass: 1200, cost: 480,  cargo: 320, blurb: 'Holds what you break.',        build: cargoPod() },
  'arm-tile':{ id: 'arm-tile',name: 'Ablative tile',  category: 'armor',   mass: 2400, cost: 620,  hull: 26,   blurb: 'Mass you are glad of.',        build: armorTile() },
  'wng-rad': { id: 'wng-rad', name: 'Radiator wing',  category: 'wing',    mass: 1500, cost: 900,  cooling: 0.09, blurb: 'Lets the guns keep firing.', build: radiatorWing() },
  'rcs-pod': { id: 'rcs-pod', name: 'RCS quad',       category: 'rcs',     mass: 400,  cost: 260,  torque: 0.42, blurb: 'Turns you.',                  build: rcsPod() },
  'utl-scan':{ id: 'utl-scan',name: 'Survey mast',    category: 'utility', mass: 700,  cost: 1400, blurb: 'Halves every scan time.',                   build: scanMast() },
  'utl-coll':{ id: 'utl-coll',name: 'Ore collector',  category: 'utility', mass: 950,  cost: 1100, blurb: 'Triples the ore pickup envelope.',          build: collector() },
};
```

Utility parts change rules, not numbers: `utl-scan` scales `ScanSpec.seconds` by 0.5, `utl-coll` scales
`ORE_PICKUP_RADIUS` by 3. Both read from the derived stats, so the sim never inspects a part list.

## 3.4 Deriving the flight numbers

This is the heart of the feature. Every number the sim reads comes out of one function.

```ts
// src/build.ts
export type DerivedStats = {
  name: string; dryMass: number; fuel: number; thrust: number; hull: number;
  torque: number; cargo: number; cooling: number;
  mounts: { weapon: string; lx: number; ly: number }[];
  scanScale: number; collectScale: number;
  accel: number;       // m/s^2 at full tanks, for display
  gees: number;        // the number the hangar shows
  valid: boolean; problems: string[]; cost: number;
};

export function derive(build: Build): DerivedStats {
  const core = CORES[build.core];
  let dryMass = core.mass, fuel = 0, thrust = 0, hull = core.hull;
  let rawTorque = core.torque, cargo = 0, cooling = 0, cost = core.cost;
  let scanScale = 1, collectScale = 1;
  const mounts: DerivedStats['mounts'] = [];

  for (const hardpoint of core.hardpoints) {
    const part = PARTS[build.slots[hardpoint.id] ?? ''];
    if (!part) continue;
    dryMass += part.mass; cost += part.cost;
    fuel += part.fuel ?? 0; thrust += part.thrust ?? 0; hull += part.hull ?? 0;
    rawTorque += part.torque ?? 0; cargo += part.cargo ?? 0; cooling += part.cooling ?? 0;
    if (part.weapon) mounts.push({ weapon: part.weapon, lx: hardpoint.x, ly: hardpoint.y });
    if (part.id === 'utl-scan') scanScale *= 0.5;
    if (part.id === 'utl-coll') collectScale *= 3;
  }

  // Angular acceleration falls as mass grows. Normalising against the truss core's 34 t keeps the
  // existing SHIPS torque values (0.82 - 2.05) as the readable scale a player already has a feel for.
  const torque = rawTorque * (34000 / Math.max(8000, dryMass));
  const wet = dryMass + fuel;
  const accel = thrust / wet;

  const problems: string[] = [];
  if (thrust <= 0) problems.push('No engine. This will not move.');
  if (fuel <= 0) problems.push('No propellant tank.');
  if (accel < 2.2) problems.push('Under 0.22 g — too sluggish to hold station against a rock.');
  if (torque < 0.35) problems.push('Too little attitude authority. Add an RCS quad or shed mass.');
  if (hull < 40) problems.push('Structurally marginal. One collision ends the sortie.');

  return {
    name: build.name, dryMass, fuel, thrust, hull, torque, cargo, cooling, mounts,
    scanScale, collectScale, accel, gees: accel / 9.81, cost,
    valid: problems.length === 0, problems,
  };
}
```

The four validity rules are the entire balance system. They rule out the degenerate builds (all guns and no
engine, all tank and no torque) without a points budget, a tech tree or a tier table. If a build passes, it
flies; the tradeoffs police themselves through mass.

`stepShip` currently reads `SHIPS[state.shipClass]`. Change it to read a `ShipSpec` carried on the state:

```ts
export type ShipSpec = { name: string; mass: number; thrust: number; fuel: number; torque: number; hull: number; length: number };
export type ShipState = { /* ...existing... */ spec: ShipSpec };
```

`createShip(spec)` takes a spec; `SHIPS[class]` and `derive(build)` both produce one. **This single change is
what makes stock ships and custom builds interchangeable everywhere downstream** — the sim, the HUD, the radar
and the hangar stop caring which kind of ship they were handed. Do it before writing the builder UI; doing it
after means touching every call site twice.

## 3.5 Assembling the model

Straight `threejs-fundamentals` Object3D hierarchy: a hardpoint is an empty `Group` at its local transform,
and a part is built into that group. Mounting is `hardpointGroup.add(...)`, removal is `disposeObject`.

```ts
// src/build.ts
export type BuiltShip = {
  group: THREE.Group;
  flames: THREE.Mesh[];          // driven by thrustLevel, same contract as ShipModel
  rcs: THREE.Mesh[];
  turrets: THREE.Group[];        // index-aligned with DerivedStats.mounts
  light: THREE.PointLight;
  sockets: Map<string, THREE.Group>;   // hardpoint id -> its group, for the builder's gizmos
};

export function buildFromParts(build: Build): BuiltShip {
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [], rcs: THREE.Mesh[] = [], turrets: THREE.Group[] = [];
  const sockets = new Map<string, THREE.Group>();
  const core = CORES[build.core];
  core.build(group);

  for (const hardpoint of core.hardpoints) {
    const socket = new THREE.Group();
    socket.position.set(hardpoint.x, hardpoint.y, hardpoint.z);
    socket.rotation.z = hardpoint.angle;
    if (hardpoint.scale) socket.scale.setScalar(hardpoint.scale);
    socket.name = hardpoint.id;
    group.add(socket);
    sockets.set(hardpoint.id, socket);

    const part = PARTS[build.slots[hardpoint.id] ?? ''];
    if (!part) continue;
    part.build(socket);
    // Parts publish their moving pieces by name; the assembler collects them without knowing the geometry.
    socket.traverse(child => {
      if (child.name === 'flame' && child instanceof THREE.Mesh) flames.push(child);
      if (child.name === 'rcs-jet' && child instanceof THREE.Mesh) rcs.push(child);
      if (child.name === 'turret-pivot' && child instanceof THREE.Group) turrets.push(child);
    });
  }

  const light = new THREE.PointLight('#73bdff', 0, 140, 1.4);
  light.position.set(0, -53, 8); group.add(light);
  return { group, flames, rcs, turrets, light, sockets };
}
```

Naming the moving pieces (`flame`, `rcs-jet`, `turret-pivot`) is the whole coupling between a part's geometry
and the renderer. A new engine part is a `build` function that names its cone `flame` and it animates
correctly with no other change anywhere.

`scene.ts` currently holds `ship: ShipModel`. Widen it to `ShipModel | BuiltShip` — both expose
`group`, `flames`, `rcs`, `light`; `ShipModel` simply has no `turrets`, so guard that one loop.
Add `scene.setShip(model)` alongside the existing `changeShip(class)`.

## 3.6 Part geometry

Curried builders, so a size is a number rather than five near-identical functions. All live in `parts.ts`
and import the `box` / `cylinder` helpers from `models.ts` (export them — they are already written and
already right; re-implementing them in a second file is the mistake to avoid here).

```ts
export const enginePod = (size: number) => (root: THREE.Group) => {
  cylinder(root, metal, 3.6 * size, 5.4 * size, 13 * size, [0, 4 * size, 0]);
  cylinder(root, dark,  4.6 * size, 6.2 * size, 7 * size,  [0, -4 * size, 0]);
  cylinder(root, black, 5.4 * size, 5.4 * size, 0.8,       [0, -8 * size, 0]);
  cylinder(root, new THREE.MeshBasicMaterial({ color: '#98d8f5' }), 4.3 * size, 4.3 * size, 0.9, [0, -8.6 * size, 0]);
  for (let i = 0; i < 5; i++) box(root, copper, [5.6 * size, 0.6, 0.7], [0, 8 + i * 2.4, 2.6 * size]);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(4.4 * size, 38 * size, 18, 1, true), flameMaterial());
  flame.name = 'flame';                        // the assembler finds it by name
  flame.rotation.z = Math.PI;
  flame.position.set(0, -28 * size, 0);
  flame.visible = false;
  root.add(flame);
};

export const tankPod = (size: number) => (root: THREE.Group) => {
  const shell = new THREE.Mesh(new THREE.CapsuleGeometry(6.5 * size, 17 * size, 4, 14), lightArmor);
  shell.castShadow = true; root.add(shell);
  for (const y of [-7 * size, 0, 7 * size]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(6.7 * size, 0.5, 6, 20), metal);
    band.rotation.x = Math.PI / 2; band.position.y = y; root.add(band);
  }
  box(root, copper, [2.2, 5, 2.2], [0, -13 * size, 0]);   // feed line
};

export const gunPart = (weapon: keyof typeof WEAPONS) => (root: THREE.Group) => {
  const { group, pivot } = buildGunMount(weapon);
  pivot.name = 'turret-pivot';
  root.add(group);
};

export const cargoPod = () => (root: THREE.Group) => {
  box(root, dark, [15, 22, 13], [0, 0, 0]);
  box(root, copper, [16, 16, 14], [0, 0, 0]);
  for (const y of [-8, 8]) box(root, metal, [16.5, 2, 14.5], [0, y, 0]);
  box(root, glass, [5, 2, 0.5], [0, 4, 7.6]);            // fill indicator; brighten it as cargo fills
};

export const armorTile = () => (root: THREE.Group) => {
  for (let i = 0; i < 3; i++) {
    box(root, i % 2 ? armor : lightArmor, [11, 7.4, 1.8], [0, -7.4 + i * 7.4, 0]);
    box(root, black, [7, 0.6, 0.3], [0, -7.4 + i * 7.4, 1.1]);
  }
};

export const radiatorWing = () => (root: THREE.Group) => {
  const panel = box(root, new THREE.MeshStandardMaterial({ color: '#203d55', roughness: 0.3, metalness: 0.85 }), [3, 44, 1.6], [0, -6, 0]);
  panel.rotation.z = 0.1;
  for (let i = -4; i <= 4; i++) box(panel, metal, [3.6, 0.5, 2], [0, i * 4.6, 0]);
  box(root, dark, [5, 8, 3], [0, 14, 0]);                // root fitting
};

export const rcsPod = () => (root: THREE.Group) => {
  const pod = box(root, dark, [5, 6.2, 4.2], [0, 0, 0]);
  for (const side of [-1, 1]) {
    box(pod, metal, [1, 4, 4.6], [side * 2.8, 0, 0]);
    const jet = new THREE.Mesh(new THREE.ConeGeometry(1.2, 10, 8), jetMaterial());
    jet.name = 'rcs-jet';
    jet.rotation.z = -side * Math.PI / 2;
    jet.position.set(side * 8, 0, 0);
    jet.visible = false;
    root.add(jet);
  }
};

export const scanMast = () => (root: THREE.Group) => {
  cylinder(root, metal, 0.7, 1.1, 16, [0, 6, 0], 6);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), lightArmor);
  dish.position.set(0, 15, 0); dish.rotation.x = -0.5; root.add(dish);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), beaconLampMaterial);
  lamp.position.set(0, 15, 3); root.add(lamp);
};

export const collector = () => (root: THREE.Group) => {
  const funnel = new THREE.Mesh(new THREE.ConeGeometry(11, 14, 16, 1, true), metal);
  funnel.rotation.x = Math.PI / 2; funnel.position.set(0, 7, 0);
  funnel.material = new THREE.MeshStandardMaterial({ color: '#667681', roughness: 0.5, metalness: 0.86, side: THREE.DoubleSide });
  root.add(funnel);
  const field = new THREE.Mesh(new THREE.RingGeometry(6, 11, 24), beaconHaloMaterial);
  field.position.set(0, 14, 0); field.rotation.x = -Math.PI / 2; root.add(field);
};
```

Cores use the same vocabulary: `spar` is a long `box` spine with ribs, `truss` is the existing `hull()`
extrusion at 60% scale with an open lattice, `keel` is a wide slab with a stepped prow. Reuse `hull()`
from `models.ts` for the truss and keel prows so custom ships still look like they came out of the same yard.

## 3.7 The builder screen

A new flow state alongside `title | hangar | launch | flight`. Extend `ShipBay` rather than writing a second
renderer — it already has the lit turntable, the resize observer and the render loop.

**Layout**

```
+-- SHIPYARD ------------------------------------------------------+
|                                     | CORE   Truss frame      v  |
|        [ live 3D build,             | -------------------------- |
|          hardpoint gizmos,          | SLOT  Port engine          |
|          click to select ]          | [ D4 ] [ D9 ] [ K12 ] [x]  |
|                                     | -------------------------- |
|   drag to spin - scroll to zoom     | Mass      41.2 t           |
|                                     | Thrust     1.96 MN         |
|                                     | Accel      1.43 g          |
|                                     | Turn       1.12 rad/s2     |
|                                     | Prop      17.6 t / 940 dv  |
|                                     | Hull        126            |
|                                     | Cargo       320            |
|                                     | -------------------------- |
|                                     | ! Too little attitude auth |
|                                     | [ Save build ] [ Launch ]  |
+------------------------------------------------------------------+
```

**Hardpoint gizmos** (`threejs-interaction`): each empty socket gets a small translucent octahedron;
each filled socket gets a thin ring. Put every gizmo on layer 1 and set `raycaster.layers.set(1)` so picking
never walks the hull geometry — with 200+ meshes on a full build that matters. Throttle the hover raycast to
20 Hz as the skill prescribes; picking on `pointerdown` is unthrottled.

```ts
private pick(event: PointerEvent): string | undefined {
  const rect = this.renderer.domElement.getBoundingClientRect();
  this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1,
                   -((event.clientY - rect.top) / rect.height) * 2 + 1);
  this.raycaster.setFromCamera(this.pointer, this.camera);
  this.raycaster.layers.set(1);
  return this.raycaster.intersectObjects(this.gizmos, false)[0]?.object.userData.hardpoint as string | undefined;
}
```

**Rebuild on change.** Do not try to add and remove single parts from a live model. Reinstalling means
`disposeObject(old.group)` then `buildFromParts(build)` — a build is at most a few hundred small meshes and
this happens on a click, not per frame. `// ponytail: whole-model rebuild per edit. Incremental swap only if a click ever stutters.`

**Rules the UI enforces**
- Only parts whose `category` is in `hardpoint.accepts` are offered for that socket.
- Only parts the profile owns are installable; unowned parts show greyed with their price and a **Buy** button
  that spends credits, then installs.
- Mirrored sockets install and remove together.
- `derive()` runs after every change; the stat column animates to the new value and the problem list updates
  live. `Launch` is disabled while `valid` is false, with the first problem shown on the button's tooltip.
- Selecting a socket dims every other part to 30% opacity so the player can see what they are editing.

Reuse the existing dialog and `hangar-screen` CSS vocabulary; this is one more screen in a game that already
has three, not a new design language.

**Verify Phase 3:** `tests/build.test.ts` — an empty core is invalid with 'No engine'; a known-good truss build
returns accel within 0.05 g of its hand-computed value; adding a tank raises fuel and lowers accel; `torque`
falls as mass rises; `derive` ignores an unknown part id in `slots` rather than throwing; a weapon part
produces a mount at its hardpoint's exact local coordinates.

---

# Phase 4 — The contract board

## 4.1 One objective system, contracts as data

Today `mission.ts` hardcodes SR-084's three stages. Generalise it so a new contract is data, not code.
**The acceptance test for this phase is that SR-084 becomes a data entry and plays identically.**

```ts
// src/contracts.ts
export type TargetRef =
  | { at: 'relay' } | { at: 'station' } | { at: 'derelict' }
  | { at: 'cargo'; id: string } | { at: 'point'; x: number; y: number };

export type Objective =
  | { kind: 'hold';    target: TargetRef; radius: number; speed: number; seconds: number; label: string }
  | { kind: 'recover'; cargo: string; label: string }
  | { kind: 'dock';    label: string }
  | { kind: 'destroy'; what: 'hostile' | 'rock'; count: number; minRadius?: number; label: string }
  | { kind: 'collect'; amount: number; label: string }
  | { kind: 'reach';   target: TargetRef; radius: number; label: string }
  | { kind: 'survive'; seconds: number; label: string }
  | { kind: 'protect'; ally: string; label: string };

export type Stage = { title: string; objectives: Objective[]; onEnter?: SpawnSpec[]; banner?: string };
export type SpawnSpec = { kind: HostileKind; near: TargetRef; count: number; spread: number; reaction?: number };

export type Contract = {
  id: string; title: string; kicker: string; brief: string;
  kind: 'salvage' | 'mining' | 'bounty' | 'survey' | 'escort';
  danger: 0 | 1 | 2 | 3;
  stages: Stage[];
  payout: number; bonus?: { label: string; credits: number; objective: Objective };
  requires?: string[];       // contract ids that must be complete first
  timeLimit?: number;
};
```

A stage completes when **every** objective in it reports done; completing the last stage completes the contract.
Progress per objective is a number in `0..1`, which is all the HUD needs to draw a stage row — the existing
`.mission-stages` markup already has the shape, it just gets its rows generated instead of hardcoded.

```ts
export type Run = {
  contract: Contract; stageIndex: number;
  progress: Record<string, number>;   // objective key -> 0..1
  counters: { hostilesKilled: number; rocksBroken: number; oreHeld: number; elapsed: number };
  payout: number; complete: boolean; failed?: string;
};

/** One step of contract progress. Same signature shape as the current updateMission — swap it in place. */
export function updateRun(run: Run, world: World, dt: number): RunSignal[];
```

`World` is a small bundle passed by `main.ts`: `{ ship, cargos, hostiles, ore, counters }`. Keeping it explicit
means `contracts.ts` never imports `main.ts` and stays testable headlessly, which is how `mission.test.ts`
already works today.

## 4.2 The five contracts

```ts
export const CONTRACTS: Contract[] = [
  {
    id: 'SR-084', title: 'Ghosts in the belt', kind: 'salvage', danger: 1,
    kicker: 'Nereid recovery zone',
    brief: 'A survey crew stopped transmitting. Their relay still answers.',
    payout: 2800,
    stages: [
      { title: 'Relay telemetry', banner: 'Hold station at the Nereid relay',
        objectives: [{ kind: 'hold', target: { at: 'relay' }, radius: 145, speed: 22, seconds: 2.6, label: 'Hold inside 145 m under 22 m/s' }] },
      { title: 'Resolve and recover',
        // Scavengers followed the same signal you did. They arrive once the archives light up.
        onEnter: [{ kind: 'raider', near: { at: 'cargo', id: 'cargo-3' }, count: 2, spread: 400 }],
        objectives: [
          { kind: 'recover', cargo: 'cargo-1', label: 'Flight recorder' },
          { kind: 'recover', cargo: 'cargo-2', label: 'Research canister' },
          { kind: 'recover', cargo: 'cargo-3', label: 'Survey archive' },
        ] },
      { title: 'Return to Wayfarer', objectives: [{ kind: 'dock', label: 'Dock under 8 m/s' }] },
    ],
    bonus: { label: 'Kite’s End black box', credits: 4200, objective: { kind: 'recover', cargo: 'blackbox', label: 'Black box' } },
  },
  {
    id: 'MN-210', title: 'Quota run', kind: 'mining', danger: 0,
    kicker: 'Wayfarer refinery', brief: 'The refinery is short. Break rock, fill your pods, come home.',
    payout: 5200,
    stages: [
      { title: 'Break and collect', objectives: [
        { kind: 'destroy', what: 'rock', count: 8, minRadius: 26, label: 'Break 8 rocks over 26 m' },
        { kind: 'collect', amount: 420, label: 'Collect 420 units of ore' },
      ] },
      { title: 'Deliver', objectives: [{ kind: 'dock', label: 'Dock and unload' }] },
    ],
    bonus: { label: 'Overfill', credits: 2200, objective: { kind: 'collect', amount: 700, label: '700 units' } },
  },
  {
    id: 'BT-047', title: 'Nest at Kite’s End', kind: 'bounty', danger: 3,
    kicker: 'Standing bounty', brief: 'Raiders have been staging off the wreck. Clear them.',
    payout: 9400, requires: ['SR-084'],
    stages: [
      { title: 'Approach', banner: 'They will see you coming',
        onEnter: [{ kind: 'turret', near: { at: 'derelict' }, count: 2, spread: 220 }],
        objectives: [{ kind: 'reach', target: { at: 'derelict' }, radius: 700, label: 'Close to 700 m' }] },
      { title: 'Clear the nest',
        onEnter: [{ kind: 'raider', near: { at: 'derelict' }, count: 3, spread: 500 },
                  { kind: 'interceptor', near: { at: 'derelict' }, count: 2, spread: 800, reaction: 0.18 }],
        objectives: [{ kind: 'destroy', what: 'hostile', count: 7, label: 'Destroy 7 hostiles' }] },
      { title: 'Report in', objectives: [{ kind: 'dock', label: 'Dock at Wayfarer' }] },
    ],
  },
  {
    id: 'SV-119', title: 'Blackout survey', kind: 'survey', danger: 2, timeLimit: 420,
    kicker: 'Timed', brief: 'Three sensor drops before the window closes. Mines were seeded here.',
    payout: 7100, requires: ['SR-084'],
    stages: [
      { title: 'Drop one', onEnter: [{ kind: 'mine', near: { at: 'point', x: -1900, y: 900 }, count: 6, spread: 600 }],
        objectives: [{ kind: 'hold', target: { at: 'point', x: -1900, y: 900 }, radius: 120, speed: 14, seconds: 4, label: 'Hold at drop one' }] },
      { title: 'Drop two', objectives: [{ kind: 'hold', target: { at: 'point', x: 2050, y: -1500 }, radius: 120, speed: 14, seconds: 4, label: 'Hold at drop two' }] },
      { title: 'Drop three', onEnter: [{ kind: 'interceptor', near: { at: 'point', x: 400, y: 1700 }, count: 2, spread: 500 }],
        objectives: [{ kind: 'hold', target: { at: 'point', x: 400, y: 1700 }, radius: 120, speed: 14, seconds: 4, label: 'Hold at drop three' },
                     { kind: 'dock', label: 'Return before the window closes' }] },
    ],
  },
  {
    id: 'EC-005', title: 'Walk the hauler home', kind: 'escort', danger: 3,
    kicker: 'Convoy', brief: 'Wayfarer wants the ore barge back intact. It is slow and it is unarmed.',
    payout: 11800, requires: ['BT-047'],
    stages: [
      { title: 'Escort', onEnter: [{ kind: 'raider', near: { at: 'point', x: -600, y: 700 }, count: 2, spread: 900 },
                                   { kind: 'raider', near: { at: 'point', x: 900, y: 1200 }, count: 2, spread: 900 }],
        objectives: [{ kind: 'protect', ally: 'hauler', label: 'Keep the hauler alive' },
                     { kind: 'reach', target: { at: 'station' }, radius: 400, label: 'Bring it to Wayfarer' }] },
    ],
  },
];
```

**Ship the first four. `EC-005` is the stretch** — `protect` needs an allied NPC that flies a route, which is
`stepHostile` with the player as the "threat" inverted, plus a waypoint follower. It is the one contract whose
cost is not already paid by earlier phases, so it goes last and gets cut without regret if time runs out.

## 4.3 The board, and what happens to `mission.ts`

The hangar's static brief becomes a **contract board**: a list of cards showing kicker, title, danger pips,
payout, the bonus line, and a lock badge with the prerequisite name when `requires` is unmet. Selecting a card
fills the existing brief column with that contract's stages, generated from `stages[].title` and each
objective's `label`. `Launch sortie` starts a `Run` for the selected contract.

**`mission.ts` is deleted, not wrapped.** Its five exports (`updateMission`, `interactive`, `recoverCargo`,
`completeDock`, `suggestTarget`) move into `contracts.ts` as operations on a `Run`. A compatibility shim would
mean two mission systems in a game that needs one, and the existing `tests/mission.test.ts` is the safety net:
port it to drive SR-084 through `updateRun` and it proves the generalisation preserved every rule —
relay gating, scan decay at 1.7x, recovery gating, the optional salvage, the docking payout.

`suggestTarget` generalises neatly: walk the current stage's incomplete objectives, resolve each to a world
position, return the nearest. The `objective-button` and the `Track nearest contact` label need no change.

**Verify Phase 4:** the ported `tests/mission.test.ts` passes unchanged in behaviour, plus — a `destroy`
objective ignores rocks under `minRadius`; a stage with two objectives does not advance on one; `onEnter`
spawns fire exactly once per stage; a `timeLimit` expiry sets `run.failed`; a locked contract is not offered.

---

# Phase 5 — Persistence and the economy

## 5.1 The profile

`localStorage` is user-editable, so loading it is a trust boundary. Validate, never trust — this is the one
place in the plan where the lazy version is the wrong version.

```ts
// src/save.ts
const KEY = 'drift-profile-v1';

export type Profile = {
  v: 1;
  credits: number;
  owned: string[];               // part ids
  builds: Build[];
  activeShip: { kind: 'stock'; id: ShipClass } | { kind: 'build'; id: string };
  completed: string[];           // contract ids
  bestTimes: Record<string, number>;
  callsign: string;
};

export const STARTING_CREDITS = 6000;
const STARTING_PARTS = ['eng-d9', 'tnk-m', 'wpn-ac20', 'rcs-pod', 'arm-tile'];

export function fresh(): Profile {
  return { v: 1, credits: STARTING_CREDITS, owned: [...STARTING_PARTS], builds: [],
           activeShip: { kind: 'stock', id: 'kestrel' }, completed: [], bestTimes: {}, callsign: 'Rook' };
}

export function load(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || raw.v !== 1) return fresh();
    const profile = fresh();
    // Take each field only if it is the right shape; anything else falls back to the fresh default.
    if (Number.isFinite(raw.credits)) profile.credits = clamp(raw.credits, 0, 1e9);
    if (Array.isArray(raw.owned)) profile.owned = raw.owned.filter((id: unknown) => typeof id === 'string' && id in PARTS);
    if (Array.isArray(raw.builds)) profile.builds = raw.builds.filter(validBuild).slice(0, 24);
    if (Array.isArray(raw.completed)) profile.completed = raw.completed.filter((id: unknown) => CONTRACTS.some(c => c.id === id));
    if (typeof raw.callsign === 'string') profile.callsign = raw.callsign.slice(0, 14);
    if (raw.bestTimes && typeof raw.bestTimes === 'object') {
      for (const [id, t] of Object.entries(raw.bestTimes)) if (Number.isFinite(t)) profile.bestTimes[id] = Number(t);
    }
    if (validActive(raw.activeShip, profile)) profile.activeShip = raw.activeShip;
    return profile;
  } catch { return fresh(); }
}

/** A build survives load only if its core exists and every filled slot names a real hardpoint and part. */
function validBuild(b: unknown): b is Build {
  if (!b || typeof b !== 'object') return false;
  const build = b as Build;
  const core = CORES[build.core];
  if (!core || typeof build.id !== 'string' || typeof build.name !== 'string') return false;
  if (!build.slots || typeof build.slots !== 'object') return false;
  for (const [slot, part] of Object.entries(build.slots)) {
    if (part === null) continue;
    if (!core.hardpoints.some(h => h.id === slot)) return false;
    if (typeof part !== 'string' || !(part in PARTS)) return false;
  }
  return true;
}

export function save(profile: Profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* Storage is optional, as elsewhere. */ }
}
```

Migrate the two existing keys (`drift-best-time`, `drift-callsign`) into the profile on first load, then
remove them. Every existing `try/catch` around `localStorage` in `main.ts` collapses into `load()` and `save()`.

## 5.2 The economy

| Source | Credits |
| --- | --- |
| Contract payout | 2,800 – 11,800 by contract |
| Bonus objective | 2,200 – 4,200 |
| Ore sold on docking | 4 cr per unit (a full 320 pod is 1,280) |
| Hostile bounty | 300 – 1,900, banked only if you dock afterwards |

Sinks: parts (260 – 9,200) and cores (bought once). Starting 6,000 buys a workable first custom build but not
a good one, which is the point — SR-084 in a stock Kestrel is the intended first hour.

**Bounties and ore bank on docking, not on the kill.** It closes the loop the game already has (the station is
where a sortie ends), it gives a reason to fly home with a damaged hull, and it costs one line: the payout is
summed into `run.payout` at kill time but only added to `profile.credits` inside `completeDock`.

Debrief gains an earnings table: payout, bonus, ore, bounties, total, new balance. The existing
`.debrief-stats` markup takes two more rows.

## 5.3 Polish backlog, in the order it pays off

1. **Damage states on the player model.** Below 45% hull the existing venting fires; add scorch decals via
   `threejs-materials` (swap a hull tile's material) and one detached, tumbling plate.
2. **Heat forces a rhythm.** Radiator wings raise `cooling`; wire `stepShip`'s heat decay to the derived
   `cooling` value so a gun-heavy build has to pause. This is where the wing part earns its mass.
3. **Shield hit flash** using the `threejs-shaders` fresnel pattern — a brief rim glow on the hull at the
   impact bearing. Fifteen lines of `ShaderMaterial` and it is the single clearest "you were hit" signal.
4. **Asteroid dissolve.** The `threejs-shaders` dissolve pattern on a destroyed rock, driven by a
   0→1 uniform over 0.35 s, instead of the mesh vanishing on the frame it dies.
5. **Cargo pod fill indicator** — brighten `glass` on the pod as ore accumulates. Two lines, reads instantly.
6. **Mobile**: a fire button under the right thumb, and tap-to-aim. The touch pads already exist; add one
   `data-key="Space"` button to `.touch-drive` and route taps on the canvas through `scene.unproject`.

---

# Three.js skills — where each one is actually needed

| Skill | Phase | What it is for |
| --- | --- | --- |
| `threejs-fundamentals` | 3 | Object3D hierarchy for sockets and parts; local vs world transforms for muzzle positions; `layers` for gizmo picking |
| `threejs-geometry` | 1, 2, 3 | `InstancedMesh` for ore; pooled `BufferGeometry` for tracers; `ExtrudeGeometry` and `CapsuleGeometry` for new parts; the rock geometry cache |
| `threejs-interaction` | 1, 3 | `Raycaster` + `Plane` for cursor aiming; gizmo picking with layer filtering and a throttled hover |
| `threejs-materials` | 1, 2, 3 | Shared module-level materials for every new part; damage-state material swaps |
| `threejs-shaders` | 1, 5 | Beam and flame `ShaderMaterial`; fresnel shield flash; asteroid dissolve |
| `threejs-postprocessing` | 1 | `EffectComposer` + `UnrealBloomPass` for guns, beams and explosions, with a low-spec bypass |
| `threejs-lighting` | 1, 2 | A small pool of point lights for muzzle flashes and explosions; the existing three-light rig stays |
| `threejs-animation` | 2, 3 | Procedural only — smooth damping for turret traverse, spring for recoil, oscillation for mine lamps. No mixer, no clips |
| `threejs-textures` | 3, 5 | `CanvasTexture` stencils for build names and pod labels, following the existing `stencil()` helper |
| `threejs-loaders` | — | **Not used.** The game loads no external assets and that is a feature — keep it that way |

---

# Order of work

Each phase is independently shippable and independently playable. Do not start the next one until the
previous one's tests are green and the browser check passes.

| # | Phase | Unblocks | Risk |
| --- | --- | --- | --- |
| 0 | Spatial grid, solid bodies, `ShipSpec` on state | everything | low — it is mostly a refactor with a bug fix inside it |
| 1 | Guns, fracture, ore, tracers, bloom | the whole pitch | medium — tunnelling and the geometry cache are the traps |
| 2 | Hostiles and AI | contracts with teeth | medium — AI tuning eats time; timebox it |
| 3 | Parts, `derive`, builder screen | progression | **high** — largest surface; `ShipSpec` from Phase 0 is the de-risker |
| 4 | Objective system, contract board | replay value | medium — the port of `mission.test.ts` is the safety net |
| 5 | Profile, economy, polish | the loop closing | low |

Pull `ShipSpec` forward into Phase 0 even though nothing uses it until Phase 3. Retrofitting it after the
builder exists means touching every call site twice.

## Tests

`bun test` grows three files and keeps its headless discipline — no DOM, no WebGL, no `main.ts` import:

- `tests/combat.test.ts` — round damage, the substep, faction filtering, fracture area conservation, ore pickup, AI state transitions, target leading.
- `tests/build.test.ts` — derived stats, the four validity rules, mount placement, unknown-part tolerance.
- `tests/contracts.test.ts` — the ported SR-084 rules plus per-objective progression, stage gating, `onEnter` firing once, time limits, lock requirements.
- `tests/save.test.ts` — a hand-corrupted profile (negative credits, unknown part ids, a build whose core does not exist, a string where a number belongs) loads to something valid and never throws.

`scripts/mission-run.mjs` extends to fly a combat contract: launch MN-210, break a rock with the cutter,
collect ore, dock, and assert the credit balance moved. Keep it driving real keyboard events through the real
UI — the game still exposes no writable test hooks and that should not change for this.

## What this plan deliberately does not build

- **Missiles with guidance.** Specced in `WEAPONS`, shipped dark until Phase 2 proves there is something worth
  chasing. Turn on with a per-round steering integrator and a `homing` flag — about 25 lines.
- **A free-form grid shipbuilder.** Hardpoints give the same expressiveness with a tenth of the UI and a save
  format that survives a part being retuned. Revisit only if players ask for structural layout, not loadout.
- **Multiplayer, a tech tree, a faction reputation system, procedural contract generation.** Five hand-written
  contracts will tell you whether the objective system is right. Generate them after that, not before.
- **A physics engine dependency.** Circles and a grid cover every collision in a planar game. Adding Rapier or
  Cannon for this would be 300 kB to do worse what 60 lines already do.
- **An asset pipeline.** Every model here is code, matching the existing game. No GLTF, no loaders, no CDN.
