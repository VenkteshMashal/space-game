import { describe, expect, test } from 'bun:test';
import { AudioMixer, cueForEvent } from '../src/audio/mixer.ts';
import type {
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  FilterLike,
  GainLike,
  OscillatorLike,
} from '../src/audio/synth.ts';
import type { EventPayloadByKind, SessionEvent, SessionEventKind } from '../src/shared/contracts.ts';

class FakeParam implements AudioParamLike {
  value = 0;

  setValueAtTime(_value: number, _time: number): unknown {
    return this;
  }

  linearRampToValueAtTime(_value: number, _time: number): unknown {
    return this;
  }

  exponentialRampToValueAtTime(_value: number, _time: number): unknown {
    return this;
  }

  setTargetAtTime(_target: number, _time: number, _constant: number): unknown {
    return this;
  }
}

class FakeNode implements AudioNodeLike {
  readonly targets: AudioNodeLike[] = [];
  disconnects = 0;

  connect(destination: AudioNodeLike): unknown {
    this.targets.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnects += 1;
  }
}

class FakeGain extends FakeNode implements GainLike {
  readonly gain = new FakeParam();
}

class FakeFilter extends FakeNode implements FilterLike {
  type = 'lowpass';
  readonly frequency = new FakeParam();
}

class FakeOscillator extends FakeNode implements OscillatorLike {
  type = 'sine';
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  starts = 0;
  stops = 0;

  start(_when?: number): void {
    this.starts += 1;
  }

