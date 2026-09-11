import * as THREE from 'three';
import { disposeObject } from './models';
import type { Part } from './parts';

type PreviewState = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.OrthographicCamera };

const cache = new Map<string, string>();
let state: PreviewState | undefined;

function getState(): PreviewState {
  if (state) return state;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(176, 112, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#c9e3ed', '#09141e', 2.4));
  const key = new THREE.DirectionalLight('#fff1d2', 4); key.position.set(-3, 5, 8); scene.add(key);
  const rim = new THREE.DirectionalLight('#62b8d1', 2.2); rim.position.set(5, -2, 4); scene.add(rim);
  const camera = new THREE.OrthographicCamera(-25, 25, 16, -16, 0.1, 4000);
  state = { renderer, scene, camera };
  return state;
}

/** Builds a thumbnail on demand, then keeps only its data URL; preview meshes are disposed. */
export function getPartPreview(part: Part): string {
  const existing = cache.get(part.id);
  if (existing) return existing;
  const preview = getState();
  const group = new THREE.Group();
  part.build(group);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible || object.userData.effect || object.name === 'flame' || object.name === 'rcs-jet') return;
    object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld));
  });
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 1);
  preview.camera.position.set(span * 1.35, span * 1.15, span * 1.85);
  preview.camera.lookAt(center);
  const half = span * 0.82;
  preview.camera.left = -half; preview.camera.right = half; preview.camera.top = half * 0.64; preview.camera.bottom = -half * 0.64;
  preview.camera.updateProjectionMatrix();
  preview.scene.add(group);
  preview.renderer.setClearColor(0x000000, 0);
  preview.renderer.render(preview.scene, preview.camera);
  const url = preview.renderer.domElement.toDataURL('image/png');
  cache.set(part.id, url);
  disposeObject(group);
  return url;
}

export function clearPartPreviewCache(): void { cache.clear(); }

/** Optional lifecycle hook for a host that permanently tears down the shipyard. */
export function disposePartPreviewRenderer(): void {
  if (!state) return;
  state.renderer.dispose(); state.renderer.forceContextLoss(); state.renderer.domElement.remove(); state = undefined; cache.clear();
}
