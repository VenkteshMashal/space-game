import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { armor as armorMaterial, buildBeacon, buildCargo, buildDerelict, buildGunMount, buildMine, buildRaider, buildShip, buildStation, buildTurret, cachedAsteroid, disposeObject, lightArmor as lightArmorMaterial, oreGeometry, oreShell as oreMaterial, oreVein as oreVeinMaterial } from './models';
import type { HostileModel, ShipModel } from './models';
import type { BuiltShip } from './build';
import { BeamPool, makeDissolveMaterial, ParticleField, RingWaves, ShieldFlash, TracerPool } from './effects';
import { DERELICT, randomSeed, RELAY, SECTOR, STATION } from './physics';
import type { Cargo, Obstacle, Ore, ShipClass, ShipState, Vec2 } from './physics';
import { MAX_ROUNDS } from './combat';
import type { Hostile, Mount, Rounds } from './combat';
import { rockyTexture, spaceTexture } from './textures';

export const SHIP_SCALE = 1.3;
/** Half-height of the flight view at zoom 1, in metres. */
const FLIGHT_HALF = 340;
/** The flight camera sits up and back from the ship so the plane reads as a lit surface rather than a flat chart. */
const TILT = { rise: -410, lift: 1100 };
const SECTOR_WIDTH = SECTOR.maxX - SECTOR.minX;
const SECTOR_HEIGHT = SECTOR.maxY - SECTOR.minY;
const MAX_ORE_INSTANCES = 240;

/** Scorched hull variants swapped in when integrity falls. Built once, shared by every damaged plate. */
const scorchedArmor = new THREE.MeshStandardMaterial({ color: '#3a2f26', roughness: 0.97, metalness: 0.35 });
const scorchedLight = new THREE.MeshStandardMaterial({ color: '#564a40', roughness: 0.99, metalness: 0.25 });
const plateMaterial = new THREE.MeshStandardMaterial({ color: '#2a231d', roughness: 0.98, metalness: 0.4 });
/** Dissolve lifetime in seconds; main.ts drives the uniform, this is the render-loop clock. */
const DISSOLVE_SECONDS = 0.35;
/** Hull integrity below which the wreck states appear. */
const DAMAGE_THRESHOLD = 0.45;

export type ViewMode = 'title' | 'flight' | 'map';

export type BeamVisual = { x: number; y: number; ex: number; ey: number; hot: boolean };

export type SceneFrame = {
  state: ShipState;
  cargos: Cargo[];
  target?: { id: string; position: Vec2 };
  scanning?: { position: Vec2; progress: number };
  rounds?: Rounds;
  beams?: BeamVisual[];
  ore?: Ore[];
  aim?: Vec2;
  mounts?: Mount[];
  hostiles?: Hostile[];
  dt: number;
  time: number;
};

