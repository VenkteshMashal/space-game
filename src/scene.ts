import * as THREE from 'three';
import { buildAsteroid, buildCargo, buildShip, buildStation, disposeObject } from './models';
import type { ShipModel } from './models';
import { randomSeed, STATION } from './physics';
import type { Cargo, Obstacle, ShipState, ShipClass, Vec2 } from './physics';
import { rockyTexture, spaceTexture } from './textures';

export class SpaceScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-600, 600, 400, -400, 1, 4500);
  ship: ShipModel;
  zoom = 1;
  tactical = false;
  cinematic = false;
  host: HTMLElement;
  moon: THREE.Mesh;
  stars: THREE.Points;
  cargos: THREE.Group[] = [];
  rocks: THREE.Mesh[] = [];
  station: THREE.Group;
  orbit = new THREE.Group();
  trajectory: THREE.Line;
  velocityVector: THREE.Line;
  targetLine: THREE.Line;
  selection: THREE.LineSegments;
  private background: THREE.Mesh;
  private follow = new THREE.Vector2();
  private cameraTarget = new THREE.Vector3();
  private lastWidth = 0;
  private lastHeight = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(host: HTMLElement, obstacles: Obstacle[], cargos: Cargo[]) {
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

    this.ship = buildShip(); this.ship.group.scale.setScalar(1.3); this.scene.add(this.ship.group);
    for (const obstacle of obstacles) {
      const rock = buildAsteroid(obstacle.radius, obstacle.seed);
      rock.position.set(obstacle.x, obstacle.y, obstacle.z);
      rock.rotation.set(obstacle.seed, obstacle.seed * 0.4, obstacle.seed * 0.7);
      this.rocks.push(rock); this.scene.add(rock);
    }
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
    this.selection = new THREE.LineSegments(selectionGeometry, new THREE.LineBasicMaterial({ color: '#83b9b5', transparent: true, opacity: 0.55 }));
    this.scene.add(this.selection);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private makeLine(count: number, color: string, opacity: number, dashed = false) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const line = new THREE.Line(geometry, dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 5, gapSize: 7 }) : new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    line.frustumCulled = false; this.scene.add(line); return line;
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
  changeShip(shipClass: ShipClass) { disposeObject(this.ship.group); this.ship = buildShip(shipClass); this.ship.group.scale.setScalar(1.3); this.scene.add(this.ship.group); }

  project(position: Vec2, z = 0) {
    const point = new THREE.Vector3(position.x, position.y, z).project(this.camera);
    return { x: (point.x + 1) / 2 * this.lastWidth, y: (1 - point.y) / 2 * this.lastHeight, visible: Math.abs(point.x) < 0.98 && Math.abs(point.y) < 0.94 && point.z < 1 };
  }

  render(state: ShipState, cargos: Cargo[], target: Vec2 | undefined, dt: number, time: number) {
    const followRate = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 4);
    this.follow.lerp(new THREE.Vector2(state.position.x, state.position.y), followRate);
    const px = this.tactical ? state.position.x * 0.15 + 110 : this.follow.x;
    const py = this.tactical ? state.position.y * 0.15 + 80 : this.follow.y;
    this.cameraTarget.set(px, py, 0);
    this.camera.position.set(px, py - (this.tactical ? 0 : 410), 1100);
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
    this.background.position.set(px * 0.98, py * 0.98, -2000);
    this.moon.position.set(415 + px * 0.97, 610 + py * 0.97, -950);
    this.stars.position.set(px * 0.94, py * 0.94, 0);
    this.moon.visible = !this.tactical;
    this.orbit.position.set(state.position.x, state.position.y, 0);
    this.orbit.visible = !this.cinematic;
    this.ship.group.position.set(state.position.x, state.position.y, 0);
    this.ship.group.rotation.z = state.angle;
    this.selection.position.copy(this.ship.group.position); this.selection.rotation.z = state.angle; this.selection.scale.setScalar(1.3);
    this.selection.visible = !this.cinematic;
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
    this.cargos.forEach((mesh, i) => {
      mesh.visible = !cargos[i].collected;
      if (!this.reducedMotion) mesh.rotation.z += dt * 0.07;
    });
    const trajectory = this.trajectory.geometry.attributes.position;
    for (let i = 0; i < trajectory.count; i++) {
      const t = i / (trajectory.count - 1) * 18;
      trajectory.setXYZ(i, state.position.x + state.velocity.x * t, state.position.y + state.velocity.y * t, -8);
    }
    trajectory.needsUpdate = true; this.trajectory.computeLineDistances();
    this.trajectory.visible = !this.cinematic && Math.hypot(state.velocity.x, state.velocity.y) > 1;
    const vp = this.velocityVector.geometry.attributes.position;
    vp.setXYZ(0, state.position.x, state.position.y, 8);
    vp.setXYZ(1, state.position.x + state.velocity.x * 2, state.position.y + state.velocity.y * 2, 8);
    vp.needsUpdate = true; this.velocityVector.visible = !this.cinematic;
    this.targetLine.visible = !!target && !this.cinematic;
    if (target) {
      const tp = this.targetLine.geometry.attributes.position;
      tp.setXYZ(0, state.position.x, state.position.y, -14); tp.setXYZ(1, target.x, target.y, -14);
      tp.needsUpdate = true; this.targetLine.computeLineDistances();
    }
    this.renderer.render(this.scene, this.camera);
  }
}
