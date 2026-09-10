/**
 * State -> markup (Plan A2). One function per screen builds the props each screen module asks for;
 * the modules themselves stay dumb string builders so tests can assert them without a browser.
 * Nothing here reads layout: viewport decisions arrive through the router context.
 */

import type { ClientView, HostView, Id } from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import { CATALOG, slotKinds } from '../shared/catalog.ts';
import { normalizeAddress } from './address.ts';
import { derivationOf } from './derivation.ts';
import { cta, esc } from './dom.ts';
import { int } from './format.ts';
import { bootMarkup } from './screens/boot.ts';
import { campaignMarkup } from './screens/campaign.ts';
import { debriefMarkup, type DebriefEntry } from './screens/debrief.ts';
import { flightMarkup } from './screens/flight.ts';
import { hardpoints, hangarMarkup, type PartOption } from './screens/hangar.ts';
import { hostMarkup } from './screens/host.ts';
import { joinMarkup } from './screens/join.ts';
import { loadingMarkup, type LoadingSeat } from './screens/loading.ts';
import { lobbyMarkup, type LobbyProps } from './screens/lobby.ts';
import { helpMarkup, settingsMarkup, type SettingsPageId } from './screens/settings.ts';
import { titleMarkup } from './screens/title.ts';
import { hudModel } from './hud.ts';
import { ownedFit, type RouterContext, type ShellState } from './router.ts';
import type { HostSetup } from './ports.ts';

export interface Layout {
  readonly availableHeight: number;
  readonly phone: boolean;
}

function fallbackScreen(title: string, detail: string, actions: readonly string[]): string {
  return `<section class="screen empty" data-screen="empty"><h1>${esc(title)}</h1><p class="screen-copy">${esc(detail)}</p>${actions.join('')}</section>`;
}

function defaultHost(): HostSetup {
  return {
    launcher: 'unknown',
    launcherDetail: null,
    adapter: 'lan',
    port: 8080,
    guestOrigin: null,
    roomCode: null,
    joinPolicy: 'open',
    mode: 'campaign',
    isOperator: false,
    canStop: false,
  };
}

function hostOf(view: ClientView): HostView | null {
  return view.host;
}

/** Loading seats: the roster tells us who is here, the link tells us who is still fetching. */
function loadingSeats(view: ClientView): readonly LoadingSeat[] {
  const roster = view.lobby?.roster ?? [];
  return roster.map(entry => ({
    pilotId: entry.pilotId,
    name: entry.name,
    state: entry.presence === 'reconnecting' ? 'loading' : entry.isBot || view.link === 'online' ? 'ready' : 'loading',
    detail: entry.presence === 'reconnecting' ? 'Reconnecting' : null,
  }));
}

function partOptions(chassisId: Id, slotId: Id, currentFitSlots: Readonly<Record<Id, Id>>): readonly PartOption[] {
  const chassis = CATALOG.chassisById.get(chassisId);
  const slot = chassis ? slotKinds(chassisId).get(slotId) : undefined;
  if (!chassis || !slot) return [];
  return CATALOG.parts
    .filter(part => part.kind === slot.kind && part.size <= slot.size)
    .map(part => {
      const candidate = deriveFitFor(chassisId, { ...currentFitSlots, [slotId]: part.id });
      return {
        partId: part.id,
        name: part.name,
        role: `${part.kind}${part.behavior ? ` \u00b7 ${part.behavior}` : ''}`,
        cost: part.cost,
        massKg: part.massKg,
        valid: candidate.valid,
        reason: candidate.valid ? null : candidate.errors[0] ?? 'Not legal',
      };
    });
}

/** Candidate derivation through the shared function so the hangar cannot disagree with the server. */
function deriveFitFor(chassisId: Id, slots: Readonly<Record<Id, Id>>) {
  return derivationOf({ chassisId, paintId: 'default', slots, fireGroups: [], powerPriority: [] });
}

