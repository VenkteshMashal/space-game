/**
 * Persistence and offline-session rules (Plan B9). These assert outcomes a player can observe —
 * credits survive a reload, a retry never pays twice, a failed disk blocks the debrief, a corrupt
 * checkpoint falls back past the bad bytes — not the shape of the tables that produce them.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientView, Command, CommandResult, EventPayloadByKind, Id, SessionEvent } from '../src/shared/contracts.ts';
import { CAMPAIGN_START } from '../src/shared/balance.ts';
import { CATALOG } from '../src/shared/catalog.ts';
import { hash32, hex8 } from '../src/shared/ids.ts';
import type { CampaignRecord, CampaignSnapshot, CheckpointState, SettlementInput } from '../src/server/store-port.ts';
import { STORE_LIMITS } from '../src/server/store-port.ts';
import { applyMigrations, readSchemaVersion, SCHEMA_VERSION } from '../src/server/persistence/migrations.ts';
import { bundleHash, decodeCampaignBundle } from '../src/server/persistence/transfer.ts';
import { MemoryStore } from '../src/server/persistence/memory-store.ts';
import { SqliteStore } from '../src/server/persistence/sqlite-store.ts';
import { LocalSession, createLocalHost } from '../src/client/session/local.ts';
import type { HostReply, HostRequest, LocalConfig, LocalHost, OfflineStorage } from '../src/client/session/local.ts';

const AT = '2026-09-10T12:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // A leaked handle must not fail a test: the next run gets a fresh directory anyway.
    }
  }
});

function scratch(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `drift-${name}-`));
  dirs.push(dir);
  return dir;
}

function checkpointState(tick: number, epoch: string): CheckpointState {
  return { tick, epoch, rng: { fracture: 7 }, ships: [], rocks: [], objectives: [], pendingActions: [], baselineRevision: 1 };
}

function settleInput(campaignId: Id, resultId: Id, over: Partial<SettlementInput> = {}): SettlementInput {
  return {
    campaignId,
    resultId,
    rewardCredits: 120,
    repairCredits: 20,
    objectiveReceipts: [{ objectiveId: 'm1-return-archives', itemId: 'archive-a' }],
    decisions: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Store rules
// ---------------------------------------------------------------------------------------------

describe('campaign store', () => {
  test('a campaign keeps credits, inventory and mission receipts across a reload', async () => {
    const path = join(scratch('reload'), 'host.sqlite');
    let store = new SqliteStore({ path });
    const created = await store.createCampaign({ name: 'Quiet Signal', at: AT });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.credits).toBe(200);
    const id = created.value.id;

    const bought = await store.purchase({ campaignId: id, action: 'buy', itemId: 'gun-autocannon', cost: 30, expectedRevision: 1 });
    expect(bought.ok && bought.value.inventoryRevision).toBe(2);
    const settled = await store.settle(settleInput(id, 'epoch-1:result'));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    await store.writeCheckpoint({ campaignId: id, state: checkpointState(240, 'epoch-1'), at: AT });
    await store.close();

    store = new SqliteStore({ path });
    const loaded = await store.loadCampaign(id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.campaign.credits).toBe(200 - 30 + 120 - 20);
    expect(loaded.value.campaign.lastSavedAt).toBe(AT);
    expect(loaded.value.inventory.map(item => item.partId)).toEqual(['gun-autocannon']);
    expect(loaded.value.receipts).toEqual([{ objectiveId: 'm1-return-archives', itemId: 'archive-a', receiptId: settled.value.receiptId }]);
    expect(loaded.value.settlements).toEqual([{ resultId: 'epoch-1:result', receiptId: settled.value.receiptId, credits: 270 }]);
    expect(loaded.value.checkpoints[0]?.state.tick).toBe(240);
    await store.close();
  });

  test('reservations survive a reload and one instance cannot be reserved twice', async () => {
    const path = join(scratch('reserved'), 'host.sqlite');
    const store = new SqliteStore({ path });
    const imported = await store.importCampaign(bundle({
      inventory: [
        { instanceId: 'inst-gun-1', partId: 'gun-autocannon', health: 74, reservedByPilotId: 'pilot-rook' },
        { instanceId: 'inst-drive-1', partId: 'drive-torch', health: 100, reservedByPilotId: 'pilot-rook' },
      ],
    }));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const contested = await store.importCampaign(bundle({
      inventory: [
        { instanceId: 'inst-gun-1', partId: 'gun-autocannon', health: 100, reservedByPilotId: 'pilot-rook' },
        { instanceId: 'inst-gun-1', partId: 'gun-autocannon', health: 100, reservedByPilotId: 'pilot-iona' },
      ],
    }));
    expect(contested.ok).toBe(false);
    if (!contested.ok) expect(contested.code).toBe('corrupt');

    const campaignId = imported.value.campaignId;
    await store.close();
    const reopened = new SqliteStore({ path });
    const loaded = await reopened.loadCampaign(campaignId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect([...loaded.value.inventory].sort((a, b) => a.instanceId.localeCompare(b.instanceId)).map(item => [item.instanceId, item.reservedByPilotId])).toEqual([
      ['inst-drive-1', 'pilot-rook'],
      ['inst-gun-1', 'pilot-rook'],
    ]);
    await reopened.close();
  });

  test('a repeated settlement returns the original receipt and never pays twice', async () => {
    const store = new MemoryStore(() => AT);
    const created = await store.createCampaign({ name: 'Repeat', at: AT });
    if (!created.ok) return;
    const id = created.value.id;
    const first = await store.settle(settleInput(id, 'epoch-1:result'));
    const second = await store.settle(settleInput(id, 'epoch-1:result'));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.receiptId).toBe(first.value.receiptId);
    expect(second.value.credits).toBe(first.value.credits);
    const loaded = await store.loadCampaign(id);
    if (!loaded.ok) return;
    expect(loaded.value.settlements).toHaveLength(1);
    expect(loaded.value.campaign.credits).toBe(300);
    await store.close();
  });

  test('a settlement that fails mid-transaction applies nothing at all', async () => {
    const store = new MemoryStore(() => AT);
    const created = await store.createCampaign({ name: 'Rollback', at: AT });
    if (!created.ok) return;
    const id = created.value.id;
    const first = await store.settle(settleInput(id, 'epoch-1:result', { decisions: [{ decisionId: 'm4-shelter', optionId: 'shelter' }] }));
    expect(first.ok).toBe(true);
    // A decision is committed once (B8); a different option must abort the whole settlement.
    const conflicted = await store.settle(settleInput(id, 'epoch-2:result', {
      rewardCredits: 999,
      decisions: [{ decisionId: 'm4-shelter', optionId: 'harvest' }],
    }));
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.code).toBe('conflict');
    const loaded = await store.loadCampaign(id);
    if (!loaded.ok) return;
    expect(loaded.value.settlements).toHaveLength(1);
    expect(loaded.value.campaign.credits).toBe(300);
    expect(loaded.value.decisions).toEqual([{ decisionId: 'm4-shelter', optionId: 'shelter' }]);
    await store.close();
  });

  test('a crash after commit is idempotent on reload and loses nothing committed', async () => {
    const path = join(scratch('crash'), 'host.sqlite');
    let store = new SqliteStore({ path });
    const created = await store.createCampaign({ name: 'Crash', at: AT });
    if (!created.ok) return;
    const id = created.value.id;
    const committed = await store.settle(settleInput(id, 'epoch-1:result'));
    await store.writeCheckpoint({ campaignId: id, state: checkpointState(600, 'epoch-1'), at: AT });
    if (!committed.ok) return;
    // The process dies here: no close, no cleanup, the WAL is left where it fell.
    store = new SqliteStore({ path });
    const replay = await store.settle(settleInput(id, 'epoch-1:result'));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.receiptId).toBe(committed.value.receiptId);
    const loaded = await store.loadCampaign(id);
    if (!loaded.ok) return;
    expect(loaded.value.campaign.credits).toBe(300);
    expect(loaded.value.settlements).toHaveLength(1);
    expect(loaded.value.checkpoints).toHaveLength(1);
    await store.close();
  });

  test('a process killed after a commit keeps the acknowledged checkpoint', async () => {
    const dir = scratch('killed');
    const path = join(dir, 'host.sqlite');
    const script = join(dir, 'killed-child.ts');
    const storeUrl = new URL('../src/server/persistence/sqlite-store.ts', import.meta.url).href;
    writeFileSync(script, `
import { SqliteStore } from ${JSON.stringify(storeUrl)};
const store = new SqliteStore({ path: process.env.DRIFT_DB });
const created = await store.createCampaign({ name: 'Killed', at: ${JSON.stringify(AT)} });
await store.writeCheckpoint({ campaignId: created.value.id, state: ${JSON.stringify(checkpointState(900, 'epoch-1'))}, at: ${JSON.stringify(AT)} });
process.kill(process.pid, 'SIGKILL');
`);
    const child = Bun.spawnSync({ cmd: [process.execPath, script], env: { ...process.env, DRIFT_DB: path }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode !== 0 || child.signalCode !== null).toBe(true);

    const reopened = new SqliteStore({ path, now: () => AT });
    const campaigns = await reopened.listCampaigns();
    expect(campaigns.ok).toBe(true);
    if (!campaigns.ok) return;
    expect(campaigns.value.map(campaign => campaign.name)).toEqual(['Killed']);
    const loaded = await reopened.loadCampaign(campaigns.value[0]!.id);
    if (!loaded.ok) return;
    expect(loaded.value.checkpoints.map(checkpoint => checkpoint.state.tick)).toEqual([900]);
    await reopened.close();
  });

  test('a corrupt checkpoint falls back to the previous verified one and keeps the bad bytes', async () => {
    const path = join(scratch('corrupt'), 'host.sqlite');
    const store = new SqliteStore({ path, now: () => AT });
    const created = await store.createCampaign({ name: 'Corrupt', at: AT });
    if (!created.ok) return;
    const id = created.value.id;
    for (const tick of [120, 240, 360]) await store.writeCheckpoint({ campaignId: id, state: checkpointState(tick, 'epoch-1'), at: AT });
    await store.close();

    const raw = new Database(path);
    raw.query("UPDATE checkpoints SET state = '{ not json' WHERE campaign_id = ? AND tick = 360").run(id);
    raw.close();

    const reopened = new SqliteStore({ path });
    const loaded = await reopened.loadCampaign(id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.checkpoints.map(checkpoint => checkpoint.state.tick)).toEqual([240, 120]);
    await reopened.close();

    const inspect = new Database(path);
    const rows = inspect.query('SELECT tick, verified FROM checkpoints WHERE campaign_id = ? ORDER BY tick').all(id) as { tick: number; verified: number }[];
    inspect.close();
    // The corrupt row is flagged, never deleted: it is evidence, not garbage.
    expect(rows).toEqual([{ tick: 120, verified: 1 }, { tick: 240, verified: 1 }, { tick: 360, verified: 0 }]);
  });

  test('a corrupt database file is quarantined and stays on disk', async () => {
    const dir = scratch('quarantine');
    const path = join(dir, 'host.sqlite');
    const store = new SqliteStore({ path });
    await store.createCampaign({ name: 'Broken', at: AT });
    await store.close();
    writeFileSync(path, 'this is not a sqlite database, it is a pile of bytes');

    const recovered = new SqliteStore({ path });
    const campaigns = await recovered.listCampaigns();
    expect(campaigns.ok).toBe(true);
    if (campaigns.ok) expect(campaigns.value).toEqual([]);
    await recovered.close();
    expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(true);
  });

  test('an older schema is backed up with VACUUM INTO before it is migrated', async () => {
    const dir = scratch('migrate');
    const path = join(dir, 'host.sqlite');
    const old = new Database(path);
    applyMigrations(old, 1);
    expect(readSchemaVersion(old)).toBe(1);
    old.close();

    const migrated = new SqliteStore({ path });
    const created = await migrated.createCampaign({ name: 'Migrated', at: AT });
    expect(created.ok).toBe(true);
    await migrated.close();

    expect(existsSync(`${path}.backup`)).toBe(true);
    const backup = new Database(`${path}.backup`);
    expect(readSchemaVersion(backup)).toBe(1);
    backup.close();
    const current = new Database(path);
    expect(readSchemaVersion(current)).toBe(SCHEMA_VERSION);
    current.close();
  });

  test('a save schema newer than this build is refused without touching the file', () => {
    const dir = scratch('future');
    const path = join(dir, 'host.sqlite');
    const db = new Database(path);
    applyMigrations(db);
    db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'from-the-future', '2027-01-01T00:00:00.000Z')").run();
    db.close();

    expect(() => new SqliteStore({ path })).toThrow();
    expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(false);
  });

  test('the checkpoint writer queue is bounded and coalesces an unstarted checkpoint', async () => {
    const store = new MemoryStore(() => AT);
    const ids: Id[] = [];
    for (let index = 0; index < 17; index++) {
      const created = await store.createCampaign({ name: `Queue ${index}`, at: AT });
      if (created.ok) ids.push(created.value.id);
    }
    const burst = ids.map((campaignId, index) => store.writeCheckpoint({ campaignId, state: checkpointState(index + 1, 'epoch-1'), at: AT }));
    const results = await Promise.all(burst);
    expect(results.filter(result => !result.ok && result.code === 'budget')).toHaveLength(1);

    const coalesceCampaign = await store.createCampaign({ name: 'Coalesce', at: AT });
    if (!coalesceCampaign.ok) return;
    const coalesced = await Promise.all([
      store.writeCheckpoint({ campaignId: coalesceCampaign.value.id, state: checkpointState(10, 'epoch-1'), at: AT }),
      store.writeCheckpoint({ campaignId: coalesceCampaign.value.id, state: checkpointState(20, 'epoch-1'), at: AT }),
    ]);
    expect(coalesced.every(result => result.ok)).toBe(true);
    if (!coalesced[0]!.ok || !coalesced[1]!.ok) return;
    expect(coalesced[1]!.value.checkpointId).toBe(coalesced[0]!.value.checkpointId);
    const loaded = await store.loadCampaign(coalesceCampaign.value.id);
    if (!loaded.ok) return;
    expect(loaded.value.checkpoints.map(checkpoint => checkpoint.state.tick)).toEqual([20]);
    await store.close();
  });

  test('export then import mints a new campaign id with identical content', async () => {
    const path = join(scratch('transfer'), 'host.sqlite');
    const store = new SqliteStore({ path, now: () => AT });
    const created = await store.createCampaign({ name: 'Exportable', at: AT });
    if (!created.ok) return;
    const id = created.value.id;
    await store.purchase({ campaignId: id, action: 'buy', itemId: 'gun-autocannon', cost: 30, expectedRevision: 1 });
    const settled = await store.settle(settleInput(id, 'epoch-1:result', { decisions: [{ decisionId: 'm4-shelter', optionId: 'shelter' }] }));
    const source = await store.loadCampaign(id);
    const bytes = await store.exportCampaign(id);
    expect(bytes.ok).toBe(true);
    if (!bytes.ok || !source.ok || !settled.ok) return;

    const imported = await store.importCampaign(bytes.value);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.campaignId).not.toBe(id);
    const copy = await store.loadCampaign(imported.value.campaignId);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.value.campaign.credits).toBe(source.value.campaign.credits);
    expect(copy.value.campaign.name).toBe('Exportable');
    expect(copy.value.inventory).toEqual(source.value.inventory);
    expect(copy.value.receipts).toEqual(source.value.receipts);
    expect(copy.value.settlements).toEqual(source.value.settlements);
    expect(copy.value.decisions).toEqual(source.value.decisions);
    await store.close();
  });

  test('import rejects an oversized bundle and a bundle that links outside itself', async () => {
    const store = new MemoryStore(() => AT);
    const oversized = await store.importCampaign(new Uint8Array(STORE_LIMITS.importBytes + 1));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe('budget');

    const linked = await store.importCampaign(bundle({ name: 'See https://evil.example/save.json' }));
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.code).toBe('unsupported');
    await store.close();
  });

  test('import rejects a bundle with a reset hash instead of trusting it', () => {
    const tampered = JSON.parse(new TextDecoder().decode(bundle({}))) as { hash: string };
    tampered.hash = '00000000';
    const decoded = decodeCampaignBundle(new TextEncoder().encode(JSON.stringify(tampered)));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.code).toBe('corrupt');
  });

  test('import rejects path traversal, a drive path and an executable member', async () => {
    const store = new MemoryStore(() => AT);
    const payload = new TextEncoder().encode(JSON.stringify({ format: 'drift-campaign' }));
    for (const name of ['../../campaign.json', 'C:/campaign.json', 'payload.exe']) {
      const archive = zipEntries([{ name, bytes: payload }, { name: 'campaign.json', bytes: payload }]);
      const result = await store.importCampaign(archive);
      expect(result.ok).toBe(false);
    }
    await store.close();
  });

  test('the import reader accepts a stored zip that carries a valid bundle', async () => {
    const store = new MemoryStore(() => AT);
    const archive = zipEntries([{ name: 'campaign.json', bytes: bundle({}) }]);
    const imported = await store.importCampaign(archive);
    expect(imported.ok).toBe(true);
    await store.close();
  });

  test('a truncated bundle is refused rather than parsed leniently', () => {
    const bytes = bundle({});
    expect(decodeCampaignBundle(bytes.slice(0, bytes.length - 8)).ok).toBe(false);
    expect(decodeCampaignBundle(new Uint8Array(0)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Offline session
// ---------------------------------------------------------------------------------------------

describe('offline session', () => {
  test('a lobby, match and debrief complete in a worker with no network', async () => {
    const session = new LocalSession({ storage: 'memory', pace: 'drain', matchSeconds: 1 });
    const events: SessionEvent[] = [];
    session.events(event => events.push(event));
    let published = 0;
    session.subscribe(() => {
      published += 1;
    });
    const controller = new AbortController();
    await session.connect({ transport: 'local', pilotName: 'Rook' }, controller.signal);
    expect(session.hostedOffThread).toBe(true);
    expect(session.view().phase).toBe('lobby');

    const edit = await session.command({ kind: 'edit-lobby', expectedRevision: revision(session), patch: { mode: 'team-deathmatch' } }, 'lobby-1');
    expect(edit.ok).toBe(true);
    const botFill = await session.command({ kind: 'bot-fill', expectedRevision: revision(session), total: 2, difficulty: 'normal' }, 'lobby-2');
    expect(botFill.ok).toBe(true);
    const ready = await session.command({ kind: 'ready', expectedRevision: revision(session), ready: true }, 'lobby-3');
    expect(ready.ok).toBe(true);
    const start = await session.command({ kind: 'start', expectedRevision: revision(session) }, 'lobby-4');
    expect(start.ok).toBe(true);

    const view = await viewWhere(session, current => current.phase === 'debrief', 30_000, 'debrief');
    expect(view.debrief).not.toBeNull();
    expect(view.save).toBe('saved');
    expect(view.epoch).not.toBeNull();
    expect(view.campaign?.id.startsWith('offline-')).toBe(true);
    // A memory namespace is not a device: the port must not claim a save it cannot reload.
    expect(view.campaign?.saveOwner).toBe('host');
    expect(events.some(event => event.kind === 'result')).toBe(true);
    expect(events.some(event => event.kind === 'save' && (event.payload as EventPayloadByKind['save']).state === 'saved')).toBe(true);
    expect(published).toBeGreaterThan(0);
    await session.dispose();
  }, 30_000);

  test('the offline shop charges once and reserves the instance to the pilot', async () => {
    const storage = new FlakyStorage();
    storage.healthy = true;
    const harness = await connectHost(storage);
    const part = CATALOG.partById.get('gun-autocannon')!;
    const bought = await harness.send({ kind: 'inventory', expectedRevision: 1, action: 'buy', itemId: 'gun-autocannon' }, 'shop-1');
    expect(bought.ok).toBe(true);
    const view = await harness.viewWhere(() => true, 5_000, 'shop view');
    expect(view.campaign?.credits).toBe(200 - part.cost * CAMPAIGN_START.shopPriceMultiplier);
    expect(view.campaign?.inventory).toEqual([
      { instanceId: 'inst-1-gun-autocannon', partId: 'gun-autocannon', health: 100, reservedByPilotId: 'pilot-' + hex8(hash32('Rook')) },
    ]);
    const stale = await harness.send({ kind: 'inventory', expectedRevision: 1, action: 'buy', itemId: 'gun-autocannon' }, 'shop-2');
    expect(stale.code).toBe('stale-revision');
  });

  test('a failed write blocks the debrief, and a retry after the device heals saves once', async () => {
    const storage = new FlakyStorage();
    const harness = await connectHost(storage);
    const lobby = await harness.map(hostCommands());
    expect(lobby.map(result => result.ok)).toEqual([true, true, true, true]);

    const blocked = await harness.viewWhere(current => current.phase === 'settlement' && current.save === 'failed', 30_000, 'failed save');
    // In-memory state survives the failed device, and the campaign does not advance.
    expect(blocked.campaign?.credits).toBe(200);
    expect(blocked.debrief).toBeNull();

    storage.healthy = true;
    const retry = await harness.send({ kind: 'recovery', action: 'retry-checkpoint' }, 'retry-1');
    expect(retry.ok).toBe(true);
    const saved = await harness.viewWhere(current => current.phase === 'debrief' && current.save === 'saved', 10_000, 'saved retry');
    expect(saved.save).toBe('saved');
    expect(storage.saved).toHaveLength(1);
    expect(storage.saved[0]!.settlements).toHaveLength(1);
    expect(storage.saved[0]!.campaign.credits).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function revision(session: LocalSession): number {
  return session.view().lobby?.revision ?? 0;
}

/** Resolves on the next published view that matches, so a test never sleeps on a guess. */
function viewWhere(session: LocalSession, predicate: (view: ClientView) => boolean, timeoutMs: number, label: string): Promise<ClientView> {
  const { promise, resolve, reject } = Promise.withResolvers<ClientView>();
  // The timer only fails a hung worker; the wait itself ends on a subscription signal.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const done = (view: ClientView): void => {
    if (timer !== null) clearTimeout(timer);
    off();
    resolve(view);
  };
  const off = session.subscribe(view => {
    if (predicate(view)) done(view);
  });
  const current = session.view();
  if (predicate(current)) done(current);
  else timer = setTimeout(() => reject(new Error(`no view matched ${label}`)), timeoutMs);
  return promise;
}

