/**
 * DRIFT composition root (Plan A1): mount the shell, build the adapter the pilot chose, drive the
 * renderer and dispose the session. Everything gameplay-shaped lives behind `SessionPort`; this file
 * never parses a socket, never calculates damage and never writes authority state.
 *
 * The title screen does not connect. A pilot chooses Join LAN or Play offline, and only that click
 * creates and connects an adapter — there is no timer and no silent fallback to a solo game.
 */

import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';

import './style.css';

import { AudioMixer } from './audio/mixer.ts';
import { LanSession } from './client/session/lan.ts';
import { LocalSession } from './client/session/local.ts';
import { attachInput, createInputRouter } from './input/router.ts';
import { SessionScene } from './render/session-scene.ts';
import type { PoseOverrides } from './render/session-scene.ts';
import type { QualityMode } from './render/tier.ts';
import { SettingsStore } from './settings.ts';
import { RELEASE } from './shared/contracts.ts';
import type { ClientView, Id, SessionPort } from './shared/contracts.ts';
import type { BootAsset } from './ui/screens/boot.ts';
import type { HostSetup } from './ui/ports.ts';
import { createShell } from './ui/shell.ts';

const HOST_INFO_PATH = '/api/info';
const HOST_CONTROL_PATH = '/api/host';

/** Adapters that can hand the renderer predicted and interpolated poses. */
interface PoseProvider {
  poses(dtSeconds: number): PoseOverrides;
}

function isPoseProvider(value: SessionPort): value is SessionPort & PoseProvider {
  if (!('poses' in value)) return false;
  const candidate = value as { poses?: unknown };
  return typeof candidate.poses === 'function';
}

function mount(): { canvasHost: HTMLElement; uiRoot: HTMLElement } {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) throw new Error('#app is missing from the document');
  app.replaceChildren();
  const canvasHost = document.createElement('div');
  canvasHost.id = 'drift-viewport';
  const uiRoot = document.createElement('div');
  uiRoot.id = 'drift-ui-root';
  app.append(canvasHost, uiRoot);
  return { canvasHost, uiRoot };
}

function webglSupport(): { ok: boolean; detail: string | null } {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return context ? { ok: true, detail: null } : { ok: false, detail: 'This browser did not provide a WebGL context.' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'WebGL is unavailable.' };
  }
}

/**
 * Launcher and adapter facts come from the host process, never from a guess. A dev server has no
 * `/api/info`, and the Host screen then explains the launcher instead of pretending to start it.
 */