function debriefChanges(view: ClientView): readonly DebriefEntry[] {
  const debrief = view.debrief;
  if (!debrief) return [];
  const entries: DebriefEntry[] = [
    { label: 'Reward credits', value: `+${int(debrief.rewardCredits)}` },
    { label: 'Repair credits', value: `-${int(debrief.repairCredits)}` },
  ];
  const inventory = view.campaign?.inventory ?? [];
  for (const item of inventory.slice(0, 4)) entries.push({ label: item.partId, value: item.reservedByPilotId ? `reserved by ${item.reservedByPilotId}` : `health ${int(item.health)}` });
  return entries;
}

function lobbyProps(state: ShellState, ctx: RouterContext, view: ClientView, layout: Layout): LobbyProps {
  const lobby = view.lobby!;
  const selectedPilotId = state.selectedPilotId ?? ctx.selfPilotId;
  const selected = lobby.roster.find(entry => entry.pilotId === selectedPilotId) ?? lobby.roster[0]!;
  const pings: Record<Id, { latencyMs: number | null; stale: boolean }> = {};
  for (const entry of lobby.roster) {
    pings[entry.pilotId] = { latencyMs: entry.pingMs, stale: entry.presence !== 'connected' };
  }
  return {
    lobby,
    selfPilotId: ctx.selfPilotId,
    capacity: Math.max(RELEASE.maxHumans, lobby.roster.length),
    reservedSeats: lobby.roster.filter(entry => entry.presence === 'left').length,
    availableHeight: layout.availableHeight,
    phone: layout.phone,
    page: state.pages.lobby ?? 0,
    tab: (state.tabs.lobby ?? 'crew') as 'crew' | 'mission' | 'fit',
    selectedPilotId,
    draft: state.drafts.name,
    fit: derivationOf(selected.fit),
    fitDraft: state.drafts.fit ? derivationOf(state.drafts.fit) : null,
    pings,
    notice: state.notice,
    conflict: null,
  };
}

