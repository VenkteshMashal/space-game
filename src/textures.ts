import * as THREE from 'three';
import { randomSeed } from './shared/rng';

function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967295;
}
function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  return (hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx) * (1 - fy) + (hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx) * fy;
}

/** Bake surface detail once; no full-screen procedural-noise shader on every frame. */
export function rockyTexture(seed = 81, width = 1024, height = 512) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(width, height);
  const rand = randomSeed(seed);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0, weight = 0.5, frequency = 0.014;
    for (let octave = 0; octave < 5; octave++) {
      value += noise(x * frequency + seed, y * frequency) * weight;
      frequency *= 2.17; weight *= 0.5;
    }
    const shade = 56 + value * 125 + (rand() - 0.5) * 19;
    const at = (y * width + x) * 4;
    pixels.data[at] = shade * 1.02; pixels.data[at + 1] = shade; pixels.data[at + 2] = shade * 0.96; pixels.data[at + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  for (let i = 0; i < 230; i++) {
    const x = rand() * width, y = rand() * height;
    const radius = 2 + Math.pow(rand(), 3) * 39;
    const crater = ctx.createRadialGradient(x, y, 0, x, y, radius);
    crater.addColorStop(0, '#12171777'); crater.addColorStop(0.6, '#1c212148');
    crater.addColorStop(0.78, '#252a2940'); crater.addColorStop(0.88, '#c5c2b53d'); crater.addColorStop(1, '#bcbcb000');
    ctx.fillStyle = crater; ctx.beginPath(); ctx.ellipse(x, y, radius, radius * 0.85, 0, 0, Math.PI * 2); ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

export function spaceTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 768;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const band = Math.exp(-Math.pow((y / canvas.height - x / canvas.width * 0.38 - 0.32) * 6, 2));
    const cloud = noise(x * 0.009, y * 0.009) * 0.6 + noise(x * 0.027, y * 0.027) * 0.25 + noise(x * 0.075, y * 0.075) * 0.15;
    const at = (y * canvas.width + x) * 4;
    pixels.data[at] = 5 + cloud * band * 7;
    pixels.data[at + 1] = 10 + cloud * band * 12;
    pixels.data[at + 2] = 17 + cloud * band * 17;
    pixels.data[at + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
