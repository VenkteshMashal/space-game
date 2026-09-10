/**
 * DRIFT shared contract v2 — canonical since gate C0.
 *
 * Promoted from `design/contracts.ts`. This is the single runtime definition; the design file is
 * the frozen review record and MUST NOT be imported by the game. Field names, units, null
 * behaviour, revisions and error codes are frozen here: Plan A (presentation, input,
 * accessibility) and Plan B (rules, units, protocol, saves) both consume this file, and when they
 * disagree this file decides.
 *
 * Units: metres, seconds, kilograms, newtons, megawatts, megajoules, radians (counterclockwise),
 * angle zero faces +Y with forward `(-sin θ, cos θ)`. Ticks are integer end-of-step authority ticks
 * and `State(T)` includes all work through `T`. Shared code imports no Bun, Three.js or DOM.
 */

export const RELEASE = {
  protocol: 2,
  saveSchema: 2,
  contentVersion: 'quiet-signal-1',
  maxHumans: 8,
  maxPvpCombatants: 8,
  maxPveEnemies: 16,
  maxMissionShips: 2,
  physicsHz: 120,
  inputHz: 60,
  snapshotHz: 30,
  rockHz: 10,
  inputLeaseTicks: 30,
  reconnectSeconds: 60,
  maxProjectiles: 512,
  maxPhysicalRocks: 256,
  maxCargo: 64,
} as const;

export type Id = string;
export type Vec2 = Readonly<{ x: number; y: number }>;
export type Mode = 'campaign' | 'skirmish' | 'team-deathmatch';
export type Phase = 'lobby' | 'loading' | 'countdown' | 'live' | 'extraction' | 'settlement' | 'debrief';
export type Life = 'staged' | 'alive' | 'disabled' | 'destroyed' | 'respawning' | 'spectating';
export type Presence = 'connected' | 'reconnecting' | 'away' | 'left';
export type Screen = 'title' | 'host' | 'join' | 'lobby' | 'campaign' | 'hangar' | 'flight' | 'debrief';
export type Overlay = 'none' | 'menu' | 'settings' | 'map' | 'scoreboard' | 'help';
export type LinkState = 'idle' | 'connecting' | 'handshake' | 'loading' | 'online' | 'reconnecting' | 'failed';
export type SlotKind = 'weapon' | 'engine' | 'reactor' | 'armor' | 'sensor' | 'utility';

export interface Fit {
  chassisId: Id;
  paintId: Id;
  /** Slot ID -> catalog part ID. Inventory instance IDs are separate campaign reservations. */
  slots: Readonly<Record<Id, Id>>;
  fireGroups: readonly (readonly Id[])[];
  powerPriority: readonly SlotKind[];
}

export interface FlightIntent {
  thrust: number;
  turn: number;
  strafe: number;
  brake: boolean;
  boost: boolean;
  angularAssist: boolean;
  fireMask: number;
  aimWorld: Vec2 | null;
  lockContactId: Id | null;
}

/** Ticks are integer, end-of-step authority ticks. State(T) includes all work through T. */
export interface InputFrame {
  epoch: Id;
  lifeId: Id;
  seq: number;
  targetTick: number;
  intent: FlightIntent;
}

export interface ScheduledInput { seq: number; applyAtTick: number; intent: FlightIntent }

export interface InputReceipt {
  seq: number;
  result: 'scheduled' | 'stale' | 'invalid' | 'wrong-life';
  applyAtTick?: number;
}

export interface RosterEntry {
  pilotId: Id;
  name: string;
  teamId: Id;
  isBot: boolean;
  presence: Presence;
  life: Life;
  readyRevision: number | null;
  fit: Fit;
  pingMs: number | null;
  /** Seat slot 0..7; reserved seats keep their slot through the reconnect grace window. */
  seat: number;
}