export function screenMarkup(state: ShellState, ctx: RouterContext, layout: Layout, overlayBody: string): string {
  const view = ctx.view;
  switch (state.screen) {
    case 'boot':
      return bootMarkup({
        appVersion: ctx.appVersion,
        protocol: RELEASE.protocol,
        contentVersion: RELEASE.contentVersion,
        webgl: ctx.webgl,
        assets: ctx.assets,
        error: state.noticeKind === 'error' ? state.notice : null,
        busy: state.busy,
      });

    case 'title':
      return titleMarkup({
        releaseLabel: `Protocol ${RELEASE.protocol} \u00b7 content ${RELEASE.contentVersion}`,
        progress: ctx.progress,
        resume: ctx.savedCampaign,
        offlineAvailable: ctx.webgl.ok,
        lanAvailable: true,
        notice: state.notice,
      });

    case 'host': {
      const setup = ctx.host ?? defaultHost();
      const hostView = hostOf(view);
      return hostMarkup({
        host: { ...setup, isOperator: setup.isOperator || hostView?.isOperator === true, canStop: setup.canStop || hostView?.canStop === true },
        copyFailed: state.copyFailed,
        busy: state.busy,
        progress: ctx.progress,
        claimUrl: hostView?.isOperator ? (hostView.guestOrigin ?? null) : null,
      });
    }

    case 'join': {
      const normalized = normalizeAddress(state.drafts.joinAddress);
      return joinMarkup({
        name: state.drafts.joinName,
        address: state.drafts.joinAddress,
        normalized,
        roomCode: state.drafts.joinCode,
        needsCode: state.joinNeedsCode,
        recent: state.recentHosts,
        error: state.joinError,
        busy: state.busy,
      });
    }

    case 'lobby':
      return view.lobby
        ? lobbyMarkup(lobbyProps(state, ctx, view, layout))
        : fallbackScreen('No lobby yet', 'Connect to a host to assemble a crew.', ['<button type="button" class="cta" data-action="join.back">Back</button>']);

    case 'campaign':
      return view.campaign
        ? campaignMarkup({
          campaign: view.campaign,
          currentMissionId: state.selectedMissionId,
          selectedMissionId: state.selectedMissionId ?? view.campaign.missions.find(mission => mission.state === 'available')?.id ?? view.campaign.missions[0]?.id ?? '',
          onHost: ctx.captain,
          deployBlockers: ctx.blockers,
        })
        : fallbackScreen('No campaign', 'This host is not running a campaign. Join a lobby instead.', ['<button type="button" class="cta" data-action="campaign.back">Back</button>']);

    case 'hangar': {
      const owned = ownedFit(ctx);
      const fit = state.drafts.fit ?? owned;
      const chassisId = fit?.chassisId ?? CATALOG.chassis[0]?.id ?? 'kestrel';
      const slot = state.selected.hangar ?? hardpoints(chassisId)[0]?.slotId ?? 'w1';
      const derivedCurrent = owned ? derivationOf(owned) : null;
      const derivedDraft = fit ? derivationOf(fit) : null;
      const commitBlockers = derivedDraft && derivedDraft.valid ? [] : [derivedDraft?.errors[0] ?? 'No build selected'];
      return hangarMarkup({
        chassisId,
        hardpoint: slot,
        parts: fit ? partOptions(chassisId, slot, fit.slots) : [],
        page: state.pages.hangar ?? 0,
        availableHeight: layout.availableHeight,
        phone: layout.phone,
        tab: (state.tabs.hangar ?? 'fit') as 'fit' | 'fire-groups' | 'systems' | 'paint',
        currentFit: owned ?? fit ?? { chassisId, paintId: 'default', slots: {}, fireGroups: [], powerPriority: [] },
        draftFit: fit ?? { chassisId, paintId: 'default', slots: {}, fireGroups: [], powerPriority: [] },
        selectedPartId: state.selected['hangar-part'] ?? null,
        revision: view.lobby?.revision ?? view.campaign?.inventoryRevision ?? 0,
        inventoryRevision: view.campaign?.inventoryRevision ?? 0,
        credits: view.campaign?.credits ?? 0,
        errors: derivedDraft && fit ? derivedDraft.errors : [],
        rejection: state.drafts.fitRejection,
        commitBlockers,
      });
    }

    case 'flight': {
      // The loading phase is its own screen with per-seat states; countdown and live share the HUD.
      if (ctx.authority.phase === 'loading') {
        const seats = loadingSeats(view);
        const blockers = seats.some(seat => seat.state === 'failed') ? ['Failed seats must be retried or dropped'] : [];
        return loadingMarkup({
          missionLabel: view.campaign?.name ?? view.map?.id ?? 'Mission',
          mapLabel: view.map?.id ?? 'No arena',
          seats,
          captain: ctx.captain,
          countdownSeconds: null,
          canDeploy: seats.every(seat => seat.state !== 'failed'),
          blockers,
        });
      }
      const hud = hudModel(view);
      if (!hud) return fallbackScreen('Standing by', 'Waiting for the authority to publish a ship.', ['<button type="button" class="cta" data-action="overlay.menu">Menu</button>']);
      return flightMarkup({
        hud,
        life: view.self?.ship.life ?? 'staged',
        respawnSeconds: view.respawnAtTick === null ? null : Math.max(0, (view.respawnAtTick - view.tick) / RELEASE.physicsHz),
        prompt: null,
        overlay: state.overlay,
        // The overlay markup is appended by the shell after the screen so it is never duplicated.
        overlayMarkup: '',
        canReturnToLobby: state.overlay !== 'none',
      });
    }

    case 'debrief':
      return view.debrief
        ? debriefMarkup({
          debrief: view.debrief,
          save: view.save,
          savedAt: view.campaign?.lastSavedAt ?? null,
          saveOwner: view.campaign?.saveOwner ?? 'host',
          captain: ctx.captain,
          selfPilotId: ctx.selfPilotId,
          teamScores: view.teamScores,
          objectives: view.objectives,
          changes: debriefChanges(view),
          blockers: ctx.blockers,
        })
        : settlementMarkup(view, ctx);

    default:
      return fallbackScreen('Unknown screen', `The shell has no screen named "${state.screen}".`, []);
  }
}

/**
 * Settlement has no published result yet: the pilot sees the save receipt progress and can retry,
 * export or leave, but never a fabricated outcome.
 */
