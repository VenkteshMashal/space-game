/**
 * Visual pools (Plan A4). A firefight produces hundreds of projectiles, thousands of sparks and a
 * burst of impact lights per minute; allocating a mesh per event stalls frames and leaks GPU
 * memory. Everything here is fixed-capacity and reused.
 *
 * The rule the pools must never break: a pooled *visual* may not hide a *gameplay* entity.
 * `GlyphPool` therefore always hands back a slot — the rich buffer is fixed-size, and anything it
 * cannot hold falls back to a cheap one-point glyph in a second buffer that grows on demand. Only
 * decoration (sparks, marks, lights) is allowed to drop work when its pool is busy.
 */

import * as THREE from 'three';
import { RELEASE } from '../shared/contracts.ts';
import type { Id } from '../shared/contracts.ts';

export interface GlyphHandle {
  readonly id: Id;
  readonly slot: number;
  /** True when this entity is drawn by the overflow buffer instead of the fixed pool. */
  readonly fallback: boolean;
}

/** Additive point sprite shader shared by every pooled point field in the scene. */
function createPointMaterial(perVertexAlpha: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `attribute float size; ${perVertexAlpha ? 'attribute float alpha; varying float vAlpha;' : ''} varying vec3 vColor;
      void main(){ vColor=color; ${perVertexAlpha ? 'vAlpha=alpha;' : ''} gl_PointSize=size; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 vColor; ${perVertexAlpha ? 'varying float vAlpha;' : ''}
      void main(){ float d=length(gl_PointCoord-.5)*2.; gl_FragColor=vec4(vColor, pow(max(0.,1.-d),1.4)*${perVertexAlpha ? 'vAlpha' : '1.'}); }`,
  });
}

function createPointField(capacity: number, size: number, perVertexAlpha: boolean): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(capacity).fill(size), 1));
  if (perVertexAlpha) geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(capacity), 1));
  geometry.setDrawRange(0, 0);
  const points = new THREE.Points(geometry, createPointMaterial(perVertexAlpha));
  points.frustumCulled = false;
  return points;
}

/**
 * Pooled projectile glyphs. Primary slots are rich points sized and coloured per weapon state;
 * overflow glyphs are one more point each in a buffer that doubles when it fills, so the visual
 * never starves a live round.
 */
export class GlyphPool {
  readonly object = new THREE.Group();

  private readonly primary: THREE.Points;
  private readonly primaryCapacity: number;
  private readonly primaryPos: Float32Array;
  private readonly primaryCol: Float32Array;
  private readonly primarySize: Float32Array;
  private readonly free: number[] = [];
  private primaryHigh = 0;

  private overflow: THREE.Points;
  private overflowCapacity: number;
  private overflowPos: Float32Array;
  private overflowCol: Float32Array;
  private overflowSize: Float32Array;
  /** Slot -> entity, plus the free list: holes stay in the draw range at size 0. */
  private overflowIds: (Id | null)[] = [];
  private readonly overflowFree: number[] = [];

  private readonly slots = new Map<Id, { slot: number; fallback: boolean; seen: number }>();
  private frame = 0;

  constructor(capacity: number = RELEASE.maxProjectiles, fallbackCapacity = 64) {
    this.primaryCapacity = Math.max(1, capacity);
    this.primary = createPointField(this.primaryCapacity, 2.6, false);
    this.primaryPos = this.primary.geometry.getAttribute('position').array as Float32Array;
    this.primaryCol = this.primary.geometry.getAttribute('color').array as Float32Array;
    this.primarySize = this.primary.geometry.getAttribute('size').array as Float32Array;
    for (let slot = this.primaryCapacity - 1; slot >= 0; slot--) this.free.push(slot);

    this.overflowCapacity = Math.max(1, fallbackCapacity);
    this.overflow = createPointField(this.overflowCapacity, 2.2, false);
    this.overflowPos = this.overflow.geometry.getAttribute('position').array as Float32Array;
    this.overflowCol = this.overflow.geometry.getAttribute('color').array as Float32Array;
    this.overflowSize = this.overflow.geometry.getAttribute('size').array as Float32Array;

    this.object.add(this.primary, this.overflow);
  }

