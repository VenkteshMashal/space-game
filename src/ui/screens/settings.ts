/**
 * Settings and help (Plan A5). Categories are separate pages, never one long scroll, and help is a
 * set of short lessons. Values arrive as one flat map because the shell owns the settings shape;
 * this module never reaches into the store itself, so it can be rendered and asserted directly.
 */

import { cta, el, esc, field, notice, tab } from '../dom.ts';
import { group } from '../dom.ts';

export type SettingsPageId = 'flight' | 'controls' | 'audio' | 'graphics' | 'accessibility' | 'storage';

export interface SettingsControl {
  readonly key: string;
  readonly label: string;
  readonly kind: 'toggle' | 'slider' | 'select' | 'action' | 'text';
  readonly detail?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  /** Action id for `kind: 'action'`. */
  readonly action?: string;
}

export interface SettingsPage {
  readonly id: SettingsPageId;
  readonly label: string;
  readonly note: string;
  readonly controls: readonly SettingsControl[];
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'flight',
    label: 'Flight',
    note: 'Default handling. Bindings live on the Controls page.',
    controls: [
      { key: 'flight.assistDefault', label: 'Angular assist on by default', kind: 'toggle' },
      { key: 'flight.fixedGunAim', label: 'Keyboard-only fixed-gun aim', kind: 'toggle', detail: 'Aim with arrow keys instead of the pointer.' },
      { key: 'flight.sensitivity', label: 'Aim sensitivity', kind: 'slider', min: 0.2, max: 3, step: 0.1 },
      { key: 'flight.leftHanded', label: 'Left-handed touch layout', kind: 'toggle' },
    ],
  },
  {
    id: 'controls',
    label: 'Controls',
    note: 'Every action can be rebound. Escape cancels a capture.',
    controls: [
      { key: 'controls.bindings', label: 'Bindings', kind: 'action', action: 'controls.reset' },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    note: 'Audio starts only after you interact with the page.',
    controls: [
      { key: 'audio.master', label: 'Master', kind: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'audio.music', label: 'Music', kind: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'audio.effects', label: 'Effects', kind: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'audio.ui', label: 'Interface', kind: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'audio.voice', label: 'Voice and cues', kind: 'slider', min: 0, max: 1, step: 0.05 },
      { key: 'audio.muted', label: 'Mute everything', kind: 'toggle' },
    ],
  },
  {
    id: 'graphics',
    label: 'Graphics',
    note: 'Auto adapts resolution before it drops effects.',
    controls: [
      { key: 'graphics.quality', label: 'Quality', kind: 'select', options: ['auto', 'low', 'medium', 'high'] },
      { key: 'graphics.resolutionScale', label: 'Resolution scale', kind: 'slider', min: 0.5, max: 2, step: 0.05 },
      { key: 'graphics.bloom', label: 'Bloom', kind: 'toggle' },
      { key: 'graphics.shake', label: 'Screen shake', kind: 'slider', min: 0, max: 1, step: 0.1 },
    ],
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    note: 'Reduced motion stops decorative movement, never projectiles.',
    controls: [
      { key: 'accessibility.reducedMotion', label: 'Reduced motion', kind: 'toggle' },
      { key: 'accessibility.textScale', label: 'Text size', kind: 'slider', min: 1, max: 2, step: 0.1 },
      { key: 'accessibility.largeControls', label: 'Larger controls', kind: 'toggle' },
      { key: 'accessibility.colorblindPatterns', label: 'Team patterns', kind: 'toggle', detail: 'Pairs colour with a shape.' },
      { key: 'accessibility.highContrast', label: 'High contrast instruments', kind: 'toggle' },
      { key: 'accessibility.subtitles', label: 'Captions for important cues', kind: 'toggle' },
      { key: 'accessibility.flashLimit', label: 'Limit flashing effects', kind: 'toggle' },
    ],
  },
  {
    id: 'storage',
    label: 'Storage',
    note: 'Campaign data stays on this device unless the host owns it.',
    controls: [
      { key: 'storage.hostSaves', label: 'Campaigns saved by the host', kind: 'toggle' },
      { key: 'storage.autoExport', label: 'Offer an export copy on save failure', kind: 'toggle' },
      { key: 'storage.export', label: 'Export settings', kind: 'action', action: 'settings.export' },
      { key: 'storage.import', label: 'Import settings', kind: 'action', action: 'settings.import' },
      { key: 'storage.resetAll', label: 'Reset every category', kind: 'action', action: 'settings.reset-all' },
    ],
  },
];

export const HELP_LESSONS: readonly { id: string; title: string; lines: readonly string[] }[] = [
  { id: 'flying', title: 'Flying', lines: ['W and S thrust and reverse, A and D turn, Q and E strafe.', 'X brakes. Braking uses propellant, so the marker only appears while you have fuel.', 'Shift boosts. Boost costs fuel and raises your thermal signature.'] },
  { id: 'fighting', title: 'Fighting', lines: ['Primary and secondary fire groups are mouse buttons one and two.', 'R reloads. A blocked shot always says why.', 'Lead markers solve for your muzzle speed; torpedoes steer, so the lead is an estimate.'] },
  { id: 'crew', title: 'Crew', lines: ['G holds the scoreboard; release it to close.', 'F interacts with a dockable or recoverable object.', 'Crew orders are bounded: regroup, defend, recover, focus a detected contact.'] },
  { id: 'connection', title: 'Connection', lines: ['A dropped link lets your ship coast; it is still vulnerable.', 'Your seat is held for 60 seconds. Rejoin with the same link or code.', 'Leaving the menu open during a reconnect is fine: the match keeps running.'] },
  { id: 'touch', title: 'Touch', lines: ['The left pad steers and thrusts; the right pad aims.', 'Two fire buttons sit under your thumbs, so you can steer, aim and fire at once.', 'Release one finger without losing the others.'] },
];

