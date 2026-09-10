/**
 * Lobby (Plan A2). Eight seats, exact blockers, paged crew on phones, and a name editor that keeps
 * whatever the pilot has typed: an incoming roster revision never discards a draft, and the input
 * keeps a stable focus key so the caret can be restored after a re-render.
 *
 * Readiness is revision-bound. The lobby shows who is ready for *this* revision, so a captain edit
 * visibly revokes it instead of leaving a stale green tick.
 */

import type { DerivedFit, Id, LobbyView, RosterEntry } from '../../shared/contracts.ts';
import { RELEASE } from '../../shared/contracts.ts';
import { cta, el, esc, field, notice, tab } from '../dom.ts';
import { group } from '../dom.ts';
import { fitComparison, int } from '../format.ts';
import { paginate, pagerLabel } from '../pagination.ts';

export interface PingQuality {
  readonly latencyMs: number | null;
  /** True when the sample is older than the heartbeat window. */
  readonly stale: boolean;
}

export interface LobbyDraft {
  readonly pilotId: Id;
  readonly value: string;
  /** True once the pilot typed; an untouched draft may still follow the roster. */
  readonly dirty: boolean;
}

export interface LobbyProps {
  readonly lobby: LobbyView;
  readonly selfPilotId: Id;
  readonly capacity: number;
  readonly reservedSeats: number;
  readonly availableHeight: number;
  /** Phones page four seats at a time; desktop shows as many rows as the height allows. */
  readonly phone: boolean;
  readonly page: number;
  readonly tab: 'crew' | 'mission' | 'fit';
  readonly selectedPilotId: Id | null;
  readonly draft: LobbyDraft | null;
  /** The selected pilot's committed derivation; the draft is the proposed side. */
  readonly fit: DerivedFit | null;
  readonly fitDraft: DerivedFit | null;
  readonly pings: Readonly<Record<Id, PingQuality>>;
  readonly notice: string | null;
  readonly conflict: string | null;
}

export function pingLabel(quality: PingQuality | undefined): { text: string; tone: 'signal' | 'caution' | 'threat' } {
  if (!quality || quality.latencyMs === null) return { text: 'Ping unknown', tone: 'caution' };
  if (quality.stale) return { text: `${int(quality.latencyMs)} ms (stale)`, tone: 'caution' };
  if (quality.latencyMs > 150) return { text: `${int(quality.latencyMs)} ms`, tone: 'threat' };
  if (quality.latencyMs > 60) return { text: `${int(quality.latencyMs)} ms`, tone: 'caution' };
  return { text: `${int(quality.latencyMs)} ms`, tone: 'signal' };
}

const PRESENCE_LABEL: Record<RosterEntry['presence'], string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  away: 'Away',
  left: 'Left',
};

function seatRow(entry: RosterEntry, props: LobbyProps, captainId: Id, isCaptain: boolean, selected: boolean): string {
  const editing = props.draft !== null && props.draft.pilotId === entry.pilotId;
  const ping = pingLabel(props.pings[entry.pilotId]);
  const named = editing
    ? el('span', { class: 'seat-editor' }, [
      field(`lobby-name-${entry.pilotId}`, props.draft!.value, { label: 'Callsign', key: `lobby-name-${entry.pilotId}`, maxLength: 20 }),
      cta('lobby.commit-name', 'Save', { kind: 'ghost', data: { pilot: entry.pilotId } }),
      cta('lobby.cancel-name', 'Cancel', { kind: 'ghost', data: { pilot: entry.pilotId } }),
    ])
    : el('button', {
      type: 'button',
      class: 'seat-name',
      'data-action': 'lobby.select',
      'data-pilot': entry.pilotId,
      'aria-pressed': selected ? 'true' : 'false',
    }, esc(entry.name));

  const actions = [
    cta('lobby.select', 'Crew', { kind: 'ghost', pressed: selected, data: { pilot: entry.pilotId } }),
    entry.pilotId === props.selfPilotId ? cta('lobby.rename', 'Rename', { kind: 'ghost', data: { pilot: entry.pilotId } }) : '',
    isCaptain && entry.pilotId !== captainId && !entry.isBot ? cta('lobby.captain-transfer', 'Make captain', { kind: 'ghost', data: { pilot: entry.pilotId } }) : '',
    isCaptain && entry.pilotId !== captainId ? cta('lobby.remove-seat', entry.isBot ? 'Remove bot' : 'Remove', { kind: 'ghost', data: { pilot: entry.pilotId } }) : '',
  ].join('');

  return el('li', {
    class: `seat presence-${entry.presence}${selected ? ' selected' : ''}`,
    'data-pilot': entry.pilotId,
    'data-seat': entry.seat,
  }, [
    el('span', { class: 'seat-index num' }, String(entry.seat + 1)),
    el('span', { class: 'seat-body' }, [
      named,
      el('span', { class: 'seat-meta' }, [
        entry.pilotId === captainId ? el('span', { class: 'tag tag-captain' }, 'Captain') : '',
        entry.isBot ? el('span', { class: 'tag' }, 'Bot') : '',
        el('span', { class: 'tag' }, PRESENCE_LABEL[entry.presence]),
        el('span', { class: `tag tone-${ping.tone}` }, ping.text),
        el('span', { class: 'tag' }, entry.teamId),
        entry.readyRevision !== null ? el('span', { class: 'tag tone-signal' }, 'Ready') : el('span', { class: 'tag tone-caution' }, 'Not ready'),
      ]),
    ]),
    el('span', { class: 'seat-actions' }, actions),
  ]);
}

