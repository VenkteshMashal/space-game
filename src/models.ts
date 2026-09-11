import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { rockyTexture } from './textures';
import { randomSeed } from './physics';
import type { ShipClass } from './physics';

export const armor = new THREE.MeshStandardMaterial({ color: '#bac4c3', roughness: 0.64, metalness: 0.55 });
export const lightArmor = new THREE.MeshStandardMaterial({ color: '#e2e3d8', roughness: 0.52, metalness: 0.4 });
export const dark = new THREE.MeshStandardMaterial({ color: '#202e38', roughness: 0.7, metalness: 0.85 });
export const metal = new THREE.MeshStandardMaterial({ color: '#667681', roughness: 0.5, metalness: 0.86 });
export const copper = new THREE.MeshStandardMaterial({ color: '#c88755', roughness: 0.65, metalness: 0.6 });
export const black = new THREE.MeshStandardMaterial({ color: '#0c141a', roughness: 0.7, metalness: 0.5 });
export const glass = new THREE.MeshStandardMaterial({ color: '#376c7c', roughness: 0.25, metalness: 0.7, emissive: '#306675', emissiveIntensity: 0.6 });
let asteroidMaterial: THREE.MeshStandardMaterial | undefined;

export function box(parent: THREE.Object3D, material: THREE.Material, size: number[], pos: number[], rotation = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.z = rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function cylinder(parent: THREE.Object3D, material: THREE.Material, top: number, bottom: number, height: number, pos: number[], segments = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, segments), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export function hull(parent: THREE.Object3D, width: number, length: number, depth: number, material: THREE.Material, x = 0, y = 0, z = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(-width * 0.34, -length / 2);
  shape.lineTo(-width / 2, -length * 0.3);
  shape.lineTo(-width / 2, length * 0.18);
  shape.lineTo(-width * 0.22, length / 2);
  shape.lineTo(width * 0.22, length / 2);
  shape.lineTo(width / 2, length * 0.18);
  shape.lineTo(width / 2, -length * 0.3);
  shape.lineTo(width * 0.34, -length / 2);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 1.4, bevelThickness: 1.2, bevelSegments: 1, steps: 1 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z - depth / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function stencil(text: string, width = 256, height = 64, color = '#192b32') {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = `600 ${height * 0.67}px Barlow Condensed, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
  return new THREE.CanvasTexture(canvas);
}

export type ShipModel = { group: THREE.Group; flames: THREE.Mesh[]; rcs: THREE.Mesh[]; light: THREE.PointLight };

export function buildShip(shipClass: ShipClass = 'kestrel'): ShipModel {
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [];
  const rcs: THREE.Mesh[] = [];
  const wide = shipClass === 'mule' ? 1.3 : shipClass === 'needle' ? 0.72 : 1;
  hull(group, 24 * wide, 70, 11, dark);
  hull(group, 20 * wide, 49, 10, armor, 0, 10, 5);
  hull(group, 10 * wide, 35, 7, lightArmor, 0, 14, 13);
  hull(group, 9 * wide, 15, 5, dark, 0, 34, 5);
  box(group, glass, [8 * wide, 2.5, 0.6], [0, 25, 17.2]);
  box(group, dark, [0.65, 3.5, 1], [0, 25, 17.7]);

  // Individual armor tiles, service rails and exposed ribs make a working vessel.
  for (const side of [-1, 1]) {
    box(group, metal, [3, 52, 4], [side * 13 * wide, -1, 0]);
    hull(group, 10 * wide, 43, 8, armor, side * 15 * wide, -6, 3);
    for (let i = 0; i < 5; i++) {
      box(group, i % 2 ? armor : lightArmor, [8 * wide, 6.4, 1.6], [side * 15 * wide, -21 + i * 8, 8.3]);
      box(group, black, [5 * wide, 0.6, 0.25], [side * 15 * wide, -21 + i * 8, 9.3]);
    }
    box(group, copper, [8 * wide, 3.8, 1.8], [side * 15 * wide, 7, 9]);
    box(group, copper, [2.8, 19, 1.2], [side * 8 * wide, 9, 12]);
    for (let i = 0; i < 8; i++) {
      box(group, black, [3, 1.15, 1], [side * 6.1 * wide, -20 + i * 2.25, 11]);
    }
    // RCS pods and point defense housings.
    for (const y of [-22, 19]) {
      const pod = box(group, dark, [4.8, 6, 4], [side * 21 * wide, y, 4]);
      box(pod, metal, [1, 4, 4.5], [side * 2.6, 0, 0]);
      const jet = new THREE.Mesh(new THREE.ConeGeometry(1.2, 10, 8), new THREE.MeshBasicMaterial({ color: '#c5f1ff', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
      jet.rotation.z = -side * Math.PI / 2;
      jet.position.set(side * 29 * wide, y, 4);
      jet.visible = false; group.add(jet); rcs.push(jet);
    }
    const gun = cylinder(group, metal, 2.5, 3.1, 5, [side * 10 * wide, 9, 15]);
    gun.rotation.x = Math.PI / 2;
    cylinder(group, black, 0.8, 0.8, 9, [side * 10 * wide, 15, 16], 8);
    // Long radiator panels, heat pipes and engine bells.
    box(group, dark, [6, 20, 2], [side * 12 * wide, -33, -1]);
    for (let i = 0; i < 7; i++) box(group, metal, [6.5, 0.6, 0.7], [side * 12 * wide, -41 + i * 2.6, 0.4]);
    cylinder(group, metal, 4.5, 6.8, 15, [side * 9 * wide, -37, 1]);
    cylinder(group, dark, 5.5, 7.1, 8, [side * 9 * wide, -45, 1]);
    cylinder(group, black, 6.1, 6.1, 0.8, [side * 9 * wide, -49.1, 1]);
    cylinder(group, new THREE.MeshBasicMaterial({ color: '#98d8f5' }), 4.9, 4.9, 0.9, [side * 9 * wide, -49.7, 1]);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(5.5, 45, 20, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 vUv; void main(){float a=pow(1.-vUv.y,1.5);vec3 c=mix(vec3(.22,.43,.88),vec3(.8,.94,1.),a);gl_FragColor=vec4(c,a*.82);}',
    }));
    flame.rotation.z = Math.PI;
    flame.position.set(side * 9 * wide, -70, 1);
    flame.visible = false; group.add(flame); flames.push(flame);
  }
  box(group, lightArmor, [9, 11, 3], [0, -21, 8]);
  box(group, copper, [10, 3.5, 3.2], [0, -22, 8]);
  cylinder(group, metal, 0.45, 0.65, 14, [-6 * wide, 42, 3], 6);
  cylinder(group, metal, 0.45, 0.65, 8, [6 * wide, 40, 3], 6);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(11, 2.7), new THREE.MeshBasicMaterial({ map: stencil(shipClass === 'kestrel' ? 'KSTR / 04' : shipClass.toUpperCase()), transparent: true, depthWrite: false }));
  label.position.set(0, 11, 17.8); group.add(label);
  if (shipClass === 'mule') {
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) box(group, copper, [11, 14, 9], [side * 28, -22 + i * 16, 1]);
  }
  if (shipClass === 'needle') {
    box(group, dark, [4, 50, 2], [-19, -7, -2], -0.17);
    box(group, dark, [4, 50, 2], [19, -7, -2], 0.17);
  }
  const navLight = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), new THREE.MeshBasicMaterial({ color: '#b6f6df' }));
  navLight.position.set(-23 * wide, 18, 6); group.add(navLight);
  const light = new THREE.PointLight('#73bdff', 0, 140, 1.4);
  light.position.set(0, -53, 8); group.add(light);
  return { group, flames, rcs, light };
}

export function buildAsteroid(radius: number, seed: number) {
  const rand = randomSeed(seed);
  const base = new THREE.IcosahedronGeometry(radius, radius > 46 ? 5 : 4);
  base.deleteAttribute('normal');
  const geometry = mergeVertices(base);
  base.dispose();
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const sx = 0.8 + rand() * 0.4, sy = 0.75 + rand() * 0.35;
  const craters = Array.from({ length: 8 }, () => ({
    dir: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
    size: 0.16 + rand() * 0.3,
  }));
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    p.fromBufferAttribute(positions, i).normalize();
    const noise = Math.sin(p.x * 11 + seed) * Math.sin(p.y * 13 - seed) * Math.sin(p.z * 12) * 0.07
      + Math.sin(p.x * 4 + 2) * Math.sin(p.y * 5) * Math.cos(p.z * 3 + seed) * 0.13;
    let craterDepth = 0;
    for (const crater of craters) {
      const d = p.distanceTo(crater.dir) / crater.size;
      if (d < 1) craterDepth -= (1 - d * d) * 0.11;
      if (d > 0.85 && d < 1.2) craterDepth += Math.sin((d - 0.85) / 0.35 * Math.PI) * 0.035;
    }
    const r = radius * (1 + noise + craterDepth);
    const tone = 0.52 + noise * 0.7 + craterDepth * 0.8;
    color.setRGB(tone * 0.97, tone * 0.97, tone * 0.99);
    colors.set([color.r, color.g, color.b], i * 3);
    positions.setXYZ(i, p.x * r * sx, p.y * r * sy, p.z * r * 0.78);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  if (!asteroidMaterial) {
    const surface = rockyTexture(42, 512, 256);
    asteroidMaterial = new THREE.MeshStandardMaterial({ map: surface, bumpMap: surface, bumpScale: 2.9, vertexColors: true, roughness: 0.98, metalness: 0.05 });
  }
  return new THREE.Mesh(geometry, asteroidMaterial);
}

export function buildStation() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(73, 8, 8, 64), metal);
  group.add(ring);
  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(64, 1.2, 6, 64), copper);
  group.add(innerRing);
  cylinder(group, armor, 17, 21, 58, [0, 0, 0]);
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * Math.PI * 2;
    box(group, dark, [4, 61, 6], [Math.sin(angle) * 37, Math.cos(angle) * 37, -2], -angle);
    box(group, lightArmor, [15, 18, 14], [Math.sin(angle) * 73, Math.cos(angle) * 73, 0], -angle);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.8, 6, 6), new THREE.MeshBasicMaterial({ color: '#b7dfdd' }));
    lamp.position.set(Math.sin(angle) * 73, Math.cos(angle) * 73, 9); group.add(lamp);
  }
  for (const side of [-1, 1]) {
    box(group, metal, [150, 3, 3], [side * 72, 0, -12]);
    box(group, new THREE.MeshStandardMaterial({ color: '#203d55', roughness: 0.3, metalness: 0.85 }), [48, 89, 1.7], [side * 112, 0, -10]);
    for (let i = -3; i <= 3; i++) box(group, metal, [48, 0.5, 2], [side * 112, i * 12, -9]);
  }
  return group;
}

export function buildCargo(index: number) {
  const group = new THREE.Group();
  box(group, dark, [13, 18, 11], [0, 0, 0]);
  box(group, index === 1 ? armor : copper, [14, 13, 12], [0, 0, 0]);
  for (const y of [-7, 7]) box(group, metal, [14, 2, 12], [0, y, 0]);
  box(group, glass, [4, 2, 0.5], [0, 3, 6.5]);
  group.rotation.set(0.15, 0.1, 0.4 + index);
  return group;
}

export function disposeObject(object: THREE.Object3D) {
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) child.geometry.dispose();
  });
  object.removeFromParent();
}

export const beaconLampMaterial = new THREE.MeshBasicMaterial({ color: '#dce6e8' });
export const beaconHaloMaterial = new THREE.MeshBasicMaterial({ color: '#83b9b5', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
export const warmLampMaterial = new THREE.MeshBasicMaterial({ color: '#efb879' });
const scorch = new THREE.MeshStandardMaterial({ color: '#181512', roughness: 0.94, metalness: 0.4 });
const rust = new THREE.MeshStandardMaterial({ color: '#5f4132', roughness: 0.92, metalness: 0.45 });

export type BeaconModel = { group: THREE.Group; lamp: THREE.Mesh; halo: THREE.Mesh };

export function buildBeacon(): BeaconModel {
  const group = new THREE.Group();
  cylinder(group, metal, 7, 9, 13, [0, 1, 0], 8);
  cylinder(group, dark, 10, 11, 2, [0, -6.5, 0], 8);
  cylinder(group, copper, 9.3, 9.3, 1.5, [0, 7.1, 0], 8);
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + i * Math.PI / 2;
    box(group, dark, [12, 5.5, 0.7], [Math.cos(angle) * 9, 1 + Math.sin(angle) * 9, 0], angle);
  }
  cylinder(group, metal, 1.1, 3, 7.5, [0, 11.8, 0], 8);
  box(group, lightArmor, [4.4, 2.4, 2.4], [0, 15.6, 0]);
  box(group, metal, [10, 0.5, 0.5], [0, 15.6, 1.2]);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 10), beaconLampMaterial);
  lamp.position.set(0, 17.6, 2.6); group.add(lamp);
  const halo = new THREE.Mesh(new THREE.RingGeometry(2.4, 7, 32), beaconHaloMaterial);
  halo.position.set(0, 17.6, 2.3); group.add(halo);
  return { group, lamp, halo };
}

export type DerelictModel = { group: THREE.Group; lamp: THREE.Mesh; debris: THREE.Mesh[] };

export function buildDerelict(): DerelictModel {
  const group = new THREE.Group();
  const debris: THREE.Mesh[] = [];
  hull(group, 30, 80, 15, dark, 0, 28, 0);
  hull(group, 20, 34, 10, armor, 0, 48, 9);
  const aft = hull(group, 26, 62, 12, metal, -7, -50, 1);
  aft.rotation.z = 0.16;
  hull(group, 16, 26, 8, rust, -10, -72, 6);
  for (let i = 0; i < 12; i++) box(group, i % 3 ? metal : black, [22 - i * 0.6, 1.2, 2.2], [0, -10 - i * 5.4, 7.6]);
  box(group, armor, [18, 26, 1.6], [13, -18, 4], 0.42);
  box(group, lightArmor, [14, 34, 1.4], [-14, -24, 5], -0.6);
  box(group, metal, [20, 22, 1.8], [8, -6, 6], 0.2);
  box(group, rust, [12, 30, 1.2], [-11, -60, 5], 0.9);
  box(group, scorch, [9, 18, 1], [15, -46, 5], -0.35);
  const bell = cylinder(group, metal, 8, 11, 12, [-9, -82, 1]);
  bell.rotation.z = 0.16;
  const cap = cylinder(group, scorch, 11.4, 11.4, 1.2, [-10, -88.4, 1]);
  cap.rotation.z = 0.16;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), warmLampMaterial);
  lamp.position.set(-11, -62, 9); group.add(lamp);
  debris.push(box(group, lightArmor, [16, 24, 1.5], [26, -34, 3], 0.5));
  debris.push(box(group, armor, [14, 20, 1.4], [-32, -16, 4], -0.8));
  return { group, lamp, debris };
}

export const oreShell = new THREE.MeshStandardMaterial({ color: '#6a6258', roughness: 0.95, metalness: 0.12 });
export const oreVein = new THREE.MeshBasicMaterial({ color: '#efb879' });

/** One shared low-poly chunk geometry, instanced by the scene. Ore is decoration around a number. */
export function oreGeometry() {
  const geometry = new THREE.IcosahedronGeometry(7, 0);
  const position = geometry.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    p.multiplyScalar(0.72 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.5);
    position.setXYZ(i, p.x, p.y, p.z * 0.7);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function buildOre() {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(oreGeometry(), oreShell);
  shell.castShadow = true;
  group.add(shell);
  const vein = new THREE.Mesh(new THREE.IcosahedronGeometry(7.6, 0), oreVein);   // pokes through the crust's low spots so the ore reads as ore
  group.add(vein);   // the glowing core reads at 1.4x zoom where the rock silhouette does not
  return group;
}

/** A traversing barrel assembly. `pivot.rotation.z` is driven from Mount.bearing each frame. */
export function buildGunMount(weapon: 'ac20' | 'ac70' | 'gauss' | 'cutter' | 'swarm'): { group: THREE.Group; pivot: THREE.Group } {
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  cylinder(group, dark, 3.4, 4.2, 3, [0, 0, 0], 10);           // barbette
  if (weapon === 'ac20') {
    for (const side of [-1, 1]) {
      const barrel = cylinder(pivot, metal, 0.7, 0.9, 13, [side * 1.5, 6, 1.6], 8);
      barrel.rotation.x = Math.PI / 2;
    }
    box(pivot, armor, [6.4, 6, 3.4], [0, 1, 1.6]);
  } else if (weapon === 'ac70') {
    const barrel = cylinder(pivot, metal, 1.9, 2.4, 21, [0, 9, 2], 10);
    barrel.rotation.x = Math.PI / 2;
    cylinder(pivot, dark, 2.9, 2.9, 3, [0, 17, 2], 10).rotation.x = Math.PI / 2;   // muzzle brake
    box(pivot, armor, [9, 9, 4.6], [0, 0, 2]);
  } else if (weapon === 'gauss') {
    const rail = box(pivot, dark, [3.2, 34, 3.2], [0, 15, 2.4]);
    for (let i = 0; i < 7; i++) box(rail, copper, [4.6, 1.4, 4.6], [0, -14 + i * 4.6, 0]);
    box(pivot, metal, [8, 8, 5], [0, -2, 2.4]);
  } else if (weapon === 'cutter') {
    const head = cylinder(pivot, metal, 2.6, 3.4, 7, [0, 5, 2], 8);
    head.rotation.x = Math.PI / 2;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(2.3, 12), new THREE.MeshBasicMaterial({ color: '#ff9d6b' }));
    lens.position.set(0, 8.6, 2); lens.rotation.x = -Math.PI / 2; pivot.add(lens);
  } else {
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
      box(pivot, i % 2 ? armor : dark, [3, 9, 3], [side * 3.4, 2, 1 + i * 3.2]);
    }
  }
  group.add(pivot);
  return { group, pivot };
}

const hostilePlate = new THREE.MeshStandardMaterial({ color: '#2c2a33', roughness: 0.72, metalness: 0.7 });
const hostileTrim = new THREE.MeshStandardMaterial({ color: '#6d3b38', roughness: 0.6, metalness: 0.75 });
const hostileLamp = new THREE.MeshBasicMaterial({ color: '#df8277' });

export type HostileModel = { group: THREE.Group; flames: THREE.Mesh[]; lamp: THREE.Mesh; turrets: THREE.Group[] };

export function buildRaider(kind: 'raider' | 'interceptor'): HostileModel {
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [];
  const turrets: THREE.Group[] = [];
  const wide = kind === 'interceptor' ? 0.74 : 1;

  // A forward-swept dart: the mirror of the player's blunt, working corvette.
  const shape = new THREE.Shape();
  shape.moveTo(0, 42); shape.lineTo(14 * wide, 4); shape.lineTo(21 * wide, -18);
  shape.lineTo(9 * wide, -30); shape.lineTo(-9 * wide, -30); shape.lineTo(-21 * wide, -18);
  shape.lineTo(-14 * wide, 4); shape.closePath();
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 11, bevelEnabled: true, bevelSize: 1.2, bevelThickness: 1, bevelSegments: 1 }), hostilePlate);
  body.position.z = -5.5; body.castShadow = true; group.add(body);

  box(group, hostileTrim, [7 * wide, 26, 4], [0, 6, 6]);
  box(group, black, [4.5 * wide, 2, 0.6], [0, 22, 8.4]);                 // canopy slit
  for (const side of [-1, 1]) {
    box(group, hostilePlate, [3, 34, 5], [side * 17 * wide, -6, 1], side * 0.22);
    box(group, hostileTrim, [8, 3, 1.4], [side * 13 * wide, 12, 6]);
    const mount = buildGunMount('ac20');
    mount.group.position.set(side * 11 * wide, 9, 7);
    group.add(mount.group); turrets.push(mount.pivot);
    cylinder(group, metal, 3.4, 5, 10, [side * 8 * wide, -33, 0]);       // engine bell
    const flame = new THREE.Mesh(new THREE.ConeGeometry(4, 30, 14, 1, true), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 vUv; void main(){float a=pow(1.-vUv.y,1.5);vec3 c=mix(vec3(.72,.22,.18),vec3(1.,.84,.6),a);gl_FragColor=vec4(c,a*.8);}',
    }));
    flame.rotation.z = Math.PI;
    flame.position.set(side * 8 * wide, -52, 0);
    flame.visible = false; group.add(flame); flames.push(flame);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 8), hostileLamp);
  lamp.position.set(0, 38, 5); group.add(lamp);
  return { group, flames, lamp, turrets };
}

export function buildTurret(): HostileModel {
  const group = new THREE.Group();
  const turrets: THREE.Group[] = [];
  cylinder(group, dark, 15, 19, 6, [0, 0, -4], 10);                  // anchored base
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    box(group, metal, [3.4, 18, 2.4], [Math.cos(a) * 15, Math.sin(a) * 15, -4], -a);
  }
  cylinder(group, hostilePlate, 9, 12, 9, [0, 0, 3], 10);
  const head = buildGunMount('ac70');
  head.group.position.set(0, 0, 9);
  group.add(head.group); turrets.push(head.pivot);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 8), hostileLamp);
  lamp.position.set(0, 0, 15); group.add(lamp);
  return { group, flames: [], lamp, turrets };
}

export function buildMine(): HostileModel {
  const group = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(7, 1), hostilePlate);
  core.castShadow = true; group.add(core);
  // Spikes on the icosahedron's own vertex directions: the shape supplies its own layout.
  const directions = new THREE.IcosahedronGeometry(1, 0).attributes.position;
  const seen = new Set<string>();
  const v = new THREE.Vector3();
  for (let i = 0; i < directions.count; i++) {
    v.fromBufferAttribute(directions, i).normalize();
    const key = v.toArray().map(n => n.toFixed(2)).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(1.1, 6, 6), hostileTrim);
    spike.position.copy(v).multiplyScalar(9);
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    spike.castShadow = true;
    group.add(spike);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(2.1, 10, 10), hostileLamp);
  lamp.position.set(0, 0, 8); group.add(lamp);
  return { group, flames: [], lamp, turrets: [] };
}

const rockCache = new Map<string, THREE.BufferGeometry>();

export function cachedAsteroid(radius: number, seed: number): THREE.Mesh {
  // 12 radius buckets x 16 seeds = at most 192 distinct geometries, and they all get reused.
  const bucket = Math.max(1, Math.round(radius / 8));
  const key = `${bucket}:${seed % 16}`;
  let geometry = rockCache.get(key);
  if (!geometry) { geometry = buildAsteroid(bucket * 8, seed % 16).geometry; rockCache.set(key, geometry); }
  const mesh = new THREE.Mesh(geometry, asteroidMaterial!);
  mesh.scale.setScalar(radius / (bucket * 8));   // exact radius from a shared shape
  return mesh;
}
