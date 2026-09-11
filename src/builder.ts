import * as THREE from 'three';
import { ShipBay } from './hangar';
import { CORES, PARTS, partFits } from './parts';
import { buildFromParts, derive, toggleSlot } from './build';
import type { Build, BuiltShip, DerivedStats } from './build';
import type { Hardpoint, Part } from './parts';

export type BuilderHost = {
  credits: () => number;
  owns: (id: string) => boolean;
  buy: (id: string) => boolean;
  save: (build: Build) => void;
  launch: (build: Build) => void;
  close: () => void;
};

const HOVER_MS = 50;   // 20 Hz hover picking, per the interaction skill
const PICK_RADIUS = 26;  // screen px: how near a marker a click counts

// Shared module-level gizmo resources: a selection change reuses them instead of allocating.
const RING_GEOMETRY = new THREE.TorusGeometry(7.6, 0.95, 8, 28);
// Empty sockets are a smaller ring, not a solid: two ring sizes read as one language and never
// look like stray geometry lying on the hull.
const SOCKET_GEOMETRY = new THREE.TorusGeometry(5, 0.6, 6, 22);
// Markers are additive and depth-tested: they glow over the hull without ever muddying it.
const makeMarker = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
const RING_IDLE = makeMarker('#efb879', 0.3);
const RING_ACTIVE = makeMarker('#efb879', 0.9);
const SOCKET_IDLE = makeMarker('#83b9b5', 0.34);
const SOCKET_ACTIVE = makeMarker('#83b9b5', 0.95);

/**
 * The shipyard screen: a live assembled hull on the bay turntable with one gizmo per hardpoint.
 * Every edit rebuilds the model — a build is a few hundred small meshes and this happens on a
 * click, not per frame.
 */
export class Builder {
  private readonly bay: ShipBay;
  private readonly panel: HTMLElement;
  private readonly host: BuilderHost;
  private readonly scratchNormal = new THREE.Vector3();
  private readonly scratchPoint = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private build: Build;
  private built?: BuiltShip;
  private stats: DerivedStats;
  private selected?: string;
  private gizmos: THREE.Mesh[] = [];
  private hovered?: string;
  /** Names the socket under the pointer: the rings are small on a crowded core. */
  private readonly tip = document.createElement('div');
  private lastHover = 0;
  private disposed = false;

  constructor(bay: ShipBay, panel: HTMLElement, host: BuilderHost, build: Build) {
    this.bay = bay;
    this.panel = panel;
    this.host = host;
    this.build = build;
    this.stats = derive(build);
    this.rebuild();
    this.tip.className = 'socket-tip';
    this.tip.hidden = true;
    (bay.renderer.domElement.parentElement ?? document.body).appendChild(this.tip);
    bay.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    bay.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderPanel();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.bay.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.bay.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.bay.setCustom(undefined);
    this.built = undefined;
    this.tip.remove();
    this.panel.innerHTML = '';
  }

  /** The build the player is looking at, including everything installed so far. */
  current(): Build { return this.build; }
  currentSpec() { return this.stats; }

  /** Read-only projection so a harness can aim real pointer events at a socket. */
  socketScreen(): { id: string; filled: boolean; x: number; y: number; onScreen: boolean }[] {
    const rect = this.bay.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3();
    const seen = new Set<string>();
    const list: { id: string; filled: boolean; x: number; y: number; onScreen: boolean }[] = [];
    for (const gizmo of this.gizmos) {
      const id = gizmo.userData.hardpoint as string;
      if (seen.has(id)) continue;
      seen.add(id);
      gizmo.getWorldPosition(point);
      const projected = point.project(this.bay.camera);
      list.push({
        id,
        filled: Boolean(this.build.slots[id]),
        x: rect.left + (projected.x + 1) / 2 * rect.width,
        y: rect.top + (1 - projected.y) / 2 * rect.height,
        onScreen: projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1,
      });
    }
    return list;
  }

  private rebuild() {
    if (this.built) {
      this.bay.setCustom(undefined);
      this.built = undefined;
    }
    this.built = buildFromParts(this.build);
    this.bay.setCustom(this.built);
    this.stats = derive(this.build);
    this.attachGizmos();
  }

  private attachGizmos() {
    this.disposeGizmos();
    if (!this.built) return;
    const core = CORES[this.build.core];
    if (!core) return;
    for (const hardpoint of core.hardpoints) {
      const socket = this.built.sockets.get(hardpoint.id);
      if (!socket) continue;
      this.placeGizmo(new THREE.Mesh(SOCKET_GEOMETRY, SOCKET_IDLE), socket, hardpoint.id);
    }
    this.paintGizmos();
  }

