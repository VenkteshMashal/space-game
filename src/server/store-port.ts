/**
 * Host-store port (Plan B9). The authority room never opens a database: it hands bounded,
 * immutable checkpoint DTOs to a writer and reads campaign aggregates back. `sqlite-store.ts` and
 * the offline device store implement this; the room only ever sees these shapes, so a slow disk can
 * never reach into the 120 Hz loop and no `Record<string, unknown>` is stored without a bound.
 *
 * Method names and the record fields below are frozen: persistence, launcher and campaign code all
 * compile against them.
 */

import { RELEASE } from '../shared/contracts.ts';
import type { FlightIntent, Id, Life, Vec2 } from '../shared/contracts.ts';
import type { RngStream } from '../shared/rng.ts';
import { boundedArray, enumField, fail, finiteNumber, idString, isPlainObject, ok, safeInteger, vec2Field } from '../shared/validate.ts';
import type { Result } from '../shared/validate.ts';

/** Runtime mirror of `RngStream`; a checkpoint stores exactly these streams, no others. */
export const RNG_STREAM_NAMES: readonly RngStream[] = ['mission', 'fracture', 'sensor', 'bot', 'spawn', 'storm'];

export interface CampaignRecord {
  id: Id;
  name: string;
  credits: number;
  inventoryRevision: number;
  createdAt: string;
  lastSavedAt: string | null;
}

export interface InventoryItem {
  instanceId: Id;
  partId: Id;
  /** Hull points; 0 means destroyed but still reserved until repair or replacement (B6). */
  health: number;
  reservedByPilotId: Id | null;
}

export interface CheckpointWeapon {
  slotId: Id;
  magazine: number | null;
  reserve: number | null;
  reloadEndsAtTick: number | null;
  chargeFraction: number;
  readyAtTick: number;
}

export interface CheckpointShip {
  pilotId: Id;
  lifeId: Id;
  teamId: Id;
  life: Life;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  hull: number;
  hullMax: number;
  fuelKg: number;
  heatMJ: number;
  capacitorMJ: number;
  respawnAtTick: number | null;
  weapons: readonly CheckpointWeapon[];
  kills: number;
  assists: number;
  deaths: number;
}

export interface CheckpointRock {
  contentId: Id;
  generation: number;
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
  radiusM: number;
  hull: number;
  hullMax: number;
  splitDepth: number;
  cracked: boolean;
}

export interface CheckpointObjective {
  objectiveId: Id;
  state: 'locked' | 'active' | 'complete' | 'failed';
  completed: number;
  required: number;
}

/** A scheduled input accepted before the checkpoint tick but not yet applied. */
export interface CheckpointAction {
  pilotId: Id;
  seq: number;
  applyAtTick: number;
  intent: FlightIntent;
}

export interface CheckpointState {
  tick: number;
  epoch: Id;
  rng: Readonly<Record<string, number>>;
  ships: readonly CheckpointShip[];
  rocks: readonly CheckpointRock[];
  objectives: readonly CheckpointObjective[];
  pendingActions: readonly CheckpointAction[];
  baselineRevision: number;
}

export interface CheckpointInput {
  campaignId: Id;
  state: CheckpointState;
  at: string;
}

export interface CheckpointReceipt {
  checkpointId: Id;
  tick: number;
  at: string;
  campaign: CampaignRecord;
}

export interface ObjectiveReceiptInput {
  objectiveId: Id;
  itemId: Id;
}

export interface DecisionInput {
  decisionId: Id;
  optionId: Id;
}

export interface SettlementInput {
  campaignId: Id;
  resultId: Id;
  rewardCredits: number;
  repairCredits: number;
  objectiveReceipts: readonly ObjectiveReceiptInput[];
  decisions: readonly DecisionInput[];
}

export interface SettlementReceipt {
  receiptId: Id;
  credits: number;
}

export interface PurchaseInput {
  campaignId: Id;
  action: 'buy' | 'repair' | 'restock';
  itemId: Id;
  cost: number;
  expectedRevision: number;
}

export interface PurchaseReceipt {
  credits: number;
  inventoryRevision: number;
  instanceId: Id | null;
}

export interface StoredCheckpoint {
  checkpointId: Id;
  state: CheckpointState;
  at: string;
}

