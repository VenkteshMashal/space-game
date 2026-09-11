import * as THREE from 'three';
import { buildShip } from './models';
import type { ShipModel } from './models';
import type { ShipClass } from './physics';

export type ShipBayOptions = { showPlatform?: boolean; autoRotate?: number };

const TAU = Math.PI * 2;
const SHIP_SCALE = 1.12;
const SWAP_FROM = 0.86;
const SWAP_SECONDS = 0.45;
const SPIN_OFFSET = -0.48;
const FLAME_MIN = 0.25;
const FLAME_MAX = 0.5;
const PLATFORM_Z = -42;
const ENGINE_LIGHT = 14;

function disposeMaterial(material: THREE.Material): void {
  (material as THREE.Material & { map?: THREE.Texture | null }).map?.dispose();
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse(child => {
    const renderable = child as Partial<THREE.Mesh>;
    renderable.geometry?.dispose();
    const material = renderable.material;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
}

/**
 * A turntable hero view of one ship, shared by the startup hangar and the in-flight shipyard
 * dialog. Each instance owns its renderer, scene and model, so several can live on one page.
 */
export class ShipBay {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly turntable = new THREE.Group();
  private readonly roller = new THREE.Group();
  private readonly engineLight: THREE.PointLight;
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private autoRotate: number;
  private model?: ShipModel;
  private raf: number | undefined;
  private active = false;
  private disposed = false;
  private spin = 0;
  private time = 0;
  private swapAt = 0;
  private width = 0;
  private height = 0;

  constructor(container: HTMLElement, options: ShipBayOptions = {}) {
    this.container = container;
    this.autoRotate = options.autoRotate ?? 0.18;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 4000);
    this.camera.position.set(78, -122, 168);
    this.camera.lookAt(0, -6, 0);

    this.scene.add(new THREE.AmbientLight('#afcadd', 1.15));
    const key = new THREE.DirectionalLight('#fff0d5', 3.5);
    key.position.set(-60, 100, 100);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#74b8ec', 2);
    rim.position.set(100, -60, 30);
    this.scene.add(rim);
    this.engineLight = new THREE.PointLight('#efb879', ENGINE_LIGHT, 220, 1);
    this.engineLight.position.set(0, -70, 26);
    this.scene.add(this.engineLight);

    if (options.showPlatform !== false) this.scene.add(this.buildPlatform());

    this.turntable.add(this.roller);
    this.scene.add(this.turntable);
    this.setShip('kestrel');

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setActive(true);
  }

  private buildDeckTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
    gradient.addColorStop(0, '#23414f');
    gradient.addColorStop(0.58, '#152836');
    gradient.addColorStop(1, '#0a131b');
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(126,190,206,.34)'; ctx.lineWidth = 2;
    for (const ratio of [0.14, 0.28, 0.43]) {
      ctx.beginPath(); ctx.arc(size / 2, size / 2, size * ratio, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(126,190,206,.16)'; ctx.lineWidth = 1;
    for (let i = 0; i < 24; i++) {
      const angle = i / 24 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(size / 2 + Math.cos(angle) * size * 0.14, size / 2 + Math.sin(angle) * size * 0.14);
      ctx.lineTo(size / 2 + Math.cos(angle) * size * 0.5, size / 2 + Math.sin(angle) * size * 0.5);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private buildPlatform(): THREE.Group {
    const group = new THREE.Group();
    const outerMaterial = new THREE.MeshStandardMaterial({ color: '#4a7284', roughness: 0.42, metalness: 0.6, emissive: '#1b3a47', emissiveIntensity: 0.9 });
    const innerMaterial = new THREE.MeshStandardMaterial({ color: '#5c8b9b', roughness: 0.4, metalness: 0.6, emissive: '#204652', emissiveIntensity: 0.7 });
    const lampMaterial = new THREE.MeshBasicMaterial({ color: '#f3c690' });
    const deck = new THREE.Mesh(new THREE.CircleGeometry(78, 72), new THREE.MeshBasicMaterial({ map: this.buildDeckTexture(), transparent: true, opacity: 0.92 }));
    deck.position.z = PLATFORM_Z - 1.2;
    group.add(deck);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(38, 48), new THREE.MeshBasicMaterial({ color: '#04090d', transparent: true, opacity: 0.5, depthWrite: false }));
    shadow.position.z = PLATFORM_Z + 0.6;
    group.add(shadow);
    const outerRing = new THREE.Mesh(new THREE.TorusGeometry(66, 2.1, 6, 96), outerMaterial);
    outerRing.position.z = PLATFORM_Z;
    group.add(outerRing);
    const innerRing = new THREE.Mesh(new THREE.TorusGeometry(40, 0.6, 4, 96), innerMaterial);
    innerRing.position.z = PLATFORM_Z;
    group.add(innerRing);
    const halo = new THREE.Mesh(new THREE.RingGeometry(74, 96, 72), new THREE.MeshBasicMaterial({ color: '#6fa8ba', transparent: true, opacity: 0.14, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.position.z = PLATFORM_Z - 2.4;
    group.add(halo);
    const lampGeometry = new THREE.SphereGeometry(1.5, 8, 8);
    for (let i = 0; i < 16; i++) {
      const angle = i / 16 * TAU;
      const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
      lamp.position.set(Math.cos(angle) * 83, Math.sin(angle) * 83, PLATFORM_Z + 1.8);
      group.add(lamp);
    }
    return group;
  }

  setShip(type: ShipClass): void {
    if (this.disposed) return;
    if (this.model) {
      disposeObject(this.model.group);
      this.model.group.removeFromParent();
    }
    const model = buildShip(type);
    model.group.scale.setScalar(SWAP_FROM);
    for (const flame of model.flames) flame.visible = true;
    this.roller.add(model.group);
    this.model = model;
    this.swapAt = this.time;
  }

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) {
      this.clock.getDelta();
      this.raf = requestAnimationFrame(this.frame);
    } else if (this.raf !== undefined) {
      cancelAnimationFrame(this.raf);
      this.raf = undefined;
    }
  }

  setAutoRotate(speed: number): void {
    this.autoRotate = speed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.model = undefined;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private frame = (): void => {
    if (this.disposed || !this.active) return;
    this.raf = requestAnimationFrame(this.frame);
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.time += delta;
    this.update(delta);
    if (this.width && this.height) this.renderer.render(this.scene, this.camera);
  };

  private update(delta: number): void {
    const time = this.time;
    this.spin += delta * this.autoRotate;
    this.turntable.rotation.z = SPIN_OFFSET + this.spin;
    this.roller.rotation.y = Math.sin(time * TAU / 3) * 0.8;
    this.roller.position.z = Math.sin(time * 1.15) * 1.4;
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);
    this.engineLight.intensity = ENGINE_LIGHT * (0.85 + 0.15 * pulse);
    const model = this.model;
    if (!model) return;
    const progress = Math.min((time - this.swapAt) / SWAP_SECONDS, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    model.group.scale.setScalar(SWAP_FROM + (SHIP_SCALE - SWAP_FROM) * eased);
    for (let i = 0; i < model.flames.length; i++) {
      const flame = model.flames[i];
      const flicker = 0.5 + 0.5 * Math.sin(time * 9.3 + i * 1.7) * Math.sin(time * 4.1);
      const scale = FLAME_MIN + (FLAME_MAX - FLAME_MIN) * flicker;
      flame.scale.set(0.9 + flicker * 0.2, scale, 0.9 + flicker * 0.2);
      flame.position.y = -49 - 22.5 * scale;
      const material = flame.material;
      if (!Array.isArray(material)) material.opacity = 0.45 + 0.4 * flicker;
    }
  }
}
