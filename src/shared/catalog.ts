/**
 * Shared content and derived stats (Plan B6). The catalog JSON is the single authored source; this
 * module is the single runtime interpretation of it. The UI must never re-derive a number with its
 * own arithmetic — it reads `deriveFit` output, so authority and presentation cannot disagree.
 *
 * Derivation order, fixed at C0:
 *   1. additive chassis and part values
 *   2. physical mass and inertia (parallel-axis, part mass never counted twice)
 *   3. named multiplicative effects once, in ascending part-ID order
 *   4. documented clamps
 *   5. dependent stats
 */

import rawCatalog from '../../design/data/catalog.json';
import { CLAMPS, FLIGHT, HULL_IDLE_MW, RULES } from './balance.ts';
import type {
  Fit,
  FitDerivation,
  Id,
  SlotKind,
  UtilitySlot,
  Vec2,
  WeaponBehavior,
  WeaponSlot,
} from './contracts.ts';
import { RELEASE } from './contracts.ts';
import { hash32, hex8 } from './ids.ts';
import { slotsForChassis, muzzleOffsetM, type ChassisGeometry, type SlotTransform } from './slots.ts';

export interface ChassisSpec extends ChassisGeometry {
  name: string;
  role: string;
  dryMassKg: number;
  fuelKg: number;
  hull: number;
  heatMJ: number;
  coolingMW: number;
  capacitorMJ: number;
  cost: number;
  maxWetMassKg: number;
  rcsTorqueMNm: number;
}

export interface PartSpec {
  id: Id;
  name: string;
  kind: SlotKind;
  size: number;
  massKg: number;
  cost: number;
  idleMW: number;
  behavior?: WeaponBehavior;
  activeMW?: number;
  thrustN?: number;
  fuelKgS?: number;
  heatMW?: number;
  supplyMW?: number;
  hullAdd?: number;
  kineticReduction?: number;
  thermalReduction?: number;
  coolingMW?: number;
  passiveRangeM?: number;
  activeRangeM?: number;
  scanMultiplier?: number;
  signatureMultiplier?: number;
  capacitorMJ?: number;
  chargeLimitMW?: number;
  repairHullS?: number;
  repairStock?: number;
  rangeM?: number;
  forceN?: number;
  breakForceN?: number;
  durationS?: number;
  cooldownS?: number;
  chargeS?: number;
  charges?: number;
  cargoAddKg?: number;
  speedMS?: number;
  damage?: number;
  damageS?: number;
  rockDamageS?: number;
  heatShotMJ?: number;
  energyShotMJ?: number;
  impulseNS?: number;
  magazine?: number;
  reserve?: number;
  reloadS?: number;
  ttlS?: number;
  armS?: number;
  blastM?: number;
  perOwnerCap?: number;
  defenseRangeM?: number;
  roundMassKg?: number;
  accelerationMS2?: number;
  turnRadS?: number;
  burnS?: number;
}

export interface RawCatalog {
  schemaVersion: number;
  contentVersion?: string;
  buildBudget: number;
  chassis: ChassisSpec[];
  parts: PartSpec[];
  referenceFits: { id: Id; chassisId: Id; parts: Id[] }[];
}

export interface Catalog {
  schemaVersion: number;
  contentVersion: string;
  buildBudget: number;
  chassis: readonly ChassisSpec[];
  parts: readonly PartSpec[];
  referenceFits: readonly { id: Id; chassisId: Id; parts: readonly Id[] }[];
  chassisById: ReadonlyMap<Id, ChassisSpec>;
  partById: ReadonlyMap<Id, PartSpec>;
}

const raw = rawCatalog as unknown as RawCatalog;

/** Structural check of authored content. A failure here is a build error, not a runtime state. */
export function assertCatalogShape(catalog: RawCatalog): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entry of [...catalog.chassis, ...catalog.parts, ...catalog.referenceFits]) {
    if (ids.has(entry.id)) errors.push(`duplicate-id:${entry.id}`);
    ids.add(entry.id);
    if (!/^[a-z][a-z0-9-]+$/.test(entry.id)) errors.push(`bad-id:${entry.id}`);
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) errors.push(`bad-number:${entry.id}.${key}`);
    }
  }
  for (const chassis of catalog.chassis) {
    if (!(chassis.weaponSizes.length > 0)) errors.push(`no-weapon-slots:${chassis.id}`);
    if (!(chassis.maxWetMassKg > chassis.dryMassKg + chassis.fuelKg)) errors.push(`impossible-wet-mass:${chassis.id}`);
  }
  for (const part of catalog.parts) {
    if (part.kind === 'weapon') {
      if (!part.behavior) errors.push(`missing-behavior:${part.id}`);
      if (part.behavior === 'beam') {
        if (!part.rangeM || !part.damageS) errors.push(`incomplete-beam:${part.id}`);
      } else if (!(part.speedMS && part.ttlS && part.magazine && part.roundMassKg && part.cooldownS && part.cooldownS >= CLAMPS.cooldownMinS)) {
        errors.push(`incomplete-weapon:${part.id}`);
      }
    }
  }
  const behaviors = new Set(catalog.parts.filter(part => part.kind === 'weapon').map(part => part.behavior));
  if (behaviors.size !== 7) errors.push(`weapon-behaviors:${behaviors.size}`);
  return errors;
}

