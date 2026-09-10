/**
 * Screen and overlay router (Plan A1/A2). Local navigation is deliberately separate from authority
 * state: `phase`, `life`, `presence` and `link` select the base screen, while the pilot may open an
 * overlay on top of a live match. Opening the menu therefore never changes the phase and never
 * stops the simulation.
 *
 * The router is pure: it takes the current state plus a snapshot of the session view and returns
 * the next state plus a list of effects for the shell to execute. That is what makes "every control
 * resolves to a real transition" a testable claim rather than a hope.
 */

import type {
  ClientView, Command, ConnectOptions, Fit, Id, Life, LinkState, Overlay, Phase, Presence, Screen, SessionPort, SlotKind,
} from '../shared/contracts.ts';
import { RELEASE } from '../shared/contracts.ts';
import { defaultFit, deriveFit } from '../shared/catalog.ts';
import type { BootAsset } from './screens/boot.ts';
import type { JoinError } from './screens/join.ts';
import type { HostSetup } from './ports.ts';
import type { LobbyDraft } from './screens/lobby.ts';
import type { SettingsPageId } from './screens/settings.ts';

export type ReleaseReason = Parameters<SessionPort['releaseControls']>[0];

/** Authority projection. The UI never writes any of it. */
export interface Authority {
  readonly phase: Phase | null;
  readonly life: Life;
  readonly presence: Presence;
  readonly link: LinkState;
  readonly screenHint: Screen;
  /** `local` is an isolated offline authority; `lan` keeps running under any overlay. */
  readonly transport: 'lan' | 'local' | null;
}

export interface AuthorityDisplay {
  readonly phaseLabel: string;
  readonly paused: boolean;
}

export interface Drafts {
  /** In-progress callsign edit in the lobby; a roster update must never replace this text. */
  readonly name: LobbyDraft | null;
  readonly joinName: string;
  readonly joinAddress: string;
  readonly joinCode: string;
  /** Hangar draft build; kept intact when the authority rejects it. */
  readonly fit: Fit | null;
  readonly fitRejection: string | null;
}

export interface Confirm {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly action: string;
  readonly data: Readonly<Record<string, string>>;
}

/** Base screens plus boot, which exists before an authority does. */
export type ShellScreen = Screen | 'boot';

export interface ShellState {
  readonly screen: ShellScreen;
  readonly overlay: Overlay;
  readonly overlayStack: readonly Overlay[];
  readonly overlayOrigin: string | null;
  readonly confirm: Confirm | null;
  readonly tabs: Readonly<Record<string, string>>;
  readonly pages: Readonly<Record<string, number>>;
  readonly selected: Readonly<Record<string, string>>;
  readonly drafts: Drafts;
  readonly notice: string | null;
  readonly noticeKind: 'info' | 'error' | 'success';
  readonly busy: boolean;
  readonly copyFailed: boolean;
  readonly joinError: JoinError | null;
  readonly joinNeedsCode: boolean;
  readonly recentHosts: readonly string[];
  readonly selectedPilotId: Id | null;
  readonly selectedMissionId: Id | null;
  readonly hostPolicy: HostSetup['joinPolicy'];
  readonly hostMode: HostSetup['mode'];
  readonly settingsDirty: boolean;
  readonly settingsNotice: string | null;
  /** Radar collapse is local presentation; it is never sent to the authority. */
  readonly radarCollapsed: boolean;
  /** Cinematic view toggle (V): presentation only. */
  readonly cinematic: boolean;
  /** Contact the pilot has locked from the aim pad; null when nothing is targetable. */
  readonly lockedContactId: Id | null;
  readonly originFocus: string | null;
}

export interface UiAction {
  readonly id: string;
  readonly data?: Readonly<Record<string, string>>;
}

export type Effect =
  | { readonly kind: 'command'; readonly command: Command; readonly requestId: string }
  | { readonly kind: 'connect'; readonly options: ConnectOptions }
  | { readonly kind: 'cancel-connect' }
  | { readonly kind: 'release'; readonly reason: ReleaseReason }
  | { readonly kind: 'copy'; readonly text: string; readonly target: 'link' | 'code' }
  | { readonly kind: 'cue'; readonly name: string }
  | { readonly kind: 'settings'; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly kind: 'settings-reset'; readonly category: string }
  | { readonly kind: 'export' }
  | { readonly kind: 'host'; readonly action: 'start' | 'stop' | 'refresh' | 'claim' | 'configure'; readonly data?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'focus'; readonly key: string }
  | { readonly kind: 'reload-assets' }
  | { readonly kind: 'end-session'; readonly reason: 'disposed' | 'left' }
  | { readonly kind: 'unknown-action'; readonly action: string };

