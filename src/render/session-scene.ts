/**
 * Flight scene adapter (Plan A4). Consumes `ClientView` and `SessionEvent` and nothing else: it
 * never writes authority state, never runs physics and never decides a hitbox. Ships, bodies,
 * projectiles and contacts are keyed by the authority's own (id, generation), and every visual is
 * built through an injected `RenderAssets` factory — which is why the scene graph can be exercised
 * without a GPU and rebuilt, in place, after a context loss.
 *
 * Where a pose comes from is the composition's decision (B owns prediction and interpolation), so
 * `render` accepts an explicit pose override and draws exactly what it is given. Pose-free ships
 * fall back to their snapshot position.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type {
  BodyView,
  ClientView,
  CollisionShape,
  ContactView,
  EventPayloadByKind,
  Fit,
  FitDerivation,
  Id,
  ProjectileView,
  SessionEvent,
  SessionEventKind,
  ShipView,
  Vec2,
} from '../shared/contracts.ts';
import { CATALOG, deriveFit, muzzleLocal } from '../shared/catalog.ts';
import { hash32 } from '../shared/ids.ts';
import { buildAsteroid, buildShip, defaultLoadout } from '../models.ts';
import type { ShipClass } from '../models.ts';
import type { ShipModel } from '../models.ts';
import { rockyTexture, spaceTexture } from '../textures.ts';
import { createRng } from '../shared/rng.ts';
import { DetailQueue, EntityRegistry, type Disposable } from './registry.ts';
import { GlyphPool, ImpactLights, ImpactMarks, ParticleField } from './pools.ts';
import { FlightCamera } from './camera.ts';
import { TierController } from './tier.ts';
import type { QualityMode, QualityTier, TierPolicy } from './tier.ts';

/** Icosphere detail used for detailed rocks, and the material/content revision of their surfaces. */
export const ROCK_RESOLUTION = 5;
export const ROCK_MATERIAL_VERSION = 1;
/** Detailed meshes are never built while the GL context is gone; the queue simply waits. */
const EVENT_MEMORY = 512;

const SHIP_CLASSES: Readonly<Record<string, ShipClass>> = { kestrel: 'kestrel', mule: 'mule', needle: 'needle' };

/** Paint IDs are authored content; until the catalog ships them, map the design tokens and default. */
const PAINT_COLORS: Readonly<Record<string, string>> = {
  default: '#dce6e8',
  ceramic: '#dfebe9',
  signal: '#83cbd3',
  caution: '#e8b56e',
  threat: '#ef8782',
  slate: '#8ea3ad',
};

const PROJECTILE_STYLE: Readonly<Record<ProjectileView['state'], { size: number; color: string }>> = {
  unarmed: { size: 1.8, color: '#e8b56e' },
  armed: { size: 2.6, color: '#dfebe9' },
  burning: { size: 3.4, color: '#ef8782' },
  coasting: { size: 2.2, color: '#83cbd3' },
};

const CONTACT_COLOR: Readonly<Record<ContactView['kind'], string>> = {
  crew: '#83cbd3',
  hostile: '#ef8782',
  unknown: '#e8b56e',
  objective: '#b6f6df',
  hazard: '#e8b56e',
};

// ---------------------------------------------------------------------------------------------
// Render assets: the only place that knows Three.js materials. Reused boats, cached rocks.
// ---------------------------------------------------------------------------------------------

export interface ShipVisual extends Disposable {
  readonly group: THREE.Object3D;
  readonly flames: readonly THREE.Mesh[];
  readonly rcs: readonly THREE.Mesh[];
  readonly light: THREE.PointLight | null;
  /** Bounding-circle radius in metres, so the camera can guarantee the hull stays framed. */
  readonly hullRadiusM: number;
  /** Maximum torch acceleration in m/s², the normaliser for inferred plume. */
  readonly maxAccelMS2: number;
  /** Smoothed plume level and last authoritative velocity, owned by the scene's plume inference. */
  thrust: number;
  previousVelocity: Vec2 | null;
  /** Local, short-lived damage glow. Never a shared material: one hit lights one hull. */
  flash(strength: number): void;
  decay(dt: number): void;
}

export interface BodyProxy extends Disposable {
  readonly object: THREE.Object3D;
}

export interface Environment extends Disposable {
  update(centre: Vec2, tactical: boolean): void;
}

export interface RenderAssets extends Disposable {
  createShip(ship: ShipView): ShipVisual;
  createBodyProxy(body: BodyView): BodyProxy;
  /** Detailed rock surface shared by every body with the same cache key. */
  createBodyDetail(body: BodyView, cacheKey: string): THREE.Object3D;
  releaseBodyDetail(cacheKey: string): void;
  createEnvironment(scene: THREE.Scene): Environment;
}

/** `visualId + render seed + shape + resolution + material version` — never the radius alone. */
export function rockCacheKey(body: Pick<BodyView, 'visualId' | 'renderSeed' | 'shape'>): string {
  return `${body.visualId}|${body.renderSeed}|${shapeKey(body.shape)}|${shapeRadiusM(body.shape).toFixed(2)}|r${ROCK_RESOLUTION}|m${ROCK_MATERIAL_VERSION}`;
}

export function shapeKey(shape: CollisionShape): string {
  return shape.kind === 'convex' ? `convex:${shape.vertices.length}` : shape.kind;
}

/** Bounding-circle radius of a collision shape: the camera and the proxy both use this one number. */
export function shapeRadiusM(shape: CollisionShape): number {
  if (shape.kind === 'circle') return Math.max(0.5, shape.radiusM);
  if (shape.kind === 'capsule') return Math.max(0.5, shape.radiusM + shape.halfSegmentM);
  let radius = 0.5;
  for (const vertex of shape.vertices) radius = Math.max(radius, Math.hypot(vertex.x, vertex.y));
  return radius;
}

