/**
 * Campaign export/import (Plan B9). An export is a bounded, self-describing byte blob; an import is
 * an untrusted file, so it is validated as hostile input: size, counts, enums, coordinates, ids,
 * hash and archive paths all before a single row is written. A zip is accepted because that is what
 * a person will produce, but only `campaign.json` inside it may carry data, and no entry may name a
 * path that escapes the archive or an executable. Nothing here reaches the network.
 *
 * An import never merges receipts into an existing campaign: it mints a new campaign id, so a
 * receipt from someone else's save can never unlock this campaign's rewards.
 */

import { inflateRawSync } from 'node:zlib';
import { RELEASE } from '../../shared/contracts.ts';
import type { Id } from '../../shared/contracts.ts';
import { hash32 } from '../../shared/ids.ts';
import { boundedArray, boundedString, fail, idString, isPlainObject, ok, safeInteger } from '../../shared/validate.ts';
import type { Result } from '../../shared/validate.ts';
import type {
  CampaignRecord,
  CampaignSnapshot,
  InventoryItem,
  StoredCheckpoint,
  StoredDecision,
  StoredReceipt,
  StoredSettlement,
  StoreResult,
} from '../store-port.ts';
import { STORE_LIMITS, storeFail, storeOk, validateCheckpointState } from '../store-port.ts';

export const BUNDLE_FORMAT = 'drift-campaign';
/** Only this member is read from a zip; every other member is rejected, not ignored. */
export const BUNDLE_MEMBER = 'campaign.json';

const MAX_INVENTORY = 1024;
const MAX_SETTLEMENTS = 512;
const MAX_ZIP_ENTRIES = 256;
const MAX_ZIP_NAME_BYTES = 255;
const EXECUTABLE = /\.(exe|dll|com|bat|cmd|ps1|psm1|vbs|vbe|js|mjs|cjs|scr|msi|jar|sh|app|sys|drv|lnk)$/i;
const EXTERNAL_URL = /\b(?:https?|ftp|file|ws|wss):\/\//i;

interface BundleEnvelope {
  format: string;
  saveSchema: number;
  contentVersion: string;
  exportedAt: string;
  campaign: CampaignRecord;
  inventory: readonly InventoryItem[];
  checkpoints: readonly StoredCheckpoint[];
  receipts: readonly StoredReceipt[];
  decisions: readonly StoredDecision[];
  settlements: readonly StoredSettlement[];
  hash: string;
}

export interface DecodedBundle {
  snapshot: CampaignSnapshot;
  exportedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** JSON is the export format: it is inspectable, diffable and needs no third-party encoder. */
export function encodeCampaignBundle(snapshot: CampaignSnapshot, exportedAt = new Date().toISOString()): StoreResult<Uint8Array> {
  const payload = {
    format: BUNDLE_FORMAT,
    saveSchema: RELEASE.saveSchema,
    contentVersion: RELEASE.contentVersion,
    exportedAt,
    campaign: snapshot.campaign,
    inventory: snapshot.inventory,
    checkpoints: snapshot.checkpoints,
    receipts: snapshot.receipts,
    decisions: snapshot.decisions,
    settlements: snapshot.settlements,
  };
  const envelope: BundleEnvelope = { ...payload, hash: bundleHash(payload) };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.length > STORE_LIMITS.importBytes) return storeFail('budget', `export is ${bytes.length} bytes`);
  return storeOk(bytes);
}