const shapeErrors = assertCatalogShape(raw);
if (shapeErrors.length > 0) throw new Error(`catalog.json is invalid: ${shapeErrors.join(', ')}`);

export const CATALOG: Catalog = Object.freeze({
  schemaVersion: raw.schemaVersion,
  contentVersion: RELEASE.contentVersion,
  buildBudget: raw.buildBudget,
  chassis: Object.freeze(raw.chassis),
  parts: Object.freeze(raw.parts),
  referenceFits: Object.freeze(raw.referenceFits),
  chassisById: new Map(raw.chassis.map(chassis => [chassis.id, chassis])),
  partById: new Map(raw.parts.map(part => [part.id, part])),
});

export const BUILD_BUDGET = RULES.buildBudget;

export function chassisSlotTransforms(chassisId: Id): readonly SlotTransform[] {
  const chassis = CATALOG.chassisById.get(chassisId);
  return chassis ? slotsForChassis(chassis) : [];
}

/** Slot ID -> the kind of part that may occupy it, for a given chassis. */
export function slotKinds(chassisId: Id): ReadonlyMap<Id, SlotTransform> {
  return new Map(chassisSlotTransforms(chassisId).map(slot => [slot.slotId, slot]));
}

export const DEFAULT_POWER_PRIORITY: readonly SlotKind[] = ['engine', 'reactor', 'sensor', 'utility', 'weapon', 'armor'];

/**
 * Every admitted pilot gets a usable loaner (B7), so the default fit is the catalog's reference
 * build for that chassis with weapons assigned largest-slot-first.
 */
export function defaultFit(chassisId: Id): Fit {
  const chassis = CATALOG.chassisById.get(chassisId) ?? CATALOG.chassis[0]!;
  const reference = CATALOG.referenceFits.find(candidate => candidate.chassisId === chassis.id) ?? CATALOG.referenceFits[0]!;
  const parts = reference.parts.map(id => CATALOG.partById.get(id)).filter((part): part is PartSpec => Boolean(part));
  const transforms = slotsForChassis(chassis);
  const slots: Record<Id, Id> = {};
  const weaponParts = parts.filter(part => part.kind === 'weapon').sort((a, b) => b.size - a.size);
  let weaponIndex = 0;
  for (const transform of transforms.filter(slot => slot.kind === 'weapon').sort((a, b) => b.size - a.size)) {
    const part = weaponParts[weaponIndex];
    if (part && part.size <= transform.size) {
      slots[transform.slotId] = part.id;
      weaponIndex += 1;
    }
  }
  const used = new Set<Id>(Object.values(slots));
  for (const transform of transforms) {
    if (transform.kind === 'weapon') continue;
    const part = parts.find(candidate => candidate.kind === transform.kind && !used.has(candidate.id));
    if (!part) continue;
    slots[transform.slotId] = part.id;
    used.add(part.id);
  }
  const weaponSlotIds = transforms.filter(slot => slot.kind === 'weapon' && slots[slot.slotId]).map(slot => slot.slotId);
  const half = Math.ceil(weaponSlotIds.length / 2);
  return {
    chassisId: chassis.id,
    paintId: 'default',
    slots,
    fireGroups: weaponSlotIds.length > 0 ? [weaponSlotIds.slice(0, half), weaponSlotIds.slice(half)].filter(group => group.length > 0) : [],
    powerPriority: [...DEFAULT_POWER_PRIORITY],
  };
}

export function emptyFit(chassisId: Id): Fit {
  return { chassisId, paintId: 'default', slots: {}, fireGroups: [], powerPriority: [...DEFAULT_POWER_PRIORITY] };
}

const SLOT_KINDS: readonly SlotKind[] = ['weapon', 'engine', 'reactor', 'armor', 'sensor', 'utility'];

