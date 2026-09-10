import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { rockyTexture } from './textures';
import { defaultLoadout, randomSeed } from './physics';
import type { Loadout, ShipClass } from './physics';

const armor = new THREE.MeshStandardMaterial({ color: '#bac4c3', roughness: 0.64, metalness: 0.55 });
const lightArmor = new THREE.MeshStandardMaterial({ color: '#e2e3d8', roughness: 0.52, metalness: 0.4 });
const dark = new THREE.MeshStandardMaterial({ color: '#202e38', roughness: 0.7, metalness: 0.85 });
const metal = new THREE.MeshStandardMaterial({ color: '#667681', roughness: 0.5, metalness: 0.86 });
const copper = new THREE.MeshStandardMaterial({ color: '#c88755', roughness: 0.65, metalness: 0.6 });
const black = new THREE.MeshStandardMaterial({ color: '#0c141a', roughness: 0.7, metalness: 0.5 });
const glass = new THREE.MeshStandardMaterial({ color: '#376c7c', roughness: 0.25, metalness: 0.7, emissive: '#306675', emissiveIntensity: 0.6 });
let asteroidMaterial: THREE.MeshStandardMaterial | undefined;

function box(parent: THREE.Object3D, material: THREE.Material, size: number[], pos: number[], rotation = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.z = rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent: THREE.Object3D, material: THREE.Material, top: number, bottom: number, height: number, pos: number[], segments = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, segments), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function hull(parent: THREE.Object3D, width: number, length: number, depth: number, material: THREE.Material, x = 0, y = 0, z = 0) {
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

function stencil(text: string, width = 256, height = 64, color = '#192b32') {
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

export function buildShip(ship: Loadout | ShipClass = 'kestrel'): ShipModel {
  const loadout = typeof ship === 'string' ? defaultLoadout(ship) : ship;
  const shipClass = loadout.chassis;
  const group = new THREE.Group();
  const flames: THREE.Mesh[] = [];
  const rcs: THREE.Mesh[] = [];
  const wide = shipClass === 'mule' ? 1.3 : shipClass === 'needle' ? 0.72 : 1;
  // Per-ship material, so it is marked owned and disposed with the model.
  const skin = new THREE.MeshStandardMaterial({ color: loadout.color, roughness: 0.52, metalness: 0.4 });
  skin.userData.owned = true;
  hull(group, 24 * wide, 70, 11, dark);
  hull(group, 20 * wide, 49, 10, armor, 0, 10, 5);
  hull(group, 10 * wide, 35, 7, skin, 0, 14, 13);
  hull(group, 9 * wide, 15, 5, dark, 0, 34, 5);
  box(group, glass, [8 * wide, 2.5, 0.6], [0, 25, 17.2]);
  box(group, dark, [0.65, 3.5, 1], [0, 25, 17.7]);

  // Individual armor tiles, service rails and exposed ribs make a working vessel.
  for (const side of [-1, 1]) {
    box(group, metal, [3, 52, 4], [side * 13 * wide, -1, 0]);
    hull(group, 10 * wide, 43, 8, skin, side * 15 * wide, -6, 3);
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
    const pod = 5 + loadout.thrustPts * 1.6;                       // a fitted ship looks fitted
    const gun = cylinder(group, metal, 2.5, 3.1, pod, [side * 10 * wide, 9, 15]);
    gun.rotation.x = Math.PI / 2;
    cylinder(group, black, 0.8, 0.8, pod * 1.8, [side * 10 * wide, 15, 16], 8);
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
  const base = new THREE.IcosahedronGeometry(radius, 5);
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
    const material = (child as THREE.Mesh).material;
    if (material) for (const m of Array.isArray(material) ? material : [material]) if (m.userData.owned) m.dispose();
  });
  object.removeFromParent();
}
