/**
 * Host setup (Plan A2/B2). The browser cannot start a Windows process, so when the local launcher
 * is absent this page explains the one-time setup instead of pretending to start it. The join QR
 * is a real encoded symbol of the advertised guest origin; copy failure selects the address and
 * says so rather than silently doing nothing.
 */

import { cta, el, esc, notice } from '../dom.ts';
import { group, reading } from '../dom.ts';
import { qrSvg } from '../qr.ts';
import type { HostSetup } from '../ports.ts';

export interface HostProps {
  readonly host: HostSetup;
  readonly copyFailed: boolean;
  readonly busy: boolean;
  readonly progress: string | null;
  /** Loopback claim URL the launcher handed to this browser, when it is the operator. */
  readonly claimUrl: string | null;
}

const LAUNCHER_TEXT: Record<HostSetup['launcher'], string> = {
  unknown: 'Checking the local launcher on this PC.',
  absent: 'No launcher detected on this PC.',
  running: 'Launcher running.',
  stopping: 'Stopping the local host.',
  stopped: 'Local host stopped.',
  failed: 'The launcher reported a failure.',
};

function launcherNotice(host: HostSetup): string {
  if (host.launcher === 'absent') {
    return notice(
      'This browser cannot start a Windows process. Run the one-time setup once, then start the DRIFT host from the Start menu or by running `bun run host` in the game folder. This page will detect it automatically.',
      'info',
    );
  }
  if (host.launcher === 'running') return notice(LAUNCHER_TEXT.running, 'success');
  if (host.launcher === 'failed') return notice(LAUNCHER_TEXT.failed, 'error');
  return '';
}

export function joinAddress(host: HostSetup): string | null {
  if (host.guestOrigin) return host.guestOrigin;
  return null;
}

export function hostMarkup(props: HostProps): string {
  const address = joinAddress(props.host);
  const qr = address
    ? qrSvg(props.host.joinPolicy === 'code' && props.host.roomCode ? `${address}/?code=${props.host.roomCode}` : address, { label: 'Scan to join this DRIFT host' })
    : el('p', { class: 'notice tone-info' }, 'Choose an adapter to publish a join address.');

  const qrBlock = group('Join link', el('div', { class: 'host-share' }, [
    qr,
    el('div', {}, [
      el('p', { class: 'host-address num', 'data-selectable': address ?? '' }, address ?? 'Not published'),
      address ? cta('host.copy-link', 'Copy link') : cta('host.choose-adapter', 'Choose adapter'),
      props.copyFailed ? notice('Select and copy this address.', 'error') : '',
      props.host.roomCode ? el('p', { class: 'host-code num' }, `Room code ${esc(props.host.roomCode)}`) : '',
      props.host.roomCode ? cta('host.copy-code', 'Copy room code') : '',
    ]),
  ]));

  const access = group('Access', el('div', { class: 'host-row' }, [
    cta('host.policy-open', 'Public', { pressed: props.host.joinPolicy === 'open' }),
    cta('host.policy-code', 'Room code', { pressed: props.host.joinPolicy === 'code' }),
    cta('host.policy-closed', 'Closed', { pressed: props.host.joinPolicy === 'closed' }),
  ]));

  const mode = group('Game type', el('div', { class: 'host-row' }, [
    cta('host.mode-campaign', 'Co-op campaign', { pressed: props.host.mode === 'campaign' }),
    cta('host.mode-pvp', 'Team PvP', { pressed: props.host.mode === 'team-deathmatch' }),
    cta('host.mode-skirmish', 'Skirmish', { pressed: props.host.mode === 'skirmish' }),
  ]));

  const launcherControls = group('Local host', el('div', { class: 'host-row' }, [
    props.host.launcher === 'absent'
      ? cta('host.start', 'Start hosting', { kind: 'primary', disabled: true, reason: 'Launcher process not detected' })
      : cta('host.start', 'Start hosting', { kind: 'primary', disabled: props.busy }),
    cta('host.refresh', 'Check again', { disabled: props.busy }),
    props.host.canStop ? cta('host.stop', 'Stop hosting', { kind: 'danger', disabled: props.busy }) : '',
    props.host.isOperator ? '' : el('p', { class: 'hud-detail' }, 'This PC hosts the game. Only the operator can stop it.'),
    props.claimUrl ? cta('host.claim', 'Open operator console') : '',
  ].join('')));

  return el('section', { class: 'screen host', 'data-screen': 'host' }, [
    el('header', { class: 'screen-heading' }, [el('h1', {}, 'Host a LAN game'), cta('host.back', 'Back')]),
    props.progress ? notice(props.progress, 'info') : '',
    launcherNotice(props.host),
    el('div', { class: 'host-grid' }, [
      qrBlock,
      group('Adapter', reading('Adapter', props.host.adapter === 'lan' ? 'LAN (Wi-Fi or cable)' : 'This PC only', `Port ${props.host.port}`)),
      access,
      mode,
      launcherControls,
    ]),
    el('p', { class: 'screen-copy' }, 'Guests keep their seat for 60 seconds after a drop and rejoin by scanning the same code. Closing this browser does not stop the host on a Windows PC.'),
  ]);
}