export function deriveFit(fit: Fit): FitDerivation {
  const errors: string[] = [];
  const chassis = CATALOG.chassisById.get(fit.chassisId);
  if (!chassis) {
    return invalidFit(`unknown-chassis:${fit.chassisId}`, errors);
  }
  const transforms = slotsForChassis(chassis);
  const byId = new Map(transforms.map(slot => [slot.slotId, slot]));

  // 1. additive chassis and part values.
  const chosen: { slot: SlotTransform; part: PartSpec }[] = [];
  for (const [slotId, partId] of Object.entries(fit.slots ?? {})) {
    const slot = byId.get(slotId);
    if (!slot) { errors.push(`unknown-slot:${slotId}`); continue; }
    const part = CATALOG.partById.get(partId);
    if (!part) { errors.push(`unknown-part:${partId}`); continue; }
    if (part.kind !== slot.kind) { errors.push(`slot-kind-mismatch:${slotId}`); continue; }
    if (part.size > slot.size) { errors.push(`weapon-too-large:${slotId}`); continue; }
    chosen.push({ slot, part });
  }

  for (const kind of ['engine', 'reactor', 'armor', 'sensor'] as const) {
    const count = chosen.filter(entry => entry.part.kind === kind).length;
    if (count === 0) errors.push(`missing-${kind}`);
    if (count > 1) errors.push(`multiple-${kind}`);
  }
  const weapons = chosen.filter(entry => entry.part.kind === 'weapon');
  if (weapons.length === 0) errors.push('no-weapon');
  const utilities = chosen.filter(entry => entry.part.kind === 'utility');
  const seenUtilities = new Set<Id>();
  for (const entry of utilities) {
    if (seenUtilities.has(entry.part.id)) errors.push(`duplicate-utility:${entry.part.id}`);
    seenUtilities.add(entry.part.id);
  }

  // 2. mass and inertia.
  const partMassKg = chosen.reduce((sum, entry) => sum + entry.part.massKg, 0);
  const ammoMassKg = weapons.reduce((sum, entry) => sum + (entry.part.magazine ?? 0) * (entry.part.roundMassKg ?? 0), 0);
  const dryMassKg = chassis.dryMassKg + partMassKg + ammoMassKg;
  const fuelCapacityKg = chassis.fuelKg;
  const wetMassKg = dryMassKg + fuelCapacityKg;
  const hullInertia = ((chassis.dryMassKg + chassis.fuelKg) * (chassis.lengthM ** 2 + chassis.beamM ** 2)) / 12;
  const parallelAxis = chosen.reduce((sum, entry) => sum + entry.part.massKg * (entry.slot.offset.x ** 2 + entry.slot.offset.y ** 2), 0);

  // 3. named multiplicative effects once, in ascending part-ID order.
  const ordered = [...chosen].sort((a, b) => (a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : 0));
  let signatureMultiplier = 1;
  let scanMultiplier = 1;
  for (const entry of ordered) {
    signatureMultiplier *= entry.part.signatureMultiplier ?? 1;
    scanMultiplier *= entry.part.scanMultiplier ?? 1;
  }

  // 4. clamps.
  const engine = chosen.find(entry => entry.part.kind === 'engine')?.part;
  const reactor = chosen.find(entry => entry.part.kind === 'reactor')?.part;
  const armor = chosen.find(entry => entry.part.kind === 'armor')?.part;
  const sensor = chosen.find(entry => entry.part.kind === 'sensor')?.part;
  const kineticReduction = Math.min(CLAMPS.resistanceMax, armor?.kineticReduction ?? 0);
  const thermalReduction = Math.min(CLAMPS.resistanceMax, armor?.thermalReduction ?? 0);

  // 5. dependent stats.
  const coolingMW = chassis.coolingMW + chosen.reduce((sum, entry) => sum + (entry.part.coolingMW ?? 0), 0);
  const heatMW = chosen.reduce((sum, entry) => sum + (entry.part.heatMW ?? 0), 0);
  const idleDemandMW = HULL_IDLE_MW + chosen.reduce((sum, entry) => sum + entry.part.idleMW, 0);
  const powerSupplyMW = reactor?.supplyMW ?? 0;
  const activeDemandMW = chosen.reduce((sum, entry) => sum + (entry.part.activeMW ?? 0), 0);
  const buildCost = chassis.cost + chosen.reduce((sum, entry) => sum + entry.part.cost, 0);
  const capacitorMJ = chassis.capacitorMJ + chosen.reduce((sum, entry) => sum + (entry.part.capacitorMJ ?? 0), 0);

  if (buildCost > BUILD_BUDGET) errors.push(`over-budget:${buildCost}`);
  if (wetMassKg > chassis.maxWetMassKg) errors.push(`over-wet-mass:${Math.round(wetMassKg)}`);
  if (reactor && idleDemandMW >= powerSupplyMW) errors.push(`idle-power-exceeds-supply:${idleDemandMW.toFixed(2)}`);

  // Fire groups and power priority are part of the frozen contract; invalid ones are rejected
  // visibly rather than silently repaired.
  const weaponSlotIds = new Set(weapons.map(entry => entry.slot.slotId));
  if ((fit.fireGroups ?? []).length > 2) errors.push('too-many-fire-groups');
  const grouped = new Set<Id>();
  for (const group of fit.fireGroups ?? []) {
    for (const slotId of group) {
      if (!weaponSlotIds.has(slotId)) { errors.push(`unknown-fire-group-slot:${slotId}`); continue; }
      if (grouped.has(slotId)) errors.push(`duplicate-fire-group-slot:${slotId}`);
      grouped.add(slotId);
    }
  }
  const priority = fit.powerPriority ?? [];
  if (priority.length !== SLOT_KINDS.length || new Set(priority).size !== SLOT_KINDS.length || SLOT_KINDS.some(kind => !priority.includes(kind))) {
    errors.push('invalid-power-priority');
  }

  const weaponSlots: WeaponSlot[] = weapons.map(entry => ({
    slotId: entry.slot.slotId,
    partId: entry.part.id,
    size: entry.part.size,
    behavior: entry.part.behavior!,
    cooldownS: Math.max(CLAMPS.cooldownMinS, entry.part.cooldownS ?? 0),
    damage: entry.part.damage ?? entry.part.damageS ?? 0,
    magazine: entry.part.magazine ?? null,
    reserve: entry.part.reserve ?? null,
    reloadS: entry.part.reloadS ?? null,
    ttlS: entry.part.ttlS ?? 0,
    speedMS: entry.part.speedMS ?? 0,
    heatShotMJ: entry.part.heatShotMJ ?? 0,
    energyShotMJ: entry.part.energyShotMJ ?? 0,
    chargeS: entry.part.chargeS ?? 0,
    impulseNS: entry.part.impulseNS ?? 0,
    roundMassKg: entry.part.roundMassKg ?? 0,
    perOwnerCap: entry.part.perOwnerCap ?? (entry.part.behavior === 'mine' ? 6 : entry.part.behavior === 'torpedo' ? 4 : null),
    armS: entry.part.armS ?? 0,
    blastM: entry.part.blastM ?? 0,
    defenseRangeM: entry.part.defenseRangeM ?? null,
    rangeM: entry.part.rangeM ?? null,
    damageS: entry.part.damageS ?? null,
    rockDamageS: entry.part.rockDamageS ?? null,
    accelerationMS2: entry.part.accelerationMS2 ?? 0,
    turnRadS: entry.part.turnRadS ?? 0,
    burnS: entry.part.burnS ?? 0,
  }));

  const utilitySlots: UtilitySlot[] = utilities.map(entry => ({
    slotId: entry.slot.slotId,
    partId: entry.part.id,
    kind: utilityKind(entry.part.id),
  }));

  const derivation: FitDerivation = {
    hash: fitHash(fit),
    valid: errors.length === 0,
    errors,
    dryMassKg,
    fuelCapacityKg,
    hullMax: chassis.hull + (armor?.hullAdd ?? 0),
    thrustN: engine?.thrustN ?? 0,
    inertiaKgM2: hullInertia + parallelAxis,
    powerSupplyMW,
    idleDemandMW,
    coolingMW,
    heatCapacityMJ: chassis.heatMJ,
    capacitorMJ,
    buildCost,
    chassisId: chassis.id,
    wetMassKg,
    activeDemandMW,
    reverseFactor: FLIGHT.reverseFactor,
    lateralFactor: FLIGHT.lateralFactor,
    brakeFactor: FLIGHT.brakeFactor,
    boostFactor: FLIGHT.boostFactor,
    fuelKgS: engine?.fuelKgS ?? 0,
    heatMW,
    rcsTorqueMNm: chassis.rcsTorqueMNm,
    maxWetMassKg: chassis.maxWetMassKg,
    cargoAddKg: utilityPart(utilitySlots, 'salvage')?.cargoAddKg ?? 0,
    passiveRangeM: sensor?.passiveRangeM ?? 0,
    activeRangeM: sensor?.activeRangeM ?? 0,
    activeScanMW: sensor?.activeMW ?? 0,
    scanMultiplier,
    signatureMultiplier,
    kineticReduction,
    thermalReduction,
    repairHullS: utilityPart(utilitySlots, 'repair')?.repairHullS ?? 0,
    repairStock: utilityPart(utilitySlots, 'repair')?.repairStock ?? 0,
    repairRangeM: utilityPart(utilitySlots, 'repair')?.rangeM ?? 0,
    tetherRangeM: utilityPart(utilitySlots, 'tether')?.rangeM ?? 0,
    tetherForceN: utilityPart(utilitySlots, 'tether')?.forceN ?? 0,
    tetherBreakForceN: utilityPart(utilitySlots, 'tether')?.breakForceN ?? 0,
    capacitorChargeLimitMW: utilityPart(utilitySlots, 'capacitor')?.chargeLimitMW ?? 0,
    ecmCharges: utilityPart(utilitySlots, 'ecm')?.charges ?? 0,
    ecmDurationS: utilityPart(utilitySlots, 'ecm')?.durationS ?? 0,
    ecmCooldownS: utilityPart(utilitySlots, 'ecm')?.cooldownS ?? 0,
    weaponSlots,
    utilities: utilitySlots,
    partIds: ordered.map(entry => entry.part.id),
  };
  return derivation;
}