export class SpaceScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-600, 600, 400, -400, 1, 6000);
  ship: ShipModel | BuiltShip;
  /** Custom builds carry their own turret pivots; stock ships get theirs from setGunMounts. */
  private customTurrets: THREE.Group[] = [];
  mode: ViewMode = 'title';
  zoom = 1.35;
  mapZoom = 1;
  cinematic = false;
  /** Launch cinematic progress: 0 is a close inspection of the ship, 1 is the normal flight framing. */
  launch = 1;
  host: HTMLElement;
  moon: THREE.Mesh;
  stars: THREE.Points;
  cargos: { cargo: Cargo; mesh: THREE.Group }[] = [];
  /** Rock meshes by obstacle id: identity survives fracture so a rock can be removed and its children added. */
  rocks = new Map<number, THREE.Mesh>();
  /** Hostile models by hostile id, driven from the frame each render. */
  hostileModels = new Map<number, HostileModel>();
  station: THREE.Group;
  orbit = new THREE.Group();
  trajectory: THREE.Line;
  velocityVector: THREE.Line;
  targetLine: THREE.Line;
  selection: THREE.LineSegments;
  beacon: { group: THREE.Group; lamp: THREE.Mesh; halo: THREE.Mesh };
  derelict: { group: THREE.Group; lamp: THREE.Mesh; debris: THREE.Mesh[] };
  sectorGrid: THREE.Group;
  private background: THREE.Mesh;
  private stationLamps: THREE.MeshBasicMaterial[] = [];
  private plume: ParticleField;
  private sparks: ParticleField;
  private vent: ParticleField;
  private waves: RingWaves;
  private scanRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private scanSweep: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private follow = new THREE.Vector2();
  private cameraTarget = new THREE.Vector3();
  private zoomCurrent: number;
  private mapZoomCurrent = 1;
  /** Where the title screen points the camera: the ship is framed beside the menu column, not behind it. */
  titleFocus = { x: 0, y: -60 };
  private lastLaunch = 1;
  private lastWidth = 0;
  private lastHeight = 0;
  private halfHeight = FLIGHT_HALF;
  private shake = 0;
  private stationFlash = 0;
  private recovering: { mesh: THREE.Group; t: number }[] = [];
  private tracers: TracerPool;
  private beams: BeamPool;
  private oreShell: THREE.InstancedMesh;
  private oreVein: THREE.InstancedMesh;
  private oreDummy = new THREE.Object3D();
  private gunPivots: { root: THREE.Group; pivot: THREE.Group }[] = [];
  private muzzleLight: THREE.PointLight;
  private composer: EffectComposer;
  private lowSpec = false;
  private aimMarker: THREE.LineSegments;
  private aimPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private aimHit = new THREE.Vector3();
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The shared solid asteroid material, captured so spawnRock can reset a recycled mesh. */
  private rockBaseMaterial: THREE.Material | null = null;
  /** Rocks currently burning away: each owns a cloned dissolve material disposed when the fade ends. */
  private dissolving: { id: number; mesh: THREE.Mesh; material: THREE.Material; uniform: { value: number }; t: number }[] = [];
  private shield: ShieldFlash;
  /** Hull tiles swapped to scorched variants below the damage threshold, with their originals to restore. */
  private scorchSwaps: { mesh: THREE.Mesh; original: THREE.Material }[] = [];
  private damageBelow = false;
  private damagePlate: THREE.Mesh;

  constructor(host: HTMLElement, obstacles: Obstacle[], cargos: Cargo[]) {
    this.host = host;
    this.zoomCurrent = this.zoom;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setClearColor('#070d15');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Three-dimensional view of your ship and the asteroid belt');
    this.scene.add(new THREE.AmbientLight('#7395b0', 0.5));
    const sun = new THREE.DirectionalLight('#f6e1c2', 3.1);
    sun.position.set(-240, 380, 450); this.scene.add(sun);
    const rim = new THREE.DirectionalLight('#629bc5', 1.4);
    rim.position.set(200, -300, 80); this.scene.add(rim);
    this.background = this.buildDust(); this.scene.add(this.background);
    this.stars = this.buildStars(); this.scene.add(this.stars);
    this.moon = this.buildMoon(); this.scene.add(this.moon);

    this.ship = buildShip(); this.ship.group.scale.setScalar(SHIP_SCALE); this.scene.add(this.ship.group);
    for (const obstacle of obstacles) this.spawnRock(obstacle);
    cargos.forEach((cargo, i) => {
      const mesh = buildCargo(i); mesh.position.set(cargo.position.x, cargo.position.y, 0);
      this.cargos.push({ cargo, mesh }); this.scene.add(mesh);
    });
    this.station = buildStation(); this.station.position.set(STATION.x, STATION.y, -10); this.scene.add(this.station);
    this.station.traverse(child => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) this.stationLamps.push(child.material);
    });
    this.beacon = buildBeacon(); this.beacon.group.position.set(RELAY.x, RELAY.y, 0); this.scene.add(this.beacon.group);
    this.derelict = buildDerelict(); this.derelict.group.position.set(DERELICT.x, DERELICT.y, -6); this.scene.add(this.derelict.group);

    for (const radius of [165, 320, 550]) {
      const points = Array.from({ length: 181 }, (_, i) => new THREE.Vector3(Math.cos(i / 180 * Math.PI * 2) * radius, Math.sin(i / 180 * Math.PI * 2) * radius, -35));
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: '#5b8a98', transparent: true, opacity: radius === 165 ? 0.16 : 0.095, dashSize: 2, gapSize: 5 }));
      ring.computeLineDistances(); this.orbit.add(ring);
    }
    for (let i = 0; i < 48; i++) {
      const a = i / 48 * Math.PI * 2;
      const r = 165;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, -35),
        new THREE.Vector3(Math.cos(a) * (r + (i % 4 === 0 ? 5 : 2)), Math.sin(a) * (r + (i % 4 === 0 ? 5 : 2)), -35),
      ]), new THREE.LineBasicMaterial({ color: '#779096', transparent: true, opacity: 0.22 }));
      this.orbit.add(line);
    }
    this.scene.add(this.orbit);
    this.sectorGrid = this.buildSectorGrid(); this.scene.add(this.sectorGrid);
    this.trajectory = this.makeLine(51, '#769d98', 0.3, true);
    this.velocityVector = this.makeLine(2, '#a5c8b7', 0.7);
    this.targetLine = this.makeLine(2, '#cca16f', 0.22, true);
    const selectionPoints: number[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      selectionPoints.push(x * 37, y * 59, 7, x * 27, y * 59, 7, x * 37, y * 59, 7, x * 37, y * 49, 7);
    }
    const selectionGeometry = new THREE.BufferGeometry(); selectionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(selectionPoints, 3));
    this.selection = new THREE.LineSegments(selectionGeometry, new THREE.LineBasicMaterial({ color: '#83b9b5', transparent: true, opacity: 0.55 }));
    this.scene.add(this.selection);

    this.plume = new ParticleField(360, '#9fd8ff', 0.86);
    this.sparks = new ParticleField(240, '#f0b183', 0.9);
    this.vent = new ParticleField(200, '#8fa6b3', 0.94);
    this.waves = new RingWaves(8);
    for (const field of [this.plume, this.sparks, this.vent]) this.scene.add(field.points);
    this.scene.add(this.waves.group);

    this.scanRing = new THREE.Mesh(new THREE.RingGeometry(34, 36.5, 72), new THREE.MeshBasicMaterial({
      color: '#83b9b5', transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scanRing.visible = false; this.scene.add(this.scanRing);
    this.scanSweep = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(34, 0, 0)]), new THREE.LineBasicMaterial({ color: '#c8f0e6', transparent: true, opacity: 0.65 }));
    this.scanSweep.visible = false; this.scene.add(this.scanSweep);

    this.tracers = new TracerPool(MAX_ROUNDS); this.scene.add(this.tracers.lines);
    this.beams = new BeamPool(4); this.scene.add(this.beams.group);
    this.oreShell = new THREE.InstancedMesh(oreGeometry(), oreMaterial, MAX_ORE_INSTANCES);
    this.oreVein = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(7.6, 0), oreVeinMaterial, MAX_ORE_INSTANCES);
    this.oreShell.count = 0; this.oreVein.count = 0;
    this.oreShell.frustumCulled = false; this.oreVein.frustumCulled = false;
    this.scene.add(this.oreShell, this.oreVein);
    this.muzzleLight = new THREE.PointLight('#ffd9a8', 0, 320, 1.6);
    this.scene.add(this.muzzleLight);
    this.aimMarker = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-20, 0, 12), new THREE.Vector3(-7, 0, 12),
      new THREE.Vector3(7, 0, 12), new THREE.Vector3(20, 0, 12),
      new THREE.Vector3(0, -20, 12), new THREE.Vector3(0, -7, 12),
      new THREE.Vector3(0, 7, 12), new THREE.Vector3(0, 20, 12),
    ]), new THREE.LineBasicMaterial({ color: '#efb879', transparent: true, opacity: 0.5 }));
    this.aimMarker.visible = false; this.scene.add(this.aimMarker);

    this.shield = new ShieldFlash(48); this.scene.add(this.shield.mesh);
    this.damagePlate = new THREE.Mesh(new THREE.BoxGeometry(8 * SHIP_SCALE, 14 * SHIP_SCALE, 1.6 * SHIP_SCALE), plateMaterial);
    this.damagePlate.castShadow = true; this.damagePlate.receiveShadow = true;
    this.damagePlate.visible = false; this.scene.add(this.damagePlate);

    // Bloom is the first thing to drop: it is the only pass, and it costs a full-screen render.
    this.lowSpec = this.reducedMotion || window.devicePixelRatio * window.innerWidth * window.innerHeight > 3600000;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1024, 768), 0.55, 0.4, 0.82));

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private makeLine(count: number, color: string, opacity: number, dashed = false) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const line = new THREE.Line(geometry, dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 5, gapSize: 7 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    line.frustumCulled = false; this.scene.add(line); return line;
  }

  private buildSectorGrid() {
    const group = new THREE.Group();
    const minor: THREE.Vector3[] = [];
    for (let x = Math.ceil(SECTOR.minX / 500) * 500; x <= SECTOR.maxX; x += 500) minor.push(new THREE.Vector3(x, SECTOR.minY, -70), new THREE.Vector3(x, SECTOR.maxY, -70));
    for (let y = Math.ceil(SECTOR.minY / 500) * 500; y <= SECTOR.maxY; y += 500) minor.push(new THREE.Vector3(SECTOR.minX, y, -70), new THREE.Vector3(SECTOR.maxX, y, -70));
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(minor), new THREE.LineBasicMaterial({ color: '#4f7d8c', transparent: true, opacity: 0.2 })));
    const corners = [
      new THREE.Vector3(SECTOR.minX, SECTOR.minY, -70), new THREE.Vector3(SECTOR.maxX, SECTOR.minY, -70),
      new THREE.Vector3(SECTOR.maxX, SECTOR.minY, -70), new THREE.Vector3(SECTOR.maxX, SECTOR.maxY, -70),
      new THREE.Vector3(SECTOR.maxX, SECTOR.maxY, -70), new THREE.Vector3(SECTOR.minX, SECTOR.maxY, -70),
      new THREE.Vector3(SECTOR.minX, SECTOR.maxY, -70), new THREE.Vector3(SECTOR.minX, SECTOR.minY, -70),
    ];
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: '#7fb2bd', transparent: true, opacity: 0.42 })));
    group.visible = false;
    return group;
  }

  private buildStars() {
    const rand = randomSeed(836);
    const vertices: number[] = [], colors: number[] = [], sizes: number[] = [];
    for (let i = 0; i < 2500; i++) {
      vertices.push((rand() - 0.5) * 6800, (rand() - 0.5) * 4600, -1100 - rand() * 800);
      const b = 0.3 + rand() * 0.6; colors.push(b * 0.86, b * 0.94, b);
      sizes.push(rand() > 0.98 ? 2.4 : 0.45 + rand() * 1.2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    return new THREE.Points(geometry, new THREE.ShaderMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      vertexShader: 'attribute float size; varying vec3 vColor; void main(){vColor=color;gl_PointSize=size;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec3 vColor;void main(){float d=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(vColor,pow(max(0.,1.-d),1.2)*.8);}',
    }));
  }

  private buildDust() {
    return new THREE.Mesh(new THREE.PlaneGeometry(9600, 6400), new THREE.MeshBasicMaterial({ map: spaceTexture(), depthWrite: false, toneMapped: false }));
  }

  private buildMoon() {
    const surface = rockyTexture(81);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(280, 80, 48), new THREE.MeshStandardMaterial({
      map: surface, bumpMap: surface, bumpScale: 4.8, roughness: 1, metalness: 0, color: '#68717b',
    }));
    moon.rotation.set(0.12, 0.15, -0.3);
    return moon;
  }

  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.lastWidth = width; this.lastHeight = height;
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.updateProjection();
  }

  private updateProjection() {
    const aspect = this.lastWidth / this.lastHeight || 1;
    const zoom = this.mode === 'map' ? this.mapZoomCurrent : this.zoomCurrent;
    const launchEase = Math.pow(this.launch, 1.7);
    this.halfHeight = this.mode === 'map'
      ? (SECTOR_HEIGHT / 2 + 90) / zoom
      : this.mode === 'title' ? 470 / zoom : (FLIGHT_HALF / zoom) * (0.26 + 0.74 * launchEase);
    this.camera.left = -this.halfHeight * aspect; this.camera.right = this.halfHeight * aspect;
    this.camera.top = this.halfHeight; this.camera.bottom = -this.halfHeight;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode: ViewMode) { this.mode = mode; this.updateProjection(); }
  setZoom(delta: number) {
    if (this.mode === 'map') this.mapZoom = THREE.MathUtils.clamp(this.mapZoom + delta * 0.6, 1, 3);
    else this.zoom = THREE.MathUtils.clamp(this.zoom + delta, 0.6, 3);
    this.updateProjection();
  }
  resetZoom() {
    if (this.mode === 'map') this.mapZoom = 1; else this.zoom = 1.35;
    this.updateProjection();
  }
  fitSector() { this.mode = 'map'; this.mapZoom = 1; this.updateProjection(); }
  changeShip(shipClass: ShipClass) {
    disposeObject(this.ship.group);
    this.gunPivots = [];
    this.customTurrets = [];
    this.ship = buildShip(shipClass);
    this.ship.group.scale.setScalar(SHIP_SCALE);
    this.scene.add(this.ship.group);
    this.scorchSwaps.length = 0;
    if (this.damageBelow) this.applyScorch();
  }

  /** Puts an assembled custom hull in the flight view. Guns and turrets come with it. */
  setShip(model: ShipModel | BuiltShip) {
    disposeObject(this.ship.group);
    this.gunPivots = [];
    this.ship = model;
    this.customTurrets = 'turrets' in model ? model.turrets : [];
    this.ship.group.scale.setScalar(SHIP_SCALE);
    this.scene.add(this.ship.group);
    this.scorchSwaps.length = 0;
    if (this.damageBelow) this.applyScorch();
  }

  project(position: Vec2, z = 0) {
    const point = new THREE.Vector3(position.x, position.y, z).project(this.camera);
    return { x: (point.x + 1) / 2 * this.lastWidth, y: (1 - point.y) / 2 * this.lastHeight, visible: Math.abs(point.x) < 0.98 && Math.abs(point.y) < 0.94 && point.z < 1 };
  }

  impact(position: Vec2, strength: number) {
    if (this.reducedMotion) return;
    this.shake = Math.min(1.4, this.shake + strength);
    const rand = Math.random;
    for (let i = 0; i < 18; i++) {
      const angle = rand() * Math.PI * 2, speed = 30 + rand() * 90;
      this.sparks.emit(position.x, position.y, 6, Math.cos(angle) * speed, Math.sin(angle) * speed, 20 + rand() * 60, 3 + rand() * 4, 0.35 + rand() * 0.45);
    }
    this.waves.pulse(position.x, position.y, 4, '#df8277', 46, 0.6);
  }

  recover(cargo: Cargo) {
    const entry = this.cargos.find(item => item.cargo === cargo);
    if (entry) this.recovering.push({ mesh: entry.mesh, t: 0 });
    this.waves.pulse(cargo.position.x, cargo.position.y, 0, '#efb879', 52, 0.9);
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2, speed = 20 + Math.random() * 45;
      this.sparks.emit(cargo.position.x, cargo.position.y, 8, Math.cos(angle) * speed, Math.sin(angle) * speed, 30, 3, 0.5);
    }
  }

  dockPulse() {
    this.stationFlash = 1;
    this.waves.pulse(STATION.x, STATION.y, -8, '#83b9b5', 190, 1.6);
    this.waves.pulse(STATION.x, STATION.y, -8, '#dce6e8', 120, 1.1);
  }

  /** The station turns slowly; its arm colliders turn with it. */
  get stationAngle() { return this.station.rotation.z; }

  /** Screen pixel -> the z = 0 navigation plane. The flight camera is tilted, so this is a ray/plane cut. */
  unproject(screenX: number, screenY: number): Vec2 {
    this.ndc.set((screenX / this.lastWidth) * 2 - 1, 1 - (screenY / this.lastHeight) * 2);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.raycaster.ray.intersectPlane(this.aimPlane, this.aimHit);
    return { x: this.aimHit.x, y: this.aimHit.y };
  }

  spawnRock(obstacle: Obstacle) {
    const mesh = cachedAsteroid(obstacle.radius, obstacle.seed);
    mesh.position.set(obstacle.x, obstacle.y, obstacle.z);
    mesh.rotation.set(obstacle.seed, obstacle.seed * 0.4, obstacle.seed * 0.7);
    mesh.castShadow = true; mesh.receiveShadow = true;
    // Recycled meshes must come back solid: a previous life may have left a dissolve clone on them.
    if (!this.rockBaseMaterial) this.rockBaseMaterial = mesh.material as THREE.Material;
    else mesh.material = this.rockBaseMaterial;
    this.rocks.set(obstacle.id, mesh);
    this.scene.add(mesh);
  }

  /** Removes a rock mesh only. The geometry comes from the shared cache and must never be disposed here. */
  removeRock(id: number) {
    const mesh = this.rocks.get(id);
    if (mesh) { this.rocks.delete(id); mesh.removeFromParent(); }
    for (let i = this.dissolving.length - 1; i >= 0; i--) {
      if (this.dissolving[i].id !== id) continue;
      const entry = this.dissolving[i];
      entry.mesh.removeFromParent();
      entry.material.dispose();
      this.dissolving.splice(i, 1);
    }
  }

  /**
   * Dissolves a rock instead of removing it instantly: the shared material is cloned per rock and its
   * dissolve uniform is driven 0..1 over 0.35 s. The clone (and only the clone) is disposed at the end.
   */
  dissolveRock(id: number) {
    const mesh = this.rocks.get(id);
    if (!mesh) return;
    this.rocks.delete(id);
    const { material, uniform } = makeDissolveMaterial(mesh.material as THREE.Material);
    mesh.material = material;
    this.dissolving.push({ id, mesh, material, uniform, t: 0 });
  }

  /** One reusable fresnel shell around the hull; the flash is aimed at the world bearing the hit came from. */
  hitFlashShip(bearing: number) {
    this.shield.flash(bearing);
  }

  /** Damage states as hull integrity falls: scorched tiles and one detached plate below 45%, reverted above. */
  setDamage(level: number) {
    const below = level < DAMAGE_THRESHOLD;
    if (below === this.damageBelow) return;
    this.damageBelow = below;
    if (below) {
      this.applyScorch();
      this.damagePlate.visible = true;
    } else {
      for (const swap of this.scorchSwaps) swap.mesh.material = swap.original;
      this.scorchSwaps.length = 0;
      this.damagePlate.visible = false;
    }
  }

  /** Swaps the first few armor tiles to scorched variants. Idempotent: a second call is a no-op while swaps exist. */
  private applyScorch() {
    if (this.scorchSwaps.length > 0) return;
    this.ship.group.traverse(child => {
      if (this.scorchSwaps.length >= 3) return;
      if (child instanceof THREE.Mesh && (child.material === armorMaterial || child.material === lightArmorMaterial)) {
        this.scorchSwaps.push({ mesh: child, original: child.material });
        child.material = this.scorchSwaps.length % 2 ? scorchedArmor : scorchedLight;
      }
    });
  }

  explode(x: number, y: number, radius: number) {
    const bursts = this.reducedMotion ? 4 : 10 + Math.round(radius);
    for (let i = 0; i < bursts; i++) {
      const angle = Math.random() * Math.PI * 2, speed = 40 + Math.random() * (60 + radius * 3);
      this.sparks.emit(x, y, 6, Math.cos(angle) * speed, Math.sin(angle) * speed, 20 + Math.random() * 60, 3 + Math.random() * 6, 0.5 + Math.random() * 0.7);
    }
    for (let i = 0; i < 6 + Math.round(radius / 4); i++) {
      const angle = Math.random() * Math.PI * 2, speed = 12 + Math.random() * 30;
      this.vent.emit(x, y, 8, Math.cos(angle) * speed, Math.sin(angle) * speed, 10, 6 + Math.random() * 8, 1.1 + Math.random());
    }
    this.waves.pulse(x, y, 4, '#efb879', radius * 2.2, 0.75);
    this.waves.pulse(x, y, 2, '#df8277', radius * 1.3, 0.5);
    this.muzzleLight.position.set(x, y, 40);
    this.muzzleLight.intensity = Math.min(90, radius * 2.4);
    const distance = Math.hypot(x - this.ship.group.position.x, y - this.ship.group.position.y);
    this.shake = Math.min(1.6, this.shake + Math.max(0, 1 - distance / 1500) * Math.min(1.2, radius / 24));
  }

  /** Every round should feel felt: a few sparks and a brief light, never a camera shake. */
  hitFlash(x: number, y: number) {
    for (let i = 0; i < 4; i++) {
      const angle = Math.random() * Math.PI * 2, speed = 25 + Math.random() * 60;
      this.sparks.emit(x, y, 8, Math.cos(angle) * speed, Math.sin(angle) * speed, 25, 3, 0.22 + Math.random() * 0.2);
    }
    this.muzzleLight.position.set(x, y, 40);
    this.muzzleLight.intensity = Math.max(this.muzzleLight.intensity, 18);
  }

  /** Attaches a visible gun to each player mount and keeps the pivots for traverse. */
  setGunMounts(defs: { weapon: string; lx: number; ly: number }[]) {
    for (const entry of this.gunPivots) entry.root.removeFromParent();
    this.gunPivots = [];
    for (const def of defs) {
      const gun = buildGunMount(def.weapon as 'ac20' | 'ac70' | 'gauss' | 'cutter' | 'swarm');
      gun.group.position.set(def.lx, def.ly, 15);
      this.ship.group.add(gun.group);
      this.gunPivots.push({ root: gun.group, pivot: gun.pivot });
    }
  }

  addHostile(hostile: Hostile) {
    const model = hostile.kind === 'mine' ? buildMine() : hostile.kind === 'turret' ? buildTurret() : buildRaider(hostile.kind);
    model.group.position.set(hostile.state.position.x, hostile.state.position.y, -2);
    model.group.rotation.z = hostile.state.angle;
    this.scene.add(model.group);
    this.hostileModels.set(hostile.id, model);
  }

  removeHostile(id: number) {
    const model = this.hostileModels.get(id);
    if (!model) return;
    disposeObject(model.group);
    this.hostileModels.delete(id);
  }

  /** Drives every live hostile: hull, flames, turret traverse and the mine's proximity blink. */
  private syncHostiles(hostiles: Hostile[], dt: number, time: number) {
    for (const hostile of hostiles) {
      const model = this.hostileModels.get(hostile.id);
      if (!model) continue;
      model.group.position.set(hostile.state.position.x, hostile.state.position.y, -2);
      model.group.rotation.z = hostile.state.angle;
      const thrust = Math.max(0, hostile.state.thrustLevel);
      for (const flame of model.flames) {
        flame.visible = thrust > 0.04;
        flame.scale.y = Math.max(0.05, thrust);
      }
      for (let i = 0; i < model.turrets.length; i++) {
        const mount = hostile.mounts[i];
        if (!mount) continue;
        // Smooth damping, same law as the player's guns.
        model.turrets[i].rotation.z += (mount.bearing - model.turrets[i].rotation.z) * (1 - Math.exp(-dt * 9));
      }
      if (hostile.kind === 'mine') {
        const range = Math.hypot(hostile.state.position.x - this.ship.group.position.x, hostile.state.position.y - this.ship.group.position.y);
        const proximity = Math.max(0, 1 - range / 600);
        model.lamp.visible = Math.sin(time * (3 + 14 * proximity)) > 0;
      } else {
        model.lamp.visible = hostile.mode === 'attack' ? Math.sin(time * 9) > -0.2 : Math.sin(time * 2.4) > 0;
      }
    }
  }

  /** Read-only diagnostics: what the beam and ore pools are actually drawing this frame. */
  combatDiagnostics() {
    return { beams: this.beams.diagnostics(), ore: { count: this.oreShell.count, visible: this.oreShell.visible } };
  }

  syncOre(ore: Ore[]) {
    const count = Math.min(ore.length, MAX_ORE_INSTANCES);
    for (let i = 0; i < count; i++) {
      const chunk = ore[i];
      this.oreDummy.position.set(chunk.x, chunk.y, 2);
      this.oreDummy.rotation.set(chunk.id * 0.7, chunk.id * 1.3, chunk.id * 0.4);
      this.oreDummy.scale.setScalar(1.5 + (chunk.id % 5) * 0.12);
      this.oreDummy.updateMatrix();
      this.oreShell.setMatrixAt(i, this.oreDummy.matrix);
      this.oreVein.setMatrixAt(i, this.oreDummy.matrix);
    }
    this.oreShell.count = count; this.oreVein.count = count;
    this.oreShell.instanceMatrix.needsUpdate = true; this.oreVein.instanceMatrix.needsUpdate = true;
    this.oreShell.visible = count > 0; this.oreVein.visible = count > 0;
  }

  render(frame: SceneFrame) {
    const { state, dt, time } = frame;
    const rate = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
    const zoomTarget = this.mode === 'map' ? this.mapZoom : this.zoom;
    const zoomValue = this.mode === 'map' ? this.mapZoomCurrent : this.zoomCurrent;
    const nextZoom = zoomValue + (zoomTarget - zoomValue) * rate;
    if (Math.abs(nextZoom - zoomValue) > 0.0005) {
      if (this.mode === 'map') this.mapZoomCurrent = nextZoom; else this.zoomCurrent = nextZoom;
      this.updateProjection();
    }
    if (Math.abs(this.launch - this.lastLaunch) > 0.002) {
      this.lastLaunch = this.launch;
      this.updateProjection();
    }
    const halfWidth = this.halfHeight * (this.lastWidth / this.lastHeight || 1);
    let cx: number, cy: number;
    if (this.mode === 'map') {
      cx = SECTOR_WIDTH / 2 + SECTOR.minX; cy = SECTOR_HEIGHT / 2 + SECTOR.minY;
      cx = clampAxis(state.position.x, SECTOR.minX, SECTOR.maxX, halfWidth);
      cy = clampAxis(state.position.y, SECTOR.minY, SECTOR.maxY, this.halfHeight);
    } else {
      const desired = this.mode === 'title'
        ? new THREE.Vector2(this.titleFocus.x + Math.sin(time * 0.05) * 110, this.titleFocus.y + Math.cos(time * 0.037) * 70)
        : new THREE.Vector2(state.position.x, state.position.y);
      this.follow.lerp(desired, rate);
      cx = this.follow.x; cy = this.follow.y;
    }
    this.cameraTarget.set(cx, cy, 0);
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const jitter = this.shake * 9;
    if (this.mode === 'map') this.camera.position.set(cx, cy, 1600);
    else this.camera.position.set(cx + Math.sin(time * 61) * jitter, cy + TILT.rise + Math.cos(time * 53) * jitter, TILT.lift);
    this.camera.lookAt(this.cameraTarget);
    if (this.mode !== 'map' && this.launch < 1) this.camera.rotateZ((1 - Math.pow(this.launch, 1.7)) * -0.2 + 0.2);
    this.camera.updateMatrixWorld();
    const map = this.mode === 'map';
    this.background.visible = !map;
    this.stars.visible = !map;
    this.background.position.set(cx * 0.98, cy * 0.98, -2000);
    this.moon.position.set(415 + cx * 0.97, 610 + cy * 0.97, -950);
    this.stars.position.set(cx * 0.94, cy * 0.94, 0);
    this.moon.visible = !map;
    this.sectorGrid.visible = map;
    for (const mesh of this.rocks.values()) mesh.visible = map ? mesh.position.z === 0 : true;
    this.orbit.position.set(state.position.x, state.position.y, 0);
    this.orbit.visible = !this.cinematic && !map;
    this.ship.group.position.set(state.position.x, state.position.y, 0);
    this.ship.group.rotation.z = state.angle;
    this.shield.mesh.position.set(state.position.x, state.position.y, 0);
    this.ship.group.visible = !map || true;
    this.selection.position.copy(this.ship.group.position); this.selection.rotation.z = state.angle; this.selection.scale.setScalar(SHIP_SCALE);
    this.selection.visible = !this.cinematic && !map;
    const thrust = Math.max(0, state.thrustLevel);
    this.ship.flames.forEach(flame => {
      flame.visible = thrust > 0.01;
      const flicker = this.reducedMotion ? 1 : 1 + Math.sin(time * 37) * 0.035;
      const scale = thrust * flicker;
      flame.scale.y = scale;
      flame.position.y = -49 - 22.5 * scale;
    });
    this.ship.light.intensity = thrust * 35;
    this.ship.rcs.forEach((jet, i) => { jet.visible = state.rcsActive && (i % 2 === 0 || Math.abs(state.angularVelocity) > 0.05); });
    if (this.mode === 'flight' && thrust > 0.04) {
      const wide = state.shipClass === 'mule' ? 1.3 : state.shipClass === 'needle' ? 0.72 : 1;
      const cos = Math.cos(state.angle), sin = Math.sin(state.angle);
      for (const side of [-1, 1]) {
        const lx = side * 9 * wide * SHIP_SCALE, ly = -52 * SHIP_SCALE;
        const ex = state.position.x + lx * cos - ly * sin;
        const ey = state.position.y + lx * sin + ly * cos;
        const spread = 26 * (1 + thrust);
        this.plume.emit(ex, ey, 2, -sin * 90 * thrust + (Math.random() - 0.5) * spread, cos * 90 * thrust + (Math.random() - 0.5) * spread, 0, 5 + thrust * 8, 0.42 + thrust * 0.5);
      }
      this.waves.pulse(state.position.x - sin * 60, state.position.y + cos * 60, -4, '#7fb6e8', 22, 0.4);
    }
    if (this.mode === 'flight' && state.rcsActive && Math.hypot(state.velocity.x, state.velocity.y) > 1) {
      const speed = Math.hypot(state.velocity.x, state.velocity.y);
      const nx = state.velocity.x / speed, ny = state.velocity.y / speed;
      this.vent.emit(state.position.x + nx * 30, state.position.y + ny * 30, 6, nx * 60 + (Math.random() - 0.5) * 30, ny * 60 + (Math.random() - 0.5) * 30, 0, 4, 0.3);
    }
    const hullRatio = state.hull / (state.shipClass === 'mule' ? 150 : state.shipClass === 'needle' ? 75 : 100);
    if (this.mode === 'flight' && hullRatio < 0.45 && Math.random() < (0.45 - hullRatio) * 0.9) {
      this.vent.emit(state.position.x + (Math.random() - 0.5) * 40, state.position.y + (Math.random() - 0.5) * 40, 8, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, 6, 5 + Math.random() * 5, 1.1);
    }
    for (const item of this.cargos) {
      if (item.cargo.collected && !this.recovering.some(entry => entry.mesh === item.mesh)) { item.mesh.visible = false; continue; }
      item.mesh.visible = !map;
      if (!this.reducedMotion) item.mesh.rotation.z += dt * 0.07;
    }
    for (let i = this.recovering.length - 1; i >= 0; i--) {
      const entry = this.recovering[i];
      entry.t += dt;
      const t = Math.min(1, entry.t / 0.75);
      entry.mesh.position.x += (state.position.x - entry.mesh.position.x) * t * 0.4;
      entry.mesh.position.y += (state.position.y - entry.mesh.position.y) * t * 0.4;
      entry.mesh.scale.setScalar(Math.max(0.02, 1 - t));
      entry.mesh.rotation.z += dt * 6;
      if (t >= 1) { entry.mesh.visible = false; this.recovering.splice(i, 1); }
    }
    const beaconBlink = 0.5 + 0.5 * Math.sin(time * 2.6);
    this.beacon.lamp.visible = beaconBlink > 0.25;
    this.beacon.halo.scale.setScalar(0.85 + beaconBlink * 0.5);
    this.beacon.halo.rotation.z = time * 0.4;
    this.beacon.group.rotation.z = this.reducedMotion ? 0 : Math.sin(time * 0.25) * 0.05;
    this.derelict.lamp.visible = Math.sin(time * 7.2) * Math.sin(time * 13.7) > -0.1;
    for (let i = 0; i < this.derelict.debris.length; i++) {
      const plate = this.derelict.debris[i];
      if (this.reducedMotion) continue;
      plate.rotation.z += dt * (i ? -0.05 : 0.07);
      plate.position.z = 3 + Math.sin(time * 0.3 + i) * 2.5;
    }
    this.stationFlash = Math.max(0, this.stationFlash - dt * 0.65);
    for (const material of this.stationLamps) material.color.setRGB(0.72 + this.stationFlash * 0.28, 0.87, 0.86 + this.stationFlash * 0.14);
    if (!this.reducedMotion) this.station.rotation.z += dt * 0.008;

    const trajectory = this.trajectory.geometry.attributes.position;
    for (let i = 0; i < trajectory.count; i++) {
      const t = i / (trajectory.count - 1) * 18;
      trajectory.setXYZ(i, state.position.x + state.velocity.x * t, state.position.y + state.velocity.y * t, -8);
    }
    trajectory.needsUpdate = true; this.trajectory.computeLineDistances();
    this.trajectory.visible = !this.cinematic && !map && Math.hypot(state.velocity.x, state.velocity.y) > 1;
    const vp = this.velocityVector.geometry.attributes.position;
    vp.setXYZ(0, state.position.x, state.position.y, 8);
    vp.setXYZ(1, state.position.x + state.velocity.x * 2, state.position.y + state.velocity.y * 2, 8);
    vp.needsUpdate = true; this.velocityVector.visible = !this.cinematic && !map;
    this.targetLine.visible = !!frame.target && !this.cinematic && !map;
    if (frame.target) {
      const tp = this.targetLine.geometry.attributes.position;
      tp.setXYZ(0, state.position.x, state.position.y, -14); tp.setXYZ(1, frame.target.position.x, frame.target.position.y, -14);
      tp.needsUpdate = true; this.targetLine.computeLineDistances();
    }
    const scanning = frame.scanning;
    this.scanRing.visible = !!scanning && !map;
    this.scanSweep.visible = !!scanning && !map;
    if (scanning) {
      this.scanRing.position.set(scanning.position.x, scanning.position.y, 10);
      this.scanRing.scale.setScalar(1 - scanning.progress * 0.45);
      this.scanRing.material.opacity = 0.25 + scanning.progress * 0.5;
      this.scanSweep.position.set(scanning.position.x, scanning.position.y, 10);
      this.scanSweep.rotation.z = -time * 2.4;
    }
    this.plume.update(dt); this.sparks.update(dt); this.vent.update(dt); this.waves.update(dt);
    this.shield.update(dt);
    for (let i = this.dissolving.length - 1; i >= 0; i--) {
      const entry = this.dissolving[i];
      entry.t += dt / DISSOLVE_SECONDS;
      entry.uniform.value = Math.min(1, entry.t);
      entry.mesh.visible = !map;
      if (entry.t >= 1) {
        entry.mesh.removeFromParent();
        entry.material.dispose();
        this.dissolving.splice(i, 1);
      }
    }
    if (this.damageBelow) {
      const cos = Math.cos(state.angle), sin = Math.sin(state.angle);
      const ox = -27 * SHIP_SCALE, oy = -6 * SHIP_SCALE;
      this.damagePlate.position.set(state.position.x + ox * cos - oy * sin, state.position.y + ox * sin + oy * cos, 9);
      if (this.reducedMotion) this.damagePlate.rotation.set(0.3, 0.4, state.angle);
      else this.damagePlate.rotation.set(Math.sin(time * 0.6) * 0.6, time * 0.45, state.angle + Math.sin(time * 0.31) * 0.5);
      this.damagePlate.visible = !map;
    }
    if (frame.rounds) this.tracers.sync(frame.rounds);
    this.beams.sync(map ? [] : frame.beams ?? []);
    this.syncOre(frame.ore ?? []);
    const mounts = frame.mounts;
    const pivots: THREE.Group[] = this.customTurrets.length ? this.customTurrets : this.gunPivots.map(entry => entry.pivot);
    for (let i = 0; i < pivots.length; i++) {
      const mount = mounts?.[i];
      if (!mount) continue;
      // Smooth damping: barrels swing rather than snap.
      pivots[i].rotation.z += (mount.bearing - pivots[i].rotation.z) * (1 - Math.exp(-dt * 9));
    }
    if (frame.aim && this.mode === 'flight' && !this.cinematic) {
      this.aimMarker.visible = true;
      this.aimMarker.position.set(frame.aim.x, frame.aim.y, 0);
    } else this.aimMarker.visible = false;
    if (frame.hostiles) this.syncHostiles(frame.hostiles, dt, time);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 140);
    if (this.lowSpec) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
}

function clampAxis(value: number, min: number, max: number, half: number) {
  if (max - min <= half * 2) return (min + max) / 2;
  return Math.min(max - half, Math.max(min + half, value));
}