function settlementMarkup(view: ClientView, ctx: RouterContext): string {
  const receipt = view.save === 'saved'
    ? 'Saved on host PC'
    : view.save === 'pending' ? 'Saving\u2026' : view.save === 'failed' ? 'Save failed' : 'Waiting for the host to settle';
  return '<section class="screen debrief settlement" data-screen="debrief" data-settlement="true">'
    + `<h1>${esc('Settling the match')}</h1>`
    + `<p class="screen-copy" role="status" data-save="${view.save}">${esc(receipt)}</p>`
    + (view.save === 'failed' ? `<p class="notice tone-error">${esc('The host kept the last checkpoint. Retry the save, or export a copy.')}</p>` : '')
    + `<div class="menu-footer">${cta('debrief.leave', 'Leave')}`
    + (view.save === 'failed' ? cta('debrief.retry-save', 'Retry save') + cta('debrief.export', 'Export copy') : '')
    + (ctx.captain ? cta('debrief.continue', 'Continue', { kind: 'primary' }) : `<span class="waiting-note" role="status">${esc('Waiting for the captain')}</span>`)
    + '</div></section>';
}

/** Settings and help are overlays, not screens, and both render one page at a time. */
export function overlayMarkup(state: ShellState, ctx: RouterContext): string {
  switch (state.overlay) {
    case 'settings': {
      const page = (state.tabs.settings ?? 'flight') as SettingsPageId;
      return `<div class="overlay" data-overlay="settings" data-overlay-kind="settings"><button type="button" class="cta ghost overlay-close" data-action="overlay.close">Close</button>${settingsMarkup({
        page,
        values: ctx.settings,
        version: ctx.settingsVersion,
        dirty: state.settingsDirty,
        notice: state.settingsNotice,
      })}</div>`;
    }
    case 'menu':
      return `<div class="overlay" data-overlay="menu" data-overlay-kind="menu"><h2>${esc('Paused menu')}</h2><p class="screen-copy">${esc(ctx.authority.transport === 'local' ? 'Offline authority paused.' : 'The match keeps running while this menu is open.')}</p>
        <button type="button" class="cta" data-action="overlay.close">Resume</button>
        <button type="button" class="cta" data-action="overlay.settings">Settings</button>
        <button type="button" class="cta" data-action="overlay.help">Help</button>
        <button type="button" class="cta" data-action="overlay.map">Map</button>
        <button type="button" class="cta" data-action="overlay.scoreboard">Scores</button></div>`;
    case 'map':
      return `<div class="overlay" data-overlay="map" data-overlay-kind="map"><h2>Map</h2><p class="screen-copy num">${esc(ctx.view.map ? `${ctx.view.map.id} \u00b7 ${int(ctx.view.map.boundsRadiusM)} m radius` : 'No arena loaded.')}</p><button type="button" class="cta" data-action="overlay.close">Close</button></div>`;
    case 'scoreboard':
      return `<div class="overlay" data-overlay="scoreboard" data-overlay-kind="scoreboard"><h2>Scores</h2><ul class="num">${Object.entries(ctx.view.teamScores).map(([team, score]) => `<li>${esc(team)} ${int(score)}</li>`).join('')}</ul><button type="button" class="cta" data-action="overlay.close">Close</button></div>`;
    case 'help':
      return `<div class="overlay" data-overlay="help" data-overlay-kind="help">${helpMarkup({ page: state.tabs.help ?? 'flying', notice: state.settingsNotice })}</div>`;
    default:
      return '';
  }
}

/** Confirmation dialog for destructive actions; it owns the focus until accepted or cancelled. */
export function confirmMarkup(state: ShellState): string {
  const confirm = state.confirm;
  if (!confirm) return '';
  return `<div class="overlay confirm" data-overlay="confirm" data-overlay-kind="confirm"><h2>${esc(confirm.title)}</h2><p class="screen-copy">${esc(confirm.detail)}</p><footer class="screen-actions"><button type="button" class="cta" data-action="confirm.cancel">${esc(confirm.cancelLabel)}</button><button type="button" class="cta primary" data-action="confirm.accept">${esc(confirm.confirmLabel)}</button></footer></div>`;
}
