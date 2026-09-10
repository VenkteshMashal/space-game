/**
 * SQLite host store (Plan B9). The authority hands over immutable DTOs; this file is the only place
 * that touches `bun:sqlite`, so the 120 Hz loop never imports a driver.
 *
 * Commit rules:
 *   - WAL, because a crash must lose at most the last acknowledged checkpoint.
 *   - one transaction per settlement: credits, receipts, decisions, the mission attempt and the
 *     settled sector flip together or not at all.
 *   - checkpoints arrive through a bounded, serialized queue; the caller is never blocked, and a
 *     newer periodic checkpoint for the same campaign supersedes an older one that has not started.
 *   - startup checks the file, backs it up with VACUUM INTO before a migration and quarantines a
 *     corrupt file instead of deleting it.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CAMPAIGN_START } from '../../shared/balance.ts';
import { RELEASE } from '../../shared/contracts.ts';
import type { Id } from '../../shared/contracts.ts';
import { boundedString, fail, idString, safeInteger } from '../../shared/validate.ts';
import type { Result } from '../../shared/validate.ts';
import type {
  CampaignRecord,
  CampaignSnapshot,
  CheckpointInput,
  CheckpointReceipt,
  CheckpointState,
  HostStorePort,
  InventoryItem,
  PurchaseInput,
  PurchaseReceipt,
  SettlementInput,
  SettlementReceipt,
  StoredCheckpoint,
  StoredDecision,
  StoredReceipt,
  StoredSettlement,
  StoreErrorCode,
  StoreResult,
} from '../store-port.ts';
import { STORE_LIMITS, storeFail, storeOk, validateCheckpointInput, validateCheckpointState, validateSettlementInput } from '../store-port.ts';
import { applyMigrations, backupDatabase, integrityCheck, readSchemaVersion, SCHEMA_VERSION } from './migrations.ts';
import { decodeCampaignBundle, encodeCampaignBundle } from './transfer.ts';

export interface SqliteStoreOptions {
  /** Database file, or `:memory:`. Defaults to `%LOCALAPPDATA%\DRIFT\host.sqlite`. */
  path?: string;
  /** Pre-migration backup target. Defaults to `<path>.backup`. */
  backupPath?: string;
  now?: () => string;
}

/** A store that cannot be opened is a startup failure, not a runtime value. */
export class StoreOpenError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreOpenError';
    this.code = code;
  }
}

/** Raised inside a transaction; the code survives the rollback and becomes a StoreResult. */
class StoreRollback extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface CampaignRow {
  id: string;
  name: string;
  credits: number;
  inventory_revision: number;
  created_at: string;
  last_saved_at: string | null;
}

interface CheckpointRow {
  checkpoint_id: string;
  tick: number;
  at: string;
  state: string;
  verified: number;
}

/** A queue entry holds its waiters so a superseded periodic checkpoint still gets a receipt. */
interface PendingWrite {
  input: CheckpointInput;
  waiters: ((result: StoreResult<CheckpointReceipt>) => void)[];
}

const WRITER_QUEUE_DEPTH = 16;
/** Module hull scale: the port stores hull points without a per-part maximum, so full repair is 100. */
const FULL_MODULE_HULL = 100;

/** Plan B9's default: `%LOCALAPPDATA%\DRIFT\host`, never inside a OneDrive folder. */
export function defaultHostDatabasePath(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  if (/onedrive/i.test(local)) throw new StoreOpenError('io', `LOCALAPPDATA is inside OneDrive (${local}); pass an explicit database path`);
  return join(local, 'DRIFT', 'host');
}

export class SqliteStore implements HostStorePort {
  protected readonly db: Database;
  private readonly path: string;
  private readonly backupPath: string;
  private readonly now: () => string;
  private queue: PendingWrite[] = [];
  private draining = false;
  private closed = false;