export interface StoredReceipt {
  objectiveId: Id;
  itemId: Id;
  receiptId: Id;
}

export interface StoredDecision {
  decisionId: Id;
  optionId: Id;
}

export interface StoredSettlement {
  resultId: Id;
  receiptId: Id;
  credits: number;
}

/** Everything one campaign holds; what `loadCampaign` returns and `importCampaign` writes. */
export interface CampaignSnapshot {
  campaign: CampaignRecord;
  inventory: readonly InventoryItem[];
  checkpoints: readonly StoredCheckpoint[];
  receipts: readonly StoredReceipt[];
  decisions: readonly StoredDecision[];
  settlements: readonly StoredSettlement[];
}

export type StoreErrorCode = 'not-found' | 'conflict' | 'duplicate' | 'corrupt' | 'unsupported' | 'budget' | 'io';

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: StoreErrorCode; message: string };

export function storeOk<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

export function storeFail<T>(code: StoreErrorCode, message: string): StoreResult<T> {
  return { ok: false, code, message };
}

/**
 * The room's only write path. `settle` commits inventory, reward, objective receipts and decisions
 * in one transaction and is idempotent per `resultId`; `purchase` charges, reserves or repairs
 * under `expectedRevision`; `writeCheckpoint` retains the latest checkpoint plus two verified
 * predecessors. All return a commit acknowledgement, never a fire-and-forget promise.
 */
export interface HostStorePort {
  loadCampaign(campaignId: Id): Promise<StoreResult<CampaignSnapshot>>;
  listCampaigns(): Promise<StoreResult<readonly CampaignRecord[]>>;
  createCampaign(input: { name: string; id?: Id; at: string }): Promise<StoreResult<CampaignRecord>>;
  writeCheckpoint(input: CheckpointInput): Promise<StoreResult<CheckpointReceipt>>;
  settle(input: SettlementInput): Promise<StoreResult<SettlementReceipt>>;
  purchase(input: PurchaseInput): Promise<StoreResult<PurchaseReceipt>>;
  exportCampaign(campaignId: Id): Promise<StoreResult<Uint8Array>>;
  importCampaign(bundle: Uint8Array): Promise<StoreResult<{ campaignId: Id }>>;
  close(): Promise<void>;
}

/** Authored bounds. A checkpoint or import that exceeds one is rejected, never truncated. */
export const STORE_LIMITS = {
  importBytes: 16 * 1024 * 1024,
  nameChars: 48,
  rocks: RELEASE.maxPhysicalRocks,
  ships: RELEASE.maxHumans,
  weaponsPerShip: 32,
  objectives: 64,
  pendingActions: 128,
  checkpoints: 3,
  receipts: 256,
  decisions: 64,
} as const;

const LIFE_VALUES: readonly Life[] = ['staged', 'alive', 'disabled', 'destroyed', 'respawning', 'spectating'];
const OBJECTIVE_STATES = ['locked', 'active', 'complete', 'failed'] as const;

/** Import validates every field before anything is written (B9). */
function text(value: unknown, max: number, label: string): Result<string> {
  const parsed = idString(value);
  if (!parsed.ok) return fail(parsed.code, `${label}: ${parsed.detail}`);
  return parsed;
}

function iso(value: unknown, label: string): Result<string> {
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(Date.parse(value))) return fail('bad-type', `${label} is not an ISO timestamp`);
  return ok(value);
}

function weapon(value: unknown, index: number): Result<CheckpointWeapon> {
  if (!isPlainObject(value)) return fail('not-object', `weapons[${index}]`);
  const slotId = text(value.slotId, 16, `weapons[${index}].slotId`);
  if (!slotId.ok) return slotId;
  const magazine = optionalInt(value.magazine, -1, 1e6);
  if (!magazine.ok) return magazine;
  const reserve = optionalInt(value.reserve, -1, 1e6);
  if (!reserve.ok) return reserve;
  const reloadEndsAtTick = optionalInt(value.reloadEndsAtTick, -1, 0xffffffff);
  if (!reloadEndsAtTick.ok) return reloadEndsAtTick;
  const chargeFraction = finiteNumber(value.chargeFraction, 0, 1);
  if (!chargeFraction.ok) return chargeFraction;
  const readyAtTick = safeInteger(value.readyAtTick, 0, 0xffffffff);
  if (!readyAtTick.ok) return readyAtTick;
  return ok({
    slotId: slotId.value,
    magazine: magazine.value,
    reserve: reserve.value,
    reloadEndsAtTick: reloadEndsAtTick.value,
    chargeFraction: chargeFraction.value,
    readyAtTick: readyAtTick.value,
  });
}