export interface LobbyView {
  revision: number;
  captainId: Id;
  mode: Mode;
  mapId: Id;
  missionId: Id | null;
  joinPolicy: 'open' | 'code' | 'closed';
  roster: readonly RosterEntry[];
  canStart: boolean;
  startBlockers: readonly string[];
  /** Captain-only: configured bot fill target and difficulty, null when not set. */
  botFill: { total: number; difficulty: BotDifficulty } | null;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface DerivedFit {
  hash: string;
  valid: boolean;
  errors: readonly string[];
  dryMassKg: number;
  fuelCapacityKg: number;
  hullMax: number;
  thrustN: number;
  inertiaKgM2: number;
  powerSupplyMW: number;
  idleDemandMW: number;
  coolingMW: number;
  heatCapacityMJ: number;
  capacitorMJ: number;
  buildCost: number;
}

/** Full derivation detail. Superset of `DerivedFit`; the contract fields above never change shape. */
export interface FitDerivation extends DerivedFit {
  chassisId: Id;
  wetMassKg: number;
  activeDemandMW: number;
  /** Reverse, lateral and brake force as fractions of available torch force. */
  reverseFactor: number;
  lateralFactor: number;
  brakeFactor: number;
  boostFactor: number;
  fuelKgS: number;
  heatMW: number;
  rcsTorqueMNm: number;
  maxWetMassKg: number;
  cargoAddKg: number;
  passiveRangeM: number;
  activeRangeM: number;
  activeScanMW: number;
  scanMultiplier: number;
  signatureMultiplier: number;
  kineticReduction: number;
  thermalReduction: number;
  repairHullS: number;
  repairStock: number;
  repairRangeM: number;
  tetherRangeM: number;
  tetherForceN: number;
  tetherBreakForceN: number;
  capacitorChargeLimitMW: number;
  ecmCharges: number;
  ecmDurationS: number;
  ecmCooldownS: number;
  weaponSlots: readonly WeaponSlot[];
  utilities: readonly UtilitySlot[];
  /** Sorted part IDs (ascending) used for multiplicative-effect order and the canonical hash. */
  partIds: readonly Id[];
}

export interface WeaponSlot {
  slotId: Id;
  partId: Id;
  size: number;
  behavior: WeaponBehavior;
  cooldownS: number;
  damage: number;
  magazine: number | null;
  reserve: number | null;
  reloadS: number | null;
  ttlS: number;
  speedMS: number;
  heatShotMJ: number;
  energyShotMJ: number;
  chargeS: number;
  impulseNS: number;
  roundMassKg: number;
  /** Behaviour-specific limits; null when the behaviour has no such limit. */
  perOwnerCap: number | null;
  armS: number;
  blastM: number;
  defenseRangeM: number | null;
  rangeM: number | null;
  damageS: number | null;
  rockDamageS: number | null;
  accelerationMS2: number;
  turnRadS: number;
  burnS: number;
}

export type WeaponBehavior = 'ballistic' | 'point-defense' | 'rail' | 'flak' | 'torpedo' | 'mine' | 'beam';

export interface UtilitySlot { slotId: Id; partId: Id; kind: 'radiator' | 'capacitor' | 'repair' | 'tether' | 'ecm' | 'salvage' }

export interface ShipView {
  id: Id;
  pilotId: Id | null;
  lifeId: Id;
  teamId: Id;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  fit: Fit;
  hull: number;
  hullMax: number;
  fuelKg: number;
  fuelMaxKg: number;
  heatMJ: number;
  heatMaxMJ: number;
  capacitorMJ: number;
  life: Life;
}

/** Lossless-enough own-ship state for B4 replay. Damage, score and inventory are never predicted. */
export interface PredictionState {
  tick: number;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  fuelKg: number;
  heatMJ: number;
  capacitorMJ: number;
  angularAssist: boolean;
}

export interface SelfAuthority {
  tick: number;
  ship: ShipView;
  derived: DerivedFit;
  activeInput: ScheduledInput | null;
  scheduledInputs: readonly ScheduledInput[];
  receivedSeq: number;
  appliedSeq: number;
  /** Exact own prediction state at `tick`; ammo, cooldowns and module health are authoritative. */
  predictionState: PredictionState;
  weapons: readonly WeaponView[];
}

export interface ObjectiveView {
  id: Id;
  title: string;
  state: 'locked' | 'active' | 'complete' | 'failed';
  completed: number;
  required: number;
  marker: Vec2 | null;
}

export interface ContactView {
  id: Id;
  kind: 'crew' | 'hostile' | 'unknown' | 'objective' | 'hazard';
  position: Vec2;
  uncertaintyM: number;
  ageTicks: number;
  targetable: boolean;
}

export type CollisionShape =
  | { kind: 'circle'; radiusM: number }
  | { kind: 'capsule'; radiusM: number; halfSegmentM: number }
  | { kind: 'convex'; vertices: readonly Vec2[] };

export interface BodyView {
  id: Id;
  generation: number;
  visualId: Id;
  renderSeed: number;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  shape: CollisionShape;
  collidable: boolean;
  hull: number;
  hullMax: number;
}

export interface ProjectileView {
  id: Id;
  generation: number;
  weaponId: Id;
  ownerLifeId: Id;
  teamId: Id;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  state: 'unarmed' | 'armed' | 'burning' | 'coasting';
  expiresAtTick: number;
}

export interface WeaponView {
  slotId: Id;
  partId: Id;
  group: number | null;
  autoDefense: boolean;
  magazine: number | null;
  reserve: number | null;
  reloadEndsAtTick: number | null;
  chargeFraction: number;
  readyAtTick: number;
  blockedReason: string | null;
}

export interface CampaignView {
  id: Id;
  name: string;
  credits: number;
  inventoryRevision: number;
  inventory: readonly { instanceId: Id; partId: Id; health: number; reservedByPilotId: Id | null }[];
  missions: readonly { id: Id; title: string; sectorId: Id; state: 'locked' | 'available' | 'complete' }[];
  decisions: readonly { id: Id; optionId: Id }[];
  activeVote: null | {
    id: Id;
    options: readonly { id: Id; label: string }[];
    eligiblePilotIds: readonly Id[];
    votes: Readonly<Record<Id, Id>>;
    defaultOptionId: Id;
    endsAtTick: number;
  };
  saveOwner: 'host' | 'device';
  lastSavedAt: string | null;
}

export interface HostView {
  isOperator: boolean;
  guestOrigin: string | null;
  selectedAdapter: string | null;
  /** No operator/resume credential in view objects used by public UI or QR. */
  roomCodeVisibleToCaptain: string | null;
  canStop: boolean;
}

/** Player-facing economy summary (B7): what is affordable and what remains of free recovery. */
export interface PlayerEconomyView {
  credits: number;
  inventoryRevision: number;
  /** First recovery per pilot and per mission is free; this is what the pilot has left. */
  freeRecoveriesLeft: number;
  repairCostPerHull: number;
  loanerAvailable: boolean;
}

export interface DebriefView {
  resultId: Id;
  outcome: 'victory' | 'defeat' | 'draw' | 'no-contest' | 'mission-complete' | 'mission-failed';
  winningTeamId: Id | null;
  rewardCredits: number;
  repairCredits: number;
  receiptId: Id | null;
  nextMissionId: Id | null;
  pilots: readonly { pilotId: Id; name: string; teamId: Id; kills: number; assists: number; deaths: number; departed: boolean }[];
}

export interface ClientView {
  phase: Phase | null;
  screenHint: Screen;
  link: LinkState;
  pilotId: Id | null;
  epoch: Id | null;
  tick: number;
  lobby: LobbyView | null;
  self: SelfAuthority | null;
  ships: readonly ShipView[];
  contacts: readonly ContactView[];
  bodies: readonly BodyView[];
  projectiles: readonly ProjectileView[];
  weapons: readonly WeaponView[];
  map: null | { id: Id; baselineHash: string; generatorVersion: number; boundsRadiusM: number; stationIds: readonly Id[] };
  campaign: CampaignView | null;
  host: HostView | null;
  debrief: DebriefView | null;
  teamScores: Readonly<Record<Id, number>>;
  objectives: readonly ObjectiveView[];
  respawnAtTick: number | null;
  phaseEndsAtTick: number | null;
  save: 'clean' | 'pending' | 'saved' | 'failed';
}

export type Command =
  | { kind: 'edit-lobby'; expectedRevision: number; patch: { mode?: Mode; mapId?: Id; missionId?: Id; joinPolicy?: LobbyView['joinPolicy'] } }
  | { kind: 'set-pilot'; expectedRevision: number; name?: string; teamId?: Id; fit?: Fit }
  | { kind: 'ready'; expectedRevision: number; ready: boolean }
  | { kind: 'start'; expectedRevision: number }
  | { kind: 'interact'; entityId: Id; action: 'dock' | 'recover' | 'repair' | 'scan' | 'rescue' }
  | { kind: 'vote'; decisionId: Id; optionId: Id }
  | { kind: 'reload'; slotId: Id }
  | { kind: 'sensor-mode'; mode: 'passive' | 'active' }
  | { kind: 'utility'; slotId: Id; targetId: Id | null; active: boolean }
  | { kind: 'crew-order'; order: 'focus' | 'defend' | 'recover' | 'regroup'; contactId: Id | null }
  | { kind: 'extraction'; action: 'request' | 'confirm' | 'cancel' }
  | { kind: 'bot-fill'; expectedRevision: number; total: number; difficulty: BotDifficulty }
  | { kind: 'captain'; expectedRevision: number; action: 'transfer' | 'remove-seat'; pilotId: Id }
  | { kind: 'recovery'; action: 'tow' | 'retry-checkpoint' | 'return-carrier' }
  | { kind: 'inventory'; expectedRevision: number; action: 'buy' | 'repair' | 'restock'; itemId: Id }
  | { kind: 'request-respawn' }
  | { kind: 'return-lobby' }
  | { kind: 'leave' };

export type CommandCode =
  | 'ok'
  | 'stale-revision'
  | 'not-captain'
  | 'seat-taken'
  | 'room-full'
  | 'invalid-fit'
  | 'join-closed'
  | 'bad-code'
  | 'receipt-expired'
  | 'rate-limited'
  | 'wrong-life'
  | 'wrong-phase'
  | 'denied'
  | 'unsupported'
  | 'incompatible'
  | 'already-processed';

export interface CommandResult { requestId: Id; ok: boolean; code: CommandCode; revision?: number; message?: string }

export interface EventPayloadByKind {
  shot: {
    shotId: Id;
    slotId: Id;
    weaponId: Id;
    ownerLifeId: Id;
    position: Vec2;
    velocity: Vec2;
    state: 'unarmed' | 'armed' | 'burning' | 'coasting';
    expiresAtTick: number;
  };
  impact: {
    hitId: Id;
    kind: 'ship' | 'rock' | 'station' | 'projectile';
    targetId: Id;
    position: Vec2;
    normal: Vec2;
    damage: number;
    energyJ: number;
    destroyed: boolean;
    attackerPilotId: Id | null;
    victimPilotId: Id | null;
  };
  life: { lifeId: Id; shipId: Id; pilotId: Id; life: Life; position: Vec2; respawnAtTick: number | null };
  roster: { reason: 'join' | 'leave' | 'reconnect' | 'captain' | 'seat' | 'ready'; pilotId: Id; revision: number };
  objective: { objectiveId: Id; state: 'locked' | 'active' | 'complete' | 'failed'; completed: number; required: number };
  result: { resultId: Id; outcome: DebriefView['outcome']; winningTeamId: Id | null };
  save: { state: 'pending' | 'saved' | 'failed'; at: string | null; reason: string | null };
  notice: { code: NoticeCode; message: string; forPilotId: Id | null };
}

export type NoticeCode =
  | 'weapon-traffic-limit'
  | 'insufficient-power'
  | 'thermal-limit'
  | 'no-ammo'
  | 'reloading'
  | 'module-disabled'
  | 'invalid-target'
  | 'out-of-range'
  | 'not-docked'
  | 'hostile-nearby'
  | 'cargo-full'
  | 'insufficient-credits'
  | 'already-recovered'
  | 'tow-dispatched'
  | 'checkpoint-restored'
  | 'boundary-warning'
  | 'boundary-tow'
  | 'vote-started'
  | 'vote-resolved'
  | 'disconnect-grace';

export type SessionEventKind = keyof EventPayloadByKind;

export interface SessionEvent {
  deliverySeq: number;
  tick: number;
  epoch: Id;
  eventId: Id;
  kind: SessionEventKind;
  payload: EventPayloadByKind[SessionEventKind];
}

export interface ConnectOptions {
  transport: 'lan' | 'local';
  address?: string;
  roomCode?: string;
  pilotName: string;
  resumeToken?: string;
  campaignId?: Id;
}

/** A depends on this boundary. B owns implementation, runtime validation and mock fixtures. */
export interface SessionPort {
  connect(options: ConnectOptions, signal: AbortSignal): Promise<void>;
  view(): ClientView;
  subscribe(listener: (view: ClientView) => void): () => void;
  events(listener: (event: SessionEvent) => void): () => void;
  command(command: Command, requestId: Id): Promise<CommandResult>;
  /** Called on control changes; adapter samples at its own rate, independently of RAF. */
  setIntent(intent: FlightIntent): void;
  releaseControls(reason: 'blur' | 'hidden' | 'overlay' | 'pointer-cancel' | 'disconnect' | 'life-change'): void;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// C0 closures. Plan B defines the required fields for each; no `Record<string, unknown>` crosses
// the production wire without a bounded, versioned validator.
// ---------------------------------------------------------------------------------------------

/** Static, immutable arena description. Baselines transfer this once per epoch. */
export interface MapDescriptor {
  id: Id;
  schemaVersion: number;
  generatorVersion: number;
  contentVersion: string;
  seed: number;
  boundsRadiusM: number;
  /** Authored non-colliding dressing layer; never physics or objective targets. */
  sceneryIds: readonly Id[];
  stationIds: readonly Id[];
  staticBodies: readonly StaticBody[];
  spawnSets: readonly { id: Id; positions: readonly Vec2[] }[];
  objectiveAnchors: readonly { id: Id; position: Vec2 }[];
  navigationCorridors: readonly { id: Id; points: readonly Vec2[] }[];
  dirty: boolean;
}

export interface StaticBody {
  id: Id;
  shape: CollisionShape;
  position: Vec2;
  angle: number;
  collidable: boolean;
  kind: 'rib' | 'rock' | 'structure';
}

export interface BaselineChunk { transferId: Id; index: number; count: number; bytes: Uint8Array }

export interface BaselineHeader {
  transferId: Id;
  mapHash: string;
  epoch: Id;
  tick: number;
  chunkCount: number;
  totalBytes: number;
}

/** Immutable state captured after `tick`; later events replay on top of it. */
export interface Baseline {
  header: BaselineHeader;
  map: MapDescriptor;
  /** Every live projectile at the baseline tick. */
  projectiles: readonly ProjectileView[];
  knownRocks: readonly BodyView[];
  eventWatermark: number;
}

export interface SnapshotHeader {
  codec: number;
  epoch: Id;
  baselineId: Id;
  stateSeq: number;
  tick: number;
  eventWatermark: number;
  flags: number;
}

export interface Snapshot {
  header: SnapshotHeader;
  self: SelfAuthority | null;
  ships: readonly ShipView[];
  bodies: readonly BodyView[];
  projectiles: readonly ProjectileView[];
  contacts: readonly ContactView[];
  objectives: readonly ObjectiveView[];
  teamScores: Readonly<Record<Id, number>>;
  inventoryRevision: number;
}

/** Host/fleet information served by `GET /api/info`. Never contains tokens or save paths. */
export interface HostInfo {
  protocol: number;
  contentVersion: string;
  appVersion: string;
  phase: Phase;
  /** Advertised guest URL for the selected adapter; null until an adapter is chosen. */
  guestOrigin: string | null;
  operatorOrigin: string | null;
  capacity: number;
  occupied: number;
  uptimeSeconds: number;
  joinPolicy: 'open' | 'code' | 'closed';
}

export interface OperatorClaim {
  /** One-use random token delivered in the launcher URL fragment and consumed over loopback. */
  token: string;
  expiresAt: string;
}

export interface HostCommandResult { ok: boolean; code: CommandCode; message?: string }

export const EMPTY_FLIGHT_INTENT: FlightIntent = {
  thrust: 0,
  turn: 0,
  strafe: 0,
  brake: false,
  boost: false,
  angularAssist: true,
  fireMask: 0,
  aimWorld: null,
  lockContactId: null,
};