/** The offline lobby sequence: deathmatch, one bot, ready, start. Revisions follow the lobby rules. */
function hostCommands(): readonly Command[] {
  return [
    { kind: 'edit-lobby', expectedRevision: 1, patch: { mode: 'team-deathmatch' } },
    { kind: 'bot-fill', expectedRevision: 2, total: 2, difficulty: 'normal' },
    { kind: 'ready', expectedRevision: 3, ready: true },
    { kind: 'start', expectedRevision: 3 },
  ];
}

interface HostHarness {
  viewWhere(predicate: (view: ClientView) => boolean, timeoutMs: number, label: string): Promise<ClientView>;
  send(command: Command, requestId: Id): Promise<CommandResult>;
  map(commands: readonly Command[]): Promise<CommandResult[]>;
}

/** Drives the offline room in-process with an injected device, so a failing disk is testable. */
async function connectHost(storage: FlakyStorage): Promise<HostHarness> {
  const replies: HostReply[] = [];
  const waiters = new Set<(view: ClientView) => void>();
  const host: LocalHost = createLocalHost(reply => {
    replies.push(reply);
    if (reply.t !== 'view' && reply.t !== 'ready') return;
    for (const waiter of [...waiters]) waiter(reply.view);
  }, () => Date.now(), storage);
  const config: LocalConfig = { storage: 'memory', pace: 'drain', matchSeconds: 1, campaignId: null, campaignName: 'Quota' };
  await host.request({ t: 'connect', options: { transport: 'local', pilotName: 'Rook' }, config });

  const latest = (): ClientView => {
    for (let index = replies.length - 1; index >= 0; index--) {
      const reply = replies[index]!;
      if (reply.t === 'view' || reply.t === 'ready') return reply.view;
    }
    throw new Error('no view yet');
  };
  const viewWhere = async (predicate: (view: ClientView) => boolean, timeoutMs: number, label: string): Promise<ClientView> => {
    if (predicate(latest())) return latest();
    const { promise, resolve, reject } = Promise.withResolvers<ClientView>();
    // The timer only fails a hung room; the wait itself ends on the next posted view.
    let timer: ReturnType<typeof setTimeout>;
    const waiter = (view: ClientView): void => {
      if (!predicate(view)) return;
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(view);
    };
    timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`no view matched ${label}`));
    }, timeoutMs);
    waiters.add(waiter);
    return promise;
  };
  const send = async (command: Command, requestId: Id): Promise<CommandResult> => {
    await host.request({ t: 'command', requestId, command } satisfies HostRequest);
    for (let index = replies.length - 1; index >= 0; index--) {
      const reply = replies[index]!;
      if (reply.t === 'result' && reply.requestId === requestId) return reply.result;
    }
    throw new Error(`no result for ${requestId}`);
  };
  return {
    viewWhere,
    send,
    map: async commands => {
      const results: CommandResult[] = [];
      for (const [index, command] of commands.entries()) results.push(await send(command, `cmd-${index}`));
      return results;
    },
  };
}