class ModelShipVisual implements ShipVisual {
  readonly group: THREE.Object3D;
  readonly flames: readonly THREE.Mesh[];
  readonly rcs: readonly THREE.Mesh[];
  readonly light: THREE.PointLight | null;
  readonly hullRadiusM: number;
  readonly maxAccelMS2: number;
  thrust = 0;
  previousVelocity: Vec2 | null = null;

  private readonly skin: THREE.MeshStandardMaterial | null;
  private readonly releaseResources: (group: THREE.Object3D) => void;
  private flashStrength = 0;

  constructor(model: ShipModel, scale: THREE.Vector3, hullRadiusM: number, maxAccelMS2: number, releaseResources: (group: THREE.Object3D) => void) {
    this.group = model.group;
    this.group.scale.copy(scale);
    this.flames = model.flames;
    this.rcs = model.rcs;
    this.light = model.light;
    this.hullRadiusM = hullRadiusM;
    this.maxAccelMS2 = Math.max(1, maxAccelMS2);
    this.releaseResources = releaseResources;
    let skin: THREE.MeshStandardMaterial | null = null;
    model.group.traverse(child => {
      if (skin) return;
      const material = (child as THREE.Mesh).material;
      if (material instanceof THREE.MeshStandardMaterial && material.userData.owned) skin = material;
    });
    this.skin = skin;
  }

  flash(strength: number): void {
    this.flashStrength = Math.max(this.flashStrength, Math.min(1, strength));
    if (!this.skin) return;
    this.skin.emissive.set('#ff9a5c');
    this.skin.emissiveIntensity = 0.35 + this.flashStrength * 0.65;
  }

  decay(dt: number): void {
    if (this.flashStrength <= 0 || !this.skin) return;
    this.flashStrength = Math.max(0, this.flashStrength - dt * 2.4);
    this.skin.emissiveIntensity = 0.35 + this.flashStrength * 0.65;
    if (this.flashStrength === 0) this.skin.emissiveIntensity = 0;
  }

  dispose(): void {
    this.group.traverse(child => {
      const holder = child as THREE.Mesh;
      if (holder.geometry) holder.geometry.dispose();
    });
    // Materials and their textures are ref-counted: buildShip shares its hull look between ships.
    this.releaseResources(this.group);
    this.group.removeFromParent();
  }
}

class SharedBodyProxy implements BodyProxy {
  readonly object: THREE.Mesh;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, radiusM: number, shape: CollisionShape) {
    this.object = new THREE.Mesh(geometry, material);
    // Capsules stretch along their own axis; everything else is a uniform block of rock.
    const stretch = shape.kind === 'capsule' ? (shape.radiusM + shape.halfSegmentM) / Math.max(0.5, shape.radiusM) : 1;
    this.object.scale.set(radiusM, radiusM * stretch, radiusM);
  }

  dispose(): void {
    // Shared geometry/material belong to the assets, not to the proxy instance.
    this.object.removeFromParent();
  }
}

class SpaceEnvironment implements Environment {
  readonly root = new THREE.Group();

  private readonly stars: THREE.Points;
  private readonly dust: THREE.Mesh;
  private readonly moon: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const rng = createRng(836, 'spawn');
    const count = 2500;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rng.next() - 0.5) * 5100;
      positions[i * 3 + 1] = (rng.next() - 0.5) * 3300;
      positions[i * 3 + 2] = -1100 - rng.next() * 800;
      const brightness = 0.3 + rng.next() * 0.6;
      colors[i * 3] = brightness * 0.86;
      colors[i * 3 + 1] = brightness * 0.94;
      colors[i * 3 + 2] = brightness;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 1.6, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false }));
    this.stars.frustumCulled = false;

    this.dust = new THREE.Mesh(
      new THREE.PlaneGeometry(6500, 4600),
      new THREE.MeshBasicMaterial({ map: spaceTexture(), depthWrite: false, toneMapped: false }),
    );
    this.dust.position.z = -2000;

    const surface = rockyTexture(81);
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(280, 64, 40),
      new THREE.MeshStandardMaterial({ map: surface, bumpMap: surface, bumpScale: 4.8, roughness: 1, metalness: 0, color: '#68717b' }),
    );
    this.moon.rotation.set(0.12, 0.15, -0.3);
    this.moon.position.z = -950;

    this.root.add(this.stars, this.dust, this.moon);
    this.root.add(new THREE.AmbientLight('#7395b0', 0.5));
    const sun = new THREE.DirectionalLight('#f6e1c2', 3.1);
    sun.position.set(-240, 380, 450);
    const rim = new THREE.DirectionalLight('#629bc5', 1.4);
    rim.position.set(200, -300, 80);
    this.root.add(sun, rim);
    scene.add(this.root);
  }

  update(centre: Vec2, tactical: boolean): void {
    // Parallax by layer: stars move slowest, the distant moon slowest of all, dust between them.
    this.stars.position.set(centre.x * 0.94, centre.y * 0.94, 0);
    this.dust.position.set(centre.x * 0.98, centre.y * 0.98, -2000);
    this.moon.position.set(415 + centre.x * 0.97, 610 + centre.y * 0.97, -950);
    // Tactical view drops decorative depth, never an obstacle.
    this.dust.visible = !tactical;
    this.moon.visible = !tactical;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const object of [this.stars, this.dust, this.moon] as const) {
      object.removeFromParent();
      object.geometry.dispose();
      const material = object.material;
      for (const entry of Array.isArray(material) ? material : [material]) {
        const textured = entry as THREE.MeshStandardMaterial;
        textured.map?.dispose();
        textured.bumpMap?.dispose();
        entry.dispose();
      }
    }
    this.root.clear();
  }
}

/** Rocks are cached by identity, ref-counted, and disposed when the last body using them leaves. */
interface RockCacheEntry {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  refs: number;
}