async function fetchHostSetup(): Promise<HostSetup | null> {
  try {
    const response = await fetch(HOST_INFO_PATH, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const info = (await response.json()) as Partial<{
      guestOrigin: string | null;
      joinPolicy: 'open' | 'code' | 'closed';
      appVersion: string;
      isOperator: boolean;
      canStop: boolean;
    }>;
    const origin = typeof info.guestOrigin === 'string' ? info.guestOrigin : null;
    const port = origin ? Number(new URL(origin).port || '80') : Number(globalThis.location.port || '8080');
    return {
      launcher: 'running',
      launcherDetail: typeof info.appVersion === 'string' ? `Build ${info.appVersion}` : null,
      adapter: 'lan',
      port: Number.isFinite(port) && port > 0 ? port : 8080,
      guestOrigin: origin,
      roomCode: null,
      joinPolicy: info.joinPolicy ?? 'open',
      mode: 'team-deathmatch',
      isOperator: info.isOperator === true,
      canStop: info.canStop === true,
    };
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const { canvasHost, uiRoot } = mount();
  const settings = new SettingsStore();
  const initial = settings.get();
  const audio = new AudioMixer({
    volumes: {
      master: initial.audio.master,
      music: initial.audio.music,
      effects: initial.audio.effects,
      ui: initial.audio.ui,
      voice: initial.audio.voice,
    },
  });

  let lan = new LanSession();
  let active: SessionPort = lan;

  // Boot readiness is reported, never assumed: the shell leaves the boot screen only once every
  // asset is ready and WebGL answered. The array is the same reference the shell holds, and entries
  // are replaced rather than mutated because the asset DTO is readonly.
  const assets: BootAsset[] = [
    { id: 'fonts', label: 'Reading face', state: 'pending' },
    { id: 'materials', label: 'Hull materials and belt geometry', state: 'pending' },
    { id: 'webgl', label: 'WebGL context', state: 'pending' },
  ];
  const setAsset = (index: number, state: BootAsset['state']): void => {
    assets[index] = { ...assets[index]!, state };
  };
  const webgl: { ok: boolean; detail: string | null } = { ok: false, detail: null };

  const probeWebgl = (): void => {
    const support = webglSupport();
    webgl.ok = support.ok;
    webgl.detail = support.detail;
    setAsset(2, support.ok ? 'ready' : 'failed');
  };
  const loadFonts = (): void => {
    const fonts = globalThis.document?.fonts;
    if (!fonts) {
      setAsset(0, 'ready');
      return;
    }
    fonts.ready.then(() => {
      setAsset(0, 'ready');
    }).catch(() => {
      setAsset(0, 'failed');
    });
  };
  probeWebgl();
  loadFonts();

  const scene = new SessionScene({
    host: canvasHost,
    reducedMotion: initial.accessibility.reducedMotion,
    onControlRelease: () => active.releaseControls('disconnect'),
    onContextRestore: () => {
      if (active === lan) lan.requestBaseline();
    },
  });
  setAsset(1, 'ready');
  scene.setQuality(qualityMode(initial.graphics.quality));

  const input = createInputRouter({
    bindings: initial.controls.bindings,
    gamepad: initial.controls.gamepad,
    gamepadDeadzone: initial.controls.gamepadDeadzone,
    sensitivity: initial.controls.sensitivity,
    touchHandedness: initial.controls.touchHandedness,
    touchAim: initial.controls.touchAim,
    largeControls: initial.accessibility.largeControls,
    angularAssist: initial.flight.assistDefault,
    onAction: (action, phase) => shell.action(action, phase),
    onRelease: reason => active.releaseControls(reason),
    onCycleLock: direction => shell.cycleLock(direction),
  });

  const hostSetup = await fetchHostSetup();
  // The shell reads this object every tick, and HostSetup is a readonly DTO, so one mutable view is
  // the honest way to keep operator capability current from the authority's own view rather than
  // from a stale HTTP snapshot.
  const liveHost = hostSetup as { -readonly [K in keyof HostSetup]: HostSetup[K] } | null;

  /**
   * Host actions from the Host screen. Policy and mode are *lobby settings* and the claimed operator is
   * the room captain, so they travel the same revision-checked command path as every other lobby edit.
   * `refresh` re-reads the host's own facts. `start` and `claim` cannot be performed from a browser:
   * the launcher owns the process and the claim is delivered in the launch link, and the screen already
   * says so rather than pretending.
   */
  async function hostControl(action: 'start' | 'stop' | 'refresh' | 'claim' | 'configure', data?: Readonly<Record<string, unknown>>): Promise<void> {
    switch (action) {
      case 'configure': {
        // The Host screen is reached before any session exists, so its settings belong to the host
        // process, not to a lobby revision this browser does not have yet.
        const response = await fetch(`${HOST_CONTROL_PATH}/configure`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data ?? {}),
        }).catch(() => null);
        if (!response || !response.ok) return;
        const applied = await response.json().catch(() => null) as { ok?: boolean } | null;
        if (applied?.ok !== true) return;
        const setup = await fetchHostSetup();
        if (setup && liveHost) Object.assign(liveHost, setup);
        return;
      }
      case 'refresh': {
        const setup = await fetchHostSetup();
        if (setup && liveHost) Object.assign(liveHost, setup);
        return;
      }
      case 'stop':
        await fetch(`${HOST_CONTROL_PATH}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
        return;
      case 'start':
      case 'claim':
        return;
    }
  }

  const shell = createShell({
    root: uiRoot,
    session: lan,
    settings,
    audio,
    appVersion: RELEASE.contentVersion,
    recentHosts: initial.storage.recentHosts,
    assets,
    webgl,
    onReloadAssets: () => {
      setAsset(0, 'pending');
      setAsset(1, 'pending');
      setAsset(2, 'pending');
      probeWebgl();
      loadFonts();
      setAsset(1, 'ready');
    },
    host: hostSetup,
    hostControl: (action, data) => void hostControl(action, data),
    createSession: kind => {
      active = kind === 'local'
        ? new LocalSession({ storage: 'auto', campaignId: null })
        : (lan = new LanSession());
      attach(active);
      return active;
    },
    onExport: kind => {
      if (kind !== 'settings') return;
      const text = JSON.stringify(settings.get(), null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'drift-settings.json';
      anchor.click();
      URL.revokeObjectURL(url);
    },
  });

  /** Adapter to presentation: the shell reads the view itself, this feeds the scene and the mixer. */
  const subscriptions: (() => void)[] = [];
  let view = lan.view();
  const attach = (session: SessionPort): void => {
    for (const dispose of subscriptions) dispose();
    subscriptions.length = 0;
    view = session.view();
    subscriptions.push(session.subscribe(next => {
      view = next;
      updateAudioListener(next.pilotId);
      updateHostCapability(next);
    }));
    subscriptions.push(session.events(event => {
      scene.handleEvent(event);
      audio.handleEvent(event);
    }));
  };
  const updateAudioListener = (pilotId: Id | null): void => {
    audio.setSelfPilotId(pilotId);
  };
  const updateHostCapability = (next: ClientView): void => {
    if (!liveHost || !next.host) return;
    liveHost.isOperator = next.host.isOperator;
    liveHost.canStop = next.host.canStop;
    liveHost.roomCode = next.host.roomCodeVisibleToCaptain;
  };
  attach(lan);

  const releaseInput = attachInput(input, { element: canvasHost, mapAim: point => scene.aimAt(point.x, point.y, point.width, point.height) });

  settings.subscribe(next => {
    input.setBindings(next.controls.bindings);
    input.setAngularAssist(next.flight.assistDefault);
    input.setSensitivity(next.controls.sensitivity);
    input.setGamepadEnabled(next.controls.gamepad);
    input.setTouchOptions({ largeControls: next.accessibility.largeControls, touchHandedness: next.controls.touchHandedness, touchAim: next.controls.touchAim });
    audio.setVolume('master', next.audio.master);
    audio.setVolume('music', next.audio.music);
    audio.setVolume('effects', next.audio.effects);
    audio.setVolume('ui', next.audio.ui);
    audio.setVolume('voice', next.audio.voice);
    scene.setQuality(qualityMode(next.graphics.quality));
  });

  const unlock = (): void => {
    audio.unlock();
  };
  globalThis.addEventListener('pointerdown', unlock);
  globalThis.addEventListener('keydown', unlock);

  // Read-only inspection surface for the browser tests: it exposes the current view and the frame
  // report, never a way to mutate authority state.
  (globalThis as unknown as { __DRIFT__?: unknown }).__DRIFT__ = {
    view: () => active.view(),
    poses: () => (isPoseProvider(active) ? active.poses(1 / 60) : null),
    report: () => scene.report?.(),
    scene,
    session: () => active,
  };

  let lastFrameMs = performance.now();
  let controlsActive = false;
  let handle = 0;
  const frame = (timeMs: number): void => {
    handle = requestAnimationFrame(frame);
    const dtSeconds = Math.min(0.25, Math.max(0, (timeMs - lastFrameMs) / 1000));
    lastFrameMs = timeMs;
    scene.render(view, dtSeconds, timeMs / 1000, isPoseProvider(active) ? active.poses(dtSeconds) : undefined);
    const enabled = shell.controlsActive && !document.hidden;
    if (enabled !== controlsActive) {
      input.releaseAll('overlay');
      controlsActive = enabled;
    }
    if (active instanceof LocalSession) active.setPaused(shell.paused);
    if (enabled) {
      input.pollGamepad();
      input.setLockTarget(shell.lockedContactId);
      active.setIntent(input.intent());
    }
  };
  handle = requestAnimationFrame(frame);

  const resize = (): void => {
    const width = canvasHost.clientWidth || globalThis.innerWidth;
    const height = canvasHost.clientHeight || globalThis.innerHeight;
    scene.resize(width, height);
    // The renderer sizes its drawing surface in device pixels and pins it inline; the host owns
    // layout, so the canvas always fills the host element and can never push the document wider
    // than the viewport after a rotation.
    const canvas = canvasHost.querySelector('canvas');
    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    }
  };
  resize();
  globalThis.addEventListener('resize', resize);

  globalThis.addEventListener('beforeunload', () => {
    cancelAnimationFrame(handle);
    releaseInput();
    globalThis.removeEventListener('resize', resize);
    globalThis.removeEventListener('pointerdown', unlock);
    globalThis.removeEventListener('keydown', unlock);
    for (const dispose of subscriptions) dispose();
    void shell.dispose();
  });
}

function qualityMode(quality: 'auto' | 'low' | 'medium' | 'high'): QualityMode {
  return quality;
}

void boot().catch(error => {
  const app = document.querySelector<HTMLElement>('#app');
  if (app) app.textContent = error instanceof Error ? error.message : 'DRIFT could not start.';
});
