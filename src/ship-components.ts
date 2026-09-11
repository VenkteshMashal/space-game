import * as THREE from 'three';
import type { Core, Hardpoint, Part, PartCategory } from './parts';
import { enginePod, cargoPod, rcsPod, radiatorWing, collector, tankPod } from './parts';
import { armor, black, box, copper, cylinder, dark, glass, hull, lightArmor, metal, buildGunMount } from './models';

// A thrust-axis corvette: tapered command citadel, segmented armor and an exposed reactor keel.
const pair = (name: string, x: number, y: number, z: number, accepts: PartCategory[]): Hardpoint[] =>
  [-1, 1].map(side => ({ id: `${side < 0 ? 'port' : 'starboard'}-${name}`, x: side * x, y, z, angle: 0,
    accepts, mirrorOf: `${side < 0 ? 'starboard' : 'port'}-${name}`, label: `${side < 0 ? 'Port' : 'Starboard'} ${name.replaceAll('-', ' ')}` }));

export const aegisCore: Core = {
  id: 'aegis', name: 'Aegis corvette', blurb: 'An armored torchship. Layered pressure decks, exposed machinery and a narrow combat profile.',
  mass: 44000, hull: 145, torque: 1.65, cooling: 0.085, cost: 0,
  hardpoints: [
    ...pair('drive', 10, -42, 0, ['engine']), ...pair('tank', 14, -14, -1, ['tank']),
    ...pair('forward-turret', 13, 30, 6, ['weapon']), ...pair('missile-rack', 15, 9, 4, ['weapon']),
    { id: 'dorsal-tool', x: 0, y: 20, z: 12, angle: 0, accepts: ['weapon'], label: 'Dorsal mining / gun mount' },
    ...pair('cargo', 23, -13, 0, ['cargo', 'utility']), ...pair('radiator', 23, -32, 1, ['wing', 'utility']),
    ...pair('attitude-pack', 17, 40, 0, ['rcs']), ...pair('aft-rcs', 20, -36, 0, ['rcs']),
    { id: 'sensor-spine', x: 0, y: -10, z: 13, angle: 0, accepts: ['utility'], label: 'Dorsal sensor spine' },
    ...[24, 3, -20].map((y, i): Hardpoint => ({ id: `deck-armor-${i}`, x: 0, y, z: 9, angle: 0, accepts: ['armor'], label: `Deck armor ${i + 1}` })),
  ],
  build(root) {
    hull(root, 22, 87, 15, dark, 0, 0, 0);
    cylinder(root, metal, 10, 11, 22, [0, -32, 0], 10);
    for (const side of [-1, 1]) {
      box(root, metal, [2.2, 78, 3], [side * 10, -3, -5]);
      for (let i = 0; i < 5; i++) {
        const y = -27 + i * 15;
        const plate = box(root, i % 2 ? armor : lightArmor, [10, 13.4, 4.5], [side * 6.8, y, 6.4]);
        plate.rotation.y = side * 0.2;
        box(root, black, [6.5, 1, 0.5], [side * 6.8, y - 3, 9]);
        box(root, copper, [0.8, 12, 1], [side * 12.3, y, 3]);
      }
      box(root, dark, [7, 21, 9], [side * 10, -37, 0]);
      for (let i = 0; i < 5; i++) box(root, metal, [8.5, 1.3, 9.6], [side * 10, -29 - i * 3.4, 0]);
      box(root, copper, [3, 9, 0.5], [side * 7, 30, 9.5]);
    }
    hull(root, 15, 27, 12, armor, 0, 40, 1);
    box(root, dark, [12, 16, 6], [0, 32, 9]);
    box(root, glass, [9, 2, 1], [0, 38, 12.3]);
    box(root, metal, [24, 4, 7], [0, -46, 0]);
    box(root, lightArmor, [6, 10, 2], [0, 1, 11]);
    for (const x of [-3, 3]) cylinder(root, copper, 0.6, 0.6, 28, [x, -27, 10], 6);
  },
};

