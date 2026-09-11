import * as THREE from 'three';
import { ShipBay } from './hangar';
import { CORES, PARTS, partFits } from './parts';
import type { Core, Hardpoint, Part, PartCategory } from './parts';
import { BUILD_PRESETS, buildFromParts, derive, presetBuild, toggleSlot } from './build';
import type { Build, BuiltShip, DerivedStats, PresetId } from './build';
import { getPartPreview } from './part-previews';
import './shipyard.css';

/** Kept for compatibility with the existing host; the free yard never calls economy methods. */
export type BuilderHost = {
  credits: () => number;
  owns: (id: string) => boolean;
  buy: (id: string) => boolean;
  save: (build: Build) => void;
  launch: (build: Build) => void;
  close: () => void;
};

const HOVER_MS = 50;
const PICK_RADIUS = 28;
const DRAG_TOLERANCE = 8;
const RING_GEOMETRY = new THREE.TorusGeometry(7.6, 0.95, 8, 28);
const SOCKET_GEOMETRY = new THREE.TorusGeometry(5, 0.6, 6, 22);
const marker = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
const RING_IDLE = marker('#efb879', 0.35);
const RING_ACTIVE = marker('#efb879', 0.95);
const SOCKET_IDLE = marker('#83b9b5', 0.38);
const SOCKET_ACTIVE = marker('#83b9b5', 0.98);