  /** One place decides what every marker looks like: filled or empty, hovered or selected. */
  private paintGizmos() {
    for (const gizmo of this.gizmos) {
      const id = gizmo.userData.hardpoint as string;
      const filled = Boolean(this.build.slots[id]);
      const lit = this.selected === id || this.hovered === id;
      gizmo.geometry = filled ? RING_GEOMETRY : SOCKET_GEOMETRY;
      gizmo.material = filled ? (lit ? RING_ACTIVE : RING_IDLE) : (lit ? SOCKET_ACTIVE : SOCKET_IDLE);
    }
  }

  private placeGizmo(mesh: THREE.Mesh, socket: THREE.Object3D, id: string) {
    mesh.position.copy(socket.position);
    mesh.rotation.z = socket.rotation.z;
    mesh.name = `gizmo:${id}`;
    mesh.userData.hardpoint = id;
    mesh.userData.shared = true;
    mesh.layers.set(1);
    this.built!.group.add(mesh);
    this.gizmos.push(mesh);
  }

  private disposeGizmos() {
    for (const gizmo of this.gizmos) gizmo.removeFromParent();
    this.gizmos = [];
  }

  private onPointerDown = (event: PointerEvent) => {
    const id = this.pick(event);
    if (!id) return;
    this.selected = id;
    this.paintGizmos();
    this.renderPanel();
  };

  private onPointerMove = (event: PointerEvent) => {
    const now = performance.now();
    if (now - this.lastHover < HOVER_MS) return;
    this.lastHover = now;
    const id = this.pick(event);
    if (id === this.hovered) return;
    this.hovered = id;
    this.bay.renderer.domElement.style.cursor = id ? 'pointer' : 'default';
    this.paintGizmos();
    this.showTip(event, id);
  };

  private showTip(event: PointerEvent, id: string | undefined) {
    const hardpoint = id ? this.hardpoint(id) : undefined;
    if (!hardpoint) { this.tip.hidden = true; return; }
    const fitted = this.build.slots[hardpoint.id];
    const part = fitted ? PARTS[fitted] : undefined;
    this.tip.innerHTML = `<strong>${hardpoint.label}</strong><small>${part ? part.name : 'empty · click to fit'}</small>`;
    const rect = this.bay.renderer.domElement.getBoundingClientRect();
    this.tip.style.left = `${event.clientX - rect.left}px`;
    this.tip.style.top = `${event.clientY - rect.top}px`;
    this.tip.hidden = false;
  }

