/**
 * Loading / countdown (Plan A2). Each seat reports its own state, a failure is actionable, and the
 * captain can drop failed seats and deploy anyway. Readiness is a proxy: it claims the client has
 * the arena and a fresh baseline, never that the ship is fighting.
 */

import type { Id } from '../../shared/contracts.ts';
import { cta, el, esc, notice } from '../dom.ts';
import { group, reading } from '../dom.ts';
import { int, seconds } from '../format.ts';

export interface LoadingSeat {
  readonly pilotId: Id;
  readonly name: string;
  readonly state: 'loading' | 'ready' | 'failed';
  readonly detail: string | null;
}

export interface LoadingProps {
  readonly missionLabel: string;
  readonly mapLabel: string;
  readonly seats: readonly LoadingSeat[];
  readonly captain: boolean;
  readonly countdownSeconds: number | null;
  /** True once every seat that is still here has the arena; failed seats may be dropped. */
  readonly canDeploy: boolean;
  readonly blockers: readonly string[];
}

export function loadingMarkup(props: LoadingProps): string {
  const failed = props.seats.filter(seat => seat.state === 'failed');
  const ready = props.seats.filter(seat => seat.state === 'ready').length;
  return el('section', { class: 'screen loading', 'data-screen': 'loading' }, [
    el('header', { class: 'screen-heading' }, [
      el('h1', {}, props.missionLabel),
      el('span', { class: 'room-tag num' }, props.countdownSeconds === null ? `Loading ${int(ready)} / ${int(props.seats.length)}` : seconds(props.countdownSeconds)),
    ]),
    group('Mission', [
      reading('Map', props.mapLabel),
      reading('Seats ready', `${int(ready)} / ${int(props.seats.length)}`),
    ].join('')),
    group('Crew', el('ul', { class: 'loading-seats' }, props.seats.map(seat => el('li', { class: `seat state-${seat.state}`, 'data-pilot': seat.pilotId }, [
      el('span', { class: 'seat-name' }, esc(seat.name)),
      el('span', { class: 'tag' }, seat.state === 'ready' ? 'Arena ready' : seat.state === 'failed' ? 'Failed' : 'Loading'),
      seat.detail ? el('span', { class: 'hud-detail' }, esc(seat.detail)) : '',
      seat.state === 'failed' && props.captain ? cta('loading.retry', 'Retry', { kind: 'ghost', data: { pilot: seat.pilotId } }) : '',
      seat.state === 'failed' && props.captain ? cta('loading.drop', 'Drop seat', { kind: 'ghost', data: { pilot: seat.pilotId } }) : '',
    ])))),
    failed.length > 0 && props.captain
      ? notice('Failed seats can be dropped, or retried while the countdown holds. Deploying without them starts the mission at reduced strength.', 'error')
      : '',
    props.blockers.length > 0 ? el('ul', { class: 'blockers' }, props.blockers.map(blocker => el('li', {}, esc(blocker)))) : '',
    el('footer', { class: 'menu-footer' }, [
      cta('loading.leave', 'Leave', { kind: 'danger' }),
      cta('loading.cancel', 'Cancel launch', { disabled: !props.captain, reason: props.captain ? null : 'Only the captain cancels' }),
      cta('loading.deploy', 'Deploy now', {
        kind: 'primary',
        disabled: !props.captain || !props.canDeploy,
        reason: !props.captain ? 'Only the captain deploys' : props.canDeploy ? null : props.blockers[0] ?? 'Waiting for the crew',
      }),
    ]),
  ]);
}
