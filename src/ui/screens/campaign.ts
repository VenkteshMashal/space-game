/**
 * Campaign screen (Plan A2/A5). Maps directly to the campaign graphs: a sector route with explicit
 * locked / available / complete states, the current mission summary, prior decisions and shared
 * credits. Replaying a finished story mission is labelled training with no rewards rather than
 * silently paying twice.
 */

import type { CampaignView, Id } from '../../shared/contracts.ts';
import { cta, el, esc, notice } from '../dom.ts';
import { group, reading } from '../dom.ts';
import { credits as creditsText, int } from '../format.ts';

export interface CampaignProps {
  readonly campaign: CampaignView;
  readonly currentMissionId: Id | null;
  readonly selectedMissionId: Id;
  readonly onHost: boolean;
  readonly deployBlockers: readonly string[];
}

const MISSION_STATE: Record<CampaignView['missions'][number]['state'], string> = {
  locked: 'Locked',
  available: 'Current',
  complete: 'Complete',
};

export function campaignMarkup(props: CampaignProps): string {
  const { campaign } = props;
  const selected = campaign.missions.find(mission => mission.id === props.selectedMissionId) ?? campaign.missions[0];
  const vote = campaign.activeVote;
  const replay = selected?.state === 'complete';
  const decisions = campaign.decisions.length > 0
    ? el('ul', { class: 'decision-history' }, campaign.decisions.map(decision => el('li', { class: 'num' }, `${decision.id} \u2192 ${decision.optionId}`)))
    : el('p', { class: 'screen-copy' }, 'No irreversible choices recorded yet.');

  return el('section', { class: 'screen campaign', 'data-screen': 'campaign' }, [
    el('header', { class: 'screen-heading' }, [
      el('h1', {}, esc(campaign.name)),
      el('span', { class: 'room-tag num' }, creditsText(campaign.credits)),
    ]),
    group('Sector route', el('ol', { class: 'route' }, campaign.missions.map(mission => el('li', {
      class: `route-stop state-${mission.state}${mission.id === props.selectedMissionId ? ' selected' : ''}`,
      'data-mission': mission.id,
      'data-state': mission.state,
    }, [
      cta('campaign.mission', mission.title, { kind: 'ghost', pressed: mission.id === props.selectedMissionId, data: { mission: mission.id } }),
      el('span', { class: 'tag' }, MISSION_STATE[mission.state]),
    ])))),
    group('Current mission', selected
      ? [
        el('h2', {}, esc(selected.title)),
        el('p', { class: 'screen-copy' }, `Sector ${esc(selected.sectorId)}`),
        reading('State', MISSION_STATE[selected.state]),
        replay ? notice('Training replay. No rewards are paid twice.', 'info') : '',
        vote
          ? group('Vote', el('div', { class: 'host-row' }, vote.options.map(option => cta('campaign.vote', option.label, {
            pressed: Object.values(vote.votes).includes(option.id),
            data: { decision: vote.id, option: option.id },
          }))))
          : '',
      ].join('')
      : el('p', { class: 'screen-copy' }, 'No missions published.')),
    group('Save', [
      reading('Owner', campaign.saveOwner === 'host' ? 'Host PC' : 'This device'),
      reading('Last saved', campaign.lastSavedAt ?? 'Not saved yet'),
      cta('campaign.save-retry', 'Retry save', { disabled: campaign.lastSavedAt !== null }),
    ].join('')),
    group('Choices', decisions),
    el('footer', { class: 'menu-footer' }, [
      cta('campaign.back', 'Back'),
      cta('campaign.hangar', 'Hangar'),
      cta('campaign.journal', 'Journal'),
      cta('campaign.deploy', 'Deploy', {
        kind: 'primary',
        disabled: props.deployBlockers.length > 0 || !props.onHost,
        reason: props.deployBlockers[0] ?? (props.onHost ? null : 'The host deploys the mission'),
      }),
    ]),
  ]);
}

/** Progress row for the mission summary the HUD cannot show in full. */
export function missionProgress(mission: { completed: number; required: number }): string {
  return `${int(mission.completed)} / ${int(mission.required)}`;
}