function optionalInt(value: unknown, min: number, max: number): Result<number | null> {
  if (value === null) return ok(null);
  return safeInteger(value, min, max);
}

function ship(value: unknown, index: number): Result<CheckpointShip> {
  if (!isPlainObject(value)) return fail('not-object', `ships[${index}]`);
  const pilotId = text(value.pilotId, 64, `ships[${index}].pilotId`);
  if (!pilotId.ok) return pilotId;
  const lifeId = text(value.lifeId, 64, `ships[${index}].lifeId`);
  if (!lifeId.ok) return lifeId;
  const teamId = text(value.teamId, 64, `ships[${index}].teamId`);
  if (!teamId.ok) return teamId;
  const life = enumField(value.life, LIFE_VALUES);
  if (!life.ok) return life;
  const position = vec2Field(value.position);
  if (!position.ok) return position;
  const velocity = vec2Field(value.velocity);
  if (!velocity.ok) return velocity;
  const angle = finiteNumber(value.angle, -1e6, 1e6);
  if (!angle.ok) return angle;
  const angularVelocity = finiteNumber(value.angularVelocity, -1e4, 1e4);
  if (!angularVelocity.ok) return angularVelocity;
  const hull = finiteNumber(value.hull, 0, 1e6);
  if (!hull.ok) return hull;
  const hullMax = finiteNumber(value.hullMax, 1, 1e6);
  if (!hullMax.ok) return hullMax;
  const fuelKg = finiteNumber(value.fuelKg, 0, 1e7);
  if (!fuelKg.ok) return fuelKg;
  const heatMJ = finiteNumber(value.heatMJ, 0, 1e7);
  if (!heatMJ.ok) return heatMJ;
  const capacitorMJ = finiteNumber(value.capacitorMJ, 0, 1e7);
  if (!capacitorMJ.ok) return capacitorMJ;
  const respawnAtTick = optionalInt(value.respawnAtTick, 0, 0xffffffff);
  if (!respawnAtTick.ok) return respawnAtTick;
  const weapons = boundedArray(value.weapons, STORE_LIMITS.weaponsPerShip, weapon);
  if (!weapons.ok) return weapons;
  const kills = safeInteger(value.kills, 0, 1e6);
  if (!kills.ok) return kills;
  const assists = safeInteger(value.assists, 0, 1e6);
  if (!assists.ok) return assists;
  const deaths = safeInteger(value.deaths, 0, 1e6);
  if (!deaths.ok) return deaths;
  return ok({
    pilotId: pilotId.value,
    lifeId: lifeId.value,
    teamId: teamId.value,
    life: life.value,
    position: position.value,
    velocity: velocity.value,
    angle: angle.value,
    angularVelocity: angularVelocity.value,
    hull: hull.value,
    hullMax: hullMax.value,
    fuelKg: fuelKg.value,
    heatMJ: heatMJ.value,
    capacitorMJ: capacitorMJ.value,
    respawnAtTick: respawnAtTick.value,
    weapons: weapons.value,
    kills: kills.value,
    assists: assists.value,
    deaths: deaths.value,
  });
}

