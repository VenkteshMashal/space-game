/**
 * Plan A4/A6 render proof (no WebGL context needed).
 *
 * Everything here runs against the same modules the game mounts: the registry, the bounded detail
 * queue, the pools, the tier controller, the camera and the scene adapter with a stub asset
 * factory. The camera assertions project real hull geometry through the real orthographic camera,
 * so "the hull stays visible" is measured, not asserted from intent.
 */

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { DetailQueue, EntityRegistry } from '../src/render/registry';
import { GlyphPool, ImpactLights, ImpactMarks, ParticleField } from '../src/render/pools';
import { FlightCamera, ELEVATION_Y_SCALE, MAX_LEAD_FRACTION, TACTICAL_HALF_HEIGHT_M, ZOOM_MAX, ZOOM_MIN } from '../src/render/camera';
import { TierController } from '../src/render/tier';
import { SessionScene, rockCacheKey } from '../src/render/session-scene';
import type { BodyProxy, Environment, RenderAssets, ShipVisual } from '../src/render/session-scene';
import { defaultFit } from '../src/shared/catalog';
import type {
  BodyView,
  ClientView,
  ContactView,
  EventPayloadByKind,
  Id,
  ProjectileView,
  SessionEvent,
  ShipView,
  Vec2,
} from '../src/shared/contracts';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const SHIP_FIT = defaultFit('kestrel');

function ship(id: Id, overrides: Partial<ShipView> = {}): ShipView {
  return {
    id,
    pilotId: id,
    lifeId: `life-${id}`,
    teamId: 'blue',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    fit: SHIP_FIT,
    hull: 100,
    hullMax: 100,
    fuelKg: 500,
    fuelMaxKg: 500,
    heatMJ: 0,
    heatMaxMJ: 20,
    capacitorMJ: 5,
    life: 'alive',
    ...overrides,
  };
}

