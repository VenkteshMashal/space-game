import * as THREE from 'three';
import {
  armor, beaconHaloMaterial, beaconLampMaterial, black, box, buildGunMount, copper, cylinder,
  dark, glass, hull, lightArmor, metal,
} from './models';

export type PartCategory = 'engine' | 'tank' | 'weapon' | 'cargo' | 'armor' | 'wing' | 'rcs' | 'utility';

/** Hull-local frame matches `buildShip`: +y is the nose, +z is dorsal, +x is starboard. */
export type Hardpoint = {
  id: string;
  x: number; y: number; z: number;
  angle: number;
  accepts: PartCategory[];
  scale?: number;
  mirrorOf?: string;
  label: string;
};

export type Core = {
  id: string; name: string; blurb: string;
  mass: number; hull: number; torque: number;
  /** Heat shed per second before any radiator wing is bolted on. */
  cooling: number;
  cost: number;
  hardpoints: Hardpoint[];
  build: (root: THREE.Group) => void;
};

export type Part = {
  id: string; name: string; category: PartCategory; blurb: string;
  mass: number;
  cost: number;
  thrust?: number;
  torque?: number;
  fuel?: number;
  hull?: number;
  cargo?: number;
  cooling?: number;
  weapon?: string;
  build: (root: THREE.Group) => void;
};

/** Weapon keys are the ones `buildGunMount` accepts — the same five in `WEAPONS`. */
type WeaponId = Parameters<typeof buildGunMount>[0];

// ---------------------------------------------------------------------------
// Materials shared by every instance of a part. A build can bolt on a dozen
// engines; each one must not mint its own copy of these.
// ---------------------------------------------------------------------------

const bellGlow = new THREE.MeshBasicMaterial({ color: '#98d8f5' });
const jetMaterial = new THREE.MeshBasicMaterial({
  color: '#c5f1ff', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
});
const radiatorPanel = new THREE.MeshStandardMaterial({ color: '#203d55', roughness: 0.3, metalness: 0.85 });
/** `metal` with the back faces visible so the collector funnel reads as a cone, not a shell. */
const collectorShell = new THREE.MeshStandardMaterial({ color: '#667681', roughness: 0.5, metalness: 0.86, side: THREE.DoubleSide });

let exhaustShader: THREE.ShaderMaterial | undefined;

/** The stock engine plume, shared by every pod. */
function exhaustMaterial(): THREE.ShaderMaterial {
  if (!exhaustShader) {
    exhaustShader = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec2 vUv; void main(){float a=pow(1.-vUv.y,1.5);vec3 c=mix(vec3(.22,.43,.88),vec3(.8,.94,1.),a);gl_FragColor=vec4(c,a*.82);}',
    });
  }
  return exhaustShader;
}

// ---------------------------------------------------------------------------
// Part geometry. Curried so a size is a number, not five near-identical builders.
// ---------------------------------------------------------------------------

export const enginePod = (size: number) => (root: THREE.Group) => {
  cylinder(root, metal, 3.6 * size, 5.4 * size, 13 * size, [0, 4 * size, 0]);
  cylinder(root, dark, 4.6 * size, 6.2 * size, 7 * size, [0, -4 * size, 0]);
  cylinder(root, black, 5.4 * size, 5.4 * size, 0.8, [0, -8 * size, 0]);
  cylinder(root, bellGlow, 4.3 * size, 4.3 * size, 0.9, [0, -8.6 * size, 0]);
  for (let i = 0; i < 5; i++) box(root, copper, [5.6 * size, 0.6, 0.7], [0, 8 + i * 2.4, 2.6 * size]);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(4.4 * size, 38 * size, 18, 1, true), exhaustMaterial());
  flame.name = 'flame';                        // the assembler finds it by name
  flame.rotation.z = Math.PI;
  flame.position.set(0, -28 * size, 0);
  flame.visible = false;
  root.add(flame);
};

export const tankPod = (size: number) => (root: THREE.Group) => {
  const shell = new THREE.Mesh(new THREE.CapsuleGeometry(6.5 * size, 17 * size, 4, 14), lightArmor);
  shell.castShadow = true;
  root.add(shell);
  for (const y of [-7 * size, 0, 7 * size]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(6.7 * size, 0.5, 6, 20), metal);
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    band.castShadow = true;
    root.add(band);
  }
  box(root, copper, [2.2, 5, 2.2], [0, -13 * size, 0]);   // feed line
};

