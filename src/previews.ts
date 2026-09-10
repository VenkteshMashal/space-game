import * as THREE from 'three';
import { buildShip } from './models';
import type { ShipClass } from './physics';

export function shipPreviews() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(500, 330);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight('#afcadd', 1.2));
  const light = new THREE.DirectionalLight('#fff0d5', 3.5); light.position.set(-60, 100, 100); scene.add(light);
  const rim = new THREE.DirectionalLight('#74b8ec', 2); rim.position.set(100, -60, 30); scene.add(rim);
  const camera = new THREE.OrthographicCamera(-80, 80, 53, -53, 1, 600);
  camera.position.set(75, -100, 220); camera.lookAt(0, -3, 0);
  const result = {} as Record<ShipClass, string>;
  for (const type of ['kestrel', 'mule', 'needle'] as ShipClass[]) {
    const ship = buildShip(type); ship.group.rotation.z = -0.48; scene.add(ship.group);
    renderer.render(scene, camera); result[type] = renderer.domElement.toDataURL('image/png');
    scene.remove(ship.group);
    ship.group.traverse(child => { if (child instanceof THREE.Mesh) child.geometry.dispose(); });
  }
  renderer.dispose(); renderer.forceContextLoss();
  return result;
}