  constructor(options: SqliteStoreOptions = {}) {
    this.path = options.path ?? defaultHostDatabasePath();
    this.backupPath = options.backupPath ?? (this.path === ':memory:' ? '' : `${this.path}.backup`);
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = this.open();
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  private open(): Database {
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    let db: Database;
    try {
      db = new Database(this.path, { create: true });
    } catch (cause) {
      throw new StoreOpenError('corrupt', `cannot open ${this.path}: ${(cause as Error).message}`);
    }
    if (this.path !== ':memory:') {
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch {
        db.close();
        return this.recoverAfterCorruption();
      }
      const integrity = integrityCheck(db);
      if (integrity !== 'ok') {
        db.close();
        return this.recoverAfterCorruption();
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    const version = readSchemaVersion(db);
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new StoreOpenError('unsupported', `save schema ${version} is newer than this build (${SCHEMA_VERSION}); original bytes preserved`);
    }
    if (version > 0 && version < SCHEMA_VERSION && this.backupPath.length > 0) {
      // A live database is only safe to copy through the engine: VACUUM INTO writes the WAL too.
      rmSync(this.backupPath, { force: true });
      try {
        backupDatabase(db, this.backupPath);
      } catch (cause) {
        db.close();
        throw new StoreOpenError('io', `pre-migration backup failed: ${(cause as Error).message}`);
      }
    }
    try {
      applyMigrations(db);
    } catch (cause) {
      db.close();
      throw new StoreOpenError('corrupt', `migration failed: ${(cause as Error).message}`);
    }
    this.verifyCheckpoints(db);
    return db;
  }

  /** Keep the bad bytes and fall back: restore the verified backup if there is one, else start over. */
  private recoverAfterCorruption(): Database {
    const stamp = this.now().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${this.path}${suffix}`;
      if (existsSync(source)) renameSync(source, `${this.path}.corrupt-${stamp}${suffix}`);
    }
    if (this.backupPath.length > 0 && existsSync(this.backupPath)) copyFileSync(this.backupPath, this.path);
    const db = new Database(this.path, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    applyMigrations(db);
    return db;
  }

  /** A checkpoint that no longer validates is flagged, never deleted, and reads fall back past it. */
  private verifyCheckpoints(db: Database): void {
    const rows = db.query('SELECT campaign_id, checkpoint_id, state FROM checkpoints').all() as { campaign_id: string; checkpoint_id: string; state: string }[];
    for (const row of rows) {
      let state: unknown;
      try {
        state = JSON.parse(row.state);
      } catch {
        state = null;
      }
      if (state !== null && validateCheckpointState(state).ok) continue;
      db.query('UPDATE checkpoints SET verified = 0 WHERE campaign_id = ? AND checkpoint_id = ?').run(row.campaign_id, row.checkpoint_id);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Closing an already-closed handle is not a failure the caller can act on.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------------------------

  async createCampaign(input: { name: string; id?: Id; at: string }): Promise<StoreResult<CampaignRecord>> {
    const name = boundedString(input.name, STORE_LIMITS.nameChars * 4, STORE_LIMITS.nameChars);
    if (!name.ok) return storeFail('corrupt', `name: ${name.detail}`);
    const at = isoField(input.at);
    if (!at.ok) return storeFail('corrupt', at.detail);
    let id: Id;
    if (input.id === undefined) {
      id = mintId('campaign');
    } else {
      const parsed = idString(input.id);
      if (!parsed.ok) return storeFail('corrupt', `id: ${parsed.detail}`);
      id = parsed.value;
    }
    const existing = this.db.query('SELECT id FROM campaigns WHERE id = ?').get(id);
    if (existing) return storeFail('conflict', `campaign ${id} already exists`);
    const record: CampaignRecord = {
      id,
      name: name.value,
      credits: CAMPAIGN_START.credits,
      inventoryRevision: 1,
      createdAt: at.value,
      lastSavedAt: null,
    };
    this.db
      .query('INSERT INTO campaigns (id, name, credits, inventory_revision, created_at, last_saved_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(record.id, record.name, record.credits, record.inventoryRevision, record.createdAt);
    return storeOk(record);
  }

  async listCampaigns(): Promise<StoreResult<readonly CampaignRecord[]>> {
    const rows = this.db.query('SELECT * FROM campaigns ORDER BY created_at DESC').all() as CampaignRow[];
    return storeOk(rows.map(campaignRecord));
  }

  async loadCampaign(campaignId: Id): Promise<StoreResult<CampaignSnapshot>> {
    const id = idString(campaignId);
    if (!id.ok) return storeFail('corrupt', `campaignId: ${id.detail}`);
    const campaign = this.campaignRow(id.value);
    if (!campaign) return storeFail('not-found', `campaign ${id.value}`);
    return storeOk({
      campaign,
      inventory: this.inventory(id.value),
      checkpoints: this.checkpoints(id.value),
      receipts: this.receipts(id.value),
      decisions: this.decisions(id.value),
      settlements: this.settlements(id.value),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  writeCheckpoint(input: CheckpointInput): Promise<StoreResult<CheckpointReceipt>> {
    const parsed = validateCheckpointInput(input);
    if (!parsed.ok) return Promise.resolve(storeFail('corrupt', `checkpoint: ${parsed.detail}`));
    const { promise, resolve } = Promise.withResolvers<StoreResult<CheckpointReceipt>>();
    const superseded = this.queue.find(entry => entry.input.campaignId === input.campaignId);
    if (superseded) {
      // A periodic checkpoint that never started is superseded by the newer one, not written twice.
      superseded.input = input;
      superseded.waiters.push(resolve);
    } else {
      if (this.queue.length >= WRITER_QUEUE_DEPTH) return Promise.resolve(storeFail('budget', `writer queue is full (${WRITER_QUEUE_DEPTH})`));
      this.queue.push({ input, waiters: [resolve] });
    }
    this.schedule();
    return promise;
  }

  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      const result = this.writeCheckpointNow(entry.input);
      for (const waiter of entry.waiters) waiter(result);
    }
    this.draining = false;
  }

  private writeCheckpointNow(input: CheckpointInput): StoreResult<CheckpointReceipt> {
    const campaign = this.campaignRow(input.campaignId);
    if (!campaign) return storeFail('not-found', `campaign ${input.campaignId}`);
    const checkpointId = mintId('cp');
    const state = input.state;
    try {
      this.transaction(() => {
        this.db
          .query('INSERT INTO checkpoints (campaign_id, checkpoint_id, tick, at, state, verified) VALUES (?, ?, ?, ?, ?, 1)')
          .run(input.campaignId, checkpointId, state.tick, input.at, JSON.stringify(state));
        this.db.query('UPDATE campaigns SET last_saved_at = ? WHERE id = ?').run(input.at, input.campaignId);
        for (const ship of state.ships) {
          this.db
            .query('INSERT INTO pilots (campaign_id, pilot_id, enrolled_at) VALUES (?, ?, ?) ON CONFLICT(campaign_id, pilot_id) DO NOTHING')
            .run(input.campaignId, ship.pilotId, input.at);
        }
        this.db
          .query(
            `INSERT INTO sectors (campaign_id, sector_id, baseline_revision, content_version, materialized_at, settled_at)
             VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT(campaign_id, sector_id) DO UPDATE SET baseline_revision = excluded.baseline_revision,
               content_version = excluded.content_version, materialized_at = excluded.materialized_at`,
          )
          .run(input.campaignId, state.epoch, state.baselineRevision, RELEASE.contentVersion, input.at);
        // Retention: the newest checkpoint plus two verified predecessors, nothing older.
        this.db
          .query(
            `DELETE FROM checkpoints WHERE campaign_id = ? AND verified = 1 AND checkpoint_id NOT IN (
               SELECT checkpoint_id FROM checkpoints WHERE campaign_id = ? AND verified = 1 ORDER BY tick DESC, at DESC LIMIT ?
             )`,
          )
          .run(input.campaignId, input.campaignId, STORE_LIMITS.checkpoints);
      });
    } catch (cause) {
      return storeFail(cause instanceof StoreRollback ? cause.code : 'io', (cause as Error).message);
    }
    return storeOk({ checkpointId, tick: state.tick, at: input.at, campaign: this.campaignRow(input.campaignId)! });
  }

  async settle(input: SettlementInput): Promise<StoreResult<SettlementReceipt>> {
    const parsed = validateSettlementInput(input);
    if (!parsed.ok) return storeFail('corrupt', `settlement: ${parsed.detail}`);
    const settlement = parsed.value;
    const campaign = this.campaignRow(settlement.campaignId);
    if (!campaign) return storeFail('not-found', `campaign ${settlement.campaignId}`);
    const previous = this.db
      .query('SELECT receipt_id, credits FROM settlements WHERE campaign_id = ? AND result_id = ?')
      .get(settlement.campaignId, settlement.resultId) as { receipt_id: string; credits: number } | null;
    // A retried settlement returns the original receipt: no credit is ever paid twice (B9).
    if (previous) return storeOk({ receiptId: previous.receipt_id, credits: previous.credits });
    const receiptId = mintId('rc');
    const at = this.now();
    let credited = campaign.credits;
    try {
      this.transaction(() => {
        for (const decision of settlement.decisions) {
          const prior = this.db
            .query('SELECT option_id FROM decisions WHERE campaign_id = ? AND decision_id = ?')
            .get(settlement.campaignId, decision.decisionId) as { option_id: string } | null;
          if (prior && prior.option_id !== decision.optionId) {
            throw new StoreRollback('conflict', `decision ${decision.decisionId} was already committed as ${prior.option_id}`);
          }
          this.db
            .query('INSERT INTO decisions (campaign_id, decision_id, option_id, decided_at) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id, decision_id) DO NOTHING')
            .run(settlement.campaignId, decision.decisionId, decision.optionId, at);
        }
        for (const objective of settlement.objectiveReceipts) {
          // Unique collection per attempt/objective/item: a duplicate is the same collection, not a new one.
          this.db
            .query(
              `INSERT INTO objective_receipts (campaign_id, objective_id, item_id, receipt_id, collected_at)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT(campaign_id, objective_id, item_id) DO NOTHING`,
            )
            .run(settlement.campaignId, objective.objectiveId, objective.itemId, receiptId, at);
        }
        credited = Math.max(0, campaign.credits + settlement.rewardCredits - settlement.repairCredits);
        this.db.query('UPDATE campaigns SET credits = ?, last_saved_at = ? WHERE id = ?').run(credited, at, settlement.campaignId);
        this.db
          .query('INSERT INTO reward_receipts (campaign_id, result_id, receipt_id, credits, paid_at) VALUES (?, ?, ?, ?, ?)')
          .run(settlement.campaignId, settlement.resultId, receiptId, settlement.rewardCredits, at);
        this.db
          .query('INSERT INTO settlements (campaign_id, result_id, receipt_id, credits, reward_credits, repair_credits, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(settlement.campaignId, settlement.resultId, receiptId, credited, settlement.rewardCredits, settlement.repairCredits, at);
        this.db
          .query(
            `INSERT INTO mission_attempts (campaign_id, attempt_id, mission_id, state, started_at, settled_at)
             VALUES (?, ?, ?, 'settled', ?, ?)
             ON CONFLICT(campaign_id, attempt_id) DO UPDATE SET state = 'settled', settled_at = excluded.settled_at`,
          )
          .run(settlement.campaignId, settlement.resultId, this.currentEpoch(settlement.campaignId), at, at);
        this.db.query('UPDATE sectors SET settled_at = ? WHERE campaign_id = ?').run(at, settlement.campaignId);
      });
    } catch (cause) {
      return storeFail(cause instanceof StoreRollback ? cause.code : 'io', (cause as Error).message);
    }
    return storeOk({ receiptId, credits: credited });
  }

  async purchase(input: PurchaseInput): Promise<StoreResult<PurchaseReceipt>> {
    const campaignId = idString(input.campaignId);
    if (!campaignId.ok) return storeFail('corrupt', `campaignId: ${campaignId.detail}`);
    const itemId = idString(input.itemId);
    if (!itemId.ok) return storeFail('corrupt', `itemId: ${itemId.detail}`);
    const action = input.action;
    if (action !== 'buy' && action !== 'repair' && action !== 'restock') return storeFail('unsupported', `action ${String(action)}`);
    const cost = safeInteger(input.cost, 0, 1e9);
    if (!cost.ok) return storeFail('corrupt', `cost: ${cost.detail}`);
    const revision = safeInteger(input.expectedRevision, 0, 0xffffffff);
    if (!revision.ok) return storeFail('corrupt', `expectedRevision: ${revision.detail}`);
    const campaign = this.campaignRow(campaignId.value);
    if (!campaign) return storeFail('not-found', `campaign ${campaignId.value}`);
    if (campaign.inventoryRevision !== revision.value) return storeFail('conflict', `inventory revision is ${campaign.inventoryRevision}`);
    if (cost.value > campaign.credits) return storeFail('budget', `${cost.value} credits is beyond ${campaign.credits}`);

    const nextRevision = campaign.inventoryRevision + 1;
    let instanceId: Id | null = null;
    try {
      this.transaction(() => {
        if (action === 'buy') {
          instanceId = mintId('inst');
          this.db
            .query('INSERT INTO module_instances (instance_id, campaign_id, part_id, health, reserved_by_pilot_id) VALUES (?, ?, ?, ?, NULL)')
            .run(instanceId, campaignId.value, itemId.value, FULL_MODULE_HULL);
        } else if (action === 'repair') {
          const changed = this.db
            .query('UPDATE module_instances SET health = ? WHERE instance_id = ? AND campaign_id = ?')
            .run(FULL_MODULE_HULL, itemId.value, campaignId.value);
          if (changed.changes === 0) throw new StoreRollback('not-found', `instance ${itemId.value}`);
          instanceId = itemId.value;
        }
        this.db
          .query('UPDATE campaigns SET credits = ?, inventory_revision = ?, last_saved_at = ? WHERE id = ?')
          .run(campaign.credits - cost.value, nextRevision, this.now(), campaignId.value);
      });
    } catch (cause) {
      return storeFail(cause instanceof StoreRollback ? cause.code : 'io', (cause as Error).message);
    }
    return storeOk({ credits: campaign.credits - cost.value, inventoryRevision: nextRevision, instanceId });
  }

  // -------------------------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------------------------

  async exportCampaign(campaignId: Id): Promise<StoreResult<Uint8Array>> {
    const loaded = await this.loadCampaign(campaignId);
    if (!loaded.ok) return loaded;
    return encodeCampaignBundle(loaded.value, this.now());
  }

  async importCampaign(bundle: Uint8Array): Promise<StoreResult<{ campaignId: Id }>> {
    const decoded = decodeCampaignBundle(bundle);
    if (!decoded.ok) return decoded;
    const snapshot = decoded.value.snapshot;
    const campaignId = mintId('campaign');
    try {
      this.transaction(() => {
        this.db
          .query('INSERT INTO campaigns (id, name, credits, inventory_revision, created_at, last_saved_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(campaignId, snapshot.campaign.name, snapshot.campaign.credits, snapshot.campaign.inventoryRevision, snapshot.campaign.createdAt, snapshot.campaign.lastSavedAt);
        for (const item of snapshot.inventory) {
          this.db
            .query('INSERT INTO module_instances (instance_id, campaign_id, part_id, health, reserved_by_pilot_id) VALUES (?, ?, ?, ?, ?)')
            .run(item.instanceId, campaignId, item.partId, item.health, item.reservedByPilotId);
          if (item.reservedByPilotId !== null) {
            this.db
              .query('INSERT INTO pilots (campaign_id, pilot_id, enrolled_at) VALUES (?, ?, ?) ON CONFLICT(campaign_id, pilot_id) DO NOTHING')
              .run(campaignId, item.reservedByPilotId, this.now());
            // One instance can be reserved by one pilot: the primary key is the rule, not a comment.
            this.db
              .query('INSERT INTO fit_reservations (instance_id, campaign_id, pilot_id, slot_id, reserved_at) VALUES (?, ?, ?, NULL, ?)')
              .run(item.instanceId, campaignId, item.reservedByPilotId, this.now());
          }
        }
        for (const checkpoint of snapshot.checkpoints) {
          this.db
            .query('INSERT INTO checkpoints (campaign_id, checkpoint_id, tick, at, state, verified) VALUES (?, ?, ?, ?, ?, 1)')
            .run(campaignId, checkpoint.checkpointId, checkpoint.state.tick, checkpoint.at, JSON.stringify(checkpoint.state));
          for (const ship of checkpoint.state.ships) {
            this.db
              .query('INSERT INTO pilots (campaign_id, pilot_id, enrolled_at) VALUES (?, ?, ?) ON CONFLICT(campaign_id, pilot_id) DO NOTHING')
              .run(campaignId, ship.pilotId, checkpoint.at);
          }
        }
        for (const receipt of snapshot.receipts) {
          this.db
            .query('INSERT INTO objective_receipts (campaign_id, objective_id, item_id, receipt_id, collected_at) VALUES (?, ?, ?, ?, ?)')
            .run(campaignId, receipt.objectiveId, receipt.itemId, receipt.receiptId, this.now());
        }
        for (const decision of snapshot.decisions) {
          this.db
            .query('INSERT INTO decisions (campaign_id, decision_id, option_id, decided_at) VALUES (?, ?, ?, ?)')
            .run(campaignId, decision.decisionId, decision.optionId, this.now());
        }
        for (const settlement of snapshot.settlements) {
          this.db
            .query('INSERT INTO reward_receipts (campaign_id, result_id, receipt_id, credits, paid_at) VALUES (?, ?, ?, 0, ?)')
            .run(campaignId, settlement.resultId, settlement.receiptId, this.now());
          this.db
            .query('INSERT INTO settlements (campaign_id, result_id, receipt_id, credits, reward_credits, repair_credits, settled_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
            .run(campaignId, settlement.resultId, settlement.receiptId, settlement.credits, this.now());
        }
      });
    } catch (cause) {
      return storeFail(cause instanceof StoreRollback ? cause.code : 'conflict', `import failed: ${(cause as Error).message}`);
    }
    return storeOk({ campaignId });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  private campaignRow(id: Id): CampaignRecord | null {
    const row = this.db.query('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | null;
    return row ? campaignRecord(row) : null;
  }

  private inventory(campaignId: Id): InventoryItem[] {
    const rows = this.db
      .query('SELECT instance_id, part_id, health, reserved_by_pilot_id FROM module_instances WHERE campaign_id = ? ORDER BY instance_id')
      .all(campaignId) as { instance_id: string; part_id: string; health: number; reserved_by_pilot_id: string | null }[];
    return rows.map(row => ({
      instanceId: row.instance_id,
      partId: row.part_id,
      health: row.health,
      reservedByPilotId: row.reserved_by_pilot_id,
    }));
  }

  /** Newest verified first; a corrupt payload is skipped, leaving the row for an operator to inspect. */
  private checkpoints(campaignId: Id): StoredCheckpoint[] {
    const rows = this.db
      .query('SELECT checkpoint_id, tick, at, state FROM checkpoints WHERE campaign_id = ? AND verified = 1 ORDER BY tick DESC, at DESC')
      .all(campaignId) as CheckpointRow[];
    const verified: StoredCheckpoint[] = [];
    for (const row of rows) {
      const state = JSON.parse(row.state) as CheckpointState;
      verified.push({ checkpointId: row.checkpoint_id, at: row.at, state });
    }
    return verified;
  }

  private receipts(campaignId: Id): StoredReceipt[] {
    const rows = this.db
      .query('SELECT objective_id, item_id, receipt_id FROM objective_receipts WHERE campaign_id = ? ORDER BY collected_at')
      .all(campaignId) as { objective_id: string; item_id: string; receipt_id: string }[];
    return rows.map(row => ({ objectiveId: row.objective_id, itemId: row.item_id, receiptId: row.receipt_id }));
  }

  private decisions(campaignId: Id): StoredDecision[] {
    const rows = this.db
      .query('SELECT decision_id, option_id FROM decisions WHERE campaign_id = ? ORDER BY decided_at')
      .all(campaignId) as { decision_id: string; option_id: string }[];
    return rows.map(row => ({ decisionId: row.decision_id, optionId: row.option_id }));
  }

  private settlements(campaignId: Id): StoredSettlement[] {
    const rows = this.db
      .query('SELECT result_id, receipt_id, credits FROM settlements WHERE campaign_id = ? ORDER BY settled_at')
      .all(campaignId) as { result_id: string; receipt_id: string; credits: number }[];
    return rows.map(row => ({ resultId: row.result_id, receiptId: row.receipt_id, credits: row.credits }));
  }

  private currentEpoch(campaignId: Id): Id {
    const row = this.db
      .query('SELECT state FROM checkpoints WHERE campaign_id = ? AND verified = 1 ORDER BY tick DESC, at DESC LIMIT 1')
      .get(campaignId) as { state: string } | null;
    if (!row) return 'campaign';
    return (JSON.parse(row.state) as CheckpointState).epoch;
  }
}

function mintId(prefix: string): Id {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isoField(value: unknown): Result<string> {
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(Date.parse(value))) return fail('bad-type', 'not an ISO timestamp');
  return { ok: true, value };
}

function campaignRecord(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    name: row.name,
    credits: row.credits,
    inventoryRevision: row.inventory_revision,
    createdAt: row.created_at,
    lastSavedAt: row.last_saved_at,
  };
}
