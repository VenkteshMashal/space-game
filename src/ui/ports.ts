/**
 * Narrow structural ports the shell consumes (Plan A1). These are deliberately loose: the shell
 * never owns settings, audio or the adapter, so it must not depend on their concrete classes. A
 * concrete `SettingsStore` or `AudioMixer` satisfies these shapes by ordinary structural typing,
 * and the tests pass recordings instead of the real modules.
 */

import type { SessionPort } from '../shared/contracts.ts';
import type { BootAsset } from './screens/boot.ts';

export interface SettingsPort {
  get(): unknown;
  subscribe(listener: () => void): () => void;
  set(patch: unknown): unknown;
  reset(category: string): unknown;
}

export type AudioBus = 'master' | 'music' | 'effects' | 'ui' | 'voice';

export interface AudioPort {
  unlock(): unknown;
  setVolume(bus: AudioBus, value: number): unknown;
  play(request: { cue: string; key?: string; priority?: number }): unknown;
  suspend(): unknown;
  dispose(): unknown;
}

/** Frame/time seam: production passes `requestAnimationFrame`, tests pass a deterministic clock. */
export interface FrameClock {
  requestFrame(callback: (timeMs: number) => void): number;
  cancelFrame(handle: number): void;
  now(): number;
}

export const browserClock: FrameClock = {
  requestFrame: callback => globalThis.requestAnimationFrame(callback),
  cancelFrame: handle => globalThis.cancelAnimationFrame(handle),
  now: () => globalThis.performance?.now() ?? Date.now(),
};

/** Where markup lands. One browser implementation in `shell.ts`, a recording one in the tests. */
export interface Surface {
  render(markup: string): void;
  /** Telemetry writes bypass `render` so a 10 Hz HUD flush cannot disturb the rest of the DOM. */
  writeHud(markup: string): void;
  /** Focus key and caret of the field being edited, so a re-render can restore both. */
  captureFocus(): FocusSnapshot | null;
  restoreFocus(snapshot: FocusSnapshot): void;
  announce(message: string, urgent?: boolean): void;
  copy(text: string): Promise<boolean>;
  title(text: string): void;
  /** Viewport measurement; paged layouts size themselves from the height actually available. */
  measure(): { readonly availableHeight: number; readonly width: number };
  download?(filename: string, text: string): void;
}

export interface FocusSnapshot {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** Readiness of the local Windows launcher, reported by the server's loopback API — not guessed. */
export type LauncherState = 'unknown' | 'absent' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface HostSetup {
  readonly launcher: LauncherState;
  readonly launcherDetail: string | null;
  readonly adapter: 'lan' | 'local';
  readonly port: number;
  /** Advertised guest URL; null until an adapter is chosen (HostInfo.guestOrigin). */
  readonly guestOrigin: string | null;
  readonly roomCode: string | null;
  readonly joinPolicy: 'open' | 'code' | 'closed';
  readonly mode: 'campaign' | 'skirmish' | 'team-deathmatch';
  /** Operator-only: the process can be stopped from this browser (HostView.isOperator). */
  readonly isOperator: boolean;
  readonly canStop: boolean;
}

export interface ShellOptions {
  readonly root: HTMLElement;
  readonly session: SessionPort;
  readonly settings: SettingsPort;
  readonly audio: AudioPort;
  /** Injectable for tests; defaults to the browser clock. */
  readonly clock?: FrameClock;
  /** Injectable for tests; defaults to a DOM surface over `root`. */
  readonly surface?: Surface;
  /** Host setup shown by the Host screen; main supplies it from `GET /api/info`. */
  readonly host?: HostSetup | null;
  /** Room-code/link origin discovered for this browser (Recent hosts, LAN join defaults). */
  readonly recentHosts?: readonly string[];
  readonly pilotName?: string;
  readonly onSessionEnd?: (reason: 'disposed' | 'left') => void;
  /** Server-side host actions the browser asks for over loopback. */
  readonly hostControl?: (action: 'start' | 'stop' | 'refresh' | 'claim' | 'configure', data?: Readonly<Record<string, unknown>>) => void;
  /** Asset readiness reported by the render slice; the shell never guesses it. */
  readonly assets?: readonly BootAsset[];
  readonly webgl?: { readonly ok: boolean; readonly detail: string | null };
  readonly savedCampaign?: { readonly owner: 'host' | 'device'; readonly location: string; readonly savedAt: string | null } | null;
  readonly transport?: 'lan' | 'local' | null;
  readonly appVersion?: string;
  readonly onExport?: (kind: 'settings' | 'campaign') => void;
  readonly onReloadAssets?: () => void;
  /**
   * Builds the adapter at connect time. The title screen must not connect on its own, so a shell
   * that is handed a factory only creates a port when the pilot chooses Join LAN or Play offline.
   */
  readonly createSession?: (kind: 'lan' | 'local') => SessionPort;
  /** Set while the local loader worker is running; the scope releases it on teardown. */
  readonly reloadWorker?: () => void;
}

/** Runtime options for tests and for anything that already has a surface. */
export type RuntimeOptions = Omit<ShellOptions, 'root' | 'surface' | 'clock'> & {
  readonly surface: Surface;
  readonly clock: FrameClock;
  readonly assets?: readonly BootAsset[];
};

export interface Shell {
  dispose(): Promise<void>;
  /**
   * Binding-driven action from the input router (`ActionId` values from `src/input/bindings.ts`
   * are accepted as plain strings so the shell keeps no build dependency on the input module).
   * No-op unless the flight screen is active; `pause` follows the same one-layer rule as Escape.
   */
  action(action: string, phase: 'press' | 'release'): void;
  /** Aim-pad lock cycling through currently targetable contacts (+1 next, -1 previous). */
  cycleLock(direction: -1 | 1): void;
  /** The contact the pilot has locked, if any; presentation state, never sent to the authority. */
  readonly lockedContactId: string | null;
}
