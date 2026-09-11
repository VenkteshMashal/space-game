import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { armor, lightArmor, dark, metal, copper, black, glass, box, cylinder, hull, stencil, buildGunMount } from './models';
import type { ShipModel } from './models';
import type { ShipClass } from './physics';
import { STOCK_MOUNTS } from './combat';

// Fleet geometry is authored in metres, nose +Y, dorsal +Z. Static plates are batched by material;
// engines, RCS and weapon pivots remain separate so their transforms can follow the simulation.
const teal = new THREE.MeshStandardMaterial({ color: '#326b70', metalness: 0.55, roughness: 0.42 });
const ochre = new THREE.MeshStandardMaterial({ color: '#bc783c', metalness: 0.45, roughness: 0.68 });
const ceramic = new THREE.MeshStandardMaterial({ color: '#8299a9', metalness: 0.65, roughness: 0.35 });
const exhaust = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'varying vec2 vUv; void main(){float a=pow(1.-vUv.y,1.65);float edge=pow(sin(vUv.x*3.14159),.4);gl_FragColor=vec4(mix(vec3(.12,.38,1.),vec3(.78,.97,1.),a),a*edge*.8);}',
});
const glow = new THREE.MeshBasicMaterial({ color: '#a3e9ff', toneMapped: false });
const jetMaterial = new THREE.MeshBasicMaterial({ color: '#c2e9ff', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
for (const material of [teal, ochre, ceramic, exhaust, glow, jetMaterial]) material.userData.shared = true;

function plate(root: THREE.Group, outline: number[][], depth: number, z: number, material: THREE.Material) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.7, bevelThickness: 0.6, bevelSegments: 1 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = z; root.add(mesh);
}

function drive(root: THREE.Group, x: number, y: number, radius: number, flames: THREE.Mesh[]) {
  cylinder(root, metal, radius * 0.65, radius, 13, [x, y + 4, 0]);
  cylinder(root, dark, radius * 0.9, radius * 1.1, 6, [x, y - 5, 0]);
  cylinder(root, black, radius, radius, 0.8, [x, y - 8.2, 0]);
  cylinder(root, glow, radius * 0.72, radius * 0.72, 0.5, [x, y - 8.8, 0]);
  // The base is at the nozzle; scaling length never pulls the flame off its engine.
  const geometry = new THREE.ConeGeometry(radius * 0.83, 36, 12, 1, true);
  geometry.rotateZ(Math.PI); geometry.translate(0, -18, 0);
  const flame = new THREE.Mesh(geometry, exhaust);
  flame.name = 'flame'; flame.userData.effect = true;
  flame.position.set(x, y - 9, 0); flame.visible = false;
  root.add(flame); flames.push(flame);
}

function thrusters(root: THREE.Group, width: number, front: number, back: number, rcs: THREE.Mesh[]) {
  for (const side of [-1, 1]) for (const y of [front, back]) {
    box(root, dark, [3.3, 4.5, 3], [side * width, y, 2]);
    box(root, metal, [0.7, 3, 3.2], [side * (width + 1.8), y, 2]);
    const geometry = new THREE.ConeGeometry(1.2, 9, 6);
    geometry.rotateZ(-side * Math.PI / 2); geometry.translate(side * 4.5, 0, 0);
    const jet = new THREE.Mesh(geometry, jetMaterial);
    jet.position.set(side * (width + 2), y, 2); jet.visible = false;
    jet.name = 'rcs-jet'; jet.userData.effect = true;
    root.add(jet); rcs.push(jet);
  }
}

function batchPlates(root: THREE.Group) {
  const batches = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of root.children) {
    if (!(child instanceof THREE.Mesh) || child.children.length || child.userData.effect || Array.isArray(child.material) || child.material.transparent) continue;
    const meshes = batches.get(child.material) ?? [];
    meshes.push(child); batches.set(child.material, meshes);
  }
  for (const [material, meshes] of batches) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => {
      mesh.updateMatrix();
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      return geometry.applyMatrix4(mesh.matrix);
    });
    const geometry = mergeGeometries(geometries, false);
    geometries.forEach(entry => entry.dispose());
    if (!geometry) continue;
    for (const mesh of meshes) { mesh.geometry.dispose(); mesh.removeFromParent(); }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  }
}