  /**
   * Sockets are rings on a crowded hull, so picking is done in screen space: the marker whose
   * projected centre is nearest the pointer wins, and only markers facing the camera are candidates.
   * A raycaster would let a neighbour's hit disc steal the click from the ring under the pointer.
   */
  private pick(event: PointerEvent): string | undefined {
    const rect = this.bay.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const gizmo of this.gizmos) {
      if (!this.facesCamera(gizmo)) continue;
      gizmo.getWorldPosition(this.scratchPoint).project(this.bay.camera);
      if (this.scratchPoint.z > 1) continue;
      const px = (this.scratchPoint.x + 1) * 0.5 * rect.width;
      const py = (1 - this.scratchPoint.y) * 0.5 * rect.height;
      const distance = (px - x) ** 2 + (py - y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = gizmo.userData.hardpoint as string;
      }
    }
    return bestDistance <= PICK_RADIUS * PICK_RADIUS ? best : undefined;
  }

  private facesCamera(object: THREE.Object3D): boolean {
    const normal = this.scratchNormal.set(0, 0, 1).applyQuaternion(object.getWorldQuaternion(this.scratchQuaternion));
    return normal.z > 0.12;
  }

  private install(partId: string | null) {
    if (!this.selected) return;
    const hardpoint = this.hardpoint(this.selected);
    if (!hardpoint) return;
    const part = partId ? PARTS[partId] : undefined;
    if (part && !this.host.owns(part.id) && !this.host.buy(part.id)) return;
    toggleSlot(this.build, hardpoint.id, part ? part.id : null);
    this.rebuild();
    this.renderPanel();
  }

  private pickCore(coreId: string) {
    if (coreId === this.build.core) return;
    if (!this.host.owns(coreId) && !this.host.buy(coreId)) return;
    this.build = { ...this.build, core: coreId, slots: {} };
    this.selected = undefined;
    this.rebuild();
    this.renderPanel();
  }

  private hardpoint(id: string): Hardpoint | undefined {
    return CORES[this.build.core]?.hardpoints.find(entry => entry.id === id);
  }

  private openParts(hardpoint: Hardpoint): Part[] {
    return Object.values(PARTS).filter(part => partFits(part, hardpoint));
  }

  renderPanel() {
    if (this.disposed) return;
    const core = CORES[this.build.core];
    const hardpoint = this.selected ? this.hardpoint(this.selected) : undefined;
    const installed = hardpoint ? this.build.slots[hardpoint.id] : null;
    const parts = hardpoint ? this.openParts(hardpoint) : [];
    const partButton = (part: Part) => {
      const owned = this.host.owns(part.id);
      const active = installed === part.id;
      return `<button class="part-option ${active ? 'active' : ''} ${owned ? '' : 'locked'}" data-part="${part.id}">
        <span class="part-name">${part.name}</span>
        <span class="part-blurb">${part.blurb}</span>
        <span class="part-cost">${owned ? `${(part.mass / 1000).toFixed(1)} t` : `${part.cost.toLocaleString()} cr · Buy`}</span>
      </button>`;
    };
    this.panel.innerHTML = `
      <div class="builder-head">
        <span class="dialog-kicker">Shipyard</span>
        <button class="text-icon-button" id="builder-close" aria-label="Close shipyard" title="Close">Close</button>
      </div>
      <h2 id="builder-title">${this.build.name}</h2>
      <div class="builder-cores">${Object.values(CORES).map(entry => `
        <button class="core-option ${entry.id === this.build.core ? 'active' : ''} ${this.host.owns(entry.id) ? '' : 'locked'}" data-core="${entry.id}">
          <b>${entry.name}</b><small>${this.host.owns(entry.id) ? entry.blurb : `${entry.cost.toLocaleString()} cr · Buy`}</small>
        </button>`).join('')}</div>
      <div class="builder-slot" data-socket="${hardpoint ? hardpoint.id : ''}">
        <span class="section-label">${hardpoint ? hardpoint.label : 'Select a socket'}</span>
        ${hardpoint ? `<div class="part-list">${parts.map(partButton).join('')}
          <button class="part-option clear ${installed ? '' : 'active'}" data-part=""><span class="part-name">Empty socket</span><span class="part-blurb">Bolt nothing here</span><span class="part-cost">0 t</span></button>
        </div>` : '<p class="builder-hint">Click a teal ring on the hull to fit a part, or an amber ring to change one.</p>'}
      </div>
      <div class="builder-stats">
        <div class="spec-row"><span>Dry mass</span><i></i><strong>${(this.stats.dryMass / 1000).toFixed(1)} t</strong></div>
        <div class="spec-row"><span>Thrust</span><i></i><strong>${(this.stats.thrust / 1e6).toFixed(2)} MN</strong></div>
        <div class="spec-row"><span>Acceleration</span><i></i><strong>${this.stats.gees.toFixed(2)} g</strong></div>
        <div class="spec-row"><span>Attitude</span><i></i><strong>${this.stats.torque.toFixed(2)}</strong></div>
        <div class="spec-row"><span>Propellant</span><i></i><strong>${(this.stats.fuel / 1000).toFixed(1)} t</strong></div>
        <div class="spec-row"><span>Hull</span><i></i><strong>${Math.round(this.stats.hull)}</strong></div>
        <div class="spec-row"><span>Heat shed</span><i></i><strong>${this.stats.cooling.toFixed(3)}/s</strong></div>
        <div class="spec-row"><span>Hold</span><i></i><strong>${Math.round(this.stats.cargo)} u</strong></div>
        <div class="spec-row"><span>Hardpoints</span><i></i><strong>${this.stats.mounts.length} gun${this.stats.mounts.length === 1 ? '' : 's'}</strong></div>
        <div class="spec-row"><span>Build cost</span><i></i><strong>${this.stats.cost.toLocaleString()} cr</strong></div>
      </div>
      ${this.stats.problems.length ? `<ul class="builder-problems">${this.stats.problems.map(problem => `<li>${problem}</li>`).join('')}</ul>` : '<p class="builder-ok">All systems within tolerance.</p>'}
      <div class="builder-actions">
        <button class="secondary-button" id="builder-save">Save build</button>
        <button class="primary-button" id="builder-launch" ${this.stats.valid ? '' : `disabled title="${this.stats.problems[0] ?? ''}"`}>Launch sortie</button>
      </div>
      <div class="builder-credits">Balance <strong>${this.host.credits().toLocaleString()} cr</strong></div>
    `;
    this.panel.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(button => button.addEventListener('click', () => this.install(button.dataset.part || null)));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-core]').forEach(button => button.addEventListener('click', () => this.pickCore(button.dataset.core!)));
    this.panel.querySelector('#builder-close')?.addEventListener('click', () => this.host.close());
    this.panel.querySelector('#builder-save')?.addEventListener('click', () => { this.host.save(this.build); this.renderPanel(); });
    this.panel.querySelector('#builder-launch')?.addEventListener('click', () => { if (this.stats.valid) this.host.launch(this.build); });
  }
}