class ThreeAssets implements RenderAssets {
  private readonly rockCache = new Map<string, RockCacheEntry>();
  private readonly proxyGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly proxyMaterial = new THREE.MeshStandardMaterial({ color: '#5d5b54', roughness: 1, metalness: 0.04, flatShading: true });
  /** One entry per material/texture, shared hull resources included (A4: reference counts). */
  private readonly refs = new Map<THREE.Material | THREE.Texture, number>();

  createShip(ship: ShipView): ShipVisual {
    const chassisClass = SHIP_CLASSES[ship.fit.chassisId] ?? 'kestrel';
    const loadout = { ...defaultLoadout(chassisClass), color: PAINT_COLORS[ship.fit.paintId] ?? PAINT_COLORS.default! };
    const model = buildShip(loadout);
    // Plumes and jets are the only animated pieces: tag them before measuring or merging.
    for (const flame of model.flames) flame.userData.exhaust = true;
    for (const jet of model.rcs) jet.userData.exhaust = true;
    // Measured before the merge: the scale pass needs the authored silhouette, not the merged one.
    const scale = shipScale(ship.fit, model.group);
    mergeHullByMaterial(model.group);
    const chassis = CATALOG.chassisById.get(ship.fit.chassisId);
    const hullRadiusM = chassis ? 0.5 * Math.hypot(chassis.lengthM, chassis.beamM) : 26;
    const derived = CATALOG.chassisById.has(ship.fit.chassisId) ? deriveFitCached(ship.fit) : null;
    const maxAccelMS2 = derived && derived.valid ? derived.thrustN / Math.max(1, derived.dryMassKg + derived.fuelCapacityKg) : 18;
    this.retain(shipResources(model.group));
    return new ModelShipVisual(model, scale, hullRadiusM, maxAccelMS2, group => this.release(shipResources(group)));
  }

  createBodyProxy(body: BodyView): BodyProxy {
    return new SharedBodyProxy(this.proxyGeometry, this.proxyMaterial, shapeRadiusM(body.shape), body.shape);
  }

  createBodyDetail(body: BodyView, cacheKey: string): THREE.Object3D {
    let entry = this.rockCache.get(cacheKey);
    if (!entry) {
      const template = buildAsteroid(shapeRadiusM(body.shape), body.renderSeed);
      entry = { geometry: template.geometry, material: template.material as THREE.Material, refs: 0 };
      this.rockCache.set(cacheKey, entry);
    }
    entry.refs += 1;
    return new THREE.Mesh(entry.geometry, entry.material);
  }

  releaseBodyDetail(cacheKey: string): void {
    const entry = this.rockCache.get(cacheKey);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.geometry.dispose();
    if (entry.material.userData.owned) entry.material.dispose();
    this.rockCache.delete(cacheKey);
  }

  createEnvironment(scene: THREE.Scene): Environment {
    return new SpaceEnvironment(scene);
  }

  private retain(resources: readonly (THREE.Material | THREE.Texture)[]): void {
    for (const resource of resources) this.refs.set(resource, (this.refs.get(resource) ?? 0) + 1);
  }

  private release(resources: readonly (THREE.Material | THREE.Texture)[]): void {
    for (const resource of resources) {
      const remaining = (this.refs.get(resource) ?? 1) - 1;
      if (remaining > 0) {
        this.refs.set(resource, remaining);
        continue;
      }
      this.refs.delete(resource);
      resource.dispose();
    }
  }

  dispose(): void {
    for (const entry of this.rockCache.values()) {
      entry.geometry.dispose();
      if (entry.material.userData.owned) entry.material.dispose();
    }
    this.rockCache.clear();
    for (const resource of this.refs.keys()) resource.dispose();
    this.refs.clear();
    this.proxyGeometry.dispose();
    this.proxyMaterial.dispose();
  }
}

/**
 * Every material a ship uses, plus the textures only that ship owns: `buildShip` shares the base
 * hull look across ships, so disposal is by reference count rather than by "owned" flag.
 */
function shipResources(group: THREE.Object3D): (THREE.Material | THREE.Texture)[] {
  const resources: (THREE.Material | THREE.Texture)[] = [];
  const materials = new Set<THREE.Material>();
  group.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    for (const entry of Array.isArray(material) ? material : [material]) {
      if (materials.has(entry)) continue;
      materials.add(entry);
      resources.push(entry);
      const textured = entry as THREE.MeshStandardMaterial;
      for (const texture of [textured.map, textured.bumpMap, textured.normalMap]) if (texture) resources.push(texture);
    }
  });
  return resources;
}

/** Ship models are authored at a fixed model-space size; scale to the chassis' declared metres. */
function shipScale(fit: Fit, group: THREE.Object3D): THREE.Vector3 {
  const bounds = authoredBounds(group);
  const chassis = CATALOG.chassisById.get(fit.chassisId);
  const lengthM = chassis?.lengthM ?? 42;
  const beamM = chassis?.beamM ?? 16;
  const scaleX = beamM / Math.max(0.001, bounds.x);
  const scaleY = lengthM / Math.max(0.001, bounds.y);
  return new THREE.Vector3(scaleX, scaleY, scaleX);
}

/**
 * `buildShip` assembles one hull from ~90 separate boxes, which the hangar needs so a single module
 * can be highlighted. In flight that is ~90 draw calls per ship and no A6 budget survives eight of
 * them, so meshes sharing a material are merged once here: the same silhouette in ~a dozen calls.
 * Exhaust plumes and RCS jets are left alone because they animate.
 */
