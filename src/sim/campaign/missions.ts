/**
 * B8 "The Quiet Signal" campaign as data (Plan B8 table, transcribed row for row).
 *
 * The table's comma groups are *items* inside one objective ("recover-a,b,c in any order" is one
 * ordered objective with three unique item IDs), which is what makes progress countable by unique
 * item instead of by button press. Stages are the ordering primitive: every objective in a stage may
 * be attempted in any order, a later stage stays locked until the whole current stage is complete,
 * and only a branch gate (`requiresOption`) can leave an objective locked inside its own stage.
 *
 * Nothing here reads a clock, a socket or the catalog: it is authored content plus two pure
 * helpers. `MissionObjective` stays view-compatible with the frozen `ObjectiveView` contract.
 */

import { RULES } from '../../shared/balance.ts';
import type { DebriefView, Id, ObjectiveView, Vec2 } from '../../shared/contracts.ts';
import { RELEASE } from '../../shared/contracts.ts';

export const CAMPAIGN_TICK_RATE = RELEASE.physicsHz;

/** B7 wave scaling: never rescale existing HP, only future waves (cap is `RELEASE.maxPveEnemies`). */
export function waveCount(baseCount: number, activeHumans: number): number {
  const scaled = baseCount * (1 + 0.45 * Math.max(0, activeHumans - 1));
  return Math.min(RELEASE.maxPveEnemies, Math.ceil(scaled));
}

export type ObjectiveKind =
  | 'recover'
  | 'deliver'
  | 'clear'
  | 'rendezvous'
  | 'return'
  | 'withdraw'
  | 'extract'
  | 'scan'
  | 'translate'
  | 'repair'
  | 'hold'
  | 'charge'
  | 'escort'
  | 'defend'
  /** Settled by a recorded vote; never by a contact observation (B8 decisions). */
  | 'decision';

/** Shared work doubles the solo rate at most (B8); every other kind is a single-owner predicate. */
export const SHARED_WORK_KINDS: readonly ObjectiveKind[] = ['scan', 'repair'];

/** Literal states of the frozen `ObjectiveView` contract. */
export type ObjectiveState = ObjectiveView['state'];

export interface MissionOptionRef {
  decisionId: Id;
  optionId: Id;
}

export interface MissionObjective {
  id: Id;
  title: string;
  kind: ObjectiveKind;
  /** Objectives in the same stage run concurrently; later stages stay locked. */
  stage: number;
  /** Unique item IDs counted by the predicate; empty for single-shot objectives. */
  items: readonly Id[];
  /** Sustained seconds required per item for work kinds; 0 for contact predicates. */
  workSeconds: number;
  /** One marker per item (length 1 when `items` is empty). */
  anchors: readonly Vec2[];
  maxDistanceM: number;
  maxRelativeSpeedMS: number;
  /** Withdraw predicates require at least this distance instead of a maximum. */
  minDistanceM: number;
  /** Docking berth heading (radians) when `requiresBerth`. */
  berthHeadingRad: number | null;
  /** Berth rules apply: < 10 m/s, within 30 deg of heading, clear berth, visible queue (B8). */
  requiresBerth: boolean;
  /** Branch gate: active only while `decisionId` holds this option. */
  requiresOption: MissionOptionRef | null;
  subtitleIds: readonly Id[];
}

type ObjectiveSpec = Omit<MissionObjective, 'items' | 'workSeconds' | 'maxDistanceM' | 'maxRelativeSpeedMS' | 'minDistanceM' | 'berthHeadingRad' | 'requiresBerth' | 'requiresOption' | 'subtitleIds'> &
  Partial<MissionObjective>;

function objective(spec: ObjectiveSpec): MissionObjective {
  return {
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    stage: spec.stage,
    items: spec.items ?? [],
    workSeconds: spec.workSeconds ?? 0,
    anchors: spec.anchors,
    maxDistanceM: spec.maxDistanceM ?? 120,
    maxRelativeSpeedMS: spec.maxRelativeSpeedMS ?? 25,
    minDistanceM: spec.minDistanceM ?? 0,
    berthHeadingRad: spec.berthHeadingRad ?? null,
    requiresBerth: spec.requiresBerth ?? false,
    requiresOption: spec.requiresOption ?? null,
    subtitleIds: spec.subtitleIds ?? [],
  };
}