export const gunPart = (weapon: WeaponId) => (root: THREE.Group) => {
  const { group, pivot } = buildGunMount(weapon);
  pivot.name = 'turret-pivot';
  root.add(group);
};

export const cargoPod = () => (root: THREE.Group) => {
  box(root, dark, [15, 22, 13], [0, 0, 0]);
  box(root, copper, [16, 16, 14], [0, 0, 0]);
  for (const y of [-8, 8]) box(root, metal, [16.5, 2, 14.5], [0, y, 0]);
  // The fill indicator is per pod, so a hold can brighten it as ore accumulates.
  const fill = new THREE.Mesh(new THREE.BoxGeometry(5, 2, 0.5), glass.clone());
  fill.position.set(0, 4, 7.6);
  fill.name = 'cargo-fill';
  root.add(fill);
};

export const armorTile = () => (root: THREE.Group) => {
  for (let i = 0; i < 3; i++) {
    box(root, i % 2 ? armor : lightArmor, [11, 7.4, 1.8], [0, -7.4 + i * 7.4, 0]);
    box(root, black, [7, 0.6, 0.3], [0, -7.4 + i * 7.4, 1.1]);
  }
};

export const radiatorWing = () => (root: THREE.Group) => {
  const panel = box(root, radiatorPanel, [3, 44, 1.6], [0, -6, 0]);
  panel.rotation.z = 0.1;
  for (let i = -4; i <= 4; i++) box(panel, metal, [3.6, 0.5, 2], [0, i * 4.6, 0]);
  box(root, dark, [5, 8, 3], [0, 14, 0]);                // root fitting
};

export const rcsPod = () => (root: THREE.Group) => {
  const pod = box(root, dark, [5, 6.2, 4.2], [0, 0, 0]);
  for (const side of [-1, 1]) {
    box(pod, metal, [1, 4, 4.6], [side * 2.8, 0, 0]);
    const jet = new THREE.Mesh(new THREE.ConeGeometry(1.2, 10, 8), jetMaterial);
    jet.name = 'rcs-jet';
    jet.rotation.z = -side * Math.PI / 2;
    jet.position.set(side * 8, 0, 0);
    jet.visible = false;
    root.add(jet);
  }
};

export const scanMast = () => (root: THREE.Group) => {
  cylinder(root, metal, 0.7, 1.1, 16, [0, 6, 0], 6);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), lightArmor);
  dish.position.set(0, 15, 0);
  dish.rotation.x = -0.5;
  dish.castShadow = true;
  root.add(dish);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), beaconLampMaterial);
  lamp.position.set(0, 15, 3);
  root.add(lamp);
};

export const collector = () => (root: THREE.Group) => {
  const funnel = new THREE.Mesh(new THREE.ConeGeometry(11, 14, 16, 1, true), collectorShell);
  funnel.rotation.x = Math.PI / 2;
  funnel.position.set(0, 7, 0);
  funnel.castShadow = true;
  root.add(funnel);
  const field = new THREE.Mesh(new THREE.RingGeometry(6, 11, 24), beaconHaloMaterial);
  field.position.set(0, 14, 0);
  field.rotation.x = -Math.PI / 2;
  root.add(field);
};

// ---------------------------------------------------------------------------
// Hardpoints. Every left/right pair points `mirrorOf` at its other half and
// shares a label root, so the builder installs and removes the pair in one click.
// ---------------------------------------------------------------------------