export function buildFleetShip(shipClass: ShipClass): ShipModel {
  const group = new THREE.Group(); group.name = `fleet-${shipClass}`;
  const flames: THREE.Mesh[] = [], rcs: THREE.Mesh[] = [];
  if (shipClass === 'kestrel') {
    // Armored patrol corvette: split prow, swept shoulders, recessed central avionics spine.
    plate(group, [[-9,-32],[-25,-20],[-25,-3],[-14,17],[-10,39],[-3,39],[-3,29],[3,29],[3,39],[10,39],[14,17],[25,-3],[25,-20],[9,-32]], 7, -4, dark);
    for (const side of [-1, 1]) {
      plate(group, [[side*7,-25],[side*22,-17],[side*21,-2],[side*11,28],[side*5,22]], 5, 3, armor);
      box(group, teal, [3, 23, 0.8], [side * 12, 0, 9], -side * 0.25);
      hull(group, 10, 31, 7, lightArmor, side * 16, -19, 1);
      for (let i = 0; i < 5; i++) box(group, black, [7, 1.1, 1], [side * 16, -25 + i * 3, 5.8]);
      drive(group, side * 16, -33, 5.3, flames);
    }
    hull(group, 12, 41, 7, lightArmor, 0, 3, 8);
    hull(group, 8, 14, 3, glass, 0, 18, 12.2);
    box(group, dark, [0.7, 14, 0.8], [0, 18, 14.4]);
    box(group, copper, [7, 9, 1.4], [0, -14, 12]);
    thrusters(group, 24, 5, -22, rcs);
  } else if (shipClass === 'mule') {
    // Salvage tug: exposed load-bearing chassis, external freight and four protected drive bells.
    hull(group, 28, 78, 10, dark, 0, -1, 0);
    for (const side of [-1, 1]) {
      box(group, metal, [3, 66, 4], [side * 15, -5, 0]);
      for (let i = 0; i < 3; i++) {
        const y = -24 + i * 21;
        box(group, ochre, [13, 17, 12], [side * 24, y, 1]);
        box(group, lightArmor, [13.5, 2, 12.6], [side * 24, y - 5, 1]);
        box(group, dark, [13.5, 2, 12.6], [side * 24, y + 5, 1]);
        box(group, black, [8, 0.9, 0.4], [side * 24, y, 7.3]);
        box(group, metal, [11, 4, 3], [side * 16, y, -1]);
      }
      hull(group, 11, 18, 5, armor, side * 18, 30, 2);
      drive(group, side * 10, -38, 5.9, flames);
      drive(group, side * 25, -37, 4.1, flames);
      box(group, copper, [2, 36, 2], [side * 9, -7, 7]);
    }
    hull(group, 22, 22, 9, lightArmor, 0, 24, 9);
    box(group, glass, [17, 4, 2], [0, 29, 14.3]);
    for (const x of [-5, 5]) box(group, dark, [0.9, 5, 2.2], [x, 29, 14.5]);
    box(group, ochre, [12, 34, 3], [0, -12, 7]);
    for (let i = 0; i < 6; i++) box(group, dark, [9, 2, 0.6], [0, -24 + i * 4, 9]);
    thrusters(group, 32, 24, -24, rcs);
  } else {
    // Recon interceptor: long sensor needle and swept radiator blades around one oversized drive.
    plate(group, [[0,47],[-8,17],[-9,-22],[-16,-34],[16,-34],[9,-22],[8,17]], 6, -3, ceramic);
    hull(group, 9, 49, 6, lightArmor, 0, 8, 4);
    hull(group, 6, 18, 3, glass, 0, 17, 8);
    for (const side of [-1, 1]) {
      plate(group, [[side*7,8],[side*22,-25],[side*21,-34],[side*11,-24]], 2, -1, dark);
      box(group, teal, [2, 31, 0.8], [side * 14, -11, 2], side * 0.4);
      for (let i = 0; i < 5; i++) box(group, metal, [5, 0.8, 1], [side * 15, -19 + i * 3, 2]);
      cylinder(group, copper, 0.4, 0.7, 17, [side * 5, 36, 0], 6);
    }
    drive(group, 0, -37, 7, flames);
    thrusters(group, 12, 14, -24, rcs);
  }
  const label = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.6), new THREE.MeshBasicMaterial({ map: stencil(shipClass === 'kestrel' ? 'KSTR / 04' : shipClass === 'mule' ? 'MULE / 12' : 'NDL / 07'), transparent: true, depthWrite: false }));
  label.position.set(0, shipClass === 'mule' ? 19 : 0, shipClass === 'mule' ? 14.3 : shipClass === 'needle' ? 7.8 : 12.5); group.add(label);
  batchPlates(group);
  for (const mount of STOCK_MOUNTS[shipClass]) {
    const gun = buildGunMount(mount.weapon as Parameters<typeof buildGunMount>[0]);
    gun.group.name = 'stock-weapon'; gun.group.position.set(mount.lx, mount.ly, 13);
    group.add(gun.group);
  }
  const light = new THREE.PointLight('#73bdff', 0, 140, 1.4);
  light.position.set(0, -44, 8); group.add(light);
  return { group, flames, rcs, light };
}