/** Flatten the versioned settings object into `a.b` keys the pages address. */
export function readSettings(snapshot: unknown): Readonly<Record<string, unknown>> {
  const flat: Record<string, unknown> = {};
  const walk = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      flat[prefix] = value;
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, prefix ? `${prefix}.${key}` : key);
  };
  walk(snapshot, '');
  return flat;
}

export function valueOf(values: Readonly<Record<string, unknown>>, key: string, fallback: string | number | boolean): string | number | boolean {
  const value = values[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : fallback;
}

export function asNumber(value: string | number | boolean, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asBool(value: string | number | boolean): boolean {
  return value === true || value === 'true' || value === 1;
}

export interface SettingsProps {
  readonly page: SettingsPageId;
  readonly values: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly dirty: boolean;
  readonly notice: string | null;
}

function controlMarkup(control: SettingsControl, values: Readonly<Record<string, unknown>>): string {
  const value = valueOf(values, control.key, control.kind === 'toggle' ? false : control.kind === 'slider' ? 0 : '');
  if (control.kind === 'toggle') {
    return cta('settings.toggle', `${control.label}: ${asBool(value) ? 'On' : 'Off'}`, {
      kind: 'ghost',
      pressed: asBool(value),
      data: { key: control.key },
      hint: control.detail ?? null,
    });
  }
  if (control.kind === 'slider') {
    const numeric = asNumber(value, control.min ?? 0);
    return el('div', { class: 'setting-slider' }, [
      el('label', { for: `setting-${control.key}`, class: 'setting-label' }, esc(control.label)),
      field(`setting-${control.key}`, String(numeric), { label: control.label, type: 'range', key: `setting-${control.key}`, maxLength: 8 }),
      el('input', {
        type: 'number',
        class: 'num',
        value: String(numeric),
        min: control.min ?? null,
        max: control.max ?? null,
        step: control.step ?? null,
        'data-number': control.key,
        'aria-label': `${control.label} value`,
      }),
      el('span', { class: 'hud-detail' }, control.detail ?? ''),
    ]);
  }
  if (control.kind === 'select') {
    return el('div', { class: 'setting-select' }, [
      el('label', { for: `setting-${control.key}`, class: 'setting-label' }, esc(control.label)),
      el('select', { id: `setting-${control.key}`, 'data-select': control.key, 'aria-label': control.label },
        (control.options ?? []).map(option => el('option', { value: option, selected: String(value) === option }, esc(option)))),
    ]);
  }
  return cta(control.action ?? 'settings.noop', control.label, { kind: 'ghost', data: { key: control.key } });
}

export function settingsMarkup(props: SettingsProps): string {
  const page = SETTINGS_PAGES.find(candidate => candidate.id === props.page) ?? SETTINGS_PAGES[0]!;
  const bindings = readSettings(props.values['controls.bindings'] ?? {});
  return el('section', { class: 'screen settings', 'data-screen': 'settings', 'data-page': page.id }, [
    el('header', { class: 'screen-heading' }, [
      el('h1', {}, 'Settings'),
      el('span', { class: 'room-tag num' }, `v${props.version}`),
    ]),
    el('nav', { class: 'settings-tabs', 'aria-label': 'Settings pages' }, SETTINGS_PAGES.map(candidate => tab(`settings.page-${candidate.id}`, candidate.label, candidate.id === page.id))),
    group(page.label, [
      el('p', { class: 'screen-copy' }, page.note),
      ...page.controls.map(control => controlMarkup(control, props.values)),
      props.page === 'controls'
        ? el('ul', { class: 'binding-list' }, Object.entries(bindings).map(([actionId, keys]) => el('li', {}, [
          el('span', {}, esc(actionId)),
          el('span', { class: 'num' }, esc(Array.isArray(keys) ? keys.join(' / ') : String(keys))),
          cta('controls.assign', 'Rebind', { kind: 'ghost', data: { action: actionId } }),
        ])))
        : '',
      cta('settings.reset', `Reset ${page.label.toLowerCase()}`, { kind: 'danger', data: { category: page.id } }),
    ].join('')),
    props.dirty ? notice('Unsaved changes apply immediately but are not written yet.', 'info') : '',
    props.notice ? notice(props.notice, 'success') : '',
    el('footer', { class: 'screen-actions' }, [cta('settings.close', 'Close', { kind: 'primary' }), cta('settings.help', 'Controls and help')]),
  ]);
}

export interface HelpProps {
  readonly page: string;
  readonly notice: string | null;
}

export function helpMarkup(props: HelpProps): string {
  const lesson = HELP_LESSONS.find(candidate => candidate.id === props.page) ?? HELP_LESSONS[0]!;
  return el('section', { class: 'screen help', 'data-screen': 'help', 'data-page': lesson.id }, [
    el('header', { class: 'screen-heading' }, [el('h1', {}, 'Controls and help'), cta('help.close', 'Close')]),
    el('nav', { class: 'help-tabs', 'aria-label': 'Help pages' }, HELP_LESSONS.map(candidate => tab(`help.page-${candidate.id}`, candidate.title, candidate.id === lesson.id))),
    group(lesson.title, el('ul', { class: 'lesson' }, lesson.lines.map(line => el('li', {}, esc(line))))),
    props.notice ? notice(props.notice, 'info') : '',
    el('footer', { class: 'screen-actions' }, [cta('help.close', 'Back to the game', { kind: 'primary' }), cta('help.settings', 'Settings')]),
  ]);
}
