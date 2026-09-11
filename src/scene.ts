import * as THREE from 'three';
import { buildAsteroid, buildBeacon, buildCargo, buildDerelict, buildShip, buildStation, disposeObject } from './models';
import type { ShipModel } from './models';
import { ParticleField, RingWaves } from './effects';
import { DERELICT, randomSeed, RELAY, SECTOR, STATION } from './physics';
import type { Cargo, Obstacle, ShipClass, ShipState, Vec2 } from './physics';
import { rockyTexture, spaceTexture } from './textures';

const SHIP_SCALE = 1.3;
/** Half-height of the flight view at zoom 1, in metres. */
const FLIGHT_HALF = 340;
/** The flight camera sits up and back from the ship so the plane reads as a lit surface rather than a flat chart. */
const TILT = { rise: -410, lift: 1100 };
const SECTOR_WIDTH = SECTOR.maxX - SECTOR.minX;
const SECTOR_HEIGHT = SECTOR.maxY - SECTOR.minY;

export type ViewMode = 'title' | 'flight' | 'map';

export type SceneFrame = {
  state: ShipState;
  cargos: Cargo[];
  target?: { id: string; position: Vec2 };
  scanning?: { position: Vec2; progress: number };
  dt: number;
  time: number;
};

export class SpaceScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-600, 600, 400, -400, 1, 6000);
  ship: ShipModel;
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
  rocks: { mesh: THREE.Mesh; planar: boolean }[] = [];
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
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    for (const obstacle of obstacles) {
      const rock = buildAsteroid(obstacle.radius, obstacle.seed);
      rock.position.set(obstacle.x, obstacle.y, obstacle.z);
      rock.rotation.set(obstacle.seed, obstacle.seed * 0.4, obstacle.seed * 0.7);
      this.rocks.push({ mesh: rock, planar: obstacle.z === 0 }); this.scene.add(rock);
    }
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
  changeShip(shipClass: ShipClass) { disposeObject(this.ship.group); this.ship = buildShip(shipClass); this.ship.group.scale.setScalar(SHIP_SCALE); this.scene.add(this.ship.group); }

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
    for (const rock of this.rocks) rock.mesh.visible = map ? rock.planar : true;
    this.orbit.position.set(state.position.x, state.position.y, 0);
    this.orbit.visible = !this.cinematic && !map;
    this.ship.group.position.set(state.position.x, state.position.y, 0);
    this.ship.group.rotation.z = state.angle;
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
    this.renderer.render(this.scene, this.camera);
  }
}

function clampAxis(value: number, min: number, max: number, half: number) {
  if (max - min <= half * 2) return (min + max) / 2;
  return Math.min(max - half, Math.max(min + half, value));
}