function emptySeat(seat: number, props: LobbyProps, isCaptain: boolean): string {
  return el('li', { class: 'seat empty', 'data-seat': seat }, [
    el('span', { class: 'seat-index num' }, String(seat + 1)),
    el('span', { class: 'seat-body' }, el('span', { class: 'seat-name' }, 'Open seat')),
    el('span', { class: 'seat-actions' }, isCaptain
      ? cta('lobby.bot-fill', 'Add bot', { kind: 'ghost', data: { seat } })
      : el('span', { class: 'seat-meta' }, 'Captain can add a bot')),
  ]);
}

export function lobbyMarkup(props: LobbyProps): string {
  const { lobby } = props;
  const isCaptain = lobby.captainId === props.selfPilotId;
  const state = paginate(
    { availableHeight: props.availableHeight, fixedPx: 220, maxRows: props.phone ? 4 : 8 },
    RELEASE.maxHumans,
    lobby.roster.findIndex(entry => entry.pilotId === props.selectedPilotId),
    props.page,
  );
  const seats = Array.from({ length: RELEASE.maxHumans }, (_, seat) => seat).slice(state.firstRow, state.lastRow);
  const bySeat = new Map(lobby.roster.map(entry => [entry.seat, entry]));
  const selected = props.selectedPilotId ?? props.selfPilotId;
  const selectedEntry = lobby.roster.find(entry => entry.pilotId === selected) ?? lobby.roster[0]!;
  const blockers = lobby.startBlockers;

  const roster = el('div', { class: 'roster-panel' }, [
    el('div', { class: 'panel-heading' }, [el('h2', {}, 'Crew manifest'), el('span', { class: 'num', 'data-page': pagerLabel(state) }, pagerLabel(state))]),
    el('ul', { class: 'roster' }, seats.map(seat => {
      const entry = bySeat.get(seat);
      return entry ? seatRow(entry, props, lobby.captainId, isCaptain, entry.pilotId === selected) : emptySeat(seat, props, isCaptain);
    })),
    el('div', { class: 'pager' }, [
      cta('lobby.page-prev', 'Previous', { disabled: state.page === 0, data: { page: state.page - 1 } }),
      el('span', { class: 'num' }, `${state.firstRow + 1}\u2013${state.lastRow} of ${RELEASE.maxHumans}`),
      cta('lobby.page-next', 'Next', { disabled: state.page >= state.pages - 1, data: { page: state.page + 1 } }),
    ]),
  ]);

  const mission = el('div', { class: 'mission-panel' }, [
    el('span', { class: 'kicker' }, lobby.mode === 'campaign' ? 'Co-op campaign' : lobby.mode === 'team-deathmatch' ? 'Team PvP' : 'Skirmish'),
    el('h2', {}, lobby.missionId ?? lobby.mapId),
    isCaptain ? el('div', { class: 'host-row' }, [
      cta('lobby.mode-campaign', 'Campaign', { pressed: lobby.mode === 'campaign' }),
      cta('lobby.mode-pvp', 'PvP', { pressed: lobby.mode === 'team-deathmatch' }),
      cta('lobby.mode-skirmish', 'Skirmish', { pressed: lobby.mode === 'skirmish' }),
    ]) : '',
    isCaptain ? el('div', { class: 'host-row' }, [
      cta('lobby.map-belt', 'Belt', { pressed: lobby.mapId === 'belt' }),
      cta('lobby.map-relay', 'Relay', { pressed: lobby.mapId === 'relay' }),
    ]) : '',
    el('p', { class: 'num' }, `Revision ${int(lobby.revision)}${props.reservedSeats > 0 ? ` \u00b7 ${int(props.reservedSeats)} seat reserved` : ''}`),
    el('p', { class: 'num' }, `Capacity ${int(props.capacity)} seats`),
  ]);

  const fitPanel = el('div', { class: 'fit-panel' }, [
    el('h2', {}, selectedEntry.name),
    el('span', { class: 'kicker' }, selectedEntry.teamId),
    props.fitDraft && props.fit && selectedEntry.pilotId === props.selfPilotId
      ? el('ul', { class: 'fit-deltas' }, fitComparison(props.fit, props.fitDraft)
        .slice(0, 4)
        .map(row => el('li', { class: row.worse ? 'tone-threat' : 'tone-signal' }, `${row.label} ${row.before} \u2192 ${row.after} (${row.delta})`)))
      : '',
    cta('lobby.hangar', 'Open hangar', { kind: 'primary', data: { pilot: selectedEntry.pilotId } }),
    cta('lobby.ready', selectedEntry.readyRevision !== null ? 'Ready' : 'Not ready', {
      pressed: selectedEntry.readyRevision !== null,
      data: { pilot: props.selfPilotId },
    }),
  ]);

  return el('section', { class: 'screen lobby', 'data-screen': 'lobby' }, [
    el('header', { class: 'screen-heading' }, [
      el('h1', {}, lobby.mode === 'campaign' ? 'Assemble the crew' : 'Match setup'),
      el('span', { class: 'room-tag num' }, `${int(lobby.roster.length)} of ${int(props.capacity)}`),
    ]),
    el('nav', { class: 'lobby-tabs', 'aria-label': 'Lobby pages' }, [
      tab('lobby.tab-crew', 'Crew', props.tab === 'crew'),
      tab('lobby.tab-mission', 'Mission', props.tab === 'mission'),
      tab('lobby.tab-fit', 'Fit', props.tab === 'fit'),
    ]),
    el('div', { class: 'lobby-layout', 'data-pane': props.tab }, [roster, mission, fitPanel]),
    group('Crew orders', el('div', { class: 'host-row' }, [
      cta('lobby.order-regroup', 'Regroup'),
      cta('lobby.order-defend', 'Defend'),
      cta('lobby.order-recover', 'Recover'),
      cta('lobby.order-focus', 'Focus contact'),
    ])),
    props.conflict ? notice(props.conflict, 'error') : '',
    props.notice ? notice(props.notice, 'info') : '',
    blockers.length > 0 ? el('ul', { class: 'blockers', role: 'status' }, blockers.map(blocker => el('li', {}, esc(blocker)))) : el('p', { class: 'ready-note', role: 'status' }, 'All pilots ready.'),
    el('footer', { class: 'menu-footer' }, [
      cta('lobby.leave', 'Leave', { kind: 'danger' }),
      cta('lobby.ready', selectedEntry.readyRevision !== null ? 'Cancel ready' : 'Ready up', {
        kind: 'primary',
        pressed: selectedEntry.readyRevision !== null,
        data: { pilot: props.selfPilotId },
      }),
      cta('lobby.start', 'Start mission', {
        kind: 'primary',
        disabled: !isCaptain || !lobby.canStart,
        reason: !isCaptain ? 'Only the captain starts' : lobby.canStart ? null : blockers[0] ?? 'Not ready',
      }),
    ]),
  ]);
}