export interface MissionDecisionOption {
  id: Id;
  label: string;
  /** Ally that works the branch with the crew; 'none' when the branch is flown alone. */
  allyId: Id;
  /** Cosmetic/appearance change recorded by the choice; null when the branch has none. */
  cosmeticId: Id | null;
  /** Optional bonus on top of the mission reward; the base reward is identical on both branches. */
  bonusCredits: number;
  dialogueIds: readonly Id[];
}

export interface MissionDecision {
  id: Id;
  /** Objective the decision settles; committing completes it and opens its branch. */
  objectiveId: Id;
  prompt: string;
  options: readonly MissionDecisionOption[];
  /** Displayed conservative option used on a tie or when nobody votes. */
  defaultOptionId: Id;
  voteSeconds: number;
}

export type SpawnRole = 'crew' | 'wingman' | 'transport' | 'civilian' | 'hostile' | 'cargo' | 'wreck';

export interface MissionSpawnGroup {
  id: Id;
  role: SpawnRole;
  count: number;
  anchorId: Id;
  /** Catalog chassis the group may fly; empty for props, wrecks and structures. */
  chassisIds: readonly Id[];
  /** Added when this stage becomes active. */
  fromStage: number;
  /** ...and this objective has counted at least `afterItems` unique items (null = immediately). */
  triggerObjectiveId: Id | null;
  afterItems: number;
  /** Wave groups scale with active humans up to `RELEASE.maxPveEnemies` (B7). */
  wave: boolean;
}

export type MissionRecoveryRule =
  | { kind: 'lost-item-beacon'; itemIds: readonly Id[] }
  | { kind: 'zero-hull-tow'; transportId: Id; autoTowSeconds: number }
  | { kind: 'backup-route'; itemIds: readonly Id[] }
  | { kind: 'cell-return'; carrierId: Id; delaySeconds: number }
  | { kind: 'pods-on-loss'; transportIds: readonly Id[]; forfeits: 'optional-bonus' }
  | { kind: 'wipe-checkpoint' };

export interface MissionTransitions {
  success: Extract<DebriefView['outcome'], 'mission-complete'>;
  failure: Extract<DebriefView['outcome'], 'mission-failed'>;
  nextMissionId: Id | null;
  nextSectorId: Id | null;
  /** A wipe returns the attempt to the last checkpoint instead of failing the story. */
  wipe: 'retry-checkpoint';
  /** Human request + captain confirmation, then this long to dock (B8). */
  extractionWindowSeconds: number;
  /** Recovery column of the B8 table: what survives a loss on this mission. */
  recovery: readonly MissionRecoveryRule[];
  /** Repeatable contracts after completion, with no first-completion reward (B8). */
  repeatable: boolean;
}

export interface MissionDefinition {
  id: Id;
  index: number;
  title: string;
  /** Sector identity the map descriptor must preserve (B9). */
  sectorId: Id;
  /** Base generator map the sector override derives from. */
  mapId: Id;
  summary: string;
  objectives: readonly MissionObjective[];
  decisions: readonly MissionDecision[];
  spawnGroups: readonly MissionSpawnGroup[];
  rewardCredits: number;
  /** Unique receipt: one first-completion reward per mission (B9). */
  receiptId: Id;
  /** Parts/progression access granted on first completion; identical on both branches. */
  unlocks: readonly Id[];
  transitions: MissionTransitions;
  /** Brief, recovery and settlement subtitles for the mission. */
  subtitleIds: readonly Id[];
}

const M4_BRANCH: MissionDecision = {
  id: 'shelter-or-harvest',
  objectiveId: 'decide-shelter-or-harvest',
  prompt: 'The survivors are aboard the tender. Shelter them, or harvest the vault?',
  defaultOptionId: 'shelter',
  voteSeconds: RULES.voteSeconds,
  options: [
    {
      id: 'shelter',
      label: 'Shelter the survivors',
      allyId: 'wayfarer-tender',
      cosmeticId: null,
      bonusCredits: 0,
      dialogueIds: ['m4-decision-shelter', 'm4-ally-tender'],
    },
    {
      id: 'harvest',
      label: 'Harvest the vault',
      allyId: 'none',
      cosmeticId: 'scan-pattern-vault',
      bonusCredits: 60,
      dialogueIds: ['m4-decision-harvest', 'm4-ally-rig'],
    },
  ],
};