function mergeHullByMaterial(group: THREE.Group): void {
  group.updateMatrixWorld(true);
  const originals: THREE.Mesh[] = [];
  group.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || object.userData.exhaust || Array.isArray(mesh.material)) return;
    originals.push(mesh);
  });
  if (originals.length <= 1) return;

  const toOrigin = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  for (const mesh of originals) {
    const material = mesh.material;
    if (Array.isArray(material)) continue;
    let geometry = mesh.geometry.clone();
    if (geometry.index) {
      const flat = geometry.toNonIndexed();
      geometry.dispose();
      geometry = flat;
    }
    local.multiplyMatrices(toOrigin, mesh.matrixWorld);
    geometry.applyMatrix4(local);
    const bucket = buckets.get(material.uuid);
    if (bucket) bucket.geometries.push(geometry);
    else buckets.set(material.uuid, { material, geometries: [geometry] });
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  for (const bucket of buckets.values()) {
    const merged = mergeGeometries(bucket.geometries, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    } else {
      // An attribute mismatch must never delete a piece of the hull: keep the parts separate.
      for (const geometry of bucket.geometries) group.add(new THREE.Mesh(geometry, bucket.material));
      continue;
    }
    for (const geometry of bucket.geometries) geometry.dispose();
  }
}

/** Authored bounds, ignoring exhaust plumes: a plume is not part of the hull's silhouette. */
function authoredBounds(group: THREE.Object3D): Vec2 {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const child = new THREE.Box3();
  group.traverse(object => {
    if (object.userData.exhaust) return;
    const mesh = object as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const geometryBox = mesh.geometry.boundingBox;
    if (!geometryBox) return;
    child.copy(geometryBox).applyMatrix4(mesh.matrixWorld);
    box.union(child);
  });
  const size = box.getSize(new THREE.Vector3());
  return { x: Math.max(0.001, size.x), y: Math.max(0.001, size.y) };
}

/**
 * Derived fits are referenced by ship creation and by muzzle pacing; the derivation is pure, so a
 * bounded cache by canonical slot content is safe and keeps per-frame work off the hot path.
 */
const derivationCache = new Map<string, FitDerivation>();

function deriveFitCached(fit: Fit): FitDerivation {
  const key = `${fit.chassisId}|${fit.paintId}|${Object.entries(fit.slots ?? {}).map(([slot, part]) => `${slot}=${part}`).sort().join(',')}`;
  const cached = derivationCache.get(key);
  if (cached) return cached;
  const derived = deriveFit(fit);
  if (derivationCache.size > 256) derivationCache.clear();
  derivationCache.set(key, derived);
  return derived;
}

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

export interface ShipPose {
  readonly position: Vec2;
  readonly angle: number;
}

/** Composition-owned pose overrides: the renderer never interpolates or extrapolates on its own. */
export type PoseOverrides = ReadonlyMap<Id, ShipPose>;

export interface SceneOptions {
  readonly host?: HTMLElement | null;
  readonly renderer?: THREE.WebGLRenderer | null;
  readonly assets?: RenderAssets;
  readonly camera?: FlightCamera;
  readonly tier?: TierController;
  readonly reducedMotion?: boolean;
  /** Called when the shape of the world is gone and input must stop until assets are back. */
  readonly onControlRelease?: (reason: 'disconnect') => void;
  /** Called after a context restore, so the composition asks the authority for a fresh baseline. */
  readonly onContextRestore?: () => void;
}

export interface SceneReport {
  readonly epoch: Id | null;
  readonly tick: number;
  readonly tier: QualityTier;
  readonly contextLost: boolean;
  readonly inputReady: boolean;
  readonly ships: number;
  readonly bodies: number;
  readonly contacts: number;
  readonly projectiles: number;
  readonly fallbackProjectiles: number;
  readonly pendingDetails: number;
  readonly builtDetails: number;
  readonly particles: number;
  readonly drawCalls: number;
  readonly triangles: number;
  /** Renderer bookkeeping: what is actually resident on the GPU right now. */
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

/** What the shell needs from the viewport; `SessionScene` satisfies it structurally. */
export interface ScenePort extends Disposable {
  resize(width: number, height: number): void;
  render(view: ClientView, dtSeconds: number, timeSeconds: number, poses?: PoseOverrides): void;
  handleEvent(event: SessionEvent): void;
  project(point: Vec2): { x: number; y: number; visible: boolean };
  setQuality(mode: QualityMode): void;
}

export class SessionScene implements ScenePort {
  readonly scene = new THREE.Scene();
  readonly camera: FlightCamera;
  readonly tier: TierController;
  readonly glyphs: GlyphPool;
  readonly particles: ParticleField;

  private readonly assets: RenderAssets;
  private readonly ships: EntityRegistry<ShipVisual, ShipView>;
  private readonly bodies: EntityRegistry<BodyVisual, BodyView>;
  private readonly contacts: EntityRegistry<ContactVisual, ContactView>;
  private readonly details = new DetailQueue();
  private readonly lights: ImpactLights;
  private readonly marks: ImpactMarks;
  private readonly environment: Environment;
  private readonly sceneMarks: THREE.Group;

  private renderer: THREE.WebGLRenderer | null;
  private readonly host: HTMLElement | null;
  private readonly onControlRelease: ((reason: 'disconnect') => void) | undefined;
  private readonly onContextRestore: (() => void) | undefined;
  private reducedMotion: boolean;
  private resizeObserver: ResizeObserver | null = null;
  private readonly domListeners: { target: EventTarget; type: string; handler: EventListener }[] = [];

  private view: ClientView | null = null;
  private epoch: Id | null = null;
  private tick = 0;
  private lastTime: number | null = null;
  private builtDetails = 0;
  private contextLost = false;
  private inputReady = true;
  private disposed = false;
  private readonly seenEvents = new Map<Id, number>();
  private readonly provisionalFlashes = new Map<Id, number>();
  private readonly lifeToShip = new Map<Id, Id>();
  private readonly shipFits = new Map<Id, Fit>();
  /** Bodies still on their proxy, so the bounded queue can be refilled as builds complete. */
  private readonly awaitingDetail = new Map<Id, BodyView>();