function utilityPart(slots: readonly UtilitySlot[], kind: UtilitySlot['kind']): PartSpec | null {
  const slot = slots.find(candidate => candidate.kind === kind);
  return slot ? CATALOG.partById.get(slot.partId) ?? null : null;
}

function utilityKind(partId: Id): UtilitySlot['kind'] {
  if (partId.includes('radiator')) return 'radiator';
  if (partId.includes('capacitor')) return 'capacitor';
  if (partId.includes('repair')) return 'repair';
  if (partId.includes('tether')) return 'tether';
  if (partId.includes('ecm')) return 'ecm';
  return 'salvage';
}

function invalidFit(error: string, errors: string[]): FitDerivation {
  errors.push(error);
  return {
    hash: '', valid: false, errors, dryMassKg: 0, fuelCapacityKg: 0, hullMax: 0, thrustN: 0, inertiaKgM2: 0,
    powerSupplyMW: 0, idleDemandMW: 0, coolingMW: 0, heatCapacityMJ: 0, capacitorMJ: 0, buildCost: 0,
    chassisId: '', wetMassKg: 0, activeDemandMW: 0, reverseFactor: FLIGHT.reverseFactor, lateralFactor: FLIGHT.lateralFactor,
    brakeFactor: FLIGHT.brakeFactor, boostFactor: FLIGHT.boostFactor, fuelKgS: 0, heatMW: 0, rcsTorqueMNm: 0,
    maxWetMassKg: 0, cargoAddKg: 0, passiveRangeM: 0, activeRangeM: 0, activeScanMW: 0, scanMultiplier: 1,
    signatureMultiplier: 1, kineticReduction: 0, thermalReduction: 0, repairHullS: 0, repairStock: 0, repairRangeM: 0,
    tetherRangeM: 0, tetherForceN: 0, tetherBreakForceN: 0, capacitorChargeLimitMW: 0, ecmCharges: 0, ecmDurationS: 0,
    ecmCooldownS: 0, weaponSlots: [], utilities: [], partIds: [],
  };
}

/**
 * Canonical fit identity: catalog content version plus sorted slot assignments, fire groups and
 * power priority. Two clients that agree on this hash are flying the same ship.
 */
export function fitHash(fit: Fit): string {
  const slots = Object.entries(fit.slots ?? {})
    .filter(([slotId, partId]) => typeof slotId === 'string' && typeof partId === 'string')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slotId, partId]) => `${slotId}=${partId}`)
    .join(',');
  const groups = (fit.fireGroups ?? []).map(group => group.join('+')).join('|');
  const priority = (fit.powerPriority ?? []).join('>');
  const canonical = `${RELEASE.contentVersion};${fit.chassisId};${fit.paintId};${slots};${groups};${priority}`;
  return hex8(hash32(canonical));
}

/** World-space muzzle offset for a fitted weapon, in the hull's local frame. */
export function muzzleLocal(fit: Fit, slotId: Id): Vec2 {
  const chassis = CATALOG.chassisById.get(fit.chassisId);
  return chassis ? muzzleOffsetM(chassis, slotId) : { x: 0, y: 0 };
}