const M6_BRANCH: MissionDecision = {
  id: 'broadcast-or-seal',
  objectiveId: 'decide-broadcast-or-seal',
  prompt: 'Broadcast the maintenance protocol, or seal it in the Array?',
  defaultOptionId: 'seal',
  voteSeconds: RULES.voteSeconds,
  options: [
    {
      id: 'broadcast',
      label: 'Broadcast the protocol',
      allyId: 'witness-array',
      cosmeticId: null,
      bonusCredits: 0,
      dialogueIds: ['m6-decision-broadcast', 'm6-ally-array'],
    },
    {
      id: 'seal',
      label: 'Seal the archive',
      allyId: 'none',
      cosmeticId: null,
      bonusCredits: 0,
      dialogueIds: ['m6-decision-seal', 'm6-ally-solo'],
    },
  ],
};

export const CAMPAIGN_MISSIONS: readonly MissionDefinition[] = [
  {
    id: 'm1-ghosts-in-the-belt',
    index: 1,
    title: 'Ghosts in the belt',
    sectorId: 'belt',
    mapId: 'belt',
    summary: 'Three dead archive cores are drifting in the belt. Tag them before the raiders do.',
    objectives: [
      objective({
        id: 'recover-archives',
        title: 'Recover the three flight archives',
        kind: 'recover',
        stage: 0,
        items: ['recover-a', 'recover-b', 'recover-c'],
        anchors: [{ x: -820, y: 410 }, { x: 640, y: 900 }, { x: 980, y: -520 }],
        maxDistanceM: 75,
        maxRelativeSpeedMS: 12,
        subtitleIds: ['m1-archive-find'],
      }),
      objective({
        id: 'return-archives',
        title: 'Return to the Wayfarer',
        kind: 'return',
        stage: 1,
        anchors: [{ x: 0, y: -200 }],
        maxDistanceM: 90,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 0,
        requiresBerth: true,
        subtitleIds: ['m1-return'],
      }),
    ],
    decisions: [],
    spawnGroups: [
      { id: 'wayfarer-escort', role: 'wingman', count: 1, anchorId: 'carrier', chassisIds: ['kestrel'], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'raider-pair', role: 'hostile', count: 2, anchorId: 'archive-c', chassisIds: ['needle'], fromStage: 0, triggerObjectiveId: 'recover-archives', afterItems: 2, wave: false },
    ],
    rewardCredits: 120,
    receiptId: 'receipt-m1-archives',
    unlocks: ['gun-cutter', 'utility-salvage'],
    transitions: {
      success: 'mission-complete',
      failure: 'mission-failed',
      nextMissionId: 'm2-borrowed-light',
      nextSectorId: 'quarry',
      wipe: 'retry-checkpoint',
      extractionWindowSeconds: RULES.extractionSeconds,
      recovery: [
        { kind: 'lost-item-beacon', itemIds: ['recover-a', 'recover-b', 'recover-c'] },
        { kind: 'wipe-checkpoint' },
      ],
      repeatable: false,
    },
    subtitleIds: ['m1-intro', 'm1-raider-hail', 'm1-complete', 'm1-wipe', 'm1-archive-beacon'],
  },
  {
    id: 'm2-borrowed-light',
    index: 2,
    title: 'Borrowed light',
    sectorId: 'quarry',
    mapId: 'quarry',
    summary: 'The fuel transport Vesper has to cross the quarry. Escort her, clear the route, dock her.',
    objectives: [
      objective({
        id: 'rendezvous-vesper',
        title: 'Rendezvous with Vesper',
        kind: 'rendezvous',
        stage: 0,
        anchors: [{ x: 520, y: -640 }],
        maxDistanceM: 150,
        maxRelativeSpeedMS: 30,
        subtitleIds: ['m2-rendezvous'],
      }),
      objective({
        id: 'escort-leg-1',
        title: 'Escort Vesper through the first leg',
        kind: 'escort',
        stage: 1,
        anchors: [{ x: 280, y: -260 }],
        workSeconds: 12,
        maxDistanceM: 220,
        maxRelativeSpeedMS: 45,
        subtitleIds: ['m2-escort'],
      }),
      objective({
        id: 'clear-route',
        title: 'Clear the quarry pickets',
        kind: 'clear',
        stage: 2,
        items: ['route-picket-1', 'route-picket-2', 'route-picket-3'],
        anchors: [{ x: 60, y: -120 }, { x: -140, y: 60 }, { x: -320, y: 180 }],
        maxDistanceM: 320,
        maxRelativeSpeedMS: 140,
        subtitleIds: ['m2-clear'],
      }),
      objective({
        id: 'escort-leg-2',
        title: 'Escort Vesper to the berth',
        kind: 'escort',
        stage: 3,
        anchors: [{ x: -420, y: 320 }],
        workSeconds: 15,
        maxDistanceM: 220,
        maxRelativeSpeedMS: 45,
        subtitleIds: ['m2-escort'],
      }),
      objective({
        id: 'dock-vesper',
        title: 'Dock Vesper at the Wayfarer',
        kind: 'return',
        stage: 4,
        anchors: [{ x: 0, y: -180 }],
        maxDistanceM: 90,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 0,
        requiresBerth: true,
        subtitleIds: ['m2-dock'],
      }),
    ],
    decisions: [],
    spawnGroups: [
      { id: 'vesper-transport', role: 'transport', count: 1, anchorId: 'vesper-anchor', chassisIds: ['mule'], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'quarry-pickets', role: 'hostile', count: 3, anchorId: 'route-corridor', chassisIds: ['needle'], fromStage: 2, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'route-tender', role: 'wingman', count: 1, anchorId: 'vesper-anchor', chassisIds: ['kestrel'], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
    ],
    rewardCredits: 160,
    receiptId: 'receipt-m2-resupply',
    unlocks: ['sensor-survey'],
    transitions: {
      success: 'mission-complete',
      failure: 'mission-failed',
      nextMissionId: 'm3-listening-stone',
      nextSectorId: 'relay',
      wipe: 'retry-checkpoint',
      extractionWindowSeconds: RULES.extractionSeconds,
      recovery: [
        { kind: 'zero-hull-tow', transportId: 'vesper-transport', autoTowSeconds: 45 },
        { kind: 'wipe-checkpoint' },
      ],
      repeatable: false,
    },
    subtitleIds: ['m2-intro', 'm2-tow', 'm2-complete', 'm2-wipe'],
  },
  {
    id: 'm3-listening-stone',
    index: 3,
    title: 'Listening stone',
    sectorId: 'relay',
    mapId: 'expanse',
    summary: 'The relay is still working. Scan its nodes, translate the protocol, then withdraw.',
    objectives: [
      objective({
        id: 'scan-nodes',
        title: 'Scan the three relay nodes',
        kind: 'scan',
        stage: 0,
        items: ['scan-north', 'scan-south', 'scan-core'],
        anchors: [{ x: 0, y: 900 }, { x: 0, y: -900 }, { x: 0, y: 0 }],
        workSeconds: 3,
        maxDistanceM: 120,
        maxRelativeSpeedMS: 15,
        subtitleIds: ['m3-scan'],
      }),
      objective({
        id: 'translate',
        title: 'Translate the protocol',
        kind: 'translate',
        stage: 1,
        anchors: [{ x: 0, y: 0 }],
        workSeconds: 10,
        maxDistanceM: 70,
        maxRelativeSpeedMS: 6,
        subtitleIds: ['m3-translate'],
      }),
      objective({
        id: 'withdraw',
        title: 'Withdraw from the relay',
        kind: 'withdraw',
        stage: 2,
        anchors: [{ x: 0, y: 1400 }],
        maxDistanceM: 2400,
        maxRelativeSpeedMS: 400,
        minDistanceM: 400,
        subtitleIds: ['m3-withdraw'],
      }),
    ],
    decisions: [],
    spawnGroups: [
      { id: 'travelling-custodians', role: 'civilian', count: 3, anchorId: 'relay-core', chassisIds: [], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'relay-ribs', role: 'wreck', count: 4, anchorId: 'relay-core', chassisIds: [], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
    ],
    rewardCredits: 180,
    receiptId: 'receipt-m3-relay',
    unlocks: ['gun-rail', 'reactor-hot'],
    transitions: {
      success: 'mission-complete',
      failure: 'mission-failed',
      nextMissionId: 'm4-terms-of-silence',
      nextSectorId: 'relay',
      wipe: 'retry-checkpoint',
      extractionWindowSeconds: RULES.extractionSeconds,
      recovery: [
        { kind: 'backup-route', itemIds: ['scan-north', 'scan-south', 'scan-core'] },
        { kind: 'wipe-checkpoint' },
      ],
      repeatable: false,
    },
    subtitleIds: ['m3-intro', 'm3-custodian-warn', 'm3-complete', 'm3-wipe'],
  },
  {
    id: 'm4-terms-of-silence',
    index: 4,
    title: 'Terms of silence',
    sectorId: 'relay',
    mapId: 'expanse',
    summary: 'Two pods are still signalling inside the relay shell. Shelter them or take the vault.',
    objectives: [
      objective({
        id: 'recover-survivors',
        title: 'Recover the two survivor pods',
        kind: 'recover',
        stage: 0,
        items: ['pod-1', 'pod-2'],
        anchors: [{ x: -620, y: -430 }, { x: 520, y: -760 }],
        maxDistanceM: 60,
        maxRelativeSpeedMS: 15,
        subtitleIds: ['m4-survivors'],
      }),
      objective({
        id: 'decide-shelter-or-harvest',
        title: 'Decide the terms',
        kind: 'decision',
        stage: 1,
        anchors: [{ x: 0, y: 0 }],
        maxDistanceM: 0,
        maxRelativeSpeedMS: 0,
        subtitleIds: ['m4-intro'],
      }),
      objective({
        id: 'defend-tender',
        title: 'Defend the tender',
        kind: 'defend',
        stage: 2,
        anchors: [{ x: 0, y: 0 }],
        workSeconds: 20,
        maxDistanceM: 160,
        maxRelativeSpeedMS: 60,
        requiresOption: { decisionId: 'shelter-or-harvest', optionId: 'shelter' },
        subtitleIds: ['m4-defend-tender'],
      }),
      objective({
        id: 'extract-sample',
        title: 'Extract the archive sample',
        kind: 'recover',
        stage: 2,
        items: ['archive-sample'],
        anchors: [{ x: -140, y: 320 }],
        maxDistanceM: 55,
        maxRelativeSpeedMS: 15,
        requiresOption: { decisionId: 'shelter-or-harvest', optionId: 'harvest' },
        subtitleIds: ['m4-extract-sample'],
      }),
      objective({
        id: 'return',
        title: 'Return to the Wayfarer',
        kind: 'return',
        stage: 3,
        anchors: [{ x: 0, y: -200 }],
        maxDistanceM: 90,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 0,
        requiresBerth: true,
        subtitleIds: ['m4-return'],
      }),
    ],
    decisions: [M4_BRANCH],
    spawnGroups: [
      { id: 'survivor-pods', role: 'civilian', count: 2, anchorId: 'pod-1', chassisIds: [], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'cinder-raiders', role: 'hostile', count: 2, anchorId: 'relay-core', chassisIds: ['needle'], fromStage: 2, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'harvest-tender', role: 'transport', count: 1, anchorId: 'relay-core', chassisIds: ['mule'], fromStage: 2, triggerObjectiveId: null, afterItems: 0, wave: false },
    ],
    rewardCredits: 180,
    receiptId: 'receipt-m4-terms',
    unlocks: ['armor-dense'],
    transitions: {
      success: 'mission-complete',
      failure: 'mission-failed',
      nextMissionId: 'm5-closed-circuit',
      nextSectorId: 'conduit',
      wipe: 'retry-checkpoint',
      extractionWindowSeconds: RULES.extractionSeconds,
      recovery: [
        { kind: 'lost-item-beacon', itemIds: ['pod-1', 'pod-2'] },
        { kind: 'wipe-checkpoint' },
      ],
      repeatable: false,
    },
    subtitleIds: ['m4-intro', 'm4-complete', 'm4-wipe'],
  },
  {
    id: 'm5-closed-circuit',
    index: 5,
    title: 'Closed circuit',
    sectorId: 'conduit',
    mapId: 'belt',
    summary: 'Two conduit cells are dead. Deliver replacements, patch the junctions, hold the relay.',
    objectives: [
      objective({
        id: 'deliver-cell-a',
        title: 'Deliver cell A to junction A',
        kind: 'deliver',
        stage: 0,
        items: ['cell-a'],
        anchors: [{ x: 180, y: 420 }],
        maxDistanceM: 50,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 1.5708,
        requiresBerth: true,
        subtitleIds: ['m5-deliver'],
      }),
      objective({
        id: 'repair-a',
        title: 'Repair junction A',
        kind: 'repair',
        stage: 1,
        anchors: [{ x: 180, y: 420 }],
        workSeconds: 8,
        maxDistanceM: 60,
        maxRelativeSpeedMS: 5,
        subtitleIds: ['m5-repair'],
      }),
      objective({
        id: 'deliver-cell-b',
        title: 'Deliver cell B to junction B',
        kind: 'deliver',
        stage: 2,
        items: ['cell-b'],
        anchors: [{ x: -260, y: 360 }],
        maxDistanceM: 50,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 1.5708,
        requiresBerth: true,
        subtitleIds: ['m5-deliver'],
      }),
      objective({
        id: 'repair-b',
        title: 'Repair junction B',
        kind: 'repair',
        stage: 3,
        anchors: [{ x: -260, y: 360 }],
        workSeconds: 8,
        maxDistanceM: 60,
        maxRelativeSpeedMS: 5,
        subtitleIds: ['m5-repair'],
      }),
      objective({
        id: 'hold-relay',
        title: 'Hold the relay while it charges',
        kind: 'hold',
        stage: 4,
        anchors: [{ x: 0, y: 300 }],
        workSeconds: 60,
        maxDistanceM: 140,
        maxRelativeSpeedMS: 40,
        subtitleIds: ['m5-hold'],
      }),
      objective({
        id: 'extract',
        title: 'Extract to the Wayfarer',
        kind: 'extract',
        stage: 5,
        anchors: [{ x: 0, y: -200 }],
        maxDistanceM: 90,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 0,
        requiresBerth: true,
        subtitleIds: ['m5-extract'],
      }),
    ],
    decisions: [],
    spawnGroups: [
      { id: 'conduit-cells', role: 'cargo', count: 2, anchorId: 'carrier', chassisIds: [], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'conduit-wave', role: 'hostile', count: 2, anchorId: 'relay-core', chassisIds: ['needle', 'kestrel'], fromStage: 4, triggerObjectiveId: null, afterItems: 0, wave: true },
    ],
    rewardCredits: 220,
    receiptId: 'receipt-m5-conduits',
    unlocks: ['utility-ecm', 'gun-torpedo'],
    transitions: {
      success: 'mission-complete',
      failure: 'mission-failed',
      nextMissionId: 'm6-a-long-way-home',
      nextSectorId: 'homebound',
      wipe: 'retry-checkpoint',
      extractionWindowSeconds: RULES.extractionSeconds,
      recovery: [
        { kind: 'cell-return', carrierId: 'wayfarer', delaySeconds: 20 },
        { kind: 'wipe-checkpoint' },
      ],
      repeatable: false,
    },
    subtitleIds: ['m5-intro', 'm5-cell-lost', 'm5-complete', 'm5-wipe'],
  },
  {
    id: 'm6-a-long-way-home',
    index: 6,
    title: 'A long way home',
    sectorId: 'homebound',
    mapId: 'expanse',
    summary: 'The Cinder blockade sits on the homebound lane. Escort the evacuation, break the screen, charge the gate.',
    objectives: [
      objective({
        id: 'escort-evacuation',
        title: 'Escort the evacuation column',
        kind: 'escort',
        stage: 0,
        anchors: [{ x: 700, y: 800 }],
        workSeconds: 20,
        maxDistanceM: 260,
        maxRelativeSpeedMS: 70,
        subtitleIds: ['m6-evacuation'],
      }),
      objective({
        id: 'break-blockade',
        title: 'Break the blockade screen',
        kind: 'clear',
        stage: 1,
        items: ['blockade-1', 'blockade-2', 'blockade-3', 'blockade-4'],
        anchors: [{ x: 240, y: 160 }, { x: -200, y: 60 }, { x: 320, y: -260 }, { x: -160, y: -340 }],
        maxDistanceM: 340,
        maxRelativeSpeedMS: 150,
        subtitleIds: ['m6-blockade'],
      }),
      objective({
        id: 'decide-broadcast-or-seal',
        title: 'Decide the fate of the protocol',
        kind: 'decision',
        stage: 2,
        anchors: [{ x: 0, y: -500 }],
        maxDistanceM: 0,
        maxRelativeSpeedMS: 0,
        subtitleIds: ['m6-intro'],
      }),
      objective({
        id: 'charge-gate',
        title: 'Charge the homebound gate',
        kind: 'charge',
        stage: 3,
        anchors: [{ x: 0, y: -500 }],
        workSeconds: 45,
        maxDistanceM: 100,
        maxRelativeSpeedMS: 12,
        subtitleIds: ['m6-charge'],
      }),
      objective({
        id: 'extract-crew',
        title: 'Extract the crew',
        kind: 'extract',
        stage: 4,
        anchors: [{ x: 0, y: -200 }],
        maxDistanceM: 90,
        maxRelativeSpeedMS: 10,
        berthHeadingRad: 0,
        requiresBerth: true,
        subtitleIds: ['m6-complete'],
      }),
    ],
    decisions: [M6_BRANCH],
    spawnGroups: [
      { id: 'evacuation-column', role: 'civilian', count: 3, anchorId: 'evacuation-column', chassisIds: ['mule'], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'blockade-screen', role: 'hostile', count: 4, anchorId: 'blockade-line', chassisIds: ['needle', 'kestrel'], fromStage: 1, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'evac-transports', role: 'transport', count: 3, anchorId: 'evacuation-column', chassisIds: ['mule'], fromStage: 0, triggerObjectiveId: null, afterItems: 0, wave: false },
      { id: 'gate-couplers', role: 'wreck', count: 3, anchorId: 'gate', chassisIds: [], fromStage: 3, triggerObjectiveId: null, afterItems: 0, wave: false },
    ],
    rewardCredits: 300,
    receiptId: 'receipt-m6-homebound',
    unlocks: ['torch-sprint', 'gun-flak'],
    transitions: {
      success: 'mission-complete',
      failure: 'mission-failed',
      nextMissionId: null,
      nextSectorId: null,
      wipe: 'retry-checkpoint',
      extractionWindowSeconds: RULES.extractionSeconds,
      recovery: [
        { kind: 'pods-on-loss', transportIds: ['evac-transport-1', 'evac-transport-2', 'evac-transport-3'], forfeits: 'optional-bonus' },
        { kind: 'wipe-checkpoint' },
      ],
      repeatable: true,
    },
    subtitleIds: ['m6-intro', 'm6-pods', 'm6-complete', 'm6-wipe'],
  },
];

const BY_ID: Record<Id, MissionDefinition> = {};
for (const mission of CAMPAIGN_MISSIONS) BY_ID[mission.id] = mission;

export function missionDefinition(missionId: Id): MissionDefinition | null {
  return BY_ID[missionId] ?? null;
}

/** Next mission in the linear M1..M6 chain, or null at the end. */
export function nextMission(missionId: Id): MissionDefinition | null {
  const mission = missionDefinition(missionId);
  return mission === null || mission.transitions.nextMissionId === null ? null : missionDefinition(mission.transitions.nextMissionId);
}

export function missionDecision(mission: MissionDefinition, decisionId: Id): MissionDecision | null {
  return mission.decisions.find(candidate => candidate.id === decisionId) ?? null;
}

/** Stage count of a mission; stage numbers are authored but must form 0..n-1 without gaps. */
export function stageCount(mission: MissionDefinition): number {
  let count = 0;
  for (const entry of mission.objectives) count = Math.max(count, entry.stage + 1);
  return count;
}

/** Every subtitle the campaign can display, for dialogue coverage checks and the operator guide. */
export function allSubtitleIds(): readonly Id[] {
  const ids = new Set<Id>();
  for (const mission of CAMPAIGN_MISSIONS) {
    for (const id of mission.subtitleIds) ids.add(id);
    for (const entry of mission.objectives) for (const id of entry.subtitleIds) ids.add(id);
    for (const decision of mission.decisions) for (const option of decision.options) for (const id of option.dialogueIds) ids.add(id);
  }
  return [...ids];
}

/** Stable entity IDs for a spawn group; the seed varies composition, never the ID (B9). */
export function spawnEntityIds(group: MissionSpawnGroup): readonly Id[] {
  const ids: Id[] = [];
  for (let index = 0; index < group.count; index++) ids.push(`${group.id}-${index + 1}`);
  return ids;
}
