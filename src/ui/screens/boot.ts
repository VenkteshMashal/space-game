/**
 * Boot screen (Plan A2). Asset/version readiness with a real retry. There is deliberately no
 * automatic connect and no "fall back to solo after 1.5 s": the pilot chooses, and an unsupported
 * WebGL context is explained instead of hidden behind a spinner.
 */

import { el, cta, notice } from '../dom.ts';
import { group, reading } from '../dom.ts';
import { percent } from '../format.ts';

export interface BootAsset {
  readonly id: string;
  readonly label: string;
  readonly state: 'pending' | 'ready' | 'failed';
  /** Bytes loaded / total when known. */
  readonly progress?: number;
}

export interface BootProps {
  readonly appVersion: string;
  readonly protocol: number;
  readonly contentVersion: string;
  readonly webgl: { readonly ok: boolean; readonly detail: string | null };
  readonly assets: readonly BootAsset[];
  readonly error: string | null;
  readonly busy: boolean;
}

export function bootMarkup(props: BootProps): string {
  const ready = props.assets.length > 0 && props.assets.every(asset => asset.state === 'ready');
  const failed = props.assets.filter(asset => asset.state === 'failed');
  if (!props.webgl.ok) {
    return el('section', { class: 'screen boot', 'data-screen': 'boot' }, [
      el('h1', {}, 'DRIFT'),
      notice(props.webgl.detail ?? 'This browser cannot open a WebGL context.', 'error'),
      el('p', { class: 'screen-copy' }, 'DRIFT needs WebGL 2 for lit ships and the belt. Enable hardware acceleration or open the game in a current Chrome, Edge or Firefox.'),
      el('footer', { class: 'screen-actions' }, [cta('boot.retry', 'Try again', { kind: 'primary' }), cta('boot.help', 'Controls and help')]),
    ]);
  }
  return el('section', { class: 'screen boot', 'data-screen': 'boot' }, [
    el('h1', {}, 'DRIFT'),
    el('p', { class: 'screen-copy' }, 'Preparing hull materials, belt geometry and the local launcher.'),
    group('Release', [
      reading('App', props.appVersion),
      reading('Protocol', String(props.protocol)),
      reading('Content', props.contentVersion),
    ].join('')),
    group('Assets', el('ul', { class: 'asset-list' }, props.assets.map(asset => el('li', { class: `asset state-${asset.state}`, 'data-asset': asset.id }, [
      el('span', {}, asset.label),
      el('span', { class: 'num' }, asset.state === 'ready' ? 'Ready' : asset.state === 'failed' ? 'Failed' : asset.progress === undefined ? 'Loading' : percent(asset.progress)),
    ])))),
    props.error ? notice(props.error, 'error') : '',
    failed.length > 0 ? notice(`${failed.map(asset => asset.label).join(', ')} did not load.`, 'error') : '',
    el('footer', { class: 'screen-actions' }, [
      cta('boot.retry', ready ? 'Reload assets' : 'Retry', { kind: 'primary', disabled: props.busy && !failed.length }),
      ready ? cta('boot.continue', 'Continue', { kind: 'primary' }) : '',
      cta('boot.help', 'Controls and help'),
    ]),
  ]);
}