  get count(): number {
    return this.slots.size;
  }

  get primaryCount(): number {
    return this.primaryCapacity - this.free.length;
  }

  get fallbackCount(): number {
    return this.overflowIds.length - this.overflowFree.length;
  }

  /** Entity ids currently drawn; diagnostics only, the render loop never iterates this. */
  ids(): Id[] {
    return [...this.slots.keys()];
  }

  beginFrame(): number {
    this.frame += 1;
    return this.frame;
  }

  /** Always succeeds: the entity is drawn from fallback capacity when the fixed pool is full. */
  ensure(id: Id): GlyphHandle {
    const existing = this.slots.get(id);
    if (existing) {
      existing.seen = this.frame;
      return { id, slot: existing.slot, fallback: existing.fallback };
    }
    const slot = this.free.pop();
    if (slot !== undefined) {
      const handle: GlyphHandle = { id, slot, fallback: false };
      this.slots.set(id, { slot, fallback: false, seen: this.frame });
      if (slot + 1 > this.primaryHigh) this.primaryHigh = slot + 1;
      return handle;
    }
    const recycled = this.overflowFree.pop();
    let overflowSlot = recycled;
    if (overflowSlot === undefined) {
      overflowSlot = this.overflowIds.length;
      if (overflowSlot >= this.overflowCapacity) this.growOverflow();
      this.overflowIds.push(id);
    } else {
      this.overflowIds[overflowSlot] = id;
    }
    this.slots.set(id, { slot: overflowSlot, fallback: true, seen: this.frame });
    return { id, slot: overflowSlot, fallback: true };
  }

  set(id: Id, x: number, y: number, z: number, size: number, color: THREE.ColorRepresentation): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const color3 = colorToThree.set(color);
    if (slot.fallback) {
      this.overflowPos[slot.slot * 3] = x;
      this.overflowPos[slot.slot * 3 + 1] = y;
      this.overflowPos[slot.slot * 3 + 2] = z;
      this.overflowCol[slot.slot * 3] = color3.r;
      this.overflowCol[slot.slot * 3 + 1] = color3.g;
      this.overflowCol[slot.slot * 3 + 2] = color3.b;
      this.overflowSize[slot.slot] = size;
      this.overflow.geometry.setDrawRange(0, this.overflowIds.length);
      flagAttributes(this.overflow);
      return;
    }
    this.primaryPos[slot.slot * 3] = x;
    this.primaryPos[slot.slot * 3 + 1] = y;
    this.primaryPos[slot.slot * 3 + 2] = z;
    this.primaryCol[slot.slot * 3] = color3.r;
    this.primaryCol[slot.slot * 3 + 1] = color3.g;
    this.primaryCol[slot.slot * 3 + 2] = color3.b;
    this.primarySize[slot.slot] = size;
    this.primary.geometry.setDrawRange(0, this.primaryHigh);
    flagAttributes(this.primary);
  }

  release(id: Id): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    this.slots.delete(id);
    if (slot.fallback) {
      this.overflowIds[slot.slot] = null;
      this.overflowFree.push(slot.slot);
      this.overflowSize[slot.slot] = 0;
      this.overflow.geometry.setDrawRange(0, this.overflowIds.length);
      flagAttributes(this.overflow);
      return true;
    }
    this.primarySize[slot.slot] = 0;
    this.free.push(slot.slot);
    flagAttributes(this.primary);
    return true;
  }

  /** Release everything the current frame did not touch. No set allocation, no id cross-product. */
  releaseUnseen(): number {
    let released = 0;
    for (const [id, slot] of this.slots) {
      if (slot.seen === this.frame) continue;
      this.release(id);
      released += 1;
    }
    return released;
  }

  clear(): void {
    for (const id of [...this.slots.keys()]) this.release(id);
    this.primaryHigh = 0;
    this.overflowIds.length = 0;
    this.overflowFree.length = 0;
    this.primary.geometry.setDrawRange(0, 0);
    this.overflow.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.slots.clear();
    this.free.length = 0;
    this.overflowIds.length = 0;
    this.overflowFree.length = 0;
    this.object.removeFromParent();
    disposePointField(this.primary);
    disposePointField(this.overflow);
    this.object.clear();
  }

  private growOverflow(): void {
    const next = this.overflowCapacity * 2;
    const pos = new Float32Array(next * 3);
    const col = new Float32Array(next * 3);
    const size = new Float32Array(next);
    pos.set(this.overflowPos);
    col.set(this.overflowCol);
    size.set(this.overflowSize);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geometry.setDrawRange(0, this.overflowIds.length);
    this.overflow.geometry.dispose();
    this.overflow.geometry = geometry;
    this.overflowCapacity = next;
    this.overflowPos = pos;
    this.overflowCol = col;
    this.overflowSize = size;
  }
}