  constructor(options: SceneOptions = {}) {
    this.assets = options.assets ?? new ThreeAssets();
    this.camera = options.camera ?? new FlightCamera();
    this.tier = options.tier ?? new TierController();
    this.reducedMotion = options.reducedMotion ?? false;
    this.onControlRelease = options.onControlRelease;
    this.onContextRestore = options.onContextRestore;
    this.host = options.host ?? null;

    this.glyphs = new GlyphPool();
    this.particles = new ParticleField(this.tier.policy.particles);
    this.scene.add(this.glyphs.object, this.particles.object);
    this.sceneMarks = new THREE.Group();
    this.scene.add(this.sceneMarks);
    this.lights = new ImpactLights(this.sceneMarks);
    this.marks = new ImpactMarks(this.sceneMarks);
    this.environment = this.assets.createEnvironment(this.scene);

    this.ships = new EntityRegistry<ShipVisual, ShipView>((_id, _generation, _epoch, ship) => this.assets.createShip(ship));
    this.bodies = new EntityRegistry<BodyVisual, BodyView>((_id, _generation, _epoch, body) => new BodyVisual(this.assets, body));
    this.contacts = new EntityRegistry<ContactVisual, ContactView>((_id, _generation, _epoch, contact) => new ContactVisual(contact));

    this.renderer = options.renderer ?? null;
    if (this.host) {
      this.renderer ??= this.createRenderer(this.host);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          const rect = this.host!.getBoundingClientRect();
          if (rect.width && rect.height) this.resize(rect.width, rect.height);
        });
        this.resizeObserver.observe(this.host);
      }
      const rect = this.host.getBoundingClientRect();
      if (rect.width && rect.height) this.resize(rect.width, rect.height);
    }
    this.applyPolicy();
  }

  get qualityMode(): QualityMode {
    return this.tier.qualityMode;
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  /** False from context loss until assets are restored: no input may reach the ship in between. */
  get isInputReady(): boolean {
    return this.inputReady;
  }

  resize(width: number, height: number): void {
    this.camera.setViewport(width, height);
    if (!this.renderer) return;
    // Pixel ratio is applied before the size, or the canvas keeps the previous drawing buffer.
    this.applyPolicy();
    this.renderer.setSize(width, height);
  }

  setQuality(mode: QualityMode): void {
    this.tier.setMode(mode);
    this.applyPolicy();
  }

  /** Accessibility setting, applied from the next frame: motion is cut, never an obstacle or cue. */
  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  project(point: Vec2): { x: number; y: number; visible: boolean } {
    return this.camera.project(point);
  }

  aimAt(x: number, y: number, width: number, height: number): Vec2 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2), this.camera.camera);
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return point ? { x: point.x, y: point.y } : null;
  }

  render(view: ClientView, dtSeconds: number, timeSeconds: number, poses?: PoseOverrides): void {
    if (this.disposed) return;
    this.view = view;
    this.tick = view.tick;
    // With no context there is nothing to draw and nothing to build: hold the frame and let the
    // restore path rebuild from the newest view rather than churn resources during the loss.
    if (this.contextLost) return;
    const dt = Number.isFinite(dtSeconds) ? Math.min(Math.max(dtSeconds, 0), 0.25) : 0;

    if (view.epoch !== this.epoch) {
      this.epoch = view.epoch;
      this.ships.setEpoch(this.epoch);
      this.bodies.setEpoch(this.epoch);
      this.contacts.setEpoch(this.epoch);
      this.details.clear();
      this.awaitingDetail.clear();
      this.glyphs.clear();
      this.provisionalFlashes.clear();
    }

    // Every registry sweeps what the authority stopped reporting; the glyph pool does the same.
    this.ships.beginFrame();
    this.bodies.beginFrame();
    this.contacts.beginFrame();
    this.glyphs.beginFrame();

    const localPose = this.resolveLocalPose(view, poses);
    this.camera.update({
      position: localPose.position,
      velocity: localPose.velocity,
      hullRadiusM: this.localHullRadius(view),
      dt,
      reducedMotion: this.reducedMotion,
    });
    this.environment.update(this.camera.frame.center, this.camera.tactical);

    this.updateShips(view, dt, poses);
    this.updateBodies(view);
    this.updateContacts(view);
    this.updateProjectiles(view);
    this.drainDetails();

    this.lights.update(dt);
    this.marks.update(dt, this.camera.camera);
    this.particles.update(dt);

    if (this.lastTime !== null && timeSeconds > this.lastTime) {
      const window = this.tier.sample((timeSeconds - this.lastTime) * 1000);
      if (window && window.direction) this.applyPolicy();
    }
    if (Number.isFinite(timeSeconds)) this.lastTime = timeSeconds;

    if (this.renderer && !this.contextLost) this.renderer.render(this.scene, this.camera.camera);
  }

  handleEvent(event: SessionEvent): void {
    if (this.disposed) return;
    // A burst can repeat after a baseline install; eventId is the only safe identity to dedupe on.
    if (this.seenEvents.has(event.eventId)) return;
    this.rememberEvent(event.eventId);

    const impact = payloadOf(event, 'impact');
    if (impact) {
      this.onImpact(impact);
      return;
    }
    const shot = payloadOf(event, 'shot');
    if (shot) {
      const shipId = this.lifeToShip.get(shot.ownerLifeId);
      // Unknown shooter: recorded as seen, nothing allocated.
      if (!shipId) return;
      const ship = this.ships.get(shipId);
      if (!ship) return;
      // A provisional flash already covered this slot inside its cooldown; the authority's copy is
      // the same shot arriving late, so it must not flash twice.
      const cooldown = this.weaponCooldownS(shipId, shot.slotId);
      const provisionalTick = this.provisionalFlashes.get(shot.slotId);
      if (provisionalTick !== undefined && event.tick - provisionalTick <= cooldown * 120) return;
      this.flashAt(shot.position.x, shot.position.y, 1.1, '#ffd9a0');
      return;
    }
    const life = payloadOf(event, 'life');
    if (life && life.lifeId === this.view?.self?.ship.lifeId) {
      // The local life ended: the frame restarts on the new hull and stale glyphs must go with it.
      this.camera.snap();
      this.glyphs.clear();
      this.provisionalFlashes.clear();
    }
  }

  handleContextLost(): void {
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    // Controls stop before anything else: the ship keeps coasting on the authority, but nothing
    // the pilot holds may be replayed into a half-built scene.
    this.inputReady = false;
    this.onControlRelease?.('disconnect');
  }

  handleContextRestored(): void {
    if (this.disposed || !this.contextLost) return;
    // Assets and proxies are rebuilt from the live view, then a fresh baseline is requested before
    // input resumes; nothing is recreated while the context is still gone.
    this.contextLost = false;
    this.inputReady = false;
    this.marks.clear();
    this.lights.clear();
    // Every GPU-backed visual is rebuilt from the live view: clear drops the old resources and the
    // render below recreates ships, proxies and surfaces in one pass rather than piecemeal.
    this.ships.clear();
    this.bodies.clear();
    this.contacts.clear();
    this.details.clear();
    this.awaitingDetail.clear();
    this.glyphs.clear();
    this.epoch = null;
    if (this.view) this.render(this.view, 0, this.lastTime ?? 0);
    this.onContextRestore?.();
    this.inputReady = true;
  }

  /** Idempotent, and it frees pooled resources as well as the scene graph. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const listener of this.domListeners) listener.target.removeEventListener(listener.type, listener.handler);
    this.domListeners.length = 0;
    this.ships.dispose();
    this.bodies.dispose();
    this.contacts.dispose();
    this.details.clear();
    this.glyphs.dispose();
    this.particles.dispose();
    this.lights.dispose();
    this.marks.dispose();
    this.environment.dispose();
    this.assets.dispose();
    this.scene.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.seenEvents.clear();
    this.provisionalFlashes.clear();
    this.lifeToShip.clear();
    this.shipFits.clear();
    this.awaitingDetail.clear();
  }

  report(): SceneReport {
    return {
      epoch: this.epoch,
      tick: this.tick,
      tier: this.tier.tier,
      contextLost: this.contextLost,
      inputReady: this.inputReady,
      ships: this.ships.size,
      bodies: this.bodies.size,
      contacts: this.contacts.size,
      projectiles: this.glyphs.count,
      fallbackProjectiles: this.glyphs.fallbackCount,
      pendingDetails: this.details.size,
      builtDetails: this.builtDetails,
      particles: this.particles.liveCount,
      drawCalls: this.renderer?.info.render.calls ?? 0,
      triangles: this.renderer?.info.render.triangles ?? 0,
      geometries: this.renderer?.info.memory.geometries ?? 0,
      textures: this.renderer?.info.memory.textures ?? 0,
      programs: this.renderer?.info.programs?.length ?? 0,
    };
  }

  /** The exact entity set the frame drew, for tests and for a late join's diagnostics. */
  entityIds(kind: 'ships' | 'bodies' | 'contacts'): Id[] {
    if (kind === 'ships') return this.ships.ids();
    if (kind === 'bodies') return this.bodies.ids();
    return this.contacts.ids();
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame updates.
  // -------------------------------------------------------------------------------------------

  private updateShips(view: ClientView, dt: number, poses?: PoseOverrides): void {
    this.lifeToShip.clear();
    this.shipFits.clear();
    const localShipId = view.self?.ship.id ?? null;
    const self = view.self;
    for (const ship of view.ships) {
      const result = this.ships.upsert(ship.id, hash32(ship.lifeId), view.epoch, ship);
      const visual = result.entry.value;
      if (result.created) this.scene.add(visual.group);
      this.lifeToShip.set(ship.lifeId, ship.id);
      this.shipFits.set(ship.id, ship.fit);
      const pose = poses?.get(ship.id) ?? { position: ship.position, angle: ship.angle };
      visual.group.position.set(pose.position.x, pose.position.y, 0);
      visual.group.rotation.z = pose.angle;
      visual.group.visible = ship.life !== 'destroyed' && ship.life !== 'staged';
      visual.decay(dt);
      this.drivePlumes(visual, ship, dt, ship.id === localShipId ? self?.activeInput?.intent.thrust ?? null : null);
    }
    this.ships.pruneUnseen();

    const selfShip = self ? this.ships.get(self.ship.id) : undefined;
    if (selfShip && self?.activeInput) this.provisionalMuzzles(view, selfShip);
  }

  /** Inferred thrust: the pilot's own command locally, the observed acceleration for everyone else. */
  private drivePlumes(visual: ShipVisual, ship: ShipView, dt: number, commanded: number | null): void {
    const forwardX = -Math.sin(ship.angle);
    const forwardY = Math.cos(ship.angle);
    const previous = visual.previousVelocity;
    let thrust = 0;
    if (commanded !== null) {
      thrust = Math.max(0, Math.min(1, commanded));
    } else if (previous && dt > 0) {
      const accel = ((ship.velocity.x - previous.x) * forwardX + (ship.velocity.y - previous.y) * forwardY) / dt;
      thrust = Math.max(0, Math.min(1, accel / visual.maxAccelMS2));
    }
    visual.previousVelocity = { x: ship.velocity.x, y: ship.velocity.y };
    const blend = dt > 0 ? 1 - Math.exp(-dt * 8) : 1;
    visual.thrust += (thrust - visual.thrust) * blend;
    const flicker = this.reducedMotion ? 1 : 1 + Math.sin(this.tick * 0.31) * 0.035;
    const scale = visual.thrust * flicker;
    for (const flame of visual.flames) {
      flame.visible = visual.thrust > 0.01;
      flame.scale.y = Math.max(0.001, scale);
      flame.position.y = -70 + 22.5 * (1 - Math.max(0.001, scale));
    }
    if (visual.light) visual.light.intensity = visual.thrust * 35;
    const turning = Math.abs(ship.angularVelocity) > 0.05;
    visual.rcs.forEach((jet, index) => {
      jet.visible = turning && (index % 2 === 0 || Math.abs(ship.angularVelocity) > 0.2);
    });
  }

  /** Provisional muzzle flash, paced by the weapon's own cooldown and reconciled on the shot event. */
  private provisionalMuzzles(view: ClientView, visual: ShipVisual): void {
    const intent = view.self?.activeInput?.intent;
    if (!intent || intent.fireMask === 0) return;
    const fit = view.self?.ship.fit;
    if (!fit) return;
    for (const weapon of view.weapons) {
      const group = weapon.group;
      if (group === null || (intent.fireMask & (1 << (group - 1))) === 0) continue;
      if (this.tick < weapon.readyAtTick) continue;
      const cooldownS = this.weaponCooldownS(view.self!.ship.id, weapon.slotId);
      const last = this.provisionalFlashes.get(weapon.slotId);
      if (last !== undefined && this.tick - last < cooldownS * 120) continue;
      this.provisionalFlashes.set(weapon.slotId, this.tick);
      const muzzle = localToWorld(visual.group.position, visual.group.rotation.z, muzzleLocal(fit, weapon.slotId));
      this.flashAt(muzzle.x, muzzle.y, 0.9, '#ffe6b8');
    }
  }

  private updateBodies(view: ClientView): void {
    const centre = this.camera.frame.center;
    const lockId = view.self?.activeInput?.intent.lockContactId ?? null;
    for (const body of view.bodies) {
      const result = this.bodies.upsert(body.id, body.generation, view.epoch, body);
      const visual = result.entry.value;
      if (result.created) this.scene.add(visual.object);
      visual.apply(body);
      const key = `body:${body.id}`;
      const readDistance = Math.max(0, Math.hypot(body.position.x - centre.x, body.position.y - centre.y) - shapeRadiusM(body.shape));
      if (result.created) {
        // The proxy is already on screen; the detailed surface waits its turn in a bounded queue.
        this.awaitingDetail.set(body.id, body);
        this.details.enqueue({ key, id: body.id, generation: body.generation, epoch: view.epoch, readDistance, target: body.id === lockId });
      } else {
        this.details.refresh(key, readDistance, body.id === lockId);
      }
    }
    this.bodies.pruneUnseen();
    this.details.cancelWhere(job => job.epoch !== this.epoch || this.bodies.entry(job.id)?.generation !== job.generation);
    this.refillDetails();
  }

  /**
   * A saturated queue drops its worst jobs, so without a refill a field of hundreds of rocks would
   * leave the furthest ones on their proxies forever. As builds complete, the freed slots go to the
   * nearest bodies still waiting; the waiting set is empty once everything has its surface, so a
   * settled field costs one `size` check per frame.
   */
  private refillDetails(): void {
    if (this.awaitingDetail.size === 0 || this.details.size >= DetailQueue.MAX_PENDING) return;
    const centre = this.camera.frame.center;
    const lockId = this.view?.self?.activeInput?.intent.lockContactId ?? null;
    const candidates: { body: BodyView; distance: number }[] = [];
    for (const [id, body] of this.awaitingDetail) {
      if (!this.bodies.has(id)) {
        this.awaitingDetail.delete(id);
        continue;
      }
      candidates.push({ body, distance: Math.max(0, Math.hypot(body.position.x - centre.x, body.position.y - centre.y) - shapeRadiusM(body.shape)) });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates) {
      if (this.details.size >= DetailQueue.MAX_PENDING) break;
      const { body, distance } = candidate;
      this.details.enqueue({ key: `body:${body.id}`, id: body.id, generation: body.generation, epoch: this.epoch, readDistance: distance, target: body.id === lockId });
    }
  }

  private updateContacts(view: ClientView): void {
    for (const contact of view.contacts) {
      const result = this.contacts.upsert(contact.id, hash32(`${contact.kind}:${contact.id}`), view.epoch, contact);
      if (result.created) this.scene.add(result.entry.value.object);
      result.entry.value.apply(contact);
    }
    this.contacts.pruneUnseen();
  }

  private updateProjectiles(view: ClientView): void {
    for (const projectile of view.projectiles) {
      this.glyphs.ensure(projectile.id);
      const style = PROJECTILE_STYLE[projectile.state];
      this.glyphs.set(projectile.id, projectile.position.x, projectile.position.y, 4, style.size, style.color);
      if (projectile.state === 'burning' && !this.reducedMotion) {
        this.particles.emit(projectile.position.x, projectile.position.y, 1, '#ffb27a', 14);
      }
    }
    this.glyphs.releaseUnseen();
  }

  private drainDetails(): void {
    if (this.contextLost) return;
    for (const job of this.details.take(this.tier.policy.detailPerFrame)) {
      const entry = this.bodies.entry(job.id);
      if (!entry || entry.generation !== job.generation || entry.value.detail) continue;
      const body = entry.value.body;
      const detail = this.assets.createBodyDetail(body, entry.value.cacheKey);
      entry.value.upgrade(detail);
      this.scene.add(detail);
      this.awaitingDetail.delete(job.id);
      this.builtDetails += 1;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------------------------

  private resolveLocalPose(view: ClientView, poses?: PoseOverrides): { position: Vec2; velocity: Vec2 } {
    const self = view.self;
    const localId = self?.ship.id ?? null;
    const override = localId !== null ? poses?.get(localId) : undefined;
    if (override) {
      return { position: override.position, velocity: self?.predictionState.velocity ?? self?.ship.velocity ?? { x: 0, y: 0 } };
    }
    if (self) return { position: self.predictionState.position, velocity: self.predictionState.velocity };
    const first = view.ships[0];
    if (first) return { position: first.position, velocity: first.velocity };
    return { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
  }

  private localHullRadius(view: ClientView): number {
    const ship = view.self ? this.ships.get(view.self.ship.id) : undefined;
    return ship?.hullRadiusM ?? 28;
  }

  private weaponCooldownS(shipId: Id, slotId: Id): number {
    const fit = this.shipFits.get(shipId);
    if (!fit || !CATALOG.chassisById.has(fit.chassisId)) return 0.2;
    const slot = deriveFitCached(fit).weaponSlots.find(candidate => candidate.slotId === slotId);
    return slot?.cooldownS ?? 0.2;
  }

  private flashAt(x: number, y: number, intensity: number, color: string): void {
    this.lights.flash(x, y, 10, intensity * 22, color, 0.14);
  }

  private onImpact(impact: EventPayloadByKind['impact']): void {
    const knownShip = this.ships.get(impact.targetId);
    const knownBody = this.bodies.entry(impact.targetId);
    if (impact.kind === 'ship' && !knownShip) return;
    if (impact.kind === 'rock' && !knownBody) return;
    const strength = Math.min(1, impact.damage / 40 + 0.25);
    this.marks.mark(impact.position.x, impact.position.y, 9, impact.kind === 'ship' ? 6 : 14, '#1b1410', 6);
    this.lights.flash(impact.position.x, impact.position.y, 12, 18 * strength, '#ffd9a0', 0.2);
    knownShip?.flash(strength);
    if (impact.destroyed && knownBody) {
      this.particles.emit(impact.position.x, impact.position.y, 18, '#cbbd9a', 60);
    }
  }

  private rememberEvent(eventId: Id): void {
    // evicting the oldest keeps a long match from growing an unbounded id set.
    if (this.seenEvents.size >= EVENT_MEMORY) {
      const oldest = this.seenEvents.keys().next();
      if (!oldest.done) this.seenEvents.delete(oldest.value);
    }
    this.seenEvents.set(eventId, this.tick);
  }

  private applyPolicy(): void {
    const policy = this.tier.policy;
    this.particles.setCapacity(policy.particles);
    if (this.renderer) this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, policy.maxDpr));
  }

  private createRenderer(host: HTMLElement): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({ antialias: this.tier.policy.antialias, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor('#050b12');
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.domElement.setAttribute('aria-label', 'Three-dimensional view of your ship and the asteroid belt');
    host.appendChild(renderer.domElement);
    const lost = (event: Event): void => {
      event.preventDefault();
      this.handleContextLost();
    };
    const restored = (): void => this.handleContextRestored();
    renderer.domElement.addEventListener('webglcontextlost', lost);
    renderer.domElement.addEventListener('webglcontextrestored', restored);
    this.domListeners.push({ target: renderer.domElement, type: 'webglcontextlost', handler: lost });
    this.domListeners.push({ target: renderer.domElement, type: 'webglcontextrestored', handler: restored });
    return renderer;
  }
}

function localToWorld(position: THREE.Vector3, angle: number, local: Vec2): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: position.x + cos * local.x - sin * local.y, y: position.y + sin * local.x + cos * local.y };
}

