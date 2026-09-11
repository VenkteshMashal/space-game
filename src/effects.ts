import * as THREE from 'three';

const vertexShader = `
attribute float alpha;
attribute float size;
varying float vAlpha;
void main() {
  vAlpha = alpha;
  gl_PointSize = size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(uColor, pow(max(0.0, 1.0 - d), 1.6) * vAlpha);
}`;

/** Additive point sprites with per-particle velocity, size and lifetime: plumes, sparks and venting gas. */
export class ParticleField {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly alphas: Float32Array;
  private readonly sizes: Float32Array;
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  private readonly drag: number;
  private cursor = 0;

  constructor(count: number, color: THREE.ColorRepresentation, drag = 0.9) {
    this.drag = drag;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.alphas = new Float32Array(count);
    this.sizes = new Float32Array(count);
    this.life = new Float32Array(count);
    this.span = new Float32Array(count);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader, fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, seconds: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.life.length;
    this.positions[i * 3] = x; this.positions[i * 3 + 1] = y; this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx; this.velocities[i * 3 + 1] = vy; this.velocities[i * 3 + 2] = vz;
    this.sizes[i] = size; this.alphas[i] = 1; this.life[i] = seconds; this.span[i] = seconds;
  }

  update(dt: number) {
    const decay = Math.pow(this.drag, dt * 60);
    for (let i = 0; i < this.life.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alphas[i] = 0; continue; }
      this.velocities[i * 3] *= decay; this.velocities[i * 3 + 1] *= decay; this.velocities[i * 3 + 2] *= decay;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      this.alphas[i] = this.life[i] / this.span[i];
    }
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.alpha.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Expanding flat rings used for recovery, docking and collision feedback. */
export class RingWaves {
  readonly group = new THREE.Group();
  private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly life: number[] = [];
  private readonly span: number[] = [];
  private readonly reach: number[] = [];
  private cursor = 0;

  constructor(count: number) {
    const geometry = new THREE.RingGeometry(0.86, 1, 72);
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: '#83b9b5', transparent: true, opacity: 0, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const ring = new THREE.Mesh(geometry, material);
      ring.visible = false;
      this.group.add(ring);
      this.rings.push(ring);
      this.life.push(0); this.span.push(1); this.reach.push(100);
    }
    this.group.renderOrder = 4;
  }

  pulse(x: number, y: number, z: number, color: THREE.ColorRepresentation, radius: number, seconds: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.rings.length;
    const ring = this.rings[i];
    ring.position.set(x, y, z);
    ring.scale.setScalar(radius * 0.25);
    ring.material.color.set(color);
    ring.visible = true;
    this.life[i] = seconds; this.span[i] = seconds; this.reach[i] = radius;
  }

  update(dt: number) {
    for (let i = 0; i < this.rings.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const ring = this.rings[i];
      if (this.life[i] <= 0) { ring.visible = false; ring.material.opacity = 0; continue; }
      const t = 1 - this.life[i] / this.span[i];
      ring.scale.setScalar(this.reach[i] * (0.25 + t * 1.05));
      ring.material.opacity = (1 - t) * 0.75;
    }
  }

  dispose() {
    this.rings[0]?.geometry.dispose();
    for (const ring of this.rings) ring.material.dispose();
  }
}