const colorToThree = new THREE.Color();

function flagAttributes(points: THREE.Points): void {
  for (const attribute of Object.values(points.geometry.attributes)) attribute.needsUpdate = true;
}

function disposePointField(points: THREE.Points): void {
  points.geometry.dispose();
  const material = points.material;
  for (const entry of Array.isArray(material) ? material : [material]) entry.dispose();
}

/**
 * Short-lived additive sparks: weapon hits, rock debris and muzzle flash. Decorative, so a full
 * pool drops the newest burst instead of stealing a slot from a live one, and low tier simply runs
 * a smaller ring.
 */
export class ParticleField {
  readonly object: THREE.Points;

  private capacity: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private readonly tint = new THREE.Color();
  private live = 0;

  constructor(capacity = 500) {
    this.capacity = Math.max(1, capacity);
    this.object = createPointField(this.capacity, 3.4, true);
    this.pos = this.object.geometry.getAttribute('position').array as Float32Array;
    this.col = this.object.geometry.getAttribute('color').array as Float32Array;
    this.size = this.object.geometry.getAttribute('size').array as Float32Array;
    this.alpha = this.object.geometry.getAttribute('alpha').array as Float32Array;
    this.vel = new Float32Array(this.capacity * 3);
    this.life = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.size[i] = 3.4;
  }

  get capacitySize(): number {
    return this.capacity;
  }

  get liveCount(): number {
    return this.live;
  }

  /** Tier change: reallocate the ring. In-flight sparks are decoration and simply drop. */
  setCapacity(next: number): void {
    const capacity = Math.max(1, Math.floor(next));
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(capacity * 3);
    const col = new Float32Array(capacity * 3);
    const size = new Float32Array(capacity).fill(3.4);
    const alpha = new Float32Array(capacity);
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    geometry.setDrawRange(0, 0);
    this.object.geometry.dispose();
    this.object.geometry = geometry;
    this.pos = pos;
    this.col = col;
    this.size = size;
    this.alpha = alpha;
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.next = 0;
    this.live = 0;
  }

  emit(x: number, y: number, count: number, color: THREE.ColorRepresentation, speed: number): void {
    this.tint.set(color);
    for (let i = 0; i < count; i++) {
      const slot = this.next;
      this.next = (this.next + 1) % this.capacity;
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.pos[slot * 3] = x;
      this.pos[slot * 3 + 1] = y;
      this.pos[slot * 3 + 2] = 6;
      this.vel[slot * 3] = Math.cos(angle) * v;
      this.vel[slot * 3 + 1] = Math.sin(angle) * v;
      this.vel[slot * 3 + 2] = 0;
      this.col[slot * 3] = this.tint.r;
      this.col[slot * 3 + 1] = this.tint.g;
      this.col[slot * 3 + 2] = this.tint.b;
      this.size[slot] = 2 + Math.random() * 3;
      this.alpha[slot] = 1;
      this.life[slot] = 0.42 + Math.random() * 0.28;
    }
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    const drag = 1 - Math.min(0.9, step * 4);
    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= step;
      live += 1;
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * step;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * step;
      this.alpha[i] = Math.max(0, Math.min(1, this.life[i]! * 3));
      this.size[i] = 3.4 * Math.max(0.2, Math.min(1, this.life[i]! * 2));
    }
    this.live = live;
    this.object.geometry.setDrawRange(0, this.capacity);
    flagAttributes(this.object);
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
    this.live = 0;
    this.object.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.object.removeFromParent();
    disposePointField(this.object);
    this.object.clear();
  }
}

