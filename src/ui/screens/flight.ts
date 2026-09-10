/**
 * Flight screen (Plan A3). The screen itself is almost nothing: it mounts the HUD, a contextual
 * prompt and the input layer's touch surface. Everything persistent lives in `hud.ts`, and the
 * authority decides which actions are legal — this module only shows them.
 */

import type { Life, Overlay } from '../../shared/contracts.ts';
import { cta, el } from '../dom.ts';
import { hudMarkup, type HudModel } from '../hud.ts';
import { int, seconds } from '../format.ts';

export interface FlightPrompt {
  readonly label: string;
  readonly action: string;
  readonly detail: string | null;
  readonly data?: Readonly<Record<string, string>>;
}

export interface FlightProps {
  readonly hud: HudModel;
  readonly life: Life;
  readonly respawnSeconds: number | null;
  readonly prompt: FlightPrompt | null;
  readonly overlay: Overlay;
  /** Overlay body rendered by the shell; the flight screen only reserves the slot. */
  readonly overlayMarkup: string;
  /** True when the pilot may leave the match back to the lobby. */
  readonly canReturnToLobby: boolean;
}

const LIFE_LABEL: Record<Life, string> = {
  staged: 'Standing by',
  alive: 'Flying',
  disabled: 'Disabled',
  destroyed: 'Destroyed',
  respawning: 'Respawning',
  spectating: 'Spectating',
};

export function flightMarkup(props: FlightProps): string {
  const dead = props.life === 'destroyed';
  return el('section', { class: 'screen flight', 'data-screen': 'flight', 'data-life': props.life }, [
    el('p', { class: 'flight-life', 'data-life-label': props.life, role: 'status' }, [
      LIFE_LABEL[props.life],
      props.respawnSeconds !== null ? ` \u00b7 ${seconds(props.respawnSeconds)}` : '',
    ]),
    // The HUD lives in its own region: telemetry rewrites it ten times a second without touching
    // the rest of the screen, so no other control can lose focus to a telemetry flush.
    el('div', { 'data-hud-region': 'true' }, props.hud ? hudMarkup(props.hud) : ''),
    el('div', { class: 'flight-actions' }, [
      dead ? cta('flight.respawn', 'Redeploy', { kind: 'primary' }) : '',
      props.life === 'disabled' ? cta('flight.call-rescue', 'Call rescue', { kind: 'primary' }) : '',
      cta('overlay.map', 'Map'),
      cta('overlay.scoreboard', 'Scores'),
      cta('overlay.help', 'Help'),
      cta('overlay.settings', 'Settings'),
      props.canReturnToLobby ? cta('flight.return-lobby', 'Return to lobby') : '',
      el('span', { class: 'hud-detail num' }, `Tick ${int(props.hud.tick)}`),
    ]),
    props.prompt
      ? el('div', { class: 'flight-prompt', 'data-prompt': props.prompt.action }, [
        cta(props.prompt.action, props.prompt.label, { kind: 'primary', data: props.prompt.data ?? {} }),
        props.prompt.detail ? el('span', { class: 'hud-detail' }, props.prompt.detail) : '',
      ])
      : '',
    // The input router mounts the touch controls here: two pointers, steer + aim + fire.
    el('div', { class: 'touch-layer', 'data-input-mount': 'flight', 'aria-hidden': 'true' }, ''),
    el('div', { class: 'overlay-host', 'data-overlay': props.overlay }, props.overlayMarkup),
  ]);
}
