import * as THREE from 'three';
import type { Rounds } from './combat';

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

const tracerPlayer = new THREE.Color('#cfe9ff');
const tracerHostile = new THREE.Color('#ff8f72');

/** Live rounds as one LineSegments draw call: two vertices per round, no per-round Mesh. */
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
    const tail = 0.022;   // seconds of travel drawn behind the round
    for (let i = 0; i < this.max; i++) {
      const o = i * 6;
      if (rounds.life[i] <= 0) { this.positions.fill(0, o, o + 6); continue; }
      this.positions[o] = rounds.x[i]; this.positions[o + 1] = rounds.y[i]; this.positions[o + 2] = 6;
      this.positions[o + 3] = rounds.x[i] - rounds.vx[i] * tail;
      this.positions[o + 4] = rounds.y[i] - rounds.vy[i] * tail;
      this.positions[o + 5] = 6;
      const c = rounds.faction[i] ? tracerHostile : tracerPlayer;
      this.colors[o] = c.r; this.colors[o + 1] = c.g; this.colors[o + 2] = c.b;
      this.colors[o + 3] = c.r * 0.2; this.colors[o + 4] = c.g * 0.2; this.colors[o + 5] = c.b * 0.2;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }

  dispose() { this.lines.geometry.dispose(); (this.lines.material as THREE.Material).dispose(); }
}

const beamVertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const beamFragmentShader = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float d = abs(vUv.y - 0.5) * 2.0;
  gl_FragColor = vec4(mix(vec3(1.0), uColor, d), pow(max(0.0, 1.0 - d), 1.8) * uIntensity);
}`;

/** Beam width in metres; the length comes from the hit so the plane can be a unit quad. */
const BEAM_WIDTH = 7;

const beamMaterial = (color: THREE.ColorRepresentation, intensity: number) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: intensity } },
  vertexShader: beamVertexShader, fragmentShader: beamFragmentShader,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});

/** The mining cutter: one stretched additive plane per live beam, all sharing a geometry and two materials. */
export class BeamPool {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.PlaneGeometry;
  private readonly idle: THREE.ShaderMaterial;
  private readonly hot: THREE.ShaderMaterial;
  private readonly planes: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];

  constructor(max: number) {
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.idle = beamMaterial('#ffb27a', 0.55);
    this.hot = beamMaterial('#ffb27a', 0.95);
    for (let i = 0; i < max; i++) {
      const plane = new THREE.Mesh(this.geometry, this.idle);
      plane.visible = false;
      this.group.add(plane);
      this.planes.push(plane);
    }
    this.group.position.z = 10;
    this.group.renderOrder = 6;
  }

  /** Rebuilds the live beams each frame from the beam hits. */
  sync(beams: { x: number; y: number; ex: number; ey: number; hot: boolean }[]) {
    for (let i = 0; i < this.planes.length; i++) {
      const plane = this.planes[i];
      if (i >= beams.length) { plane.visible = false; continue; }
      const beam = beams[i];
      const dx = beam.ex - beam.x, dy = beam.ey - beam.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-3) { plane.visible = false; continue; }
      plane.visible = true;
      plane.position.set(beam.x + dx * 0.5, beam.y + dy * 0.5, 0);
      plane.rotation.z = Math.atan2(dy, dx);
      plane.scale.set(length, BEAM_WIDTH, 1);
      plane.material = beam.hot ? this.hot : this.idle;
    }
  }

  /** Read-only diagnostic: what each pooled plane is currently drawing. */
  diagnostics() {
    return this.planes.map(plane => ({
      visible: plane.visible,
      x: Math.round(plane.position.x),
      y: Math.round(plane.position.y),
      length: Math.round(plane.scale.x),
      width: Math.round(plane.scale.y),
      hot: plane.material === this.hot,
    }));
  }

  dispose() {
    this.geometry.dispose();
    this.idle.dispose();
    this.hot.dispose();
  }
}

/** Hashy value noise on a 3D position: enough structure for a burning dissolve edge, cheap enough to run per fragment. */
const rockNoise = `
float rockNoise(vec3 p) {
  float n = sin(p.x * 0.55) * sin(p.y * 0.62) * sin(p.z * 0.68);
  n += 0.5 * sin(p.x * 1.9 + 1.7) * sin(p.z * 2.1 + 0.6);
  return clamp(n * 0.67 + 0.5, 0.0, 1.0);
}`;

/**
 * Clones a rock material and injects a dissolve uniform into its shader. `uniform.value` runs 0..1;
 * below 1 a noisy threshold eats fragments away and leaves a glowing char edge behind.
 * The clone shares the base material's textures and must be disposed once the rock is gone.
 */
export function makeDissolveMaterial(base: THREE.Material) {
  const material = (base as THREE.MeshStandardMaterial).clone();
  material.name = 'rock-dissolve';
  const uniform: { value: number } = { value: 0 };
  material.onBeforeCompile = shader => {
    shader.uniforms.uDissolve = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRockPos;
uniform float uDissolve;
${rockNoise}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  float rockN = rockNoise(vRockPos);
  float rockEdge = mix(-0.2, 1.25, uDissolve);
  if (rockN < rockEdge) discard;
  float rockGlow = smoothstep(rockEdge + 0.16, rockEdge, rockN);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += vec3(1.7, 0.6, 0.18) * rockGlow * (0.35 + 0.65 * uDissolve);
  diffuseColor.rgb *= mix(1.0, 0.4, rockGlow);`);
  };
  material.needsUpdate = true;
  return { material, uniform };
}

const shieldVertex = `
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vLocalDir;
void main() {
  vLocalDir = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const shieldFragment = `
uniform float uIntensity;
uniform float uBearing;
uniform vec3 uColor;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying vec3 vLocalDir;
void main() {
  if (uIntensity <= 0.001) discard;
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - clamp(dot(normalize(vWorldNormal), viewDir), 0.0, 1.0), 2.2);
  float facing = clamp(dot(vLocalDir, vec3(cos(uBearing), sin(uBearing), 0.0)), 0.0, 1.0);
  float mask = mix(0.2, 1.0, smoothstep(0.1, 0.95, facing));
  gl_FragColor = vec4(uColor, fres * mask * uIntensity);
}`;

/** One reusable fresnel shell around the player hull. Flashes at a world bearing for ~0.25 s, invisible at rest. */
export class ShieldFlash {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private intensity = 0;
  private bearing = 0;

  constructor(radius = 48) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), new THREE.ShaderMaterial({
      uniforms: {
        uIntensity: { value: 0 },
        uBearing: { value: 0 },
        uColor: { value: new THREE.Color('#8fd0ff') },
      },
      vertexShader: shieldVertex, fragmentShader: shieldFragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  flash(bearing: number) {
    this.bearing = bearing;
    this.intensity = 1;
    this.mesh.visible = true;
  }

  /** Advances the 0.25 s decay; mutates uniforms in place, never allocates. */
  update(dt: number) {
    if (this.intensity <= 0) return;
    this.intensity = Math.max(0, this.intensity - dt / 0.25);
    const uniforms = this.mesh.material.uniforms;
    uniforms.uIntensity.value = this.intensity;
    uniforms.uBearing.value = this.bearing;
    if (this.intensity <= 0) this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