class FlakyStorage implements OfflineStorage {
  readonly durable = false;
  healthy = false;
  readonly saved: CampaignSnapshot[] = [];
  private readonly inner = new Map<Id, CampaignSnapshot>();

  async load(namespace: Id): Promise<CampaignSnapshot | null> {
    return this.inner.get(namespace) ?? null;
  }

  async save(namespace: Id, snapshot: CampaignSnapshot): Promise<void> {
    if (!this.healthy) throw new Error('device is full or read-only');
    this.inner.set(namespace, snapshot);
    this.saved.push(snapshot);
  }

  async list(): Promise<readonly CampaignRecord[]> {
    return [...this.inner.values()].map(entry => entry.campaign);
  }
}

/** A campaign bundle for import tests: field overrides, then a hash computed over the result. */
function bundle(over: { inventory?: CampaignSnapshot['inventory']; name?: string }): Uint8Array {
  const snapshot: CampaignSnapshot = {
    campaign: { id: 'campaign-source', name: over.name ?? 'Imported', credits: 500, inventoryRevision: 3, createdAt: AT, lastSavedAt: AT },
    inventory: over.inventory ?? [],
    checkpoints: [],
    receipts: [],
    decisions: [],
    settlements: [],
  };
  const payload = { format: 'drift-campaign', saveSchema: SCHEMA_VERSION, contentVersion: 'quiet-signal-1', exportedAt: AT, ...snapshot };
  return new TextEncoder().encode(JSON.stringify({ ...payload, hash: bundleHash(payload) }));
}

/** Minimal stored zip: enough to prove the reader rejects an entry before it reads any data. */
function zipEntries(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const archive = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