export interface Transition {
  readonly state: ShellState;
  readonly effects: readonly Effect[];
}

export interface RouterContext {
  readonly view: ClientView;
  readonly authority: Authority;
  readonly host: HostSetup | null;
  readonly savedCampaign: { readonly owner: 'host' | 'device'; readonly location: string; readonly savedAt: string | null } | null;
  readonly webgl: { readonly ok: boolean; readonly detail: string | null };
  readonly assets: readonly BootAsset[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly settingsVersion: number;
  readonly appVersion: string;
  readonly phone: boolean;
  readonly availableHeight: number;
  readonly overlayMarkup: string;
  readonly progress: string | null;
  readonly blockers: readonly string[];
  readonly captain: boolean;
  readonly selfPilotId: Id;
}

/** Phase -> base screen. A local overlay may sit on top; the base screen never drifts. */
export function screenForPhase(phase: Phase | null, hint: Screen): Screen {
  switch (phase) {
    case 'lobby': return 'lobby';
    case 'loading':
    case 'countdown':
    case 'live':
    case 'extraction':
      return 'flight';
    case 'settlement':
    case 'debrief':
      return 'debrief';
    default:
      return hint;
  }
}

export function authorityOf(view: ClientView, transport: 'lan' | 'local' | null): Authority {
  return {
    phase: view.phase,
    life: view.self?.ship.life ?? 'staged',
    presence: view.lobby?.roster?.find(entry => entry.pilotId === view.pilotId)?.presence ?? (view.link === 'reconnecting' ? 'reconnecting' : 'connected'),
    link: view.link,
    screenHint: view.screenHint,
    transport,
  };
}

/**
 * A live LAN match keeps its clock running under an overlay; only an isolated offline authority may
 * ever claim to be paused, and the label says which one the pilot is looking at.
 */
export function authorityDisplay(authority: Authority): AuthorityDisplay {
  const live = authority.phase === 'countdown' || authority.phase === 'live' || authority.phase === 'extraction';
  return {
    phaseLabel: authority.phase ?? 'offline',
    paused: live && authority.transport === 'local',
  };
}

export function createInitialState(options: { recentHosts?: readonly string[]; pilotName?: string } = {}): ShellState {
  return {
    screen: 'boot',
    overlay: 'none',
    overlayStack: [],
    overlayOrigin: null,
    confirm: null,
    tabs: { lobby: 'crew', hangar: 'fit', settings: 'flight', help: 'flying' },
    pages: { lobby: 0, hangar: 0 },
    selected: { hangar: 'w1' },
    drafts: {
      name: null,
      joinName: options.pilotName ?? '',
      joinAddress: '',
      joinCode: '',
      fit: null,
      fitRejection: null,
    },
    notice: null,
    noticeKind: 'info',
    busy: false,
    copyFailed: false,
    joinError: null,
    joinNeedsCode: false,
    recentHosts: options.recentHosts ?? [],
    selectedPilotId: null,
    selectedMissionId: null,
    hostPolicy: 'open',
    hostMode: 'campaign',
    settingsDirty: false,
    settingsNotice: null,
    radarCollapsed: false,
    cinematic: false,
    lockedContactId: null,
    originFocus: null,
  };
}

const record = <T>(base: Readonly<Record<string, T>>, key: string, value: T): Readonly<Record<string, T>> => ({ ...base, [key]: value });

const OVERLAY_LAYER: readonly Overlay[] = ['none', 'menu', 'map', 'scoreboard', 'settings', 'help'];

/** Escape closes exactly one layer: confirm -> overlay -> back to the authority's base screen. */
export function escapeLayer(state: ShellState, ctx: RouterContext): Transition {
  if (state.confirm) return { state: { ...state, confirm: null, originFocus: state.confirm.id }, effects: [{ kind: 'focus', key: state.confirm.id }] };
  if (state.overlay !== 'none') return closeOverlay(state);
  const base = screenForPhase(ctx.authority.phase, ctx.authority.screenHint);
  if (state.screen !== base) return { state: { ...state, screen: base }, effects: [{ kind: 'release', reason: 'overlay' }] };
  return { state, effects: [] };
}

export function closeOverlay(state: ShellState): Transition {
  const stack = state.overlayStack.slice(0, -1);
  const overlay = stack.length > 0 ? stack[stack.length - 1]! : 'none';
  return {
    state: { ...state, overlay, overlayStack: stack, originFocus: state.overlayOrigin },
    effects: [
      { kind: 'release', reason: 'overlay' },
      ...(state.overlayOrigin ? [{ kind: 'focus' as const, key: state.overlayOrigin }] : []),
    ],
  };
}

function openOverlay(state: ShellState, overlay: Overlay, action: UiAction): Transition {
  return {
    state: { ...state, overlay, overlayStack: [...state.overlayStack, overlay], overlayOrigin: action.data?.origin ?? state.overlayOrigin },
    // Opening an overlay is not a phase change; it only releases captured controls.
    effects: [{ kind: 'release', reason: 'overlay' }],
  };
}

/** Actions that destroy work or drop the pilot out of a match ask first. */
const CONFIRMATIONS: Readonly<Record<string, Confirm>> = {
  'lobby.leave': { id: 'lobby.leave', title: 'Leave the lobby?', detail: 'Your seat is given up immediately.', confirmLabel: 'Leave', cancelLabel: 'Stay', action: 'lobby.leave', data: {} },
  'loading.cancel': { id: 'loading.cancel', title: 'Cancel the launch?', detail: 'The crew returns to the lobby.', confirmLabel: 'Cancel launch', cancelLabel: 'Keep waiting', action: 'loading.cancel', data: {} },
  'hangar.revert': { id: 'hangar.revert', title: 'Discard this draft?', detail: 'The fitted build is kept; unsaved changes are lost.', confirmLabel: 'Discard draft', cancelLabel: 'Keep editing', action: 'hangar.revert', data: {} },
  'hangar.loaner': { id: 'hangar.loaner', title: 'Take the loaner build?', detail: 'Your current draft is replaced by the loaner.', confirmLabel: 'Take loaner', cancelLabel: 'Keep draft', action: 'hangar.loaner', data: {} },
  'host.stop': { id: 'host.stop', title: 'Stop hosting?', detail: 'Connected guests lose the lobby. The last checkpoint stays on this PC.', confirmLabel: 'Stop host', cancelLabel: 'Keep hosting', action: 'host.stop', data: {} },
  'debrief.leave': { id: 'debrief.leave', title: 'Leave the crew?', detail: 'You can rejoin with the same link while the seat is held.', confirmLabel: 'Leave', cancelLabel: 'Stay', action: 'debrief.leave', data: {} },
  'settings.reset-all': { id: 'settings.reset-all', title: 'Reset every setting?', detail: 'All categories return to their defaults.', confirmLabel: 'Reset all', cancelLabel: 'Keep settings', action: 'settings.reset-all', data: {} },
};

function revision(ctx: RouterContext): number {
  return ctx.view.lobby?.revision ?? ctx.view.campaign?.inventoryRevision ?? 0;
}

/**
 * The build the local pilot actually owns: their lobby seat's fit while in a lobby, otherwise the
 * fitted ship in a live match. The hangar edits this, never a copy it invented.
 */
export function ownedFit(ctx: RouterContext): Fit | null {
  const seat = ctx.view.lobby?.roster.find(entry => entry.pilotId === ctx.view.pilotId);
  return seat?.fit ?? ctx.view.self?.ship.fit ?? null;
}

function nextRequestId(action: string): string {
  return `req-${action}-${requestCounter++}`;
}

let requestCounter = 0;

function navigate(state: ShellState, screen: ShellScreen, effects: readonly Effect[] = []): Transition {
  return { state: { ...state, screen, confirm: null }, effects };
}

function commandTransition(state: ShellState, payload: Command, action: UiAction): Transition {
  return { state: { ...state, busy: true }, effects: [{ kind: 'command', command: payload, requestId: nextRequestId(action.id) }] };
}

export function dispatch(state: ShellState, action: UiAction, ctx: RouterContext): Transition {
  const data = action.data ?? {};
  const requested = state.confirm ? null : CONFIRMATIONS[action.id];
  if (requested && !data.confirmed) {
    return { state: { ...state, confirm: requested, originFocus: action.id }, effects: [] };
  }
  const page = Number(data.page ?? Number.NaN);
  const selfPilot = ctx.view.lobby?.roster.find(entry => entry.pilotId === ctx.selfPilotId);
  const readyNow = selfPilot ? selfPilot.readyRevision !== null : false;

  switch (action.id) {
    // ---- boot / title ---------------------------------------------------------------------
    case 'boot.retry':
      return { state: { ...state, busy: true }, effects: [{ kind: 'reload-assets' }, { kind: 'cue', name: 'ui-click' }] };
    case 'boot.help':
      return openOverlay({ ...state, screen: 'title' }, 'help', action);
    case 'boot.continue':
      return navigate(state, 'title');
    case 'title.resume':
      return navigate(state, 'campaign');
    case 'title.offline':
      return { state: { ...state, busy: true, joinError: null }, effects: [{ kind: 'connect', options: { transport: 'local', pilotName: state.drafts.joinName || 'Pilot' } }] };
    case 'title.join':
      return navigate(state, 'join');
    case 'title.host':
      return navigate(state, 'host');
    case 'title.settings':
      return openOverlay(state, 'settings', action);
    case 'title.help':
      return openOverlay(state, 'help', action);

    // ---- host -----------------------------------------------------------------------------
    case 'host.back':
      return navigate(state, 'title');
    case 'host.copy-link': {
      const text = ctx.host?.guestOrigin ?? '';
      return { state: { ...state, copyFailed: false }, effects: [{ kind: 'copy', text, target: 'link' }] };
    }
    case 'host.copy-code':
      return { state: { ...state, copyFailed: false }, effects: [{ kind: 'copy', text: ctx.host?.roomCode ?? '', target: 'code' }] };
    case 'host.choose-adapter':
      return { state: { ...state, notice: 'Pick LAN to publish an address guests can reach.', noticeKind: 'info' }, effects: [{ kind: 'host', action: 'refresh' }] };
    case 'host.policy-open':
      return { state: { ...state, hostPolicy: 'open' }, effects: [{ kind: 'host', action: 'configure', data: { joinPolicy: 'open' } }] };
    case 'host.policy-code':
      return { state: { ...state, hostPolicy: 'code' }, effects: [{ kind: 'host', action: 'configure', data: { joinPolicy: 'code' } }] };
    case 'host.policy-closed':
      return { state: { ...state, hostPolicy: 'closed' }, effects: [{ kind: 'host', action: 'configure', data: { joinPolicy: 'closed' } }] };
    case 'host.mode-campaign':
      return { state: { ...state, hostMode: 'campaign' }, effects: [{ kind: 'host', action: 'configure', data: { mode: 'campaign' } }] };
    case 'host.mode-pvp':
      return { state: { ...state, hostMode: 'team-deathmatch' }, effects: [{ kind: 'host', action: 'configure', data: { mode: 'team-deathmatch' } }] };
    case 'host.mode-skirmish':
      return { state: { ...state, hostMode: 'skirmish' }, effects: [{ kind: 'host', action: 'configure', data: { mode: 'skirmish' } }] };
    case 'host.start':
      return { state: { ...state, busy: true }, effects: [{ kind: 'host', action: 'start' }] };
    case 'host.refresh':
      return { state: { ...state, busy: true }, effects: [{ kind: 'host', action: 'refresh' }] };
    case 'host.stop':
      return { state: { ...state, busy: true }, effects: [{ kind: 'host', action: 'stop' }] };
    case 'host.claim':
      return { state, effects: [{ kind: 'host', action: 'claim' }] };

    // ---- join -----------------------------------------------------------------------------
    case 'join.back':
      return navigate(state, 'title');
    case 'join.settings':
      return openOverlay(state, 'settings', action);
    case 'join.recent':
      return { state: { ...state, drafts: { ...state.drafts, joinAddress: data.host ?? state.drafts.joinAddress }, joinError: null }, effects: [] };
    case 'join.forget':
      return { state: { ...state, recentHosts: state.recentHosts.filter(host => host !== data.host) }, effects: [] };
    case 'join.connect':
      return {
        state: { ...state, busy: true, joinError: null },
        effects: [{ kind: 'connect', options: {
          transport: 'lan',
          address: state.drafts.joinAddress,
          roomCode: state.drafts.joinCode || undefined,
          pilotName: state.drafts.joinName.trim(),
        } }],
      };
    case 'join.retry':
      return { state: { ...state, busy: true, joinError: null }, effects: [{ kind: 'connect', options: {
        transport: 'lan',
        address: state.drafts.joinAddress,
        roomCode: state.drafts.joinCode || undefined,
        pilotName: state.drafts.joinName.trim(),
      } }] };
    case 'join.cancel':
      return { state: { ...state, busy: false }, effects: [{ kind: 'cancel-connect' }] };

    // ---- lobby ----------------------------------------------------------------------------
    case 'lobby.select':
      return { state: { ...state, selectedPilotId: data.pilot ?? state.selectedPilotId }, effects: [cue()] };
    case 'lobby.rename':
      return { state: { ...state, selectedPilotId: data.pilot ?? state.selectedPilotId, drafts: { ...state.drafts, name: { pilotId: data.pilot ?? ctx.selfPilotId, value: selfPilot?.name ?? '', dirty: false } } }, effects: [] };
    case 'lobby.commit-name': {
      const draft = state.drafts.name;
      if (!draft || draft.value.trim().length === 0) return { state: { ...state, drafts: { ...state.drafts, name: null } }, effects: [] };
      return commandTransition({ ...state, drafts: { ...state.drafts, name: null } }, { kind: 'set-pilot', expectedRevision: revision(ctx), name: draft.value.trim() }, action);
    }
    case 'lobby.cancel-name':
      return { state: { ...state, drafts: { ...state.drafts, name: null }, originFocus: `lobby-name-${data.pilot}` }, effects: [{ kind: 'focus', key: `lobby-name-${data.pilot}` }] };
    case 'lobby.captain-transfer':
      return commandTransition(state, { kind: 'captain', expectedRevision: revision(ctx), action: 'transfer', pilotId: data.pilot ?? '' }, action);
    case 'lobby.remove-seat':
      return commandTransition(state, { kind: 'captain', expectedRevision: revision(ctx), action: 'remove-seat', pilotId: data.pilot ?? '' }, action);
    case 'lobby.bot-fill':
      return commandTransition(state, { kind: 'bot-fill', expectedRevision: revision(ctx), total: Number(data.seat ?? 0) + 1, difficulty: 'normal' }, action);
    case 'lobby.mode-campaign':
      return commandTransition(state, { kind: 'edit-lobby', expectedRevision: revision(ctx), patch: { mode: 'campaign' } }, action);
    case 'lobby.mode-pvp':
      return commandTransition(state, { kind: 'edit-lobby', expectedRevision: revision(ctx), patch: { mode: 'team-deathmatch' } }, action);
    case 'lobby.mode-skirmish':
      return commandTransition(state, { kind: 'edit-lobby', expectedRevision: revision(ctx), patch: { mode: 'skirmish' } }, action);
    case 'lobby.map-belt':
      return commandTransition(state, { kind: 'edit-lobby', expectedRevision: revision(ctx), patch: { mapId: 'belt' } }, action);
    case 'lobby.map-relay':
      return commandTransition(state, { kind: 'edit-lobby', expectedRevision: revision(ctx), patch: { mapId: 'relay' } }, action);
    case 'lobby.page-prev':
      return { state: { ...state, pages: record(state.pages, 'lobby', Math.max(0, Number.isFinite(page) ? page : 0)) }, effects: [] };
    case 'lobby.page-next':
      return { state: { ...state, pages: record(state.pages, 'lobby', Math.max(0, Number.isFinite(page) ? page : 0)) }, effects: [] };
    case 'lobby.tab-crew':
      return { state: { ...state, tabs: record(state.tabs, 'lobby', 'crew') }, effects: [cue()] };
    case 'lobby.tab-mission':
      return { state: { ...state, tabs: record(state.tabs, 'lobby', 'mission') }, effects: [cue()] };
    case 'lobby.tab-fit':
      return { state: { ...state, tabs: record(state.tabs, 'lobby', 'fit') }, effects: [cue()] };
    case 'lobby.hangar':
      return navigate(state, 'hangar');
    case 'lobby.ready':
      return commandTransition(state, { kind: 'ready', expectedRevision: revision(ctx), ready: !readyNow }, action);
    case 'lobby.start':
      return commandTransition(state, { kind: 'start', expectedRevision: revision(ctx) }, action);
    case 'lobby.leave':
      return { state: { ...state, screen: 'title', busy: false }, effects: [{ kind: 'command', command: { kind: 'leave' }, requestId: nextRequestId(action.id) }, { kind: 'end-session', reason: 'left' }] };
    case 'lobby.order-regroup':
      return commandTransition(state, { kind: 'crew-order', order: 'regroup', contactId: null }, action);
    case 'lobby.order-defend':
      return commandTransition(state, { kind: 'crew-order', order: 'defend', contactId: null }, action);
    case 'lobby.order-recover':
      return commandTransition(state, { kind: 'crew-order', order: 'recover', contactId: null }, action);
    case 'lobby.order-focus':
      return commandTransition(state, { kind: 'crew-order', order: 'focus', contactId: firstContact(ctx) }, action);

    // ---- campaign -------------------------------------------------------------------------
    case 'campaign.mission':
      return { state: { ...state, selectedMissionId: data.mission ?? state.selectedMissionId }, effects: [] };
    case 'campaign.vote':
      return commandTransition(state, { kind: 'vote', decisionId: data.decision ?? '', optionId: data.option ?? '' }, action);
    case 'campaign.save-retry':
      return commandTransition(state, { kind: 'recovery', action: 'retry-checkpoint' }, action);
    case 'campaign.journal':
      return openOverlay(state, 'map', action);
    case 'campaign.deploy':
      return commandTransition(state, { kind: 'start', expectedRevision: revision(ctx) }, action);
    case 'campaign.hangar':
      return navigate(state, 'hangar');
    case 'campaign.back':
      return navigate(state, 'title');

    // ---- hangar ---------------------------------------------------------------------------
    case 'hangar.tab-fit':
      return { state: { ...state, tabs: record(state.tabs, 'hangar', 'fit') }, effects: [cue()] };
    case 'hangar.tab-fire-groups':
      return { state: { ...state, tabs: record(state.tabs, 'hangar', 'fire-groups') }, effects: [cue()] };
    case 'hangar.tab-systems':
      return { state: { ...state, tabs: record(state.tabs, 'hangar', 'systems') }, effects: [cue()] };
    case 'hangar.tab-paint':
      return { state: { ...state, tabs: record(state.tabs, 'hangar', 'paint') }, effects: [cue()] };
    case 'hangar.hardpoint':
      return { state: { ...state, selected: record(state.selected, 'hangar', data.hardpoint ?? 'w1'), pages: record(state.pages, 'hangar', 0) }, effects: [cue()] };
    case 'hangar.part':
      return { state: { ...state, selected: record(state.selected, 'hangar-part', data.part ?? '') }, effects: [cue()] };
    case 'hangar.page-prev':
      return { state: { ...state, pages: record(state.pages, 'hangar', Math.max(0, Number.isFinite(page) ? page : 0)) }, effects: [] };
    case 'hangar.page-next':
      return { state: { ...state, pages: record(state.pages, 'hangar', Math.max(0, Number.isFinite(page) ? page : 0)) }, effects: [] };
    case 'hangar.fit-part': {
      const base = state.drafts.fit ?? ownedFit(ctx);
      if (!base || !data.part || !data.slot) return { state, effects: [] };
      const draft: Fit = { ...base, slots: { ...base.slots, [data.slot]: data.part } };
      const derived = deriveFit(draft);
      return {
        state: { ...state, drafts: { ...state.drafts, fit: draft, fitRejection: derived.valid ? null : derived.errors.join(', ') } },
        effects: [{ kind: 'cue', name: derived.valid ? 'ui-click' : 'ui-denied' }],
      };
    }
    case 'hangar.clear-slot': {
      const base = state.drafts.fit ?? ownedFit(ctx);
      if (!base || !data.slot) return { state, effects: [] };
      const slots = { ...base.slots };
      delete slots[data.slot];
      return { state: { ...state, drafts: { ...state.drafts, fit: { ...base, slots } } }, effects: [] };
    }
    case 'hangar.cycle-group': {
      const base = state.drafts.fit ?? ownedFit(ctx);
      if (!base || !data.slot) return { state, effects: [] };
      const groups = base.fireGroups.length > 0 ? base.fireGroups : [[data.slot]];
      const current = groups.findIndex(group => group.includes(data.slot));
      const from = current === -1 ? 0 : current;
      const next = groups.map((group, index) => index === from ? group.filter(slot => slot !== data.slot) : group);
      const target = (from + 1) % Math.max(1, groups.length);
      next[target] = [...(next[target] ?? []), data.slot];
      return { state: { ...state, drafts: { ...state.drafts, fit: { ...base, fireGroups: next.filter(group => group.length > 0) } } }, effects: [] };
    }
    case 'hangar.power-up': {
      const base = state.drafts.fit ?? ownedFit(ctx);
      if (!base || !data.kind) return { state, effects: [] };
      return { state: { ...state, drafts: { ...state.drafts, fit: { ...base, powerPriority: reorder(base.powerPriority, data.kind, -1) } } }, effects: [] };
    }
    case 'hangar.power-down': {
      const base = state.drafts.fit ?? ownedFit(ctx);
      if (!base || !data.kind) return { state, effects: [] };
      return { state: { ...state, drafts: { ...state.drafts, fit: { ...base, powerPriority: reorder(base.powerPriority, data.kind, 1) } } }, effects: [] };
    }
    case 'hangar.paint': {
      const base = state.drafts.fit ?? ownedFit(ctx);
      if (!base || !data.paint) return { state, effects: [] };
      return { state: { ...state, drafts: { ...state.drafts, fit: { ...base, paintId: data.paint } } }, effects: [] };
    }
    case 'hangar.repair-module':
      return commandTransition(state, { kind: 'inventory', expectedRevision: revision(ctx), action: 'repair', itemId: data.slot ?? '' }, action);
    case 'hangar.revert':
      return { state: { ...state, drafts: { ...state.drafts, fit: null, fitRejection: null } }, effects: [{ kind: 'release', reason: 'overlay' }] };
    case 'hangar.loaner': {
      const chassisId = state.drafts.fit?.chassisId ?? ownedFit(ctx)?.chassisId ?? 'kestrel';
      const loaner = defaultFit(chassisId);
      const derived = deriveFit(loaner);
      // The reference build is only offered when it is legal; otherwise the pilot keeps the draft.
      return {
        state: { ...state, drafts: { ...state.drafts, fit: derived.valid ? loaner : state.drafts.fit, fitRejection: derived.valid ? null : `Loaner build is not legal: ${derived.errors.join(', ')}` } },
        effects: [],
      };
    }
    case 'hangar.commit': {
      const fit = state.drafts.fit ?? ownedFit(ctx);
      if (!fit) return { state, effects: [] };
      return commandTransition(state, { kind: 'set-pilot', expectedRevision: revision(ctx), fit }, action);
    }
    case 'hangar.back':
      return navigate(state, ctx.authority.phase === 'lobby' ? 'lobby' : 'title');

    // ---- loading --------------------------------------------------------------------------
    case 'loading.retry':
      return commandTransition(state, { kind: 'interact', entityId: data.pilot ?? '', action: 'recover' }, action);
    case 'loading.drop':
      return commandTransition(state, { kind: 'captain', expectedRevision: revision(ctx), action: 'remove-seat', pilotId: data.pilot ?? '' }, action);
    case 'loading.cancel':
      return commandTransition(state, { kind: 'return-lobby' }, action);
    case 'loading.deploy':
      return commandTransition(state, { kind: 'start', expectedRevision: revision(ctx) }, action);
    case 'loading.leave':
      return { state: { ...state, screen: 'title', busy: false }, effects: [{ kind: 'command', command: { kind: 'leave' }, requestId: nextRequestId(action.id) }, { kind: 'end-session', reason: 'left' }] };

    // ---- flight ---------------------------------------------------------------------------
    case 'flight.respawn':
      return commandTransition(state, { kind: 'request-respawn' }, action);
    case 'flight.call-rescue':
      return commandTransition(state, { kind: 'crew-order', order: 'recover', contactId: data.contact ?? null }, action);
    case 'flight.interact':
      return commandTransition(state, { kind: 'interact', entityId: data.entity ?? '', action: 'dock' }, action);
    case 'flight.return-lobby':
      return commandTransition(state, { kind: 'return-lobby' }, action);
    case 'hud.distress':
      return commandTransition(state, { kind: 'crew-order', order: 'recover', contactId: data.id ?? null }, action);
    case 'hud.radar-toggle':
      return { state: { ...state, radarCollapsed: !state.radarCollapsed }, effects: [] };
    case 'flight.cinematic':
      return { state: { ...state, cinematic: !state.cinematic }, effects: [] };
    case 'flight.reload':
      return commandTransition(state, { kind: 'reload', slotId: data.slot ?? ctx.view.weapons[0]?.slotId ?? '' }, action);
    case 'flight.sensor-mode':
      return commandTransition(state, { kind: 'sensor-mode', mode: data.mode === 'active' ? 'active' : 'passive' }, action);
    case 'flight.lock-cycle': {
      const targetable = ctx.view.contacts.filter(contact => contact.targetable);
      if (targetable.length === 0) return { state: { ...state, lockedContactId: null }, effects: [] };
      const step = Number(data.direction ?? 1) >= 0 ? 1 : -1;
      const index = targetable.findIndex(contact => contact.id === state.lockedContactId);
      const nextIndex = index < 0
        ? (step === 1 ? 0 : targetable.length - 1)
        : (index + step + targetable.length) % targetable.length;
      return { state: { ...state, lockedContactId: targetable[nextIndex]!.id }, effects: [] };
    }

    // ---- debrief --------------------------------------------------------------------------
    case 'debrief.continue':
      return commandTransition(state, { kind: 'return-lobby' }, action);
    case 'debrief.retry-save':
      return commandTransition(state, { kind: 'recovery', action: 'retry-checkpoint' }, action);
    case 'debrief.export':
      return { state: { ...state, notice: 'Exported a copy of the campaign.', noticeKind: 'success' }, effects: [{ kind: 'export' }] };
    case 'debrief.scoreboard':
      return openOverlay(state, 'scoreboard', action);
    case 'debrief.leave':
      return { state: { ...state, screen: 'title', busy: false }, effects: [{ kind: 'command', command: { kind: 'leave' }, requestId: nextRequestId(action.id) }, { kind: 'end-session', reason: 'left' }] };

    // ---- overlays -------------------------------------------------------------------------
    case 'overlay.menu':
      return openOverlay(state, 'menu', action);
    case 'overlay.map':
      return openOverlay(state, 'map', action);
    case 'overlay.scoreboard':
      return openOverlay(state, 'scoreboard', action);
    case 'overlay.settings':
      return openOverlay(state, 'settings', action);
    case 'overlay.help':
      return openOverlay(state, 'help', action);
    case 'overlay.close':
      return closeOverlay(state);
    case 'confirm.accept': {
      const confirm = state.confirm;
      if (!confirm) return { state, effects: [] };
      return dispatch({ ...state, confirm: null }, { id: confirm.action, data: { ...confirm.data, confirmed: 'true' } }, ctx);
    }
    case 'confirm.cancel':
      return { state: { ...state, confirm: null, originFocus: state.confirm?.id ?? null }, effects: state.confirm ? [{ kind: 'focus', key: state.confirm.id }] : [] };

    // ---- settings / help ------------------------------------------------------------------
    case 'settings.close':
      return closeOverlay(state);
    case 'settings.help':
      return { state: { ...state, overlay: 'help', overlayStack: [...state.overlayStack, 'help'] }, effects: [] };
    case 'help.close':
      return closeOverlay(state);
    case 'help.settings':
      return { state: { ...state, overlay: 'settings', overlayStack: [...state.overlayStack, 'settings'] }, effects: [] };
    case 'settings.export':
      return { state: { ...state, settingsNotice: 'Settings exported.' }, effects: [{ kind: 'export' }] };
    case 'settings.import':
      return { state: { ...state, settingsNotice: 'Import reads a settings file and applies it as a new copy.' }, effects: [] };
    case 'settings.reset':
      return { state: { ...state, settingsDirty: true }, effects: [{ kind: 'settings-reset', category: data.category ?? 'flight' }] };
    case 'settings.reset-all':
      return { state: { ...state, settingsDirty: true }, effects: [{ kind: 'settings-reset', category: 'all' }] };
    case 'settings.toggle': {
      const key = data.key ?? '';
      const current = ctx.settings[key];
      return { state: { ...state, settingsDirty: true }, effects: [{ kind: 'settings', patch: patchFor(key, current !== true) }] };
    }
    case 'controls.assign':
      return { state: { ...state, settingsNotice: `Press the new binding for ${data.action ?? 'this action'}. Escape cancels.` }, effects: [] };

    default:
      break;
  }

  if (action.id.startsWith('settings.page-')) {
    const id = action.id.slice('settings.page-'.length) as SettingsPageId;
    return { state: { ...state, tabs: record(state.tabs, 'settings', id) }, effects: [cue()] };
  }
  if (action.id.startsWith('help.page-')) {
    return { state: { ...state, tabs: record(state.tabs, 'help', action.id.slice('help.page-'.length)) }, effects: [cue()] };
  }
  return { state, effects: [{ kind: 'unknown-action', action: action.id }] };
}

/** Every interaction acknowledges itself; the mixer decides whether the cue is audible. */
function cue(): Effect {
  return { kind: 'cue', name: 'ui-click' };
}

function firstContact(ctx: RouterContext): Id | null {
  return ctx.view.contacts[0]?.id ?? null;
}

function reorder(priority: readonly SlotKind[], kind: string, direction: -1 | 1): readonly SlotKind[] {
  const list = [...priority];
  const index = list.indexOf(kind as SlotKind);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= list.length) return list;
  const swapped = list[index]!;
  list[index] = list[target]!;
  list[target] = swapped;
  return list;
}

/** Dotted `a.b` key -> the one-level patch the settings store expects. */
export function patchFor(key: string, value: unknown): Readonly<Record<string, unknown>> {
  const [category, leaf] = key.split('.');
  if (!category) return {};
  if (!leaf) return { [category]: value };
  return { [category]: { [leaf]: value } };
}

/** Reconciliation after every view update: a typed draft always wins over the roster name. */
export function reconcileDrafts(state: ShellState, view: ClientView): ShellState {
  const draft = state.drafts.name;
  if (!draft) return state;
  const entry = view.lobby?.roster.find(candidate => candidate.pilotId === draft.pilotId);
  if (!entry) return state;
  if (draft.dirty) return state;
  if (entry.name === draft.value) return state;
  return { ...state, drafts: { ...state.drafts, name: { ...draft, value: entry.name } } };
}

/** Room capacity includes seats reserved for a pilot inside the reconnect window. */
export function capacityOf(view: ClientView): number {
  const reserved = view.lobby?.roster.filter(entry => entry.presence === 'left').length ?? 0;
  return RELEASE.maxHumans + reserved;
}