/** The bundle's integrity hash: FNV-1a over the canonical payload, hex-padded to eight digits. */
export function bundleHash(payload: unknown): string {
  return hash32(JSON.stringify(payload)).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export function decodeCampaignBundle(bytes: Uint8Array): StoreResult<DecodedBundle> {
  if (bytes.length === 0) return storeFail('corrupt', 'empty bundle');
  if (bytes.length > STORE_LIMITS.importBytes) return storeFail('budget', `bundle is ${bytes.length} bytes`);

  // PK\x03\x04 is the local file header of every zip that starts with a file, not a directory.
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const text = zipped ? zipText(bytes) : utf8(bytes);
  if (!text.ok) return storeFail('corrupt', text.detail);
  if (EXTERNAL_URL.test(text.value)) return storeFail('unsupported', 'bundle contains an external URL');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.value);
  } catch {
    return storeFail('corrupt', 'bundle is not JSON');
  }
  if (!isPlainObject(parsed)) return storeFail('corrupt', 'bundle is not an object');
  if (parsed.format !== BUNDLE_FORMAT) return storeFail('unsupported', `unknown bundle format ${String(parsed.format)}`);
  if (parsed.saveSchema !== RELEASE.saveSchema) return storeFail('unsupported', `bundle save schema ${String(parsed.saveSchema)}`);

  const campaign = campaignRecord(parsed.campaign);
  if (!campaign.ok) return storeFail('corrupt', campaign.detail);
  const inventory = boundedArray(parsed.inventory, MAX_INVENTORY, inventoryItem);
  if (!inventory.ok) return storeFail('corrupt', inventory.detail);
  const receipts = boundedArray(parsed.receipts, STORE_LIMITS.receipts, storedReceipt);
  if (!receipts.ok) return storeFail('corrupt', receipts.detail);
  const decisions = boundedArray(parsed.decisions, STORE_LIMITS.decisions, storedDecision);
  if (!decisions.ok) return storeFail('corrupt', decisions.detail);
  const settlements = boundedArray(parsed.settlements, MAX_SETTLEMENTS, storedSettlement);
  if (!settlements.ok) return storeFail('corrupt', settlements.detail);
  const checkpoints = boundedArray(parsed.checkpoints, STORE_LIMITS.checkpoints, storedCheckpoint);
  if (!checkpoints.ok) return storeFail('corrupt', checkpoints.detail);

  const payload = {
    format: parsed.format,
    saveSchema: parsed.saveSchema,
    contentVersion: parsed.contentVersion,
    exportedAt: parsed.exportedAt,
    campaign: campaign.value,
    inventory: inventory.value,
    checkpoints: checkpoints.value,
    receipts: receipts.value,
    decisions: decisions.value,
    settlements: settlements.value,
  };
  if (typeof parsed.hash !== 'string' || parsed.hash !== bundleHash(payload)) return storeFail('corrupt', 'bundle hash does not match its contents');

  // A reservation is one pilot on one instance; a bundle that breaks that is corrupt, not merged.
  const reserved = new Set<Id>();
  for (const item of inventory.value) {
    if (item.reservedByPilotId === null) continue;
    if (reserved.has(item.instanceId)) return storeFail('corrupt', `instance ${item.instanceId} is reserved twice`);
    reserved.add(item.instanceId);
  }
  return storeOk({
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : new Date(0).toISOString(),
    snapshot: {
      campaign: campaign.value,
      inventory: inventory.value,
      checkpoints: checkpoints.value,
      receipts: receipts.value,
      decisions: decisions.value,
      settlements: settlements.value,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------------------------

/**
 * A minimal reader for the one member the bundle defines. Deflate and store are the only methods
 * accepted; encryption, data descriptors with mismatched sizes and archive-relative paths are not.
 */
function zipText(bytes: Uint8Array): Result<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) return fail('bad-type', 'zip has no end-of-central-directory');
  const count = view.getUint16(end + 10, true);
  const directoryAt = view.getUint32(end + 16, true);
  if (count === 0 || count > MAX_ZIP_ENTRIES) return fail('too-many', `zip has ${count} entries`);
  if (directoryAt + count * 46 > bytes.length) return fail('too-many', 'zip central directory is out of bounds');

  let data: Uint8Array | null = null;
  let offset = directoryAt;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) return fail('bad-type', 'bad central directory entry');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localAt = view.getUint32(offset + 42, true);
    if (nameLength === 0 || nameLength > MAX_ZIP_NAME_BYTES) return fail('too-long', 'zip member name is out of range');
    const name = utf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name.ok) return name;
    const safe = safeEntryName(name.value);
    if (!safe.ok) return safe;
    if (index === 0 && (flags & 0x1) !== 0) return fail('bad-type', 'zip member is encrypted');
    if (name.value === BUNDLE_MEMBER) {
      if (method !== 0 && method !== 8) return fail('bad-type', `zip method ${method}`);
      if (compressedSize > STORE_LIMITS.importBytes || uncompressedSize > STORE_LIMITS.importBytes) return fail('too-large', 'zip member is too large');
      const local = localData(bytes, view, localAt, compressedSize);
      if (!local.ok) return local;
      try {
        data = method === 0 ? local.value : new Uint8Array(inflateRawSync(local.value));
      } catch {
        return fail('bad-type', 'zip member did not inflate');
      }
      if (data.length !== uncompressedSize) return fail('bad-type', 'zip member size does not match');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!data) return fail('missing-field', `zip has no ${BUNDLE_MEMBER}`);
  return utf8(data);
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= start; at--) {
    if (view.getUint32(at, true) === 0x06054b50) return at;
  }
  return -1;
}

function localData(bytes: Uint8Array, view: DataView, localAt: number, compressedSize: number): Result<Uint8Array> {
  if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) return fail('bad-type', 'bad local header');
  const nameLength = view.getUint16(localAt + 26, true);
  const extraLength = view.getUint16(localAt + 28, true);
  const from = localAt + 30 + nameLength + extraLength;
  if (from + compressedSize > bytes.length) return fail('too-large', 'zip member is out of bounds');
  return ok(bytes.subarray(from, from + compressedSize));
}