  stop(_when?: number): void {
    this.stops += 1;
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = 'suspended';
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  resumes = 0;
  susps = 0;
  closed = 0;

  createGain(): GainLike {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createOscillator(): OscillatorLike {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  createBiquadFilter(): FilterLike {
    return new FakeFilter();
  }

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.susps += 1;
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.state = 'closed';
  }
}

interface Rig {
  mixer: AudioMixer;
  context: FakeContext;
  created: number;
}

async function rig(options: { maxEffectVoices?: number; maxEngines?: number; selfPilotId?: string | null } = {}): Promise<Rig> {
  const context = new FakeContext();
  let created = 0;
  const mixer = new AudioMixer({
    contextFactory: () => {
      created += 1;
      return context;
    },
    maxEffectVoices: options.maxEffectVoices,
    maxEngines: options.maxEngines,
    selfPilotId: options.selfPilotId ?? null,
  });
  await mixer.unlock();
  return { mixer, context, created };
}

function eventOf<K extends SessionEventKind>(kind: K, eventId: string, payload: EventPayloadByKind[K]): SessionEvent {
  return { deliverySeq: 1, tick: 10, epoch: 'e1', eventId, kind, payload };
}

describe('mixer lifecycle', () => {
  test('no context is created before a user gesture', async () => {
    let created = 0;
    const mixer = new AudioMixer({
      contextFactory: () => {
        created += 1;
        return new FakeContext();
      },
    });
    expect(mixer.play({ cue: 'ui-click' })).toBe(false);
    expect(created).toBe(0);
    expect(mixer.isUnlocked()).toBe(false);
  });

  test('unlock creates the context once and resumes a suspended one', async () => {
    const { mixer, context, created } = await rig();
    expect(created).toBe(1);
    expect(context.resumes).toBe(1);
    expect(mixer.isUnlocked()).toBe(true);
    await mixer.unlock();
    expect(created).toBe(1);
  });

  test('suspend silences playback until the next permitted gesture', async () => {
    const { mixer, context } = await rig();
    expect(mixer.play({ cue: 'ui-click' })).toBe(true);
    await mixer.suspend();
    expect(mixer.isUnlocked()).toBe(false);
    expect(mixer.play({ cue: 'ui-click' })).toBe(false);
    expect(context.susps).toBe(1);
    expect(await mixer.unlock()).toBe(true);
    expect(mixer.play({ cue: 'ui-click' })).toBe(true);
  });

  test('a context factory that fails leaves the mixer silent instead of throwing', async () => {
    const mixer = new AudioMixer({
      contextFactory: () => {
        throw new Error('blocked');
      },
    });
    expect(await mixer.unlock()).toBe(false);
    expect(mixer.play({ cue: 'ui-click' })).toBe(false);
  });
});

describe('voice budget', () => {
  test('one-shots cull to 32 voices', async () => {
    const { mixer } = await rig();
    let played = 0;
    for (let index = 0; index < 40; index += 1) if (mixer.play({ cue: 'ui-click' })) played += 1;
    expect(played).toBe(32);
    expect(mixer.activeEffectVoices()).toBe(32);
  });

  test('an important or nearer event steals a distant quiet one', async () => {
    const { mixer } = await rig({ maxEffectVoices: 1 });
    expect(mixer.play({ cue: 'impact-remote', position: { x: 600, y: 0 } })).toBe(true);
    expect(mixer.activeEffectVoices()).toBe(1);
    // Lower priority never displaces the occupant.
    expect(mixer.play({ cue: 'ui-click' })).toBe(false);
    expect(mixer.activeEffectVoices()).toBe(1);
    // A confirmed, close impact does.
    expect(mixer.play({ cue: 'impact-confirmed', position: { x: 10, y: 0 } })).toBe(true);
    expect(mixer.activeEffectVoices()).toBe(1);
  });

  test('combat outside the tactical range stays silent', async () => {
    const { mixer } = await rig();
    expect(mixer.play({ cue: 'impact-confirmed', position: { x: 5000, y: 0 } })).toBe(false);
    expect(mixer.activeEffectVoices()).toBe(0);
  });

  test('engines are bounded to 8 and culled by importance', async () => {
    const { mixer, context } = await rig();
    for (let index = 0; index < 8; index += 1) mixer.setEngine(`engine-${index}`, 0.1, { x: 0, y: 0 });
    expect(mixer.activeEngines()).toBe(8);
    // A ninth, weaker engine never gets a voice.
    mixer.setEngine('weak', 0.05, { x: 0, y: 0 });
    expect(mixer.activeEngines()).toBe(8);
    // The loud hero replaces the weakest slot: one more oscillator, still eight engines.
    mixer.setEngine('hero', 1, { x: 0, y: 0 });
    expect(mixer.activeEngines()).toBe(8);
    expect(context.oscillators.length).toBe(9);
  });
});

describe('deduplication', () => {
  test('a duplicate cue key plays once', async () => {
    const { mixer } = await rig();
    expect(mixer.play({ cue: 'ui-click', key: 'e1' })).toBe(true);
    expect(mixer.play({ cue: 'ui-click', key: 'e1' })).toBe(false);
    expect(mixer.activeEffectVoices()).toBe(1);
  });

  test('an authority event replayed across a burst still plays once', async () => {
    const { mixer } = await rig();
    const notice = eventOf('notice', 'evt-7', { code: 'thermal-limit', message: 'Thermal limit', forPilotId: null });
    mixer.handleEvent(notice);
    mixer.handleEvent(notice);
    mixer.handleEvent(notice);
    expect(mixer.activeEffectVoices()).toBe(1);
  });
});

describe('cue conventions', () => {
  test('confirmed impact, lock, thermal, objective, distress and save failure are distinct', () => {
    const impact = eventOf('impact', 'i1', {
      hitId: 'h1', kind: 'ship', targetId: 't1', position: { x: 0, y: 0 }, normal: { x: 1, y: 0 },
      damage: 4, energyJ: 10, destroyed: false, attackerPilotId: 'me', victimPilotId: 'you',
    });
    const remote = eventOf('impact', 'i2', {
      hitId: 'h2', kind: 'rock', targetId: 'r1', position: { x: 4, y: 0 }, normal: { x: 1, y: 0 },
      damage: 2, energyJ: 4, destroyed: false, attackerPilotId: 'a', victimPilotId: 'b',
    });
    expect(cueForEvent(impact, 'me')).toBe('impact-confirmed');
    expect(cueForEvent(remote, 'me')).toBe('impact-remote');
    expect(cueForEvent(eventOf('notice', 'n1', { code: 'thermal-limit', message: '', forPilotId: null }), 'me')).toBe('thermal-limit');
    expect(cueForEvent(eventOf('notice', 'n2', { code: 'boundary-warning', message: '', forPilotId: null }), 'me')).toBe('boundary');
    expect(cueForEvent(eventOf('objective', 'o1', { objectiveId: 'obj', state: 'complete', completed: 1, required: 1 }), 'me')).toBe('objective-complete');
    expect(cueForEvent(eventOf('save', 's1', { state: 'failed', at: null, reason: 'disk' }), 'me')).toBe('save-failed');
    expect(cueForEvent(eventOf('life', 'l1', { lifeId: 'l', shipId: 's', pilotId: 'crew', life: 'disabled', position: { x: 0, y: 0 }, respawnAtTick: null }), 'me')).toBe('ally-distress');
    expect(cueForEvent(eventOf('life', 'l2', { lifeId: 'l', shipId: 's', pilotId: 'crew', life: 'alive', position: { x: 0, y: 0 }, respawnAtTick: null }), 'me')).toBeNull();
    expect(cueForEvent(eventOf('roster', 'r1', { reason: 'join', pilotId: 'p', revision: 1 }), 'me')).toBeNull();
  });

  test('lock warning keeps the crew bus separate from combat effects', async () => {
    const { mixer, context } = await rig();
    expect(mixer.play({ cue: 'lock-warning' })).toBe(true);
    expect(mixer.play({ cue: 'ally-distress' })).toBe(true);
    expect(mixer.activeEffectVoices()).toBe(2);
    // Bus creation order: master, music, effects, ui, voice.
    const buses = context.gains.slice(0, 5);
    expect(buses.length).toBe(5);
    expect(context.gains.some((gain) => gain.targets.includes(buses[3]))).toBe(true);
    expect(context.gains.some((gain) => gain.targets.includes(buses[4]))).toBe(true);
    expect(context.gains.length).toBeGreaterThan(5);
  });
});

describe('volumes', () => {
  test('bus levels clamp to 0..1 and reach their nodes', async () => {
    const { mixer, context } = await rig();
    mixer.setVolume('master', 5);
    mixer.setVolume('effects', -3);
    expect(context.gains[0].gain.value).toBe(1);
    expect(context.gains[2].gain.value).toBe(0);
    mixer.applyVolumes({ master: 0.5, effects: 0.25, ui: 0.1 });
    expect(context.gains[0].gain.value).toBe(0.5);
    expect(context.gains[2].gain.value).toBe(0.25);
    expect(context.gains[3].gain.value).toBeCloseTo(0.1, 5);
  });
});

describe('disposal', () => {
  test('dispose releases every voice and closes the context, exactly once', async () => {
    const { mixer, context } = await rig();
    mixer.play({ cue: 'impact-confirmed', position: { x: 0, y: 0 } });
    mixer.play({ cue: 'ui-click' });
    mixer.setEngine('a', 0.5, { x: 0, y: 0 });
    mixer.setEngine('b', 0.7, { x: 0, y: 0 });
    expect(context.oscillators.length).toBeGreaterThan(2);

    await mixer.dispose();
    expect(mixer.activeEffectVoices()).toBe(0);
    expect(mixer.activeEngines()).toBe(0);
    expect(context.closed).toBe(1);
    expect(context.state).toBe('closed');
    for (const oscillator of context.oscillators) expect(oscillator.disconnects).toBeGreaterThan(0);
    expect(mixer.isUnlocked()).toBe(false);

    await mixer.dispose();
    expect(context.closed).toBe(1);
    expect(mixer.play({ cue: 'ui-click' })).toBe(false);
  });
});