function payloadOf<K extends SessionEventKind>(event: SessionEvent, kind: K): EventPayloadByKind[K] | null {
  // The frozen contract unions kind and payload instead of correlating them; narrow once, here.
  return event.kind === kind ? (event.payload as EventPayloadByKind[K]) : null;
}

/** One body: an immediate proxy that is always on screen, upgraded to a detailed surface later. */
class BodyVisual implements Disposable {
  readonly cacheKey: string;
  proxy: BodyProxy;
  detail: THREE.Object3D | null = null;
  body: BodyView;

  private readonly assets: RenderAssets;

  constructor(assets: RenderAssets, body: BodyView) {
    this.assets = assets;
    this.body = body;
    this.cacheKey = rockCacheKey(body);
    this.proxy = assets.createBodyProxy(body);
    this.apply(body);
  }

  get object(): THREE.Object3D {
    return this.detail ?? this.proxy.object;
  }

  apply(body: BodyView): void {
    this.body = body;
    const target = this.object;
    target.position.set(body.position.x, body.position.y, 0);
    target.rotation.set(body.renderSeed * 0.7, body.renderSeed * 0.35, body.angle + body.renderSeed * 0.11);
  }

  upgrade(detail: THREE.Object3D): void {
    if (this.detail) return;
    this.detail = detail;
    this.proxy.object.removeFromParent();
    this.apply(this.body);
  }

