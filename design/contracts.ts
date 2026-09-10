/** Design contract v2. Promote at C0; this file is not imported by the live game. */
export const RELEASE = {
  protocol: 2, saveSchema: 2, contentVersion: 'quiet-signal-1',
  maxHumans: 8, maxPvpCombatants: 8, maxPveEnemies: 16, maxMissionShips: 2,
  physicsHz: 120, inputHz: 60, snapshotHz: 30, rockHz: 10,
  inputLeaseTicks: 30, reconnectSeconds: 60,
  maxProjectiles: 512, maxPhysicalRocks: 256, maxCargo: 64,
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
  chassisId: Id; paintId: Id;
  /** Slot ID -> catalog part ID. Inventory instance IDs are separate campaign reservations. */
  slots: Readonly<Record<Id, Id>>;
  fireGroups: readonly (readonly Id[])[];
  powerPriority: readonly SlotKind[];
}
export interface FlightIntent {
  thrust: number; turn: number; strafe: number;
  brake: boolean; boost: boolean; angularAssist: boolean;
  fireMask: number; aimWorld: Vec2 | null; lockContactId: Id | null;
}
/** Ticks are integer, end-of-step authority ticks. State(T) includes all work through T. */
export interface InputFrame {
  epoch: Id; lifeId: Id; seq: number; targetTick: number; intent: FlightIntent;
}
export interface ScheduledInput { seq: number; applyAtTick: number; intent: FlightIntent }
export interface InputReceipt {
  seq: number; result: 'scheduled' | 'stale' | 'invalid' | 'wrong-life'; applyAtTick?: number;
}
export interface RosterEntry {
  pilotId: Id; name: string; teamId: Id; isBot: boolean;
  presence: Presence; life: Life; readyRevision: number | null;
  fit: Fit; pingMs: number | null;
}
export interface LobbyView {
  revision: number; captainId: Id; mode: Mode; mapId: Id;
  missionId: Id | null; joinPolicy: 'open' | 'code' | 'closed';
  roster: readonly RosterEntry[]; canStart: boolean; startBlockers: readonly string[];
}
export interface DerivedFit {
  hash: string; valid: boolean; errors: readonly string[];
  dryMassKg: number; fuelCapacityKg: number; hullMax: number;
  thrustN: number; inertiaKgM2: number; powerSupplyMW: number;
  idleDemandMW: number; coolingMW: number; heatCapacityMJ: number;
  capacitorMJ: number; buildCost: number;
}
export interface ShipView {
  id: Id; pilotId: Id | null; lifeId: Id; teamId: Id;
  position: Vec2; velocity: Vec2; angle: number; angularVelocity: number;
  fit: Fit; hull: number; hullMax: number; fuelKg: number; fuelMaxKg: number;
  heatMJ: number; heatMaxMJ: number; capacitorMJ: number; life: Life;
}
export interface SelfAuthority {
  tick: number; ship: ShipView; derived: DerivedFit;
  activeInput: ScheduledInput | null;
  scheduledInputs: readonly ScheduledInput[];
  receivedSeq: number; appliedSeq: number;
  /** Includes exact ammo, cooldowns, module health and deterministic prediction state at C0. */
  predictionState: Readonly<Record<string, unknown>>;
}
export interface ObjectiveView {
  id: Id; title: string; state: 'locked' | 'active' | 'complete' | 'failed';
  completed: number; required: number; marker: Vec2 | null;
}
export interface ContactView {
  id: Id; kind: 'crew' | 'hostile' | 'unknown' | 'objective' | 'hazard';
  position: Vec2; uncertaintyM: number; ageTicks: number; targetable: boolean;
}
export type CollisionShape =
  | { kind: 'circle'; radiusM: number }
  | { kind: 'capsule'; radiusM: number; halfSegmentM: number }
  | { kind: 'convex'; vertices: readonly Vec2[] };
