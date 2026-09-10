import * as THREE from 'three';
import { buildAsteroid, buildCargo, buildShip, buildStation, disposeObject } from './models';
import type { ShipModel } from './models';
import { randomSeed, STATION } from './physics';
import type { Cargo, Loadout, Rock, ShipClass, Vec2 } from './physics';
import type { RenderView, TeamId, WireBullet, WirePlayer } from './world';
import { rockyTexture, spaceTexture } from './textures';

const TEAM_COLOR: Record<TeamId, string> = { blue: '#83b9b5', red: '#df8277', pirate: '#efb879' };
const PARTICLE_POOL = 500;
const BULLET_POOL = 400;

/** Solo-only scenery: the mission cargo and the station are not part of a multiplayer match. */
export type SoloView = { cargos: Cargo[]; target?: Vec2 };

export class SpaceScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-600, 600, 400, -400, 1, 4500);
  ships = new Map<string, ShipModel>();
  zoom = 1;
  tactical = false;
  cinematic = false;
  host: HTMLElement;
  moon: THREE.Mesh;
  stars: THREE.Points;
  cargos: THREE.Group[] = [];
  station: THREE.Group;
  orbit = new THREE.Group();
  trajectory: THREE.Line;
  velocityVector: THREE.Line;
  targetLine: THREE.Line;
  selection: THREE.LineSegments;
  private rockMeshes = new Map<number, THREE.Mesh>();
  private pendingRocks: Rock[] = [];
  private bulletPoints: THREE.Points;
  private particles: THREE.Points;
  private pPos: Float32Array;
  private pCol: Float32Array;
  private pSize: Float32Array;
  private pAlpha: Float32Array;
  private pVel: Float32Array;
  private pLife: Float32Array;
  private pNext = 0;
  private burstColor = new THREE.Color();
  private localId = 'you';
  private followReady = false;
  private background: THREE.Mesh;
  private follow = new THREE.Vector2();
  private cameraTarget = new THREE.Vector3();
  private lastWidth = 0;
  private lastHeight = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(host: HTMLElement, rocks: Rock[], cargos: Cargo[]) {
    this.host = host;
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

    for (const rock of rocks) this.addRock(rock);
    cargos.forEach((cargo, i) => {
      const mesh = buildCargo(i); mesh.position.set(cargo.position.x, cargo.position.y, 0);
      this.cargos.push(mesh); this.scene.add(mesh);
    });
    this.station = buildStation(); this.station.position.set(STATION.x, STATION.y, -10); this.scene.add(this.station);

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
    this.trajectory = this.makeLine(51, '#769d98', 0.3, true);
    this.velocityVector = this.makeLine(2, '#a5c8b7', 0.7);
    this.targetLine = this.makeLine(2, '#cca16f', 0.22, true);
    const selectionPoints: number[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      selectionPoints.push(x * 37, y * 59, 7, x * 27, y * 59, 7, x * 37, y * 59, 7, x * 37, y * 49, 7);
    }
    const selectionGeometry = new THREE.BufferGeometry(); selectionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(selectionPoints, 3));
    this.selection = new THREE.LineSegments(selectionGeometry, new THREE.LineBasicMaterial({ color: TEAM_COLOR.blue, transparent: true, opacity: 0.55 }));
    this.scene.add(this.selection);
    this.bulletPoints = this.buildPoints(BULLET_POOL, 2.6, false);
    this.scene.add(this.bulletPoints);
    this.particles = this.buildPoints(PARTICLE_POOL, 3.4, true);
    this.pPos = this.particles.geometry.attributes.position.array as Float32Array;
    this.pCol = this.particles.geometry.attributes.color.array as Float32Array;
    this.pSize = this.particles.geometry.attributes.size.array as Float32Array;
    this.pAlpha = this.particles.geometry.attributes.alpha.array as Float32Array;
    this.pVel = new Float32Array(PARTICLE_POOL * 3);
    this.pLife = new Float32Array(PARTICLE_POOL);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private makeLine(count: number, color: string, opacity: number, dashed = false) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const line = new THREE.Line(geometry, dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 5, gapSize: 7 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    line.frustumCulled = false; this.scene.add(line); return line;
  }

  /** Points with per-vertex size and alpha: used for bullets, sparks and debris puffs. */
  private buildPoints(count: number, size: number, perVertexAlpha: boolean) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(count).fill(size), 1));
    if (perVertexAlpha) geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(count), 1));
    const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float size; ${perVertexAlpha ? 'attribute float alpha; varying float vAlpha;' : ''} varying vec3 vColor;
        void main(){ vColor=color; ${perVertexAlpha ? 'vAlpha=alpha;' : ''} gl_PointSize=size; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `varying vec3 vColor; ${perVertexAlpha ? 'varying float vAlpha;' : ''}
        void main(){ float d=length(gl_PointCoord-.5)*2.; gl_FragColor=vec4(vColor, pow(max(0.,1.-d),1.4)*${perVertexAlpha ? 'vAlpha' : '1.'}); }`,
    }));
    points.frustumCulled = false;
    points.geometry.setDrawRange(0, 0);
    return points;
  }

  private buildStars() {
    const rand = randomSeed(836);
    const vertices: number[] = [], colors: number[] = [], sizes: number[] = [];
    for (let i = 0; i < 2500; i++) {
      vertices.push((rand() - 0.5) * 5100, (rand() - 0.5) * 3300, -1100 - rand() * 800);
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
    return new THREE.Mesh(new THREE.PlaneGeometry(6500, 4600), new THREE.MeshBasicMaterial({ map: spaceTexture(), depthWrite: false, toneMapped: false }));
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
    const aspect = this.lastWidth / this.lastHeight;
    const half = (this.tactical ? 1060 : 365) / this.zoom;
    this.camera.left = -half * aspect; this.camera.right = half * aspect;
    this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
  }

  setZoom(delta: number) { this.zoom = THREE.MathUtils.clamp(this.zoom + delta, 0.55, 2); this.updateProjection(); }
  setTactical(value: boolean) { this.tactical = value; this.updateProjection(); }

  addShip(id: string, loadout: Loadout | ShipClass) {
    this.removeShip(id);
    const model = buildShip(loadout);
    model.group.scale.setScalar(1.3);
    this.scene.add(model.group);
    this.ships.set(id, model);
  }

  removeShip(id: string) {
    const model = this.ships.get(id);
    if (model) { disposeObject(model.group); this.ships.delete(id); }
  }

  setLocalTeam(team: TeamId) { (this.selection.material as THREE.LineBasicMaterial).color.set(TEAM_COLOR[team]); }
  snapCamera() { this.followReady = false; }

  /** Solo path: a nudged rock moves in the simulation, so its mesh must follow. */
  syncRockPositions(rocks: Iterable<Rock>) {
    for (const r of rocks) if (r.vx || r.vy) this.rockMeshes.get(r.id)?.position.set(r.x, r.y, r.z);
  }

  addRock(rock: Rock) {
    const mesh = buildAsteroid(rock.radius, rock.seed);
    mesh.position.set(rock.x, rock.y, rock.z);
    mesh.rotation.set(rock.seed, rock.seed * 0.4, rock.seed * 0.7);
    this.rockMeshes.set(rock.id, mesh);
    this.scene.add(mesh);
  }

  /** Fragments are queued: building several deformed icosahedrons in one frame is a visible hitch. */
  queueRocks(rocks: Rock[]) { this.pendingRocks.push(...rocks); }

  /** Remove a rock and report where it was, so debris puffs land on the rock rather than the origin. */
  removeRock(id: number): { x: number; y: number } | undefined {
    const mesh = this.rockMeshes.get(id);
    const at = mesh ? { x: mesh.position.x, y: mesh.position.y } : undefined;
    if (mesh) { disposeObject(mesh); this.rockMeshes.delete(id); }
    const queued = this.pendingRocks.findIndex(r => r.id === id);
    if (queued >= 0) this.pendingRocks.splice(queued, 1);
    return at;
  }

  clearRocks() {
    for (const id of [...this.rockMeshes.keys()]) this.removeRock(id);
    this.pendingRocks.length = 0;
  }

  /** Swap the entire field: solo boot, or a late-join `rocksFull` correction. */
  setRocks(rocks: Iterable<Rock>) {
    this.clearRocks();
    for (const rock of rocks) this.addRock(rock);
  }

  updateBullets(bullets: WireBullet[]) {
    const pos = this.bulletPoints.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.bulletPoints.geometry.attributes.color as THREE.BufferAttribute;
    const n = Math.min(bullets.length, BULLET_POOL);
    for (let i = 0; i < n; i++) {
      pos.setXYZ(i, bullets[i].x, bullets[i].y, 4);
      col.setXYZ(i, 1, 0.82, 0.5);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this.bulletPoints.geometry.setDrawRange(0, n);
  }

  /** Short-lived additive sparks: weapon hits, rock debris and muzzle flash all use this. */
  burst(x: number, y: number, count: number, color: string, speed: number) {
    this.burstColor.set(color);
    for (let i = 0; i < count; i++) {
      const slot = this.pNext; this.pNext = (this.pNext + 1) % PARTICLE_POOL;
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.pPos[slot * 3] = x; this.pPos[slot * 3 + 1] = y; this.pPos[slot * 3 + 2] = 6;
      this.pVel[slot * 3] = Math.cos(angle) * v; this.pVel[slot * 3 + 1] = Math.sin(angle) * v; this.pVel[slot * 3 + 2] = 0;
      this.pCol[slot * 3] = this.burstColor.r; this.pCol[slot * 3 + 1] = this.burstColor.g; this.pCol[slot * 3 + 2] = this.burstColor.b;
      this.pSize[slot] = 2 + Math.random() * 3;
      this.pAlpha[slot] = 1;
      this.pLife[slot] = 0.42 + Math.random() * 0.28;
    }
  }

  private updateParticles(dt: number) {
    const step = Math.min(dt, 0.05);
    const pos = this.particles.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.particles.geometry.attributes.color as THREE.BufferAttribute;
    const size = this.particles.geometry.attributes.size as THREE.BufferAttribute;
    const alpha = this.particles.geometry.attributes.alpha as THREE.BufferAttribute;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      if (this.pLife[i] <= 0) { size.setX(i, 0); continue; }
      this.pLife[i] -= step;
      const drag = 1 - Math.min(0.9, step * 4);
      this.pVel[i * 3] *= drag; this.pVel[i * 3 + 1] *= drag;
      this.pPos[i * 3] += this.pVel[i * 3] * step; this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * step;
      pos.setXYZ(i, this.pPos[i * 3], this.pPos[i * 3 + 1], this.pPos[i * 3 + 2]);
      col.setXYZ(i, this.pCol[i * 3], this.pCol[i * 3 + 1], this.pCol[i * 3 + 2]);
      alpha.setX(i, Math.max(0, Math.min(1, this.pLife[i] * 3)));
      size.setX(i, this.pSize[i] * Math.max(0.2, Math.min(1, this.pLife[i] * 2)));
    }
    pos.needsUpdate = true; col.needsUpdate = true; size.needsUpdate = true; alpha.needsUpdate = true;
    this.particles.geometry.setDrawRange(0, PARTICLE_POOL);
  }

  project(position: Vec2, z = 0) {
    const point = new THREE.Vector3(position.x, position.y, z).project(this.camera);
    return { x: (point.x + 1) / 2 * this.lastWidth, y: (1 - point.y) / 2 * this.lastHeight, visible: Math.abs(point.x) < 0.98 && Math.abs(point.y) < 0.94 && point.z < 1 };
  }

  /** Remote ships get hull and plume only; the trajectory, brackets and rings belong to the local ship. */
  private placeShip(model: ShipModel, w: WirePlayer, time: number) {
    model.group.visible = w.dead === 0;
    model.group.position.set(w.x, w.y, 0);
    model.group.rotation.z = w.a;
    const thrust = Math.max(0, w.th);
    model.flames.forEach(flame => {
      flame.visible = thrust > 0.01;
      const flicker = this.reducedMotion ? 1 : 1 + Math.sin(time * 37) * 0.035;
      const scale = thrust * flicker;
      flame.scale.y = scale;
      flame.position.y = -70 + 22.5 * (1 - scale);
    });
    model.light.intensity = thrust * 35;
    model.rcs.forEach((jet, i) => { jet.visible = w.rcs === 1 && (i % 2 === 0 || Math.abs(w.av) > 0.05); });
  }

  render(view: RenderView, localId: string, dt: number, time: number, solo?: SoloView) {
    this.localId = localId;
    const local = view.players.find(p => p.id === localId);

    if (!this.followReady && local) { this.follow.set(local.x, local.y); this.followReady = true; }
    const followRate = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 4);
    if (local) {
      this.follow.x += (local.x - this.follow.x) * followRate;
      this.follow.y += (local.y - this.follow.y) * followRate;
    }
    const px = this.tactical ? this.follow.x * 0.15 + 110 : this.follow.x;
    const py = this.tactical ? this.follow.y * 0.15 + 80 : this.follow.y;
    this.cameraTarget.set(px, py, 0);
    this.camera.position.set(px, py - (this.tactical ? 0 : 410), 1100);
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
    this.background.position.set(px * 0.98, py * 0.98, -2000);
    this.moon.position.set(415 + px * 0.97, 610 + py * 0.97, -950);
    this.stars.position.set(px * 0.94, py * 0.94, 0);
    this.moon.visible = !this.tactical;

    for (const w of view.players) {
      const model = this.ships.get(w.id);
      if (model) this.placeShip(model, w, time);
    }

    // Deferred fragment builds: at most two per frame keeps the frame budget flat.
    for (let built = 0; built < 2 && this.pendingRocks.length; built++) this.addRock(this.pendingRocks.shift()!);
    this.updateBullets(view.bullets);
    this.updateParticles(dt);

    const hasLocal = !!this.ships.get(localId) && !!local;
    this.orbit.visible = hasLocal && !this.cinematic;
    this.selection.visible = hasLocal && !this.cinematic;
    this.station.visible = !!solo;
    if (!hasLocal || !local) {
      this.trajectory.visible = false; this.velocityVector.visible = false; this.targetLine.visible = false;
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.orbit.position.set(local.x, local.y, 0);
    this.selection.position.set(local.x, local.y, 0);
    this.selection.rotation.z = local.a;
    this.selection.scale.setScalar(1.3);

    const trajectory = this.trajectory.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < trajectory.count; i++) {
      const t = i / (trajectory.count - 1) * 18;
      trajectory.setXYZ(i, local.x + local.vx * t, local.y + local.vy * t, -8);
    }
    trajectory.needsUpdate = true; this.trajectory.computeLineDistances();
    this.trajectory.visible = !this.cinematic && Math.hypot(local.vx, local.vy) > 1;
    const vp = this.velocityVector.geometry.attributes.position as THREE.BufferAttribute;
    vp.setXYZ(0, local.x, local.y, 8);
    vp.setXYZ(1, local.x + local.vx * 2, local.y + local.vy * 2, 8);
    vp.needsUpdate = true; this.velocityVector.visible = !this.cinematic;
    const target = solo?.target;
    this.targetLine.visible = !!target && !this.cinematic;
    if (target) {
      const tp = this.targetLine.geometry.attributes.position as THREE.BufferAttribute;
      tp.setXYZ(0, local.x, local.y, -14); tp.setXYZ(1, target.x, target.y, -14);
      tp.needsUpdate = true; this.targetLine.computeLineDistances();
    }

    this.cargos.forEach((mesh, i) => {
      const cargo = solo?.cargos[i];
      mesh.visible = !!cargo && !cargo.collected;
      if (cargo && !this.reducedMotion) mesh.rotation.z += dt * 0.07;
    });

    this.renderer.render(this.scene, this.camera);
  }

  /** Solo path: swapping chassis rebuilds the single local model. */
  changeShip(shipClass: ShipClass) {
    this.removeShip(this.localId);
    this.addShip(this.localId, shipClass);
    this.snapCamera();
  }
}