const CATEGORY_LABELS: Record<string, string> = {
  engine: 'Engines', tank: 'Tanks', weapon: 'Weapons', cargo: 'Cargo', armor: 'Armor', wing: 'Wings', rcs: 'RCS', utility: 'Utility',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

function signed(value: number, digits = 1): string { return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`; }

function primaryCategory(hardpoint: Hardpoint): string {
  return hardpoint.accepts.includes('wing') ? 'wing' : hardpoint.accepts[0] ?? 'utility';
}

/** A stable, inspection-first shipyard over the existing assembled ship model. */
export class Builder {
  private readonly bay: ShipBay;
  private readonly panel: HTMLElement;
  private readonly host: BuilderHost;
  private readonly scratchNormal = new THREE.Vector3();
  private readonly scratchCameraDirection = new THREE.Vector3();
  private readonly scratchPoint = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private build: Build;
  private built?: BuiltShip;
  private stats: DerivedStats;
  private selected?: string;
  private selectedPartId?: string;
  private filter: PartCategory | 'all' = 'all';
  private mirror = true;
  private gizmos: THREE.Mesh[] = [];
  private hovered?: string;
  private press?: { x: number; y: number };
  private readonly tip = document.createElement('div');
  private lastHover = 0;
  private disposed = false;
  private notice?: { kind: 'ok' | 'warn'; text: string };

  constructor(bay: ShipBay, panel: HTMLElement, host: BuilderHost, build: Build) {
    this.bay = bay;
    this.panel = panel;
    this.host = host;
    this.build = build;
    this.stats = derive(build);
    this.panel.closest('.build-screen')?.classList.add('shipyard-screen');
    this.bay.setInspectionMode(true);
    this.rebuild();
    this.tip.className = 'socket-tip';
    this.tip.hidden = true;
    (bay.renderer.domElement.parentElement ?? document.body).appendChild(this.tip);
    bay.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    bay.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    bay.renderer.domElement.addEventListener('pointercancel', this.onPointerCancel);
    bay.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderPanel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.bay.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    this.bay.setCustom(undefined);
    this.built = undefined;
    this.panel.closest('.build-screen')?.classList.remove('shipyard-screen');
    this.tip.remove();
    this.panel.innerHTML = '';
  }

  current(): Build { return this.build; }
  currentSpec(): DerivedStats { return this.stats; }

  /** Read-only projection retained for socket-focused browser checks. */
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
      list.push({ id, filled: Boolean(this.build.slots[id]), x: rect.left + (projected.x + 1) / 2 * rect.width, y: rect.top + (1 - projected.y) / 2 * rect.height, onScreen: projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 });
    }
    return list;
  }

  private rebuild(): void {
    if (this.built) { this.bay.setCustom(undefined); this.built = undefined; }
    this.built = buildFromParts(this.build);
    this.bay.setCustom(this.built);
    this.stats = derive(this.build);
    this.attachGizmos();
  }

  private attachGizmos(): void {
    this.disposeGizmos();
    if (!this.built) return;
    const core = CORES[this.build.core];
    if (!core) return;
    for (const hardpoint of core.hardpoints) {
      const socket = this.built.sockets.get(hardpoint.id);
      if (socket) this.placeGizmo(new THREE.Mesh(SOCKET_GEOMETRY, SOCKET_IDLE), socket, hardpoint.id);
    }
    this.paintGizmos();
  }

  private paintGizmos(): void {
    for (const gizmo of this.gizmos) {
      const id = gizmo.userData.hardpoint as string;
      const filled = Boolean(this.build.slots[id]);
      const lit = this.selected === id || this.hovered === id;
      gizmo.geometry = filled ? RING_GEOMETRY : SOCKET_GEOMETRY;
      gizmo.material = filled ? (lit ? RING_ACTIVE : RING_IDLE) : (lit ? SOCKET_ACTIVE : SOCKET_IDLE);
    }
  }

  private placeGizmo(mesh: THREE.Mesh, socket: THREE.Object3D, id: string): void {
    mesh.position.copy(socket.position);
    mesh.rotation.z = socket.rotation.z;
    mesh.name = `gizmo:${id}`;
    mesh.userData.hardpoint = id;
    mesh.userData.shared = true;
    mesh.layers.set(1);
    this.built!.group.add(mesh);
    this.gizmos.push(mesh);
  }

  private disposeGizmos(): void { for (const gizmo of this.gizmos) gizmo.removeFromParent(); this.gizmos = []; }

  private onPointerDown = (event: PointerEvent): void => { this.press = { x: event.clientX, y: event.clientY }; };

  private onPointerUp = (event: PointerEvent): void => {
    const press = this.press;
    this.press = undefined;
    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_TOLERANCE) return;
    const id = this.pick(event);
    if (id) this.selectSocket(id);
  };

  private onPointerCancel = (): void => { this.press = undefined; };

  private onPointerMove = (event: PointerEvent): void => {
    const now = performance.now();
    if (now - this.lastHover < HOVER_MS) return;
    this.lastHover = now;
    const id = this.pick(event);
    if (id === this.hovered) return;
    this.hovered = id;
    this.bay.renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    this.paintGizmos();
    this.showTip(event, id);
  };

  private selectSocket(id: string): void {
    this.selected = id;
    this.selectedPartId = this.build.slots[id] ?? undefined;
    const hardpoint = this.hardpoint(id);
    if (this.filter !== 'all' && hardpoint && !this.openParts(hardpoint).some(part => part.category === this.filter)) this.filter = 'all';
    this.paintGizmos();
    this.renderPanel();
  }

  private showTip(event: PointerEvent, id: string | undefined): void {
    const hardpoint = id ? this.hardpoint(id) : undefined;
    if (!hardpoint) { this.tip.hidden = true; return; }
    const fitted = this.build.slots[hardpoint.id];
    const part = fitted ? PARTS[fitted] : undefined;
    this.tip.innerHTML = `<strong>${escapeHtml(hardpoint.label)}</strong><small>${part ? escapeHtml(part.name) : 'empty · click to fit'}</small>`;
    const rect = this.bay.renderer.domElement.getBoundingClientRect();
    this.tip.style.left = `${event.clientX - rect.left}px`;
    this.tip.style.top = `${event.clientY - rect.top}px`;
    this.tip.hidden = false;
  }

  /** Screen-space marker picking avoids a neighbouring part stealing a crowded socket click. */
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
      if (distance < bestDistance) { bestDistance = distance; best = gizmo.userData.hardpoint as string; }
    }
    return bestDistance <= PICK_RADIUS * PICK_RADIUS ? best : undefined;
  }

  private facesCamera(object: THREE.Object3D): boolean {
    const normal = this.scratchNormal.set(0, 0, 1).applyQuaternion(object.getWorldQuaternion(this.scratchQuaternion));
    return normal.dot(this.bay.camera.getWorldDirection(this.scratchCameraDirection)) < -0.12;
  }

  private install(partId: string | null): void {
    this.syncName();
    if (!this.selected) { this.notice = { kind: 'warn', text: 'Select a socket in the mount manifest first.' }; this.renderPanel(); return; }
    const hardpoint = this.hardpoint(this.selected);
    if (!hardpoint) return;
    const part = partId ? PARTS[partId] : undefined;
    if (part && !partFits(part, hardpoint)) return;
    const mirrorId = hardpoint.mirrorOf;
    const mirrorBefore = mirrorId ? this.build.slots[mirrorId] : undefined;
    this.selectedPartId = part?.id;
    toggleSlot(this.build, hardpoint.id, part ? part.id : null, this.mirror);
    // Current build.ts always mirrors. Restoring the paired value here makes the toggle usable
    // against that version too; the parent optional argument already leaves it untouched.
    if (!this.mirror && mirrorId) {
      if (mirrorBefore === undefined) delete this.build.slots[mirrorId];
      else this.build.slots[mirrorId] = mirrorBefore;
    }
    this.notice = { kind: 'ok', text: part ? `${part.name} fitted free.` : 'Socket cleared.' };
    this.rebuild();
    this.renderPanel();
  }

  private pickCore(coreId: string): void {
    this.syncName();
    if (coreId === this.build.core || !CORES[coreId]) return;
    this.build = { ...this.build, core: coreId, slots: {} };
    this.selected = undefined;
    this.selectedPartId = undefined;
    this.notice = { kind: 'ok', text: `${CORES[coreId].name} frame selected. Choose a mount to begin.` };
    this.rebuild();
    this.renderPanel();
  }

  private applyPreset(id: PresetId): void {
    this.syncName();
    const preset = BUILD_PRESETS.find(entry => entry.id === id);
    if (!preset) return;
    this.build = presetBuild(id, this.build.id, preset.name);
    this.selected = undefined;
    this.selectedPartId = undefined;
    this.notice = { kind: 'ok', text: `${preset.name} starter fit applied free.` };
    this.rebuild();
    this.renderPanel();
  }

  private syncName(): void {
    const input = this.panel.querySelector<HTMLInputElement>('#builder-name');
    if (!input) return;
    const name = input.value.trim().slice(0, 32);
    if (name) this.build.name = name;
  }

  private hardpoint(id: string): Hardpoint | undefined { return CORES[this.build.core]?.hardpoints.find(entry => entry.id === id); }
  private openParts(hardpoint: Hardpoint): Part[] { return Object.values(PARTS).filter(part => partFits(part, hardpoint)); }

  private catalogParts(hardpoint?: Hardpoint): Part[] {
    const parts = hardpoint ? this.openParts(hardpoint) : Object.values(PARTS);
    return parts.filter(part => this.filter === 'all' || part.category === this.filter).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  private categories(parts: Part[]): string[] { return ['all', ...new Set(parts.map(part => part.category))]; }

  private socketGroups(core: Core): Map<string, Hardpoint[]> {
    const groups = new Map<string, Hardpoint[]>();
    for (const hardpoint of core.hardpoints) {
      const key = primaryCategory(hardpoint);
      const group = groups.get(key) ?? [];
      group.push(hardpoint);
      groups.set(key, group);
    }
    return groups;
  }

  private partStats(part: Part): string[] {
    const rows = [`${(part.mass / 1000).toFixed(1)} t`];
    if (part.thrust) rows.push(`${(part.thrust / 1e6).toFixed(2)} MN thrust`);
    if (part.fuel) rows.push(`${(part.fuel / 1000).toFixed(1)} t propellant`);
    if (part.hull) rows.push(`+${part.hull} hull`);
    if (part.torque) rows.push(`+${part.torque.toFixed(2)} attitude`);
    if (part.cargo) rows.push(`+${part.cargo} hold`);
    if (part.cooling) rows.push(`+${part.cooling.toFixed(2)} cooling`);
    return rows;
  }

  private renderPart(part: Part, installedPart?: Part): string {
    const active = installedPart?.id === part.id;
    const delta = installedPart && !active ? ` · Δ mass ${signed((part.mass - installedPart.mass) / 1000)} t` : '';
    return `<button class="part-option ${active ? 'active' : ''} ${this.selectedPartId === part.id ? 'inspected' : ''}" data-part="${escapeHtml(part.id)}" aria-label="Fit ${escapeHtml(part.name)}"><img class="part-preview" src="${getPartPreview(part)}" alt="" aria-hidden="true"><span class="part-copy"><b class="part-name">${escapeHtml(part.name)}</b><small class="part-blurb">${escapeHtml(part.blurb)}</small><span class="part-statline">${escapeHtml(this.partStats(part).join(' · '))}${escapeHtml(delta)}</span></span><span class="part-fit">${active ? 'Fitted' : 'Free fit'}</span></button>`;
  }

  private renderSocketGroups(core: Core): string {
    return [...this.socketGroups(core)].map(([category, hardpoints]) => `<section class="socket-group"><h4>${escapeHtml(categoryLabel(category))}<span>${hardpoints.length}</span></h4><div class="socket-list">${hardpoints.map(hardpoint => {
      const partId = this.build.slots[hardpoint.id];
      const part = partId ? PARTS[partId] : undefined;
      const mirror = hardpoint.mirrorOf ? ' · paired' : '';
      return `<button class="socket-option ${this.selected === hardpoint.id ? 'active' : ''} ${part ? 'filled' : ''}" data-socket="${escapeHtml(hardpoint.id)}"><span class="socket-state" aria-hidden="true"></span><span><b>${escapeHtml(hardpoint.label)}</b><small>${part ? escapeHtml(part.name) : `empty${mirror}`}</small></span><strong>${part ? 'Fitted' : 'Open'}</strong></button>`;
    }).join('')}</div></section>`).join('');
  }

  private renderInspector(installedPart?: Part): string {
    const part = this.selectedPartId ? PARTS[this.selectedPartId] : installedPart;
    if (!part) return '<div class="component-inspector empty"><span class="inspector-mark">+</span><div><b>No component selected</b><small>Select a catalog item or a fitted socket to inspect it.</small></div></div>';
    const count = Object.values(this.build.slots).filter(id => id === part.id).length;
    const fittedHere = installedPart?.id === part.id;
    return `<div class="component-inspector"><img class="inspector-preview" src="${getPartPreview(part)}" alt=""><div class="inspector-copy"><span class="eyebrow">${escapeHtml(categoryLabel(part.category))}</span><h3>${escapeHtml(part.name)}</h3><p>${escapeHtml(part.blurb)}</p><div class="inspector-stats">${this.partStats(part).map(stat => `<span>${escapeHtml(stat)}</span>`).join('')}</div><strong class="fit-state ${fittedHere ? 'is-fitted' : ''}">${fittedHere ? 'Fitted to selected socket' : count ? `Fitted on ${count} socket${count === 1 ? '' : 's'}` : 'Available · free fit'}</strong></div></div>`;
  }

  renderPanel(): void {
    if (this.disposed) return;
    const core = CORES[this.build.core];
    if (!core) return;
    const hardpoint = this.selected ? this.hardpoint(this.selected) : undefined;
    const installed = hardpoint ? this.build.slots[hardpoint.id] : null;
    const installedPart = installed ? PARTS[installed] : undefined;
    if (this.selectedPartId && !PARTS[this.selectedPartId]) this.selectedPartId = installedPart?.id;
    const allParts = Object.values(PARTS);
    const parts = this.catalogParts(hardpoint);
    const categories = this.categories(hardpoint ? this.openParts(hardpoint) : allParts);
    const launchReady = this.stats.valid;
    const status = this.stats.problems.length ? `<div class="builder-status blocked"><b>Launch needs attention</b><ul>${this.stats.problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></div>` : '<div class="builder-status ready"><b>Flight systems within tolerance</b><span>Valid builds can launch from the yard.</span></div>';
    const manifestScroll = this.panel.querySelector('.manifest-scroll')?.scrollTop ?? 0;
    const catalogScroll = this.panel.querySelector('.part-list')?.scrollTop ?? 0;
    this.panel.innerHTML = `<div class="builder"><header class="builder-head"><div><span class="dialog-kicker">Shipyard / free assembly</span><h2 id="builder-title">${escapeHtml(this.build.name)}</h2></div><button class="text-icon-button" id="builder-close" aria-label="Close shipyard">Close</button></header><label class="builder-name-field"><span>Build name</span><input id="builder-name" maxlength="32" autocomplete="off" spellcheck="false" value="${escapeHtml(this.build.name)}"></label>

      <details class="builder-section starter-section"><summary>Starter fits · ${BUILD_PRESETS.length} free recipes</summary><div class="section-heading"><div><span class="section-label">Starter fits</span><p>Complete working frames, always free to apply.</p></div><span class="section-count">${BUILD_PRESETS.length} recipes</span></div><div class="builder-presets">${BUILD_PRESETS.map(preset => `<button class="preset-option" data-preset="${preset.id}"><b>${escapeHtml(preset.name)}</b><small>${escapeHtml(preset.blurb)}</small><span>Apply free fit</span></button>`).join('')}</div></details>

      <details class="builder-section hull-section"><summary>Hull frame · ${escapeHtml(core.name)}</summary><div class="section-heading"><div><span class="section-label">Hull frame</span><p>Choose the spine that sets the available mount map.</p></div></div><div class="builder-cores">${Object.values(CORES).map(entry => `<button class="core-option ${entry.id === this.build.core ? 'active' : ''}" data-core="${escapeHtml(entry.id)}"><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.blurb)}</small><span>${(entry.mass / 1000).toFixed(1)} t · ${entry.hardpoints.length} mounts</span></button>`).join('')}</div></details>

      <section class="builder-section socket-manifest"><div class="section-heading"><div><span class="section-label">Mount manifest</span><p>Select a socket by name, then fit a compatible component.</p></div><span class="section-count">${core.hardpoints.length} sockets</span></div><div class="manifest-scroll">${this.renderSocketGroups(core)}</div></section>

      <section class="builder-section catalog-section"><div class="section-heading"><div><span class="section-label">Component catalog</span><p>${hardpoint ? `${escapeHtml(hardpoint.label)} accepts ${escapeHtml(hardpoint.accepts.map(categoryLabel).join(' / '))}.` : 'Select a socket to filter to its compatible components.'}</p></div><span class="section-count">${parts.length} shown</span></div><div class="category-filters" role="tablist" aria-label="Component categories">${categories.map(category => `<button class="category-filter ${this.filter === category ? 'active' : ''}" data-category="${escapeHtml(category)}" role="tab" aria-selected="${this.filter === category}">${escapeHtml(category === 'all' ? 'All parts' : categoryLabel(category))}</button>`).join('')}</div><div class="part-list">${parts.length ? parts.map(part => this.renderPart(part, installedPart)).join('') : '<div class="empty-catalog">No components in this category fit the selected socket.</div>'}${hardpoint ? '<button class="part-option clear" data-part=""><span class="part-clear-mark">−</span><span class="part-copy"><b class="part-name">Clear selected socket</b><small class="part-blurb">Leave this mount empty.</small><span class="part-statline">Free · removes the fitted component</span></span><span class="part-fit">Clear</span></button>' : ''}</div></section>

      ${this.renderInspector(installedPart)}
      <section class="builder-section fit-options"><div class="section-heading"><div><span class="section-label">Fit behaviour</span><p>Mirroring applies the same component to paired port and starboard mounts.</p></div></div><button class="mirror-toggle ${this.mirror ? 'active' : ''}" id="builder-mirror" aria-pressed="${this.mirror}"><span class="toggle-track"><i></i></span><span><b>${this.mirror ? 'Mirror paired mounts' : 'Single mount only'}</b><small>${this.mirror ? 'Paired sockets receive the same fit.' : 'Only the selected socket changes.'}</small></span></button></section>
      <section class="builder-section inspection-tools"><div class="section-heading"><div><span class="section-label">Inspection view</span><p>Drag the ship to inspect it. Camera position stays through edits.</p></div></div><div class="view-buttons"><button class="secondary-button" id="builder-view-reset">Reset view</button><button class="secondary-button" id="builder-view-top">Top</button><button class="secondary-button" id="builder-view-side">Side</button></div></section>
      <section class="builder-section stats-section"><div class="section-heading"><div><span class="section-label">Flight readout</span><p>Live values from the current draft.</p></div></div><div class="builder-stats"><div><span>Dry mass</span><strong>${(this.stats.dryMass / 1000).toFixed(1)} t</strong></div><div><span>Thrust</span><strong>${(this.stats.thrust / 1e6).toFixed(2)} MN</strong></div><div><span>Acceleration</span><strong>${this.stats.gees.toFixed(2)} g</strong></div><div><span>Attitude</span><strong>${this.stats.torque.toFixed(2)}</strong></div><div><span>Propellant</span><strong>${(this.stats.fuel / 1000).toFixed(1)} t</strong></div><div><span>Hull</span><strong>${Math.round(this.stats.hull)}</strong></div><div><span>Heat shed</span><strong>${this.stats.cooling.toFixed(2)}/s</strong></div><div><span>Ore hold</span><strong>${Math.round(this.stats.cargo)} u</strong></div><div><span>Weapon mounts</span><strong>${this.stats.mounts.length}</strong></div></div></section>
      ${status}${this.stats.warnings.length ? `<div class="builder-advisories"><span class="section-label">Mission notes</span><ul>${this.stats.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>` : ''}${this.notice ? `<p class="builder-notice ${this.notice.kind}" role="status" aria-live="polite">${escapeHtml(this.notice.text)}</p>` : ''}<footer class="builder-actions"><button class="secondary-button" id="builder-save">Save draft</button><button class="primary-button" id="builder-launch" ${launchReady ? '' : `disabled title="${escapeHtml(this.stats.problems[0] ?? 'Complete the required systems first.')}"`}>${launchReady ? 'Launch valid build' : 'Launch blocked'}</button></footer><p class="builder-free-note">All shipyard components are free. You design. Drafts save whether valid or unfinished.</p></div>`;

    const manifest = this.panel.querySelector('.manifest-scroll'); if (manifest) manifest.scrollTop = manifestScroll;
    const catalog = this.panel.querySelector('.part-list'); if (catalog) catalog.scrollTop = catalogScroll;
    this.panel.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(button => button.addEventListener('click', () => { this.selectedPartId = button.dataset.part; this.install(button.dataset.part ?? null); }));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-socket]').forEach(button => button.addEventListener('click', () => this.selectSocket(button.dataset.socket!)));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(button => button.addEventListener('click', () => { this.filter = (button.dataset.category ?? 'all') as PartCategory | 'all'; this.renderPanel(); }));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-core]').forEach(button => button.addEventListener('click', () => this.pickCore(button.dataset.core!)));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => this.applyPreset(button.dataset.preset as PresetId)));
    this.panel.querySelector('#builder-close')?.addEventListener('click', () => this.host.close());
    this.panel.querySelector('#builder-mirror')?.addEventListener('click', () => { this.mirror = !this.mirror; this.renderPanel(); });
    this.panel.querySelector('#builder-view-reset')?.addEventListener('click', () => this.bay.resetInspectionView());
    this.panel.querySelector('#builder-view-top')?.addEventListener('click', () => this.bay.setInspectionView('top'));
    this.panel.querySelector('#builder-view-side')?.addEventListener('click', () => this.bay.setInspectionView('side'));
    this.panel.querySelector('#builder-save')?.addEventListener('click', () => { this.syncName(); this.host.save(this.build); this.notice = { kind: 'ok', text: 'Draft saved to the yard.' }; this.renderPanel(); });
    this.panel.querySelector('#builder-launch')?.addEventListener('click', () => { this.syncName(); if (launchReady) this.host.launch(this.build); });
  }
}