export interface BodyView {
  id: Id; generation: number; visualId: Id; renderSeed: number;
  position: Vec2; velocity: Vec2; angle: number; angularVelocity: number;
  shape: CollisionShape; collidable: boolean; hull: number; hullMax: number;
}
export interface ProjectileView {
  id: Id; generation: number; weaponId: Id; ownerLifeId: Id; teamId: Id;
  position: Vec2; velocity: Vec2; angle: number;
  state: 'unarmed' | 'armed' | 'burning' | 'coasting'; expiresAtTick: number;
}
export interface WeaponView {
  slotId: Id; partId: Id; group: number | null; autoDefense: boolean;
  magazine: number | null; reserve: number | null; reloadEndsAtTick: number | null;
  chargeFraction: number; readyAtTick: number; blockedReason: string | null;
}
export interface CampaignView {
  id: Id; name: string; credits: number; inventoryRevision: number;
  inventory: readonly { instanceId: Id; partId: Id; health: number; reservedByPilotId: Id | null }[];
  missions: readonly { id: Id; title: string; sectorId: Id; state: 'locked' | 'available' | 'complete' }[];
  decisions: readonly { id: Id; optionId: Id }[];
  activeVote: null | { id: Id; options: readonly { id: Id; label: string }[]; eligiblePilotIds: readonly Id[]; votes: Readonly<Record<Id, Id>>; defaultOptionId: Id; endsAtTick: number };
  saveOwner: 'host' | 'device'; lastSavedAt: string | null;
}
export interface HostView {
  isOperator: boolean; guestOrigin: string | null; selectedAdapter: string | null;
  /** No operator/resume credential in view objects used by public UI or QR. */
  roomCodeVisibleToCaptain: string | null; canStop: boolean;
}
export interface DebriefView {
  resultId: Id; outcome: 'victory' | 'defeat' | 'draw' | 'no-contest' | 'mission-complete' | 'mission-failed';
  winningTeamId: Id | null; rewardCredits: number; repairCredits: number;
  receiptId: Id | null; nextMissionId: Id | null;
  pilots: readonly { pilotId: Id; name: string; teamId: Id; kills: number; assists: number; deaths: number; departed: boolean }[];
}
export interface ClientView {
  phase: Phase | null; screenHint: Screen; link: LinkState;
  pilotId: Id | null; epoch: Id | null; tick: number;
  lobby: LobbyView | null; self: SelfAuthority | null;
  ships: readonly ShipView[]; contacts: readonly ContactView[];
  bodies: readonly BodyView[]; projectiles: readonly ProjectileView[]; weapons: readonly WeaponView[];
  map: null | { id: Id; baselineHash: string; generatorVersion: number; boundsRadiusM: number; stationIds: readonly Id[] };
  campaign: CampaignView | null; host: HostView | null; debrief: DebriefView | null;
  teamScores: Readonly<Record<Id, number>>;
  objectives: readonly ObjectiveView[];
  respawnAtTick: number | null; phaseEndsAtTick: number | null;
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
  | { kind: 'bot-fill'; expectedRevision: number; total: number; difficulty: 'easy' | 'normal' | 'hard' }
  | { kind: 'captain'; expectedRevision: number; action: 'transfer' | 'remove-seat'; pilotId: Id }
  | { kind: 'recovery'; action: 'tow' | 'retry-checkpoint' | 'return-carrier' }
  | { kind: 'inventory'; expectedRevision: number; action: 'buy' | 'repair' | 'restock'; itemId: Id }
  | { kind: 'request-respawn' }
  | { kind: 'return-lobby' }
  | { kind: 'leave' };
export interface CommandResult { requestId: Id; ok: boolean; code: string; revision?: number }
export interface SessionEvent {
  deliverySeq: number; tick: number; epoch: Id; eventId: Id;
  kind: 'shot' | 'impact' | 'life' | 'roster' | 'objective' | 'result' | 'save' | 'notice';
  payload: Readonly<Record<string, unknown>>;
}
export interface ConnectOptions {
  transport: 'lan' | 'local'; address?: string; roomCode?: string;
  pilotName: string; resumeToken?: string; campaignId?: Id;
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
  releaseControls(reason: 'blur' | 'hidden' | 'overlay' | 'disconnect' | 'life-change'): void;
  dispose(): Promise<void>;
}
/** Gaps to close at C0: discriminated event payloads, prediction state, snapshot codec,
 * full map baseline/save DTO, campaign selection/export and operator service APIs.
 * No Record<string, unknown> may cross the production
 * wire without a bounded, versioned validator. Plan B defines their required fields. */
