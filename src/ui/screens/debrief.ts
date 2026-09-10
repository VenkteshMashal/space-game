/**
 * Debrief (Plan A2/A5). Outcome, objective progress, inventory change and an explicit save receipt
 * are separate: rewards are shown once, "Saving" and "Saved" never look alike, and a failed save
 * offers Retry and Export instead of an ambiguous spinner. The captain continues; a guest waits or
 * leaves, and the guest is told the save lives on the host PC.
 */

import type { ClientView, DebriefView, Id, ObjectiveView } from '../../shared/contracts.ts';
import { cta, el, esc, notice } from '../dom.ts';
import { group, reading } from '../dom.ts';
import { credits, int, ratio } from '../format.ts';

export interface DebriefEntry {
  readonly label: string;
  readonly value: string;
}

export interface DebriefProps {
  readonly debrief: DebriefView;
  readonly save: ClientView['save'];
  readonly savedAt: string | null;
  readonly saveOwner: 'host' | 'device';
  readonly captain: boolean;
  readonly selfPilotId: Id;
  readonly teamScores: Readonly<Record<Id, number>>;
  readonly objectives: readonly ObjectiveView[];
  readonly changes: readonly DebriefEntry[];
  readonly blockers: readonly string[];
}

const OUTCOME_LABEL: Record<DebriefView['outcome'], string> = {
  victory: 'Victory',
  defeat: 'Defeat',
  draw: 'Draw',
  'no-contest': 'No contest',
  'mission-complete': 'Mission complete',
  'mission-failed': 'Mission failed',
};

export function debriefMarkup(props: DebriefProps): string {
  const { debrief } = props;
  const self = debrief.pilots.find(pilot => pilot.pilotId === props.selfPilotId);
  const receipt = props.save === 'saved'
    ? `Saved on ${props.saveOwner === 'host' ? 'host PC' : 'this device'}${props.savedAt ? ` at ${props.savedAt}` : ''}`
    : props.save === 'pending' ? 'Saving\u2026' : props.save === 'failed' ? 'Save failed' : 'Nothing to save yet';

  return el('section', { class: 'screen debrief', 'data-screen': 'debrief', 'data-outcome': debrief.outcome }, [
    el('header', { class: 'screen-heading' }, [
      el('h1', {}, OUTCOME_LABEL[debrief.outcome]),
      el('span', { class: 'room-tag num', 'data-receipt': debrief.receiptId ?? 'none' }, receipt),
    ]),
    group('Result', [
      reading('Reward', credits(debrief.rewardCredits)),
      reading('Repairs', credits(debrief.repairCredits)),
      reading('Winning team', debrief.winningTeamId ?? 'n/a'),
    ].join('')),
    props.objectives.length > 0
      ? group('Objectives', el('ul', { class: 'objective-list' }, props.objectives.map(objective => el('li', { class: `state-${objective.state}` }, [
        el('span', {}, esc(objective.title)),
        el('span', { class: 'num' }, `${int(objective.completed)} / ${int(objective.required)}`),
        el('span', { class: 'num' }, ratio(objective.completed, objective.required)),
      ]))))
      : '',
    group('Inventory', props.changes.length > 0
      ? el('ul', { class: 'change-list' }, props.changes.map(change => el('li', {}, [el('span', {}, esc(change.label)), el('span', { class: 'num' }, esc(change.value))])))
      : el('p', { class: 'screen-copy' }, 'No inventory change.')),
    group('Pilots', el('table', { class: 'score-table' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Pilot'), el('th', {}, 'Team'), el('th', {}, 'K'), el('th', {}, 'A'), el('th', {}, 'D')])),
      el('tbody', {}, debrief.pilots.map(pilot => el('tr', { class: pilot.departed ? 'departed' : '', 'data-pilot': pilot.pilotId }, [
        el('td', {}, esc(pilot.name)),
        el('td', {}, esc(pilot.teamId)),
        el('td', { class: 'num' }, int(pilot.kills)),
        el('td', { class: 'num' }, int(pilot.assists)),
        el('td', { class: 'num' }, int(pilot.deaths)),
      ]))),
    ])),
    self ? group('Yours', [reading('Kills', int(self.kills)), reading('Assists', int(self.assists)), reading('Deaths', int(self.deaths))].join('')) : '',
    props.save === 'failed' ? notice('The save did not complete. The host keeps the checkpoint; retry, or export a copy.', 'error') : '',
    props.blockers.length > 0 && props.captain ? el('ul', { class: 'blockers' }, props.blockers.map(blocker => el('li', {}, esc(blocker)))) : '',
    el('footer', { class: 'menu-footer' }, [
      cta('debrief.leave', 'Leave'),
      props.save === 'failed' ? cta('debrief.retry-save', 'Retry save') : '',
      props.save === 'failed' ? cta('debrief.export', 'Export copy') : '',
      cta('debrief.scoreboard', 'Scoreboard'),
      props.captain
        ? cta('debrief.continue', 'Continue', { kind: 'primary', data: { result: debrief.resultId, next: debrief.nextMissionId ?? '' } })
        : el('span', { class: 'waiting-note', role: 'status' }, 'Waiting for the captain'),
    ]),
    !props.captain ? el('p', { class: 'screen-copy' }, props.saveOwner === 'host' ? 'Results are saved on the host PC.' : 'Results are saved on this device.') : '',
  ]);
}