  dispose(): void {
    // The cached surface is ref-counted: this body hands its lease back and the last one frees it.
    if (this.detail) this.assets.releaseBodyDetail(this.cacheKey);
    this.detail?.removeFromParent();
    this.detail = null;
    this.proxy.dispose();
  }
}

/** One contact: an uncertainty ring that fades with the authority's own age figure. */
class ContactVisual implements Disposable {
  readonly object: THREE.LineLoop;
  private readonly material: THREE.LineBasicMaterial;

  constructor(contact: ContactView) {
    this.material = new THREE.LineBasicMaterial({ color: CONTACT_COLOR[contact.kind], transparent: true, opacity: 0.6, depthWrite: false });
    // One ring geometry per contact: contacts are few, and sharing one would make disposal unsafe.
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < 48; i++) {
      const angle = (i / 48) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
    }
    this.object = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.material);
    this.object.frustumCulled = false;
  }

  apply(contact: ContactView): void {
    const radius = Math.max(6, contact.uncertaintyM);
    this.object.position.set(contact.position.x, contact.position.y, 8);
    this.object.scale.setScalar(radius);
    // Age is authoritative ticks: 5 s of staleness fades to a faint ring rather than vanishing.
    this.material.opacity = Math.max(0.12, 1 - contact.ageTicks / 600) * (contact.targetable ? 0.85 : 0.5);
    this.material.color.set(CONTACT_COLOR[contact.kind]);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