function rock(value: unknown, index: number): Result<CheckpointRock> {
  if (!isPlainObject(value)) return fail('not-object', `rocks[${index}]`);
  const contentId = text(value.contentId, 64, `rocks[${index}].contentId`);
  if (!contentId.ok) return contentId;
  const generation = safeInteger(value.generation, 0, 0xffff);
  if (!generation.ok) return generation;
  const position = vec2Field(value.position);
  if (!position.ok) return position;
  const velocity = vec2Field(value.velocity);
  if (!velocity.ok) return velocity;
  const angle = finiteNumber(value.angle, -1e6, 1e6);
  if (!angle.ok) return angle;
  const angularVelocity = finiteNumber(value.angularVelocity, -1e4, 1e4);
  if (!angularVelocity.ok) return angularVelocity;
  const radiusM = finiteNumber(value.radiusM, 0, 1e5);
  if (!radiusM.ok) return radiusM;
  const hull = finiteNumber(value.hull, 0, 1e6);
  if (!hull.ok) return hull;
  const hullMax = finiteNumber(value.hullMax, 0, 1e6);
  if (!hullMax.ok) return hullMax;
  const splitDepth = safeInteger(value.splitDepth, 0, 8);
  if (!splitDepth.ok) return splitDepth;
  if (typeof value.cracked !== 'boolean') return fail('bad-type', `rocks[${index}].cracked`);
  return ok({
    contentId: contentId.value,
    generation: generation.value,
    position: position.value,
    velocity: velocity.value,
    angle: angle.value,
    angularVelocity: angularVelocity.value,
    radiusM: radiusM.value,
    hull: hull.value,
    hullMax: hullMax.value,
    splitDepth: splitDepth.value,
    cracked: value.cracked,
  });
}

function objective(value: unknown, index: number): Result<CheckpointObjective> {
  if (!isPlainObject(value)) return fail('not-object', `objectives[${index}]`);
  const objectiveId = text(value.objectiveId, 64, `objectives[${index}].objectiveId`);
  if (!objectiveId.ok) return objectiveId;
  const state = enumField(value.state, OBJECTIVE_STATES);
  if (!state.ok) return state;
  const completed = safeInteger(value.completed, 0, 1e6);
  if (!completed.ok) return completed;
  const required = safeInteger(value.required, 0, 1e6);
  if (!required.ok) return required;
  return ok({ objectiveId: objectiveId.value, state: state.value, completed: completed.value, required: required.value });
}

function action(value: unknown, index: number): Result<CheckpointAction> {
  if (!isPlainObject(value)) return fail('not-object', `pendingActions[${index}]`);
  const pilotId = text(value.pilotId, 64, `pendingActions[${index}].pilotId`);
  if (!pilotId.ok) return pilotId;
  const seq = safeInteger(value.seq, 0, 0xffffffff);
  if (!seq.ok) return seq;
  const applyAtTick = safeInteger(value.applyAtTick, 0, 0xffffffff);
  if (!applyAtTick.ok) return applyAtTick;
  const intent = validateIntent(value.intent);
  if (!intent.ok) return intent;
  return ok({ pilotId: pilotId.value, seq: seq.value, applyAtTick: applyAtTick.value, intent: intent.value });
}

function validateIntent(value: unknown): Result<FlightIntent> {
  if (!isPlainObject(value)) return fail('not-object', 'intent');
  const axes: number[] = [];
  for (const key of ['thrust', 'turn', 'strafe'] as const) {
    const axis = finiteNumber(value[key], -4, 4);
    if (!axis.ok) return axis;
    axes.push(axis.value < -1 ? -1 : axis.value > 1 ? 1 : axis.value);
  }
  const flags: boolean[] = [];
  for (const key of ['brake', 'boost', 'angularAssist'] as const) {
    if (typeof value[key] !== 'boolean') return fail('bad-type', `intent.${key}`);
    flags.push(value[key]);
  }
  const fireMask = safeInteger(value.fireMask, 0, 0xffff);
  if (!fireMask.ok) return fireMask;
  const aim = value.aimWorld === null ? ok(null) : vec2Field(value.aimWorld, 1e6);
  if (!aim.ok) return aim;
  const lock = value.lockContactId === null ? ok(null) : text(value.lockContactId, 64, 'intent.lockContactId');
  if (!lock.ok) return lock;
  return ok({
    thrust: axes[0]!,
    turn: axes[1]!,
    strafe: axes[2]!,
    brake: flags[0]!,
    boost: flags[1]!,
    angularAssist: flags[2]!,
    fireMask: fireMask.value,
    aimWorld: aim.value,
    lockContactId: lock.value,
  });
}

function rngState(value: unknown): Result<Readonly<Record<string, number>>> {
  if (!isPlainObject(value)) return fail('not-object', 'rng');
  const keys = Object.keys(value);
  if (keys.length > RNG_STREAM_NAMES.length) return fail('too-many', `rng streams ${keys.length}`);
  const streams: Record<string, number> = {};
  for (const key of keys) {
    if (!(RNG_STREAM_NAMES as readonly string[]).includes(key)) return fail('bad-enum', `rng.${key}`);
    const state = safeInteger(value[key], 0, 0xffffffff);
    if (!state.ok) return state;
    streams[key] = state.value;
  }
  return ok(streams);
}