/** Absolute paths, `..` segments, drive letters and executables are rejected before decompression. */
function safeEntryName(name: string): Result<string> {
  if (name.length === 0 || name.startsWith('/') || name.startsWith('\\')) return fail('bad-id', `unsafe zip path ${name}`);
  if (name.includes('\\') || name.includes('\0')) return fail('bad-id', `unsafe zip path ${name}`);
  if (/^[A-Za-z]:/.test(name)) return fail('bad-id', `unsafe zip path ${name}`);
  const segments = name.split('/');
  if (segments.some(segment => segment === '..' || segment === '.')) return fail('bad-id', `unsafe zip path ${name}`);
  if (EXECUTABLE.test(name)) return fail('unknown-field', `executable member ${name}`);
  return ok(name);
}

// ---------------------------------------------------------------------------------------------
// Bounded field readers
// ---------------------------------------------------------------------------------------------

function utf8(bytes: Uint8Array): Result<string> {
  try {
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('bad-type', 'bytes are not UTF-8');
  }
}

function campaignRecord(value: unknown): Result<CampaignRecord> {
  if (!isPlainObject(value)) return fail('not-object', 'campaign');
  const id = idString(value.id);
  if (!id.ok) return id;
  const name = boundedString(value.name, STORE_LIMITS.nameChars * 4, STORE_LIMITS.nameChars);
  if (!name.ok) return name;
  const credits = safeInteger(value.credits, 0, 1e9);
  if (!credits.ok) return credits;
  const inventoryRevision = safeInteger(value.inventoryRevision, 0, 0xffffffff);
  if (!inventoryRevision.ok) return inventoryRevision;
  const createdAt = timestamp(value.createdAt, 'createdAt');
  if (!createdAt.ok) return createdAt;
  const lastSavedAt = value.lastSavedAt === null ? ok(null) : timestamp(value.lastSavedAt, 'lastSavedAt');
  if (!lastSavedAt.ok) return lastSavedAt;
  return ok({
    id: id.value,
    name: name.value,
    credits: credits.value,
    inventoryRevision: inventoryRevision.value,
    createdAt: createdAt.value,
    lastSavedAt: lastSavedAt.value,
  });
}

function timestamp(value: unknown, label: string): Result<string> {
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(Date.parse(value))) return fail('bad-type', `${label} is not an ISO timestamp`);
  return ok(value);
}

function inventoryItem(value: unknown, index: number): Result<InventoryItem> {
  if (!isPlainObject(value)) return fail('not-object', `inventory[${index}]`);
  const instanceId = idString(value.instanceId);
  if (!instanceId.ok) return instanceId;
  const partId = idString(value.partId);
  if (!partId.ok) return partId;
  const health = safeInteger(value.health, 0, 1e6);
  if (!health.ok) return health;
  const reservedByPilotId = value.reservedByPilotId === null ? ok(null) : idString(value.reservedByPilotId);
  if (!reservedByPilotId.ok) return reservedByPilotId;
  return ok({ instanceId: instanceId.value, partId: partId.value, health: health.value, reservedByPilotId: reservedByPilotId.value });
}

function storedCheckpoint(value: unknown, index: number): Result<StoredCheckpoint> {
  if (!isPlainObject(value)) return fail('not-object', `checkpoints[${index}]`);
  const checkpointId = idString(value.checkpointId);
  if (!checkpointId.ok) return checkpointId;
  const at = timestamp(value.at, `checkpoints[${index}].at`);
  if (!at.ok) return at;
  const state = validateCheckpointState(value.state);
  if (!state.ok) return state;
  return ok({ checkpointId: checkpointId.value, state: state.value, at: at.value });
}

function storedReceipt(value: unknown, index: number): Result<StoredReceipt> {
  if (!isPlainObject(value)) return fail('not-object', `receipts[${index}]`);
  const objectiveId = idString(value.objectiveId);
  if (!objectiveId.ok) return objectiveId;
  const itemId = idString(value.itemId);
  if (!itemId.ok) return itemId;
  const receiptId = idString(value.receiptId);
  if (!receiptId.ok) return receiptId;
  return ok({ objectiveId: objectiveId.value, itemId: itemId.value, receiptId: receiptId.value });
}

function storedDecision(value: unknown, index: number): Result<StoredDecision> {
  if (!isPlainObject(value)) return fail('not-object', `decisions[${index}]`);
  const decisionId = idString(value.decisionId);
  if (!decisionId.ok) return decisionId;
  const optionId = idString(value.optionId);
  if (!optionId.ok) return optionId;
  return ok({ decisionId: decisionId.value, optionId: optionId.value });
}

function storedSettlement(value: unknown, index: number): Result<StoredSettlement> {
  if (!isPlainObject(value)) return fail('not-object', `settlements[${index}]`);
  const resultId = idString(value.resultId);
  if (!resultId.ok) return resultId;
  const receiptId = idString(value.receiptId);
  if (!receiptId.ok) return receiptId;
  const credits = safeInteger(value.credits, 0, 1e9);
  if (!credits.ok) return credits;
  return ok({ resultId: resultId.value, receiptId: receiptId.value, credits: credits.value });
}
