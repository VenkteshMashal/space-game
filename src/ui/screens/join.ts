/**
 * Join screen (Plan A2/B2). The address is normalised for display so the pilot can see exactly
 * which origin is dialled — validation never silently rewrites an entry to localhost. Failures are
 * typed (timeout, full, code, version, address) and each keeps a retry or a way back.
 */

import { cta, el, esc, field, notice } from '../dom.ts';
import { group } from '../dom.ts';

export interface JoinError {
  readonly code: 'timeout' | 'full' | 'code' | 'version' | 'address' | 'refused';
  readonly message: string;
}

export interface JoinProps {
  readonly name: string;
  readonly address: string;
  /** What the browser will actually dial; null when the entry is not yet usable. */
  readonly normalized: string | null;
  readonly roomCode: string;
  readonly needsCode: boolean;
  readonly recent: readonly string[];
  readonly error: JoinError | null;
  readonly busy: boolean;
}

const ERROR_TITLE: Record<JoinError['code'], string> = {
  timeout: 'No answer from that address',
  full: 'That host is full',
  code: 'Room code rejected',
  version: 'Version mismatch',
  address: 'That address is not usable',
  refused: 'Connection refused',
};

export function joinMarkup(props: JoinProps): string {
  const nameValid = props.name.trim().length > 0;
  const addressValid = props.normalized !== null;
  const connectBlocked = !nameValid ? 'Enter a callsign' : !addressValid ? 'Enter a host address' : props.needsCode && props.roomCode.trim().length === 0 ? 'Enter the room code' : null;

  return el('section', { class: 'screen join', 'data-screen': 'join' }, [
    el('header', { class: 'screen-heading' }, [el('h1', {}, 'Join a LAN game'), cta('join.back', 'Back')]),
    group('Pilot', el('div', { class: 'join-form' }, [
      field('join-name', props.name, { label: 'Callsign', key: 'join-name', maxLength: 20, placeholder: 'Ace' }),
      field('join-address', props.address, { label: 'Host address', key: 'join-address', placeholder: '192.168.1.24:8080', describedBy: 'join-address-hint' }),
      el('p', { class: 'field-hint', id: 'join-address-hint' }, props.normalized ? `Connects to ${esc(props.normalized)}` : 'Enter the address shown on the host PC.'),
      props.needsCode ? field('join-code', props.roomCode, { label: 'Room code', key: 'join-code', maxLength: 12, placeholder: '7QX4' }) : '',
    ].join(''))),
    props.recent.length > 0
      ? group('Recent hosts', el('ul', { class: 'recent-hosts' }, props.recent.map(host => el('li', {}, [
        cta('join.recent', host, { kind: 'ghost', data: { host } }),
        cta('join.forget', 'Forget', { kind: 'ghost', data: { host } }),
      ]))))
      : '',
    props.error ? notice(`${ERROR_TITLE[props.error.code]}. ${props.error.message}`, 'error') : '',
    el('footer', { class: 'screen-actions' }, [
      props.busy ? cta('join.cancel', 'Cancel') : cta('join.connect', 'Connect', { kind: 'primary', disabled: connectBlocked !== null, reason: connectBlocked }),
      props.error ? cta('join.retry', 'Retry') : '',
      cta('join.settings', 'Settings'),
    ]),
    el('p', { class: 'screen-copy' }, 'A room code is only needed when the host publishes one. Your seat is held for 60 seconds if the connection drops.'),
  ]);
}