export function validateCheckpointState(value: unknown): Result<CheckpointState> {
  if (!isPlainObject(value)) return fail('not-object', 'checkpoint');
  const tick = safeInteger(value.tick, 0, 0xffffffff);
  if (!tick.ok) return tick;
  const epoch = text(value.epoch, 64, 'epoch');
  if (!epoch.ok) return epoch;
  const rng = rngState(value.rng);
  if (!rng.ok) return rng;
  const ships = boundedArray(value.ships, STORE_LIMITS.ships, ship);
  if (!ships.ok) return ships;
  const rocks = boundedArray(value.rocks, STORE_LIMITS.rocks, rock);
  if (!rocks.ok) return rocks;
  const objectives = boundedArray(value.objectives, STORE_LIMITS.objectives, objective);
  if (!objectives.ok) return objectives;
  const pendingActions = boundedArray(value.pendingActions, STORE_LIMITS.pendingActions, action);
  if (!pendingActions.ok) return pendingActions;
  const baselineRevision = safeInteger(value.baselineRevision, 0, 0xffffffff);
  if (!baselineRevision.ok) return baselineRevision;
  return ok({
    tick: tick.value,
    epoch: epoch.value,
    rng: rng.value,
    ships: ships.value,
    rocks: rocks.value,
    objectives: objectives.value,
    pendingActions: pendingActions.value,
    baselineRevision: baselineRevision.value,
  });
}

export function validateCheckpointInput(value: unknown): Result<CheckpointInput> {
  if (!isPlainObject(value)) return fail('not-object', 'checkpoint input');
  const campaignId = text(value.campaignId, 64, 'campaignId');
  if (!campaignId.ok) return campaignId;
  const state = validateCheckpointState(value.state);
  if (!state.ok) return state;
  const at = iso(value.at, 'at');
  if (!at.ok) return at;
  return ok({ campaignId: campaignId.value, state: state.value, at: at.value });
}

export function validateSettlementInput(value: unknown): Result<SettlementInput> {
  if (!isPlainObject(value)) return fail('not-object', 'settlement');
  const campaignId = text(value.campaignId, 64, 'campaignId');
  if (!campaignId.ok) return campaignId;
  const resultId = text(value.resultId, 64, 'resultId');
  if (!resultId.ok) return resultId;
  const rewardCredits = safeInteger(value.rewardCredits, 0, 1e9);
  if (!rewardCredits.ok) return rewardCredits;
  const repairCredits = safeInteger(value.repairCredits, 0, 1e9);
  if (!repairCredits.ok) return repairCredits;
  const objectiveReceipts = boundedArray<ObjectiveReceiptInput>(value.objectiveReceipts, STORE_LIMITS.objectives, (item, index) => {
    if (!isPlainObject(item)) return fail('not-object', `objectiveReceipts[${index}]`);
    const objectiveId = text(item.objectiveId, 64, `objectiveReceipts[${index}].objectiveId`);
    if (!objectiveId.ok) return objectiveId;
    const itemId = text(item.itemId, 64, `objectiveReceipts[${index}].itemId`);
    if (!itemId.ok) return itemId;
    return ok({ objectiveId: objectiveId.value, itemId: itemId.value });
  });
  if (!objectiveReceipts.ok) return objectiveReceipts;
  const decisions = boundedArray<DecisionInput>(value.decisions, STORE_LIMITS.decisions, (item, index) => {
    if (!isPlainObject(item)) return fail('not-object', `decisions[${index}]`);
    const decisionId = text(item.decisionId, 64, `decisions[${index}].decisionId`);
    if (!decisionId.ok) return decisionId;
    const optionId = text(item.optionId, 64, `decisions[${index}].optionId`);
    if (!optionId.ok) return optionId;
    return ok({ decisionId: decisionId.value, optionId: optionId.value });
  });
  if (!decisions.ok) return decisions;
  return ok({
    campaignId: campaignId.value,
    resultId: resultId.value,
    rewardCredits: rewardCredits.value,
    repairCredits: repairCredits.value,
    objectiveReceipts: objectiveReceipts.value,
    decisions: decisions.value,
  });
}