const weapon = (id: Parameters<typeof buildGunMount>[0]) => (root: THREE.Group) => root.add(buildGunMount(id).group);
export const extendedParts: Record<string, Part> = {
  'wpn-pdc': { id: 'wpn-pdc', name: 'Vulcan PDC turret', category: 'weapon', cost: 0, mass: 2600, weapon: 'pdc', blurb: 'Six-barrel tracking cannon. Rapid fire with broad turret traverse.', build: weapon('pdc') },
  'wpn-torpedo': { id: 'wpn-torpedo', name: 'Lancer torpedo rack', category: 'weapon', cost: 0, mass: 5200, weapon: 'torpedo', blurb: 'Heavy guided torpedoes. Select a hostile with Tab; launch with G.', build: weapon('torpedo') },
  'wpn-plasma': { id: 'wpn-plasma', name: 'Plasma mining lance', category: 'weapon', cost: 0, mass: 3900, weapon: 'plasma', blurb: 'Longer reach industrial cutter. Hold C while aiming at rock.', build: weapon('plasma') },
  'eng-fusion': { id: 'eng-fusion', name: 'F6 fusion torch', category: 'engine', cost: 0, mass: 14800, thrust: 1650000, torque: 0.22, cooling: 0.02, blurb: 'Magnetic nozzle with a braced reactor jacket. Strong sustained thrust.', build(root) {
    enginePod(1.18)(root);
    for (const side of [-1, 1]) { box(root, armor, [3, 17, 8], [side * 6, 7, 0]); cylinder(root, copper, 0.8, 0.8, 19, [side * 4, 9, 5], 8); }
    for (const y of [-1, 3, 7]) cylinder(root, metal, 5.1, 5.1, 1, [0, y, 0], 16);
  } },
  'tnk-armored': { id: 'tnk-armored', name: 'Armored fuel cell', category: 'tank', cost: 0, mass: 4200, fuel: 12000, hull: 16, blurb: 'Protected propellant storage with external impact shields.', build(root) {
    tankPod(0.9)(root); for (const side of [-1, 1]) box(root, armor, [3.5, 20, 13], [side * 5.5, 0, 0]);
  } },
  'crg-heavy': { id: 'crg-heavy', name: 'Bulk ore container', category: 'cargo', cost: 0, mass: 3300, cargo: 780, hull: 8, blurb: 'A braced 780 kg hold with an illuminated loading hatch.', build(root) {
    const pod = new THREE.Group(); pod.scale.set(1.12, 1.4, 1.12); cargoPod()(pod); root.add(pod);
    for (const x of [-9, 9]) box(root, lightArmor, [2, 32, 17], [x, 0, 0]);
  } },
  'arm-wedge': { id: 'arm-wedge', name: 'Sloped armor shell', category: 'armor', cost: 0, mass: 4700, hull: 58, blurb: 'A layered angled fairing that turns an exposed spine into a combat hull.', build(root) {
    hull(root, 20, 23, 5, armor); hull(root, 16, 19, 2, lightArmor, 0, 1, 4); box(root, copper, [3, 9, 0.5], [4, -2, 5.2]);
  } },
  'arm-light': { id: 'arm-light', name: 'Whipple shield', category: 'armor', cost: 0, mass: 1300, hull: 22, blurb: 'Spaced debris protection with less added mass.', build(root) {
    box(root, metal, [12, 20, 1], [0, 0, 0]); box(root, lightArmor, [13, 21, 0.7], [0, 0, 2]);
    for (const x of [-5, 5]) for (const y of [-8, 8]) box(root, dark, [1, 1, 3], [x, y, 0.5]);
  } },
  'wng-split': { id: 'wng-split', name: 'Split radiator array', category: 'wing', cost: 0, mass: 2700, cooling: 0.18, blurb: 'Twin thermal panels for sustained weapons and mining operations.', build(root) {
    for (const x of [-3, 3]) { const wing = new THREE.Group(); wing.position.x = x; radiatorWing()(wing); root.add(wing); } box(root, copper, [9, 2, 2], [0, 12, 0]);
  } },
  'rcs-vector': { id: 'rcs-vector', name: 'Vector RCS cluster', category: 'rcs', cost: 0, mass: 900, torque: 0.88, blurb: 'Paired attitude blocks turn heavy corvettes with authority.', build(root) {
    for (const y of [-4, 4]) { const pod = new THREE.Group(); pod.position.y = y; rcsPod()(pod); root.add(pod); } box(root, armor, [6, 13, 1], [0, 0, 3]);
  } },
  'utl-array': { id: 'utl-array', name: 'Phased survey array', category: 'utility', cost: 0, mass: 1600, scanScale: 3, blurb: 'Three sensor panels cut survey time to one third.', build(root) {
    cylinder(root, metal, 1, 1, 16, [0, 3, 0], 8);
    for (const x of [-5, 0, 5]) { const panel = box(root, dark, [4.6, 11, 1.4], [x, 11, 1]); box(panel, glass, [3.8, 9, 0.3], [0, 0, 0.9]); }
  } },
  'utl-magnet': { id: 'utl-magnet', name: 'Magnetic ore scoop', category: 'utility', cost: 0, mass: 2200, collectScale: 5, blurb: 'Five times the pickup reach. Fly near cut ore to draw it into a cargo hold.', build(root) {
    collector()(root); for (const x of [-10, 10]) { box(root, dark, [3, 20, 5], [x, 6, 0]); for (const y of [0, 4, 8, 12]) box(root, copper, [4, 1.4, 6], [x, y, 0]); }
  } },
};