/**
 * Pooled impact lights. A light is decoration, so when every slot is busy the oldest flash is
 * recycled rather than allocating another light for one frame of the firefight.
 */
export class ImpactLights {
  private readonly lights: THREE.PointLight[] = [];
  private readonly life: Float32Array;
  private readonly peak: Float32Array;

  constructor(parent: THREE.Object3D, count = 8) {
    this.life = new Float32Array(count);
    this.peak = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight('#ffd9a0', 0, 140, 1.6);
      light.visible = false;
      parent.add(light);
      this.lights.push(light);
    }
  }

  get size(): number {
    return this.lights.length;
  }

  flash(x: number, y: number, z: number, intensity: number, color: THREE.ColorRepresentation, ttlS = 0.18): void {
    let slot = 0;
    for (let i = 1; i < this.lights.length; i++) if (this.life[i]! < this.life[slot]!) slot = i;
    const light = this.lights[slot]!;
    light.position.set(x, y, z);
    light.color.set(color);
    light.intensity = intensity;
    light.visible = true;
    this.peak[slot] = intensity;
    this.life[slot] = ttlS;
  }

  update(dt: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] -= dt;
      const fade = Math.max(0, this.life[i]! / 0.18);
      const light = this.lights[i]!;
      light.intensity = this.peak[i]! * fade;
      if (this.life[i]! <= 0) {
        light.intensity = 0;
        light.visible = false;
      }
    }
  }

  clear(): void {
    this.life.fill(0);
    for (const light of this.lights) {
      light.intensity = 0;
      light.visible = false;
    }
  }

  dispose(): void {
    for (const light of this.lights) {
      light.intensity = 0;
      light.removeFromParent();
    }
    this.lights.length = 0;
  }
}

/**
 * Local damage marks: one small quad per recent hit, each with its own material so fading one mark
 * can never dim every ship in the fight (A4: no shared emissive mutation).
 */
export class ImpactMarks {
  private readonly marks: THREE.Mesh[] = [];
  private readonly life: Float32Array;
  private readonly ttl: Float32Array;
  private next = 0;
  private readonly geometry: THREE.PlaneGeometry;

  constructor(parent: THREE.Object3D, count = 24) {
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.life = new Float32Array(count);
    this.ttl = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({ color: '#1b1410', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const mark = new THREE.Mesh(this.geometry, material);
      mark.visible = false;
      mark.renderOrder = 2;
      parent.add(mark);
      this.marks.push(mark);
    }
  }

  get size(): number {
    return this.marks.length;
  }

  mark(x: number, y: number, z: number, sizeM: number, color: THREE.ColorRepresentation, ttlS = 6): void {
    const slot = this.next;
    this.next = (this.next + 1) % this.marks.length;
    const mesh = this.marks[slot]!;
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(sizeM);
    (mesh.material as THREE.MeshBasicMaterial).color.set(color);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    mesh.visible = true;
    this.ttl[slot] = ttlS;
    this.life[slot] = ttlS;
  }

  update(dt: number, camera: THREE.Camera): void {
    for (let i = 0; i < this.marks.length; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] -= dt;
      const mesh = this.marks[i]!;
      if (this.life[i]! <= 0) {
        mesh.visible = false;
        (mesh.material as THREE.MeshBasicMaterial).opacity = 0;
        continue;
      }
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.min(1, this.life[i]! / (this.ttl[i]! * 0.4));
      mesh.quaternion.copy(camera.quaternion);
    }
  }

  clear(): void {
    this.life.fill(0);
    for (const mark of this.marks) {
      mark.visible = false;
      (mark.material as THREE.MeshBasicMaterial).opacity = 0;
    }
  }

  dispose(): void {
    for (const mark of this.marks) {
      mark.removeFromParent();
      const material = mark.material;
      for (const entry of Array.isArray(material) ? material : [material]) entry.dispose();
    }
    this.marks.length = 0;
    this.geometry.dispose();
  }
}