export const CORES: Record<string, Core> = {
  spar: {
    id: 'spar', name: 'Spar', blurb: 'A bare girder with a cockpit bolted to it. Fast, fragile, cheap.',
    mass: 18000, hull: 42, torque: 1.05, cooling: 0.032, cost: 2400,
    hardpoints: [
      { id: 'port-engine-1', x: -7, y: -28, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'starboard-engine-1', label: 'port-engine-1' },
      { id: 'starboard-engine-1', x: 7, y: -28, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'port-engine-1', label: 'starboard-engine-1' },
      { id: 'port-tank-1', x: -6, y: -6, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'starboard-tank-1', label: 'port-tank-1' },
      { id: 'starboard-tank-1', x: 6, y: -6, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'port-tank-1', label: 'starboard-tank-1' },
      { id: 'port-gun-1', x: -8.5, y: 24, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-1', label: 'port-gun-1' },
      { id: 'starboard-gun-1', x: 8.5, y: 24, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-1', label: 'starboard-gun-1' },
      { id: 'port-gun-2', x: -9, y: 8, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-2', label: 'port-gun-2' },
      { id: 'starboard-gun-2', x: 9, y: 8, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-2', label: 'starboard-gun-2' },
      { id: 'port-wing-1', x: -13, y: -8, z: 0, angle: 0, accepts: ['wing', 'utility'], scale: 1.2, mirrorOf: 'starboard-wing-1', label: 'port-wing-1' },
      { id: 'starboard-wing-1', x: 13, y: -8, z: 0, angle: 0, accepts: ['wing', 'utility'], scale: 1.2, mirrorOf: 'port-wing-1', label: 'starboard-wing-1' },
      { id: 'port-rcs-1', x: -8, y: -16, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'starboard-rcs-1', label: 'port-rcs-1' },
      { id: 'starboard-rcs-1', x: 8, y: -16, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'port-rcs-1', label: 'starboard-rcs-1' },
    ],
    build: (root) => {
      box(root, dark, [6, 58, 6], [0, 0, 0]);                          // the girder itself
      for (let i = -2; i <= 2; i++) box(root, metal, [11, 2.4, 2.4], [0, i * 11, 0]);   // ribs
      box(root, armor, [9, 12, 7], [0, 16, 2]);                        // cockpit block
      box(root, glass, [6, 2, 1.2], [0, 19, 6.2]);                     // canopy
      box(root, black, [16, 5, 5], [0, -24, 0]);                       // engine crossbar
      box(root, copper, [5, 10, 5], [0, -30, 0]);                      // tail fitting
      box(root, black, [13, 4, 3], [0, 10, 4]);                        // avionics
    },
  },

  truss: {
    id: 'truss', name: 'Truss', blurb: 'The workhorse frame: an open lattice that swallows whatever you bolt to it.',
    mass: 34000, hull: 92, torque: 1.35, cooling: 0.05, cost: 6400,
    hardpoints: [
      { id: 'port-engine-1', x: -8, y: -30, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'starboard-engine-1', label: 'port-engine-1' },
      { id: 'starboard-engine-1', x: 8, y: -30, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'port-engine-1', label: 'starboard-engine-1' },
      { id: 'centre-engine', x: 0, y: -36, z: 0, angle: 0, accepts: ['engine'], label: 'centre-engine' },
      { id: 'port-tank-1', x: -7, y: -6, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'starboard-tank-1', label: 'port-tank-1' },
      { id: 'starboard-tank-1', x: 7, y: -6, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'port-tank-1', label: 'starboard-tank-1' },
      { id: 'centre-tank', x: 0, y: 6, z: 0, angle: 0, accepts: ['tank'], label: 'centre-tank' },
      { id: 'port-gun-1', x: -9, y: 26, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-1', label: 'port-gun-1' },
      { id: 'starboard-gun-1', x: 9, y: 26, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-1', label: 'starboard-gun-1' },
      { id: 'port-gun-2', x: -12, y: 12, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-2', label: 'port-gun-2' },
      { id: 'starboard-gun-2', x: 12, y: 12, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-2', label: 'starboard-gun-2' },
      { id: 'port-gun-3', x: -12, y: -2, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-3', label: 'port-gun-3' },
      { id: 'starboard-gun-3', x: 12, y: -2, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-3', label: 'starboard-gun-3' },
      { id: 'port-cargo-1', x: -14.5, y: -18, z: 0, angle: 0, accepts: ['cargo', 'utility'], scale: 1.15, mirrorOf: 'starboard-cargo-1', label: 'port-cargo-1' },
      { id: 'starboard-cargo-1', x: 14.5, y: -18, z: 0, angle: 0, accepts: ['cargo', 'utility'], scale: 1.15, mirrorOf: 'port-cargo-1', label: 'starboard-cargo-1' },
      { id: 'armor-top-1', x: 0, y: 16, z: 7, angle: 0, accepts: ['armor'], label: 'armor-top-1' },
      { id: 'armor-top-2', x: 0, y: 2, z: 7, angle: 0, accepts: ['armor'], label: 'armor-top-2' },
      { id: 'armor-belly-1', x: 0, y: 12, z: -7, angle: 0, accepts: ['armor'], label: 'armor-belly-1' },
      { id: 'armor-belly-2', x: 0, y: -2, z: -7, angle: 0, accepts: ['armor'], label: 'armor-belly-2' },
      { id: 'port-wing-1', x: -16.5, y: 4, z: 0, angle: 0, accepts: ['wing', 'utility'], scale: 1.2, mirrorOf: 'starboard-wing-1', label: 'port-wing-1' },
      { id: 'starboard-wing-1', x: 16.5, y: 4, z: 0, angle: 0, accepts: ['wing', 'utility'], scale: 1.2, mirrorOf: 'port-wing-1', label: 'starboard-wing-1' },
      { id: 'port-rcs-1', x: -11, y: 20, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'starboard-rcs-1', label: 'port-rcs-1' },
      { id: 'starboard-rcs-1', x: 11, y: 20, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'port-rcs-1', label: 'starboard-rcs-1' },
      { id: 'port-rcs-2', x: -9, y: -22, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'starboard-rcs-2', label: 'port-rcs-2' },
      { id: 'starboard-rcs-2', x: 9, y: -22, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'port-rcs-2', label: 'starboard-rcs-2' },
    ],
    build: (root) => {
      hull(root, 14.4, 42, 6.6, dark);                                 // 60% of the stock spine
      hull(root, 12, 29.4, 6, armor, 0, 6, 3);                         // and its upper hull
      for (const side of [-1, 1]) {
        box(root, metal, [2.6, 50, 2.6], [side * 11.5, -2, 0]);        // longeron
        for (let i = -2; i <= 2; i++) {
          box(root, dark, [11.5, 2, 2], [side * 5.75, i * 12, 0]);     // cross tie
          box(root, metal, [1.6, 13, 1.6], [side * 11.5, i * 12 + 6, 0], side * 0.5);   // diagonal
        }
      }
      box(root, black, [9, 14, 7], [0, 30, 0]);                        // prow fitting
      box(root, copper, [13, 5, 5], [0, -32, 0]);                      // engine rail
    },
  },

  keel: {
    id: 'keel', name: 'Keel', blurb: 'A wide slab with a stepped prow. Slow, tough, and it carries a refinery.',
    mass: 62000, hull: 165, torque: 1.05, cooling: 0.06, cost: 14500,
    hardpoints: [
      { id: 'port-engine-1', x: -7, y: -36, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'starboard-engine-1', label: 'port-engine-1' },
      { id: 'starboard-engine-1', x: 7, y: -36, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'port-engine-1', label: 'starboard-engine-1' },
      { id: 'port-engine-2', x: -13, y: -30, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'starboard-engine-2', label: 'port-engine-2' },
      { id: 'starboard-engine-2', x: 13, y: -30, z: 0, angle: 0, accepts: ['engine'], mirrorOf: 'port-engine-2', label: 'starboard-engine-2' },
      { id: 'port-tank-1', x: -8, y: -2, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'starboard-tank-1', label: 'port-tank-1' },
      { id: 'starboard-tank-1', x: 8, y: -2, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'port-tank-1', label: 'starboard-tank-1' },
      { id: 'port-tank-2', x: -8, y: 12, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'starboard-tank-2', label: 'port-tank-2' },
      { id: 'starboard-tank-2', x: 8, y: 12, z: 0, angle: 0, accepts: ['tank'], mirrorOf: 'port-tank-2', label: 'starboard-tank-2' },
      { id: 'port-gun-1', x: -10, y: 32, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-1', label: 'port-gun-1' },
      { id: 'starboard-gun-1', x: 10, y: 32, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-1', label: 'starboard-gun-1' },
      { id: 'port-gun-2', x: -17, y: 16, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-2', label: 'port-gun-2' },
      { id: 'starboard-gun-2', x: 17, y: 16, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-2', label: 'starboard-gun-2' },
      { id: 'port-gun-3', x: -17, y: -2, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'starboard-gun-3', label: 'port-gun-3' },
      { id: 'starboard-gun-3', x: 17, y: -2, z: 0, angle: 0, accepts: ['weapon'], mirrorOf: 'port-gun-3', label: 'starboard-gun-3' },
      { id: 'port-cargo-1', x: -19, y: -12, z: 0, angle: 0, accepts: ['cargo', 'utility'], scale: 1.15, mirrorOf: 'starboard-cargo-1', label: 'port-cargo-1' },
      { id: 'starboard-cargo-1', x: 19, y: -12, z: 0, angle: 0, accepts: ['cargo', 'utility'], scale: 1.15, mirrorOf: 'port-cargo-1', label: 'starboard-cargo-1' },
      { id: 'port-cargo-2', x: -19, y: -24, z: 0, angle: 0, accepts: ['cargo', 'utility'], scale: 1.15, mirrorOf: 'starboard-cargo-2', label: 'port-cargo-2' },
      { id: 'starboard-cargo-2', x: 19, y: -24, z: 0, angle: 0, accepts: ['cargo', 'utility'], scale: 1.15, mirrorOf: 'port-cargo-2', label: 'starboard-cargo-2' },
      { id: 'armor-top-1', x: 0, y: 22, z: 7, angle: 0, accepts: ['armor'], label: 'armor-top-1' },
      { id: 'armor-top-2', x: 0, y: 10, z: 7, angle: 0, accepts: ['armor'], label: 'armor-top-2' },
      { id: 'armor-top-3', x: 0, y: -2, z: 7, angle: 0, accepts: ['armor'], label: 'armor-top-3' },
      { id: 'armor-top-4', x: 0, y: -14, z: 7, angle: 0, accepts: ['armor'], label: 'armor-top-4' },
      { id: 'armor-belly-1', x: 0, y: 18, z: -7, angle: 0, accepts: ['armor'], label: 'armor-belly-1' },
      { id: 'armor-belly-2', x: 0, y: 6, z: -7, angle: 0, accepts: ['armor'], label: 'armor-belly-2' },
      { id: 'armor-belly-3', x: 0, y: -6, z: -7, angle: 0, accepts: ['armor'], label: 'armor-belly-3' },
      { id: 'armor-belly-4', x: 0, y: -18, z: -7, angle: 0, accepts: ['armor'], label: 'armor-belly-4' },
      { id: 'port-rcs-1', x: -14, y: 26, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'starboard-rcs-1', label: 'port-rcs-1' },
      { id: 'starboard-rcs-1', x: 14, y: 26, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'port-rcs-1', label: 'starboard-rcs-1' },
      { id: 'port-rcs-2', x: -12, y: -20, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'starboard-rcs-2', label: 'port-rcs-2' },
      { id: 'starboard-rcs-2', x: 12, y: -20, z: 0, angle: 0, accepts: ['rcs'], mirrorOf: 'port-rcs-2', label: 'starboard-rcs-2' },
    ],
    build: (root) => {
      box(root, dark, [34, 76, 10], [0, -4, 0]);                       // slab hull
      box(root, armor, [26, 58, 8], [0, -2, 5]);                       // main deck
      for (const side of [-1, 1]) box(root, metal, [4, 70, 4], [side * 17, -4, 0]);   // chine rails
      box(root, dark, [22, 12, 9], [0, 30, 0]);                        // first prow step
      hull(root, 15, 24, 8, armor, 0, 42, 0);                          // second step, off the stock extrusion
      box(root, glass, [10, 2, 1.5], [0, 24, 6]);                      // bridge windows
      box(root, copper, [28, 5, 5], [0, -46, 0]);                      // engine deck rail
      box(root, black, [14, 6, 4], [0, -54, 0]);                       // stern fitting
    },
  },
};

export const PARTS: Record<string, Part> = {
  // ENGINES — thrust per kg is the whole tradeoff; the big bell is not simply better.
  'eng-d4': { id: 'eng-d4', name: 'D4 drive', category: 'engine', mass: 5200, cost: 1400, thrust: 420000, torque: 0.10, blurb: 'Compact, thrifty, unremarkable.', build: enginePod(0.8) },
  'eng-d9': { id: 'eng-d9', name: 'D9 drive', category: 'engine', mass: 11400, cost: 3600, thrust: 980000, torque: 0.14, blurb: 'The standard haul engine.', build: enginePod(1) },
  'eng-k12': { id: 'eng-k12', name: 'K12 torch', category: 'engine', mass: 19800, cost: 9200, thrust: 1880000, torque: 0.08, blurb: 'Enormous thrust, enormous thirst.', build: enginePod(1.35) },
  // TANKS
  'tnk-s': { id: 'tnk-s', name: 'Bladder tank', category: 'tank', mass: 900, cost: 320, fuel: 4200, blurb: 'Cheap volume.', build: tankPod(0.8) },
  'tnk-m': { id: 'tnk-m', name: 'Standard tank', category: 'tank', mass: 1600, cost: 700, fuel: 8800, blurb: 'Balanced.', build: tankPod(1) },
  'tnk-l': { id: 'tnk-l', name: 'Long-range tank', category: 'tank', mass: 3100, cost: 1650, fuel: 17500, blurb: 'Dead weight until you need it.', build: tankPod(1.3) },
  // WEAPONS — one part per WEAPONS entry; the part carries the mount geometry.
  'wpn-ac20': { id: 'wpn-ac20', name: 'AC-20 turret', category: 'weapon', mass: 1400, cost: 900, weapon: 'ac20', blurb: 'Fast, forgiving, weak on rock.', build: gunPart('ac20') },
  'wpn-ac70': { id: 'wpn-ac70', name: 'AC-70 breaker', category: 'weapon', mass: 3900, cost: 2600, weapon: 'ac70', blurb: 'Splits boulders.', build: gunPart('ac70') },
  'wpn-gauss': { id: 'wpn-gauss', name: 'Gauss lance', category: 'weapon', mass: 6200, cost: 7400, weapon: 'gauss', blurb: 'One shot, long reach, hot.', build: gunPart('gauss') },
  'wpn-cutter': { id: 'wpn-cutter', name: 'Mining cutter', category: 'weapon', mass: 2100, cost: 1800, weapon: 'cutter', blurb: 'Short, thirsty, eats asteroids.', build: gunPart('cutter') },
  'wpn-swarm': { id: 'wpn-swarm', name: 'Swarm rack', category: 'weapon', mass: 2800, cost: 4100, weapon: 'swarm', blurb: 'Fire and forget.', build: gunPart('swarm') },
  // HULL AND UTILITY
  'crg-pod': { id: 'crg-pod', name: 'Ore pod', category: 'cargo', mass: 1200, cost: 480, cargo: 320, blurb: 'Holds what you break.', build: cargoPod() },
  'arm-tile': { id: 'arm-tile', name: 'Ablative tile', category: 'armor', mass: 2400, cost: 620, hull: 26, blurb: 'Mass you are glad of.', build: armorTile() },
  'wng-rad': { id: 'wng-rad', name: 'Radiator wing', category: 'wing', mass: 1500, cost: 900, cooling: 0.09, blurb: 'Lets the guns keep firing.', build: radiatorWing() },
  'rcs-pod': { id: 'rcs-pod', name: 'RCS quad', category: 'rcs', mass: 400, cost: 260, torque: 0.42, blurb: 'Turns you.', build: rcsPod() },
  'utl-scan': { id: 'utl-scan', name: 'Survey mast', category: 'utility', mass: 700, cost: 1400, blurb: 'Halves every scan time.', build: scanMast() },
  'utl-coll': { id: 'utl-coll', name: 'Ore collector', category: 'utility', mass: 950, cost: 1100, blurb: 'Triples the ore pickup envelope.', build: collector() },
};

/** Whether a socket takes this kind of part. Used by the builder UI and the save validator. */
export function partFits(part: Part, hardpoint: Hardpoint): boolean {
  return hardpoint.accepts.includes(part.category);
}