function body(id: Id, generation = 1, overrides: Partial<BodyView> = {}): BodyView {
  return {
    id,
    generation,
    visualId: `rock-${id}`,
    renderSeed: 4211,
    position: { x: 200, y: 120 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    shape: { kind: 'circle', radiusM: 24 },
    collidable: true,
    hull: 900,
    hullMax: 900,
    ...overrides,
  };
}

function projectile(id: Id, overrides: Partial<ProjectileView> = {}): ProjectileView {
  return {
    id,
    generation: 1,
    weaponId: 'gun-autocannon',
    ownerLifeId: 'life-p1',
    teamId: 'blue',
    position: { x: 12, y: 40 },
    velocity: { x: 420, y: 0 },
    angle: 0,
    state: 'armed',
    expiresAtTick: 900,
    ...overrides,
  };
}

function contact(id: Id, overrides: Partial<ContactView> = {}): ContactView {
  return { id, kind: 'hostile', position: { x: 900, y: -300 }, uncertaintyM: 40, ageTicks: 6, targetable: true, ...overrides };
}

function clientView(overrides: Partial<ClientView> = {}): ClientView {
  return {
    phase: 'live',
    screenHint: 'flight',
    link: 'online',
    pilotId: 'p1',
    epoch: 'epoch-1',
    tick: 240,
    lobby: null,
    self: null,
    ships: [],
    contacts: [],
    bodies: [],
    projectiles: [],
    weapons: [],
    map: null,
    campaign: null,
    host: null,
    debrief: null,
    teamScores: {},
    objectives: [],
    respawnAtTick: null,
    phaseEndsAtTick: null,
    save: 'clean',
    ...overrides,
  };
}

function sessionEvent(
  kind: 'shot' | 'impact',
  eventId: Id,
  payload: EventPayloadByKind['shot'] | EventPayloadByKind['impact'],
): SessionEvent {
  return { deliverySeq: 1, tick: 240, epoch: 'epoch-1', eventId, kind, payload };
}

/** Asset factory without a GPU: plain Three.js objects, counted so leaks are observable. */
class StubAssets implements RenderAssets {
  live = 0;
  details = 0;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.MeshBasicMaterial();

  createShip(): ShipVisual {
    this.live += 1;
    return {
      group: new THREE.Group(),
      flames: [],
      rcs: [],
      light: null,
      hullRadiusM: 30,
      maxAccelMS2: 20,
      thrust: 0,
      previousVelocity: null,
      flash: () => {},
      decay: () => {},
      dispose: () => {
        this.live -= 1;
      },
    };
  }

  createBodyProxy(): BodyProxy {
    return { object: new THREE.Mesh(this.geometry, this.material), dispose: () => {} };
  }

  createBodyDetail(): THREE.Object3D {
    this.details += 1;
    return new THREE.Mesh(this.geometry, this.material);
  }

  releaseBodyDetail(): void {
    this.details -= 1;
  }

  createEnvironment(): Environment {
    return { update: () => {}, dispose: () => {} };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

describe('entity registry', () => {
  test('same generation updates in place, a new generation disposes the old value', () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const registry = new EntityRegistry<{ dispose(): void }, string>((id, generation) => {
      created.push(`${id}@${generation}`);
      return { dispose: () => disposed.push(`${id}@${generation}`) };
    });

    registry.upsert('hull-a', 1, 'epoch-1', 'x');
    const first = registry.get('hull-a');
    registry.upsert('hull-a', 1, 'epoch-1', 'x');
    expect(created).toEqual(['hull-a@1']);
    expect(registry.get('hull-a')).toBe(first);
    expect(registry.size).toBe(1);

    const replaced = registry.upsert('hull-a', 2, 'epoch-1', 'x');
    expect(replaced.created).toBe(true);
    expect(replaced.replaced).toBe(true);
    expect(disposed).toEqual(['hull-a@1']);
    expect(registry.get('hull-a')).not.toBe(first);
    expect(registry.size).toBe(1);

    registry.remove('hull-a');
    expect(disposed).toEqual(['hull-a@1', 'hull-a@2']);
    expect(registry.size).toBe(0);
  });

  test('a new epoch retires every entity from the old one', () => {
    const disposed: string[] = [];
    const registry = new EntityRegistry<{ dispose(): void }, string>((id, generation) => ({ dispose: () => disposed.push(`${id}@${generation}`) }));
    registry.upsert('a', 1, 'epoch-1', 'x');
    registry.upsert('b', 1, 'epoch-1', 'x');
    expect(registry.setEpoch('epoch-2')).toBe(2);
    expect(registry.size).toBe(0);
    expect(disposed.length).toBe(2);
  });

  test('pruneUnseen drops whatever the authority stopped reporting', () => {
    const registry = new EntityRegistry<{ dispose(): void }, string>(() => ({ dispose: () => {} }));
    registry.beginFrame();
    registry.upsert('a', 1, 'epoch-1', 'x');
    registry.upsert('b', 1, 'epoch-1', 'x');
    registry.beginFrame();
    registry.upsert('a', 1, 'epoch-1', 'x');
    expect(registry.pruneUnseen()).toBe(1);
    expect(registry.ids()).toEqual(['a']);
  });

  test('lookup cost is independent of entity count', () => {
    const registry = new EntityRegistry<{ dispose(): void }, number>(() => ({ dispose: () => {} }));
    for (let i = 0; i < 20_000; i++) registry.upsert(`entity-${i}`, i, 'epoch-1', i);
    const started = performance.now();
    let hits = 0;
    for (let i = 0; i < 200_000; i++) if (registry.get(`entity-${i % 20_000}`)) hits += 1;
    const elapsed = performance.now() - started;
    expect(hits).toBe(200_000);
    // A per-lookup scan of 20k entities is 4e9 comparisons; a Map hit is well under a second.
    expect(elapsed).toBeLessThan(1000);
  });

  test('dispose is idempotent and frees every value', () => {
    let disposed = 0;
    const registry = new EntityRegistry<{ dispose(): void }, undefined>(() => ({
      dispose: () => {
        disposed += 1;
      },
    }));
    registry.upsert('a', 1, null, undefined);
    registry.upsert('b', 1, null, undefined);
    registry.dispose();
    registry.dispose();
    expect(disposed).toBe(2);
    expect(registry.isDisposed).toBe(true);
  });
});

describe('detail queue', () => {
  test('never exceeds 64 pending jobs and keeps the nearest', () => {
    const queue = new DetailQueue();
    for (let i = 0; i < 200; i++) {
      queue.enqueue({ key: `body:${i}`, id: `${i}`, generation: 1, epoch: 'epoch-1', readDistance: i, target: false });
    }
    expect(queue.size).toBe(DetailQueue.MAX_PENDING);
    expect(DetailQueue.MAX_PENDING).toBe(64);
    const kept = queue.peek().map(job => job.readDistance);
    expect(Math.max(...kept)).toBe(63);
  });

  test('a target beats a nearer rock and is taken first', () => {
    const queue = new DetailQueue();
    queue.enqueue({ key: 'body:near', id: 'near', generation: 1, epoch: 'epoch-1', readDistance: 4, target: false });
    queue.enqueue({ key: 'body:target', id: 'target', generation: 1, epoch: 'epoch-1', readDistance: 900, target: true });
    expect(queue.take(1).map(job => job.id)).toEqual(['target']);
    expect(queue.size).toBe(1);
  });

  test('obsolete generation and epoch jobs are cancelled, not built', () => {
    const queue = new DetailQueue();
    queue.enqueue({ key: 'body:a', id: 'a', generation: 1, epoch: 'epoch-1', readDistance: 1, target: false });
    queue.enqueue({ key: 'body:b', id: 'b', generation: 2, epoch: 'epoch-1', readDistance: 2, target: false });
    queue.enqueue({ key: 'body:c', id: 'c', generation: 1, epoch: 'epoch-0', readDistance: 3, target: false });

    const cancelled = queue.cancelWhere(job => job.epoch !== 'epoch-1' || job.generation !== 1);
    expect(cancelled).toBe(2);
    expect(queue.take(8).map(job => job.id)).toEqual(['a']);
    expect(queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------------

describe('visual pools', () => {
  test('a projectile beyond the fixed pool still gets a glyph', () => {
    const pool = new GlyphPool(8, 4);
    pool.beginFrame();
    const handles = [];
    for (let i = 0; i < 600; i++) handles.push(pool.ensure(`shot-${i}`));

    expect(pool.count).toBe(600);
    expect(pool.primaryCount).toBe(8);
    expect(pool.fallbackCount).toBe(592);
    expect(new Set(handles.map(handle => `${handle.fallback ? 'f' : 'p'}${handle.slot}`)).size).toBe(600);
    for (const handle of handles) expect(pool.set(handle.id, 1, 2, 4, 3, '#fff')).toBeUndefined();

    // A projectile that leaves the authority's view frees its slot for the next one.
    pool.beginFrame();
    pool.ensure('shot-599');
    expect(pool.releaseUnseen()).toBe(599);
    expect(pool.count).toBe(1);
    expect(pool.fallbackCount).toBe(1);

    pool.beginFrame();
    pool.ensure('shot-600');
    expect(pool.count).toBe(2);
    // The freed fixed slots are used before overflow grows: the fallback is a last resort.
    expect(pool.primaryCount).toBe(1);
    expect(pool.fallbackCount).toBe(1);
    pool.dispose();
  });

  test('particles and impact marks stay bounded when a burst is bigger than the ring', () => {
    const scene = new THREE.Group();
    const particles = new ParticleField(16);
    const marks = new ImpactMarks(scene, 4);
    const lights = new ImpactLights(scene, 2);
    particles.emit(0, 0, 200, '#ffd9a0', 40);
    expect(particles.capacitySize).toBe(16);
    particles.update(0.016);
    expect(particles.liveCount).toBeLessThanOrEqual(16);
    for (let i = 0; i < 20; i++) marks.mark(i, 0, 0, 3, '#000', 6);
    for (let i = 0; i < 20; i++) lights.flash(i, 0, 0, 10, '#fff', 0.2);
    expect(marks.size).toBe(4);
    expect(lights.size).toBe(2);
    particles.setCapacity(4);
    expect(particles.capacitySize).toBe(4);
    particles.dispose();
    marks.dispose();
    lights.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------------

describe('quality tiers', () => {
  const feed = (tier: TierController, frameMs: number, frames: number): ReturnType<TierController['sample']>[] => {
    const verdicts: ReturnType<TierController['sample']>[] = [];
    for (let i = 0; i < frames; i++) {
      const verdict = tier.sample(frameMs);
      if (verdict) verdicts.push(verdict);
    }
    return verdicts;
  };

  test('steps down after three bad windows and up after ten good ones', () => {
    // 40 frames of 50 ms is one 2 s window, and a p95 well past the desktop target.
    const tier = new TierController();
    expect(tier.tier).toBe('high');
    expect(feed(tier, 50, 40).length).toBe(1);
    expect(feed(tier, 50, 40).length).toBe(1);
    expect(tier.tier).toBe('high');
    const third = feed(tier, 50, 40);
    expect(third[0]!.p95Ms).toBe(50);
    expect(third[0]!.direction).toBe('down');
    expect(tier.tier).toBe('medium');

    expect(feed(tier, 50, 40 * 2).length).toBe(2);
    expect(tier.tier).toBe('medium');
    expect(feed(tier, 50, 40)[0]!.direction).toBe('down');
    expect(tier.tier).toBe('low');
    // Low is the floor: more bad windows change nothing.
    feed(tier, 50, 40 * 6);
    expect(tier.tier).toBe('low');

    // 125 frames of 16 ms is one good 2 s window; ten of them step up, twice.
    const good = () => feed(tier, 16, 125);
    for (let i = 0; i < 9; i++) good();
    expect(tier.tier).toBe('low');
    expect(good()[0]!.direction).toBe('up');
    expect(tier.tier).toBe('medium');
    for (let i = 0; i < 10; i++) good();
    expect(tier.tier).toBe('high');
    // High is the ceiling.
    for (let i = 0; i < 20; i++) good();
    expect(tier.tier).toBe('high');
  });

  test('an explicit tier never steps, and the budgets match A6', () => {
    const tier = new TierController({ mode: 'low' });
    expect(tier.policy.drawCalls).toBe(100);
    feed(tier, 60, 40 * 6);
    expect(tier.tier).toBe('low');
    tier.setMode('high');
    expect(tier.policy.maxDpr).toBe(2);
    feed(tier, 4, 125 * 12);
    expect(tier.tier).toBe('high');
    expect(new TierController({ mode: 'medium' }).policy.triangles).toBe(350_000);
  });

  test('tier changes presentation only', () => {
    const policy = new TierController().policy;
    expect(policy.gameplay).toEqual({
      changeHitboxes: false,
      hideObstacles: false,
      changeContactEligibility: false,
      changeServerStep: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

describe('flight camera', () => {
  test('the hull stays inside the frame at maximum zoom, look-ahead and shake', () => {
    const camera = new FlightCamera();
    camera.setViewport(1280, 720);
    camera.setZoom(50);
    expect(camera.zoom).toBe(ZOOM_MAX);

    const hullRadiusM = 32;
    const velocity: Vec2 = { x: 4200, y: -3100 };
    let position: Vec2 = { x: 0, y: 0 };
    for (let i = 0; i < 900; i++) {
      position = { x: position.x + (velocity.x / 60), y: position.y + (velocity.y / 60) };
      camera.update({ position, velocity, hullRadiusM, dt: 1 / 60 });
    }
    expect(camera.containsHull(position, hullRadiusM)).toBe(true);

    // The invariant measured through the real projection, not through the analytic shortcut.
    for (let i = 0; i < 96; i++) {
      const angle = (i / 96) * Math.PI * 2;
      const projected = new THREE.Vector3(
        position.x + Math.cos(angle) * hullRadiusM,
        position.y + Math.sin(angle) * hullRadiusM,
        0,
      ).project(camera.camera);
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
    }

    camera.setShake(1);
    for (let i = 0; i < 300; i++) {
      camera.update({ position, velocity, hullRadiusM, dt: 1 / 60, reducedMotion: false });
      expect(camera.containsHull(position, hullRadiusM)).toBe(true);
    }
    expect(camera.roll()).toBe(0);
  });

  test('look-ahead is capped, shake is off by default and settable to zero', () => {
    const camera = new FlightCamera();
    camera.setViewport(1280, 720);
    camera.update({ position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, hullRadiusM: 30, dt: 1 / 60 });
    expect(camera.frame.offset).toEqual({ x: 0, y: 0 });

    const frame = camera.update({ position: { x: 0, y: 0 }, velocity: { x: 90_000, y: 0 }, hullRadiusM: 30, dt: 1 / 60 });
    const cap = MAX_LEAD_FRACTION * Math.min(frame.halfWidthM, frame.halfHeightM / ELEVATION_Y_SCALE);
    expect(Math.hypot(frame.offset.x, frame.offset.y)).toBeLessThanOrEqual(cap + 1e-6);

    expect(camera.shake).toBe(0);
    camera.setShake(0.6);
    expect(camera.shake).toBe(0.6);
    camera.setShake(0);
    expect(camera.shake).toBe(0);
    camera.setShake(Number.NaN);
    expect(camera.shake).toBe(0);
  });

  test('zoom clamps on both ends and tactical changes framing, not physics', () => {
    const camera = new FlightCamera();
    camera.setViewport(1280, 720);
    camera.setZoom(0.01);
    expect(camera.zoom).toBe(ZOOM_MIN);
    const flight = camera.update({ position: { x: 500, y: -200 }, velocity: { x: 0, y: 0 }, hullRadiusM: 30, dt: 1 / 60 });
    const flightHalf = flight.halfHeightM;

    camera.setTactical(true);
    const tactical = camera.update({ position: { x: 500, y: -200 }, velocity: { x: 0, y: 0 }, hullRadiusM: 30, dt: 1 / 60 });
    expect(tactical.halfHeightM).toBe(TACTICAL_HALF_HEIGHT_M / camera.zoom);
    expect(tactical.halfHeightM).toBeGreaterThan(flightHalf);
    // Only the frame changed: the followed point did not move.
    expect(tactical.center).toEqual(flight.center);
    camera.setTactical(false);
    expect(camera.halfHeightM).toBe(flightHalf);
    expect(camera.roll()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

describe('session scene', () => {
  test('entity counts hold across 1000 update cycles after details are built', () => {
    const assets = new StubAssets();
    const scene = new SessionScene({ assets, tier: new TierController({ tier: 'high' }) });
    const bodies = Array.from({ length: 90 }, (_, i) => body(`rock-${i}`, 1, { position: { x: i * 40, y: -i * 12 } }));
    const live = clientView({
      ships: [ship('p1'), ship('p2', { position: { x: 120, y: 240 }, teamId: 'red' })],
      bodies,
      contacts: [contact('contact-1')],
      projectiles: Array.from({ length: 24 }, (_, i) => projectile(`shot-${i}`, { position: { x: i * 5, y: 300 } })),
    });

    // First frame builds the world; everything after it must be steady state.
    scene.render(live, 1 / 120, 0);
    const children = scene.scene.children.length;
    let previous = scene.report();
    for (let cycle = 0; cycle < 1000; cycle++) {
      const t = (cycle + 1) / 120;
      const moving = clientView({
        ...live,
        tick: 240 + cycle,
        ships: [
          ship('p1', { position: { x: cycle * 2, y: 0 }, velocity: { x: 240, y: 0 } }),
          ship('p2', { position: { x: 120, y: 240 + (cycle % 40) }, teamId: 'red' }),
        ],
        bodies,
        contacts: [contact('contact-1')],
        projectiles: Array.from({ length: 24 }, (_, i) => projectile(`shot-${i}`, { position: { x: i * 5 + cycle, y: 300 } })),
      });
      scene.render(moving, 1 / 120, t);
      if (cycle % 100 === 0) {
        const report = scene.report();
        expect(report.ships).toBe(previous.ships);
        expect(report.bodies).toBe(previous.bodies);
        expect(report.contacts).toBe(previous.contacts);
        expect(report.projectiles).toBe(previous.projectiles);
        expect(scene.scene.children.length).toBe(children);
        previous = report;
      }
    }
    const final = scene.report();
    expect(final.ships).toBe(2);
    expect(final.bodies).toBe(90);
    expect(final.contacts).toBe(1);
    expect(final.projectiles).toBe(24);
    expect(final.pendingDetails).toBe(0);
    expect(final.builtDetails).toBe(90);
    expect(scene.scene.children.length).toBe(children);
    expect(assets.live).toBe(2);

    scene.dispose();
    scene.dispose();
    expect(assets.live).toBe(0);
  });

  test('a corpse of a view leaves nothing behind and a new generation replaces the old body', () => {
    const scene = new SessionScene({ assets: new StubAssets() });
    scene.render(clientView({ bodies: [body('rock-1'), body('rock-2')] }), 1 / 60, 0);
    expect(scene.report().bodies).toBe(2);
    const firstVisual = scene.scene.children.length;

    scene.render(clientView({ bodies: [body('rock-2'), body('rock-3')] }), 1 / 60, 1 / 60);
    expect(scene.report().bodies).toBe(2);
    expect(scene.entityIds('bodies').sort()).toEqual(['rock-2', 'rock-3']);
    expect(scene.scene.children.length).toBe(firstVisual);

    // Same id, new generation: the old detailed visual is disposed and replaced.
    scene.render(clientView({ bodies: [body('rock-2', 2), body('rock-3')] }), 1 / 60, 2 / 60);
    expect(scene.report().bodies).toBe(2);
    expect(scene.scene.children.length).toBe(firstVisual);
    scene.dispose();
  });

  test('the detail queue is bounded in the scene and drops superseded work', () => {
    const scene = new SessionScene({ assets: new StubAssets(), tier: new TierController({ tier: 'low' }) });
    const many = Array.from({ length: 200 }, (_, i) => body(`rock-${i}`, 1, { position: { x: i * 30, y: 0 } }));
    scene.render(clientView({ bodies: many }), 1 / 60, 0);
    expect(scene.report().pendingDetails).toBeLessThanOrEqual(DetailQueue.MAX_PENDING);

    // One frame later most of the queue is still pending: 200 rocks cannot be built at once.
    scene.render(clientView({ bodies: many }), 1 / 60, 1 / 60);
    expect(scene.report().pendingDetails).toBeLessThanOrEqual(DetailQueue.MAX_PENDING);

    // The bodies leave the view; their pending jobs must not survive to be built later.
    scene.render(clientView({ bodies: [] }), 1 / 60, 2 / 60);
    expect(scene.report().pendingDetails).toBe(0);
    expect(scene.report().bodies).toBe(0);
    scene.dispose();
  });

  test('explicit and automatic tier changes never alter the entity set', () => {
    const scene = new SessionScene({ assets: new StubAssets() });
    const live = clientView({
      ships: [ship('p1'), ship('p2')],
      bodies: Array.from({ length: 8 }, (_, i) => body(`rock-${i}`)),
      contacts: [contact('contact-1')],
      projectiles: [projectile('shot-1')],
    });
    scene.render(live, 1 / 60, 0);
    const ids = [...scene.entityIds('ships'), ...scene.entityIds('bodies'), ...scene.entityIds('contacts')].sort();

    scene.setQuality('low');
    scene.render(live, 1 / 60, 1 / 60);
    expect(scene.report().tier).toBe('low');
    expect([...scene.entityIds('ships'), ...scene.entityIds('bodies'), ...scene.entityIds('contacts')].sort()).toEqual(ids);
    expect(scene.report().projectiles).toBe(1);

    // Auto mode from low: 8.33 ms frames are a good window every 240 frames, and ten of those
    // step the tier up. The entity set is remeasured afterwards.
    scene.setQuality('auto');
    const start = 1 / 60 + 200 * 0.05;
    for (let i = 0; i < 2500; i++) scene.render(live, 1 / 120, start + (i + 1) * (1 / 120));
    expect(scene.report().tier).toBe('medium');
    expect([...scene.entityIds('ships'), ...scene.entityIds('bodies'), ...scene.entityIds('contacts')].sort()).toEqual(ids);
    expect(scene.report().projectiles).toBe(1);

    // And bad windows take it straight back down without touching the entity set.
    const afterGood = start + 2501 * (1 / 120);
    for (let i = 0; i < 200; i++) scene.render(live, 0.05, afterGood + (i + 1) * 0.05);
    expect(scene.report().tier).toBe('low');
    expect([...scene.entityIds('ships'), ...scene.entityIds('bodies'), ...scene.entityIds('contacts')].sort()).toEqual(ids);
    scene.dispose();
  });

  test('context loss releases controls and holds the frame until assets are restored', () => {
    const releases: string[] = [];
    let restores = 0;
    const scene = new SessionScene({
      assets: new StubAssets(),
      onControlRelease: reason => releases.push(reason),
      onContextRestore: () => {
        restores += 1;
      },
    });
    const live = clientView({ bodies: Array.from({ length: 12 }, (_, i) => body(`rock-${i}`)), ships: [ship('p1')] });
    scene.render(live, 1 / 60, 0);
    expect(scene.isInputReady).toBe(true);

    scene.handleContextLost();
    expect(releases).toEqual(['disconnect']);
    expect(scene.isInputReady).toBe(false);
    const builtBeforeLoss = scene.report().builtDetails;
    scene.render(live, 1 / 60, 1);
    expect(scene.report().builtDetails).toBe(builtBeforeLoss);

    scene.handleContextRestored();
    expect(restores).toBe(1);
    expect(scene.isInputReady).toBe(true);
    expect(scene.report().bodies).toBe(12);
    expect(scene.report().ships).toBe(1);
    scene.dispose();
  });

  test('render after dispose is a no-op and unknown combat entities are never drawn', () => {
    const scene = new SessionScene({ assets: new StubAssets() });
    scene.render(clientView({ ships: [ship('p1')] }), 1 / 60, 0);
    scene.dispose();
    expect(() => scene.render(clientView({ ships: [ship('p1')] }), 1 / 60, 1)).not.toThrow();
    expect(scene.report().ships).toBe(0);

    const other = new SessionScene({ assets: new StubAssets() });
    other.render(clientView({ ships: [ship('p1')] }), 1 / 60, 0);
    const before = other.scene.children.length;
    // Impacts on entities this scene has no record of: deduped, recorded, nothing allocated.
    other.handleEvent(
      sessionEvent('impact', 'impact-1', {
        hitId: 'hit-1',
        kind: 'ship',
        targetId: 'ghost',
        position: { x: 0, y: 0 },
        normal: { x: 1, y: 0 },
        damage: 12,
        energyJ: 900,
        destroyed: false,
        attackerPilotId: 'p2',
        victimPilotId: 'ghost',
      }),
    );
    other.handleEvent(
      sessionEvent('shot', 'shot-1', {
        shotId: 'shot-1',
        slotId: 'w1',
        weaponId: 'gun-autocannon',
        ownerLifeId: 'life-ghost',
        position: { x: 0, y: 0 },
        velocity: { x: 400, y: 0 },
        state: 'armed',
        expiresAtTick: 400,
      }),
    );
    expect(other.scene.children.length).toBe(before);
    other.handleEvent(
      sessionEvent('impact', 'impact-1', {
        hitId: 'hit-1',
        kind: 'ship',
        targetId: 'ghost',
        position: { x: 0, y: 0 },
        normal: { x: 1, y: 0 },
        damage: 12,
        energyJ: 900,
        destroyed: false,
        attackerPilotId: 'p2',
        victimPilotId: 'ghost',
      }),
    );
    expect(other.scene.children.length).toBe(before);
    other.dispose();
  });
});

describe('rock cache key', () => {
  test('identity, seed, shape and material version all participate', () => {
    const base = body('rock-1');
    const key = rockCacheKey(base);
    expect(key).toContain(base.visualId);
    expect(key).toContain(String(base.renderSeed));
    expect(key).toContain('circle');
    // Never the radius alone: a different identity at the same radius is a different cache entry.
    expect(rockCacheKey({ ...base, visualId: 'rock-2' })).not.toBe(key);
    expect(rockCacheKey({ ...base, renderSeed: 99 })).not.toBe(key);
    expect(rockCacheKey({ ...base, shape: { kind: 'capsule', radiusM: 24, halfSegmentM: 0 } })).not.toBe(key);
    expect(rockCacheKey({ ...base, shape: { kind: 'convex', vertices: [{ x: 24, y: 0 }, { x: -24, y: 0 }] } })).not.toBe(key);
  });
});
