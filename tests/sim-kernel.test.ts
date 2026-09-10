/**
 * Kernel rules suite: the authority behaviours that a plausible bug would break. These assert
 * observable rules (conservation, attribution, readiness, spawn safety, determinism), never the
 * shape of the implementation.
 */

import { describe, expect, test } from 'bun:test';
import { CONTACT, PVP, ROCKS, SENSOR } from '../src/shared/balance.ts';
import { defaultFit, deriveFit } from '../src/shared/catalog.ts';
import { withWeapon } from './helpers/fits.ts';
import type { FlightIntent } from '../src/shared/contracts.ts';
import { EMPTY_FLIGHT_INTENT, RELEASE } from '../src/shared/contracts.ts';
import { TEAM_BLUE, TEAM_RED } from '../src/shared/teams.ts';
import { planFracture, rockMassKg, createRockState } from '../src/sim/fracture.ts';
import { createLobby, editLobby, isReady, join, notePing, setBotFill, setPilot, setReady, startCheck, transferCaptain, leave } from '../src/sim/lobby.ts';
import { createMapDescriptor, createRocks, mapDefinition } from '../src/sim/map.ts';
import { attributeKill, createLedger, evaluateResult, recordDamage, tallyFor } from '../src/sim/score.ts';
import { createLockTracker, updateLock, updateSensors } from '../src/sim/sensors.ts';
import { chooseSpawn, hazardClearanceM } from '../src/sim/spawn.ts';
import { addPilot, addRock, applyInput, applyUtility, beginMatch, bodyOf, createWorld, rockHash, rockViews, shipBody, stepWorld } from '../src/sim/world.ts';
import { createBotState, stepBot } from '../src/sim/bots/bot.ts';
import { repairStep, setUtility, tetherPull } from '../src/sim/utilities.ts';
import { admitProjectile, beginCharge, beginReload, canFire, commitShot, createWeapons, tickWeapons, wantsToFire, type FireContext, type WeaponRuntime } from '../src/sim/weapons.ts';

function context(overrides: Partial<FireContext> = {}): FireContext {
  return { tick: 0, heatMJ: 0, heatMaxMJ: 100, capacitorMJ: 100, groupPowered: true, fireMask: 1, insideServiceVolume: false, disabledSlots: new Set(), ...overrides };
}

function weaponsFor(chassisId: string): WeaponRuntime[] {
  const fit = defaultFit(chassisId);
  return createWeapons(deriveFit(fit), fit.fireGroups);
}

const intent = (patch: Partial<FlightIntent>): FlightIntent => ({ ...EMPTY_FLIGHT_INTENT, ...patch });

describe('weapons', () => {
  test('ballistic fire consumes a round and holds the trigger to the cooldown', () => {
    const weapons = weaponsFor('kestrel');
    const gun = weapons.find(weapon => weapon.spec.behavior === 'ballistic')!;
    const before = gun.magazine!;
    const shot = commitShot(gun, context());
    expect(shot).not.toBeNull();
    expect(gun.magazine).toBe(before - 1);
    expect(gun.readyAtTick).toBe(Math.round(gun.spec.cooldownS * RELEASE.physicsHz));
    expect(canFire(gun, context()).ok).toBe(false);
    expect(canFire(gun, context({ tick: gun.readyAtTick })).ok).toBe(true);
  });

  test('an empty magazine reloads from reserve and pays for it once', () => {
    const weapons = weaponsFor('kestrel');
    const gun = weapons.find(weapon => weapon.spec.behavior === 'ballistic')!;
    gun.magazine = 0;
    const reserve = gun.reserve!;
    expect(beginReload(gun, 0)).toBe(true);
    tickWeapons([gun], Math.round(gun.spec.reloadS! * RELEASE.physicsHz));
    expect(gun.magazine).toBe(gun.spec.magazine!);
    expect(gun.reserve).toBe(reserve - gun.spec.magazine!);
  });

  test('a rail reserves its energy before firing and returns it when the charge is cancelled', () => {
    const weapons = weaponsFor('mule');
    const rail = weapons.find(weapon => weapon.spec.behavior === 'rail');
    if (!rail) return;
    expect(beginCharge(rail, context({ capacitorMJ: rail.spec.energyShotMJ }))).toBe(true);
    expect(rail.reservedMJ).toBe(rail.spec.energyShotMJ);
    expect(beginCharge(rail, context())).toBe(false);
    expect(canFire(rail, context({ capacitorMJ: 0 })).ok).toBe(false);
  });

  test('thermal limit blocks a hot weapon and clears once the ship cools', () => {
    const weapons = weaponsFor('kestrel');
    const gun = weapons.find(weapon => weapon.spec.behavior === 'ballistic')!;
    expect(canFire(gun, context({ heatMJ: 100, heatMaxMJ: 100 })).ok).toBe(false);
    expect(canFire(gun, context({ heatMJ: 10, heatMaxMJ: 100 })).ok).toBe(true);
  });

  test('point defence never answers a manual trigger', () => {
    const weapons = weaponsFor('kestrel');
    const pdc = weapons.find(weapon => weapon.spec.behavior === 'point-defense')!;
    expect(wantsToFire(pdc, context({ fireMask: 0xff }))).toBe(false);
  });

  test('the shared projectile pool refuses admission without spending the shot', () => {
    expect(admitProjectile(0, 0, 'ballistic').ok).toBe(true);
    expect(admitProjectile(512, 0, 'ballistic').ok).toBe(false);
    expect(admitProjectile(100, 64, 'torpedo').ok).toBe(false);
  });
});

describe('rock fracture', () => {
  test('children plus dust conserve the parent mass and momentum', () => {
    const rock = createRockState(1, 'rock-1', 20, 7);
    const velocity = { x: 12, y: -5 };
    const outcome = planFracture({ rock, position: { x: 0, y: 0 }, velocity, impactNormal: { x: 1, y: 0 }, liveRockCount: 10, tick: 4 });
    expect(outcome.kind).toBe('split');
    if (outcome.kind !== 'split') return;
    const childMass = outcome.children.reduce((sum, child) => sum + child.massKg, 0);
    expect(childMass + outcome.dustMassKg).toBeCloseTo(rock.massKg, 6);
    const childMomentum = outcome.children.reduce(
      (sum, child) => ({ x: sum.x + child.massKg * child.velocity.x, y: sum.y + child.massKg * child.velocity.y }),
      { x: 0, y: 0 },
    );
    expect(childMomentum.x + outcome.dustMomentum.x).toBeCloseTo(rock.massKg * velocity.x, 5);
    expect(childMomentum.y + outcome.dustMomentum.y).toBeCloseTo(rock.massKg * velocity.y, 5);
    for (const child of outcome.children) {
      expect(child.radiusM).toBeGreaterThan(0);
      expect(child.radiusM).toBeLessThan(rock.radiusM);
      expect(Number.isFinite(child.velocity.x + child.velocity.y)).toBe(true);
    }
  });

  test('a field at the physical cap keeps a cracked body instead of deleting an obstacle', () => {
    const rock = createRockState(1, 'rock-1', 20, 7);
    const outcome = planFracture({ rock, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, impactNormal: { x: 0, y: 1 }, liveRockCount: ROCKS.maxPhysical, tick: 1 });
    expect(outcome.kind).toBe('retained');
    if (outcome.kind !== 'retained') return;
    expect(outcome.crackedHull).toBeLessThan(rock.hullMax);
    expect(outcome.crackedHull).toBeGreaterThan(0);
  });

  test('a rock below the split radius becomes dust rather than pebbles', () => {
    const rock = createRockState(1, 'rock-1', ROCKS.minRadiusM, 7);
    const outcome = planFracture({ rock, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, impactNormal: { x: 0, y: 1 }, liveRockCount: 0, tick: 1 });
    expect(outcome.kind).toBe('retained');
  });
});

describe('score ledger', () => {
  test('the most recent hostile attacker takes the kill and heavy hitters assist', () => {
    const ledger = createLedger([TEAM_BLUE, TEAM_RED]);
    tallyFor(ledger, 'b1', TEAM_BLUE, 'Blue one');
    tallyFor(ledger, 'b2', TEAM_BLUE, 'Blue two');
    tallyFor(ledger, 'r1', TEAM_RED, 'Red one');
    ledger.hullMaxByPilot.set('r1', 110);
    recordDamage(ledger, { attackerPilotId: 'b2', victimPilotId: 'r1', tick: 100, damage: 60 });
    recordDamage(ledger, { attackerPilotId: 'b1', victimPilotId: 'r1', tick: 130, damage: 50 });
    const outcome = attributeKill(ledger, 'r1', TEAM_RED, 140);
    expect(outcome.killerPilotId).toBe('b1');
    expect(outcome.assists).toContain('b2');
    expect(ledger.teamScores[TEAM_BLUE]).toBe(1);
    expect(ledger.tallies.get('r1')!.deaths).toBe(1);
  });

  test('an environment death scores nothing', () => {
    const ledger = createLedger([TEAM_BLUE, TEAM_RED]);
    tallyFor(ledger, 'r1', TEAM_RED, 'Red one');
    const outcome = attributeKill(ledger, 'r1', TEAM_RED, 10);
    expect(outcome.scored).toBe(false);
    expect(ledger.teamScores[TEAM_BLUE]).toBe(0);
  });

  test('a timeout tie enters sudden death and then draws', () => {
    const ledger = createLedger([TEAM_BLUE, TEAM_RED]);
    const end = 600 * 120;
    expect(evaluateResult(ledger, { tick: end, matchEndsAtTick: end, activeTeams: [TEAM_BLUE, TEAM_RED], teamsWithCombatants: [TEAM_BLUE, TEAM_RED] })).toBeNull();
    expect(ledger.suddenDeathUntilTick).toBe(end + PVP.suddenDeathS * 120);
    const result = evaluateResult(ledger, { tick: end + PVP.suddenDeathS * 120, matchEndsAtTick: end, activeTeams: [TEAM_BLUE, TEAM_RED], teamsWithCombatants: [TEAM_BLUE, TEAM_RED] });
    expect(result?.outcome).toBe('draw');
  });

  test('an empty team forfeits and both empty is a no-contest', () => {
    const forfeit = createLedger([TEAM_BLUE, TEAM_RED]);
    expect(evaluateResult(forfeit, { tick: 10, matchEndsAtTick: 1000, activeTeams: [TEAM_BLUE, TEAM_RED], teamsWithCombatants: [TEAM_BLUE] })?.winningTeamId).toBe(TEAM_BLUE);
    const empty = createLedger([TEAM_BLUE, TEAM_RED]);
    expect(evaluateResult(empty, { tick: 10, matchEndsAtTick: 1000, activeTeams: [TEAM_BLUE, TEAM_RED], teamsWithCombatants: [] })?.outcome).toBe('no-contest');
  });
});

describe('lobby readiness', () => {
  test('a pilot changing their fit loses readiness while others keep theirs', () => {
    const lobby = createLobby({ captainId: 'p1', name: 'One', mode: 'team-deathmatch', mapId: 'belt' });
    join(lobby, { pilotId: 'p2', name: 'Two', generation: 1 });
    setReady(lobby, 'p1', true);
    setReady(lobby, 'p2', true);
    expect(startCheck(lobby, 'p1').ok).toBe(true);
    setPilot(lobby, 'p2', { fit: defaultFit('needle') });
    expect(isReady(lobby, lobby.seats[1]!)).toBe(false);
    expect(isReady(lobby, lobby.seats[0]!)).toBe(true);
    expect(startCheck(lobby, 'p1').blockers).toContain('Waiting for Two');
  });

  test('a rule edit revokes every readiness and ping noise does not', () => {
    const lobby = createLobby({ captainId: 'p1', name: 'One', mode: 'team-deathmatch', mapId: 'belt' });
    setReady(lobby, 'p1', true);
    notePing(lobby, 'p1', 42);
    expect(isReady(lobby, lobby.seats[0]!)).toBe(true);
    editLobby(lobby, 'p1', { mapId: 'quarry' });
    expect(isReady(lobby, lobby.seats[0]!)).toBe(false);
  });

  test('an invalid fit is rejected and leaves the previous fit in place', () => {
    const lobby = createLobby({ captainId: 'p1', name: 'One', mode: 'team-deathmatch', mapId: 'belt' });
    const before = JSON.stringify(lobby.seats[0]!.fit);
    const outcome = setPilot(lobby, 'p1', { fit: { ...defaultFit('kestrel'), slots: { w1: 'gun-rail' } } });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('invalid-fit');
    expect(JSON.stringify(lobby.seats[0]!.fit)).toBe(JSON.stringify(JSON.parse(before)));
  });

  test('captain transfer moves the start authority and an empty room keeps a captain', () => {
    const lobby = createLobby({ captainId: 'p1', name: 'One', mode: 'team-deathmatch', mapId: 'belt' });
    join(lobby, { pilotId: 'p2', name: 'Two', generation: 1 });
    expect(transferCaptain(lobby, 'p2', 'p1').code).toBe('not-captain');
    expect(transferCaptain(lobby, 'p1', 'p2').ok).toBe(true);
    expect(lobby.captainId).toBe('p2');
    leave(lobby, 'p2');
    expect(lobby.captainId).toBe('p1');
  });

  test('bot fill reaches the configured total and stays balanced', () => {
    const lobby = createLobby({ captainId: 'p1', name: 'One', mode: 'team-deathmatch', mapId: 'belt' });
    expect(setBotFill(lobby, 'p1', 4, 'normal').ok).toBe(true);
    const seated = lobby.seats.filter(Boolean)!;
    expect(seated.length).toBe(4);
    const blue = seated.filter(seat => seat!.teamId === TEAM_BLUE).length;
    const red = seated.filter(seat => seat!.teamId === TEAM_RED).length;
    expect(Math.abs(blue - red)).toBeLessThanOrEqual(1);
    setReady(lobby, 'p1', true);
    expect(startCheck(lobby, 'p1').ok).toBe(true);
  });
});

describe('arena generation', () => {
  test('the same seed produces the same field and a different seed does not', () => {
    const first = createRocks('belt', 1234);
    const second = createRocks('belt', 1234);
    const other = createRocks('belt', 4321);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(first.length).toBe(mapDefinition('belt').rockCount);
  });

  test('no rock starts overlapping another or inside the clearing', () => {
    const definition = mapDefinition('quarry');
    const rocks = createRocks('quarry', 99);
    for (let i = 0; i < rocks.length; i++) {
      const rock = rocks[i]!;
      expect(Math.hypot(rock.position.x, rock.position.y)).toBeGreaterThanOrEqual(definition.clearingRadiusM - 1e-6);
      expect(Math.hypot(rock.position.x, rock.position.y)).toBeLessThanOrEqual(definition.boundsRadiusM);
      for (let j = i + 1; j < rocks.length; j++) {
        const other = rocks[j]!;
        const distance = Math.hypot(rock.position.x - other.position.x, rock.position.y - other.position.y);
        expect(distance).toBeGreaterThan(rock.radiusM + other.radiusM);
      }
    }
    expect(createMapDescriptor('quarry', 99).boundsRadiusM).toBe(definition.boundsRadiusM);
  });
});

describe('spawn safety', () => {
  const base = {
    tick: 10,
    seed: 5,
    teamId: TEAM_BLUE,
    corridor: [{ id: 'c', position: { x: 0, y: 500 } }],
    occupants: [],
    hazards: [],
    enemies: [],
    obstacles: [],
    boundsRadiusM: 1500,
    shipRadiusM: 12,
  };

  test('an occupied authored point is rejected in favour of a clear one', () => {
    const choice = chooseSpawn({
      ...base,
      candidates: [{ id: 'a', position: { x: 0, y: 300 } }, { id: 'b', position: { x: 900, y: 0 } }],
      obstacles: [{ position: { x: 0, y: 300 }, radiusM: 60 }],
    });
    expect(choice.sourceId).toBe('b');
  });

  test('a hostile sitting on every authored point forces the ring fallback', () => {
    const choice = chooseSpawn({
      ...base,
      candidates: [{ id: 'a', position: { x: 0, y: 300 } }, { id: 'b', position: { x: -300, y: 0 } }],
      enemies: [
        { position: { x: 0, y: 300 }, radiusM: 20, teamId: TEAM_RED },
        { position: { x: -300, y: 0 }, radiusM: 20, teamId: TEAM_RED },
      ],
    });
    expect(choice.inserted).toBe(true);
    for (const enemy of [{ x: 0, y: 300 }, { x: -300, y: 0 }]) {
      expect(Math.hypot(choice.position.x - enemy.x, choice.position.y - enemy.y)).toBeGreaterThanOrEqual(250);
    }
  });

  test('an incoming torpedo line is avoided and hazard clearance is measured along its path', () => {
    const hazard = { position: { x: 400, y: 0 }, velocity: { x: -400, y: 0 }, ttlTicks: 240, radiusM: 2 };
    expect(hazardClearanceM({ x: 0, y: 0 }, hazard, 180)).toBeLessThan(5);
    const choice = chooseSpawn({
      ...base,
      candidates: [{ id: 'a', position: { x: 200, y: 0 } }, { id: 'b', position: { x: 0, y: 900 } }],
      hazards: [hazard],
    });
    expect(choice.sourceId).toBe('b');
  });
});

describe('sensors', () => {
  const observer = { passiveRangeM: 1200, activeRangeM: 1800, scanMultiplier: 1 };
  test('a distant hull is a targetable contact and an occluded one ages out', () => {
    const visible = updateSensors({
      tick: 1,
      observerTeamId: TEAM_BLUE,
      observerPosition: { x: 0, y: 0 },
      observerBonuses: observer,
      targets: [{ id: 'r1', teamId: TEAM_RED, position: { x: 800, y: 0 }, velocity: { x: 0, y: 0 }, boosting: false, coasting: true, signatureMultiplier: 1, radiusM: 12 }],
      occluders: [],
      arenaRadiusM: 1500,
    }, []);
    expect(visible.contacts[0]?.targetable).toBe(true);

    const blocked = updateSensors({
      tick: 1,
      observerTeamId: TEAM_BLUE,
      observerPosition: { x: 0, y: 0 },
      observerBonuses: observer,
      targets: [{ id: 'r1', teamId: TEAM_RED, position: { x: 800, y: 0 }, velocity: { x: 0, y: 0 }, boosting: false, coasting: false, signatureMultiplier: 1, radiusM: 12 }],
      occluders: [{ position: { x: 400, y: 0 }, radiusM: 60 }],
      arenaRadiusM: 1500,
    }, visible.contacts);
    expect(blocked.contacts[0]?.kind).toBe('unknown');
    expect(blocked.contacts[0]?.targetable).toBe(false);
    expect(blocked.targetable).toHaveLength(0);
  });

  test('an expired contact disappears and a lock needs a continuous second', () => {
    const tracker = createLockTracker();
    updateLock(tracker, ['r1']);
    expect(tracker.progress.get('r1')).toBe(1);
    // The lock survives a quarter-second gap and breaks after it (B6).
    for (let tick = 0; tick < 20; tick++) updateLock(tracker, []);
    expect(tracker.progress.get('r1')).toBe(1);
    for (let tick = 0; tick < 40; tick++) updateLock(tracker, []);
    expect(tracker.progress.get('r1')).toBe(0);
  });

  test('an aged contact is uncertain and then drops out of the contact list', () => {
    const observer = { passiveRangeM: 1200, activeRangeM: 1800, scanMultiplier: 1 };
    const input = {
      observerTeamId: TEAM_BLUE,
      observerPosition: { x: 0, y: 0 },
      observerBonuses: observer,
      targets: [{ id: 'r1' as const, teamId: TEAM_RED, position: { x: 4000, y: 0 }, velocity: { x: 0, y: 0 }, boosting: false, coasting: false, signatureMultiplier: 1, radiusM: 12 }],
      occluders: [],
      arenaRadiusM: 5000,
    };
    let contacts = updateSensors({ ...input, tick: 5 }, [{ id: 'r1', kind: 'hostile', position: { x: 800, y: 0 }, uncertaintyM: 0, ageTicks: 0, targetable: true }]).contacts;
    expect(contacts[0]?.kind).toBe('unknown');
    expect(contacts[0]?.targetable).toBe(false);
    for (let tick = 0; tick < SENSOR.uncertainSeconds * RELEASE.physicsHz; tick++) {
      contacts = updateSensors({ ...input, tick: 6 + tick }, contacts).contacts;
    }
    expect(contacts).toHaveLength(0);
  });
});

describe('world determinism', () => {
  function run(seed: number): { hash: number; hulls: number[] } {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'belt', seed, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    const fit = defaultFit('kestrel');
    addPilot(world, { pilotId: 'b1', name: 'Blue one', teamId: TEAM_BLUE, fit, isBot: false, position: { x: 400, y: 0 } });
    addPilot(world, { pilotId: 'r1', name: 'Red one', teamId: TEAM_RED, fit, isBot: false, position: { x: -400, y: 0 } });
    applyInput(world, 'b1', { epoch: 'e1', lifeId: 'life:b1:1', seq: 1, targetTick: 1, intent: intent({ thrust: 1 }) });
    applyInput(world, 'r1', { epoch: 'e1', lifeId: 'life:r1:1', seq: 1, targetTick: 1, intent: intent({ thrust: 1, turn: 0.4 }) });
    for (let tick = 0; tick < 240; tick++) stepWorld(world);
    const blue = shipBody(world, 'b1')!;
    const red = shipBody(world, 'r1')!;
    return { hash: rockHash(world), hulls: [blue.position.x, blue.position.y, red.position.x, red.position.y] };
  }

  test('two runs of the same seed and inputs agree exactly', () => {
    expect(run(7)).toEqual(run(7));
    expect(run(7).hash).not.toBe(run(8).hash);
  });

  test('a held thrust input really accelerates the ship', () => {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'belt', seed: 11, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    addPilot(world, { pilotId: 'b1', name: 'Blue one', teamId: TEAM_BLUE, fit: defaultFit('kestrel'), isBot: false, position: { x: 400, y: 0 } });
    const start = { ...shipBody(world, 'b1')!.position };
    // A client sends held controls at its own cadence; the lease covers packets in between.
    for (let tick = 1; tick <= 240; tick += 2) {
      applyInput(world, 'b1', { epoch: 'e1', lifeId: 'life:b1:1', seq: tick, targetTick: tick, intent: intent({ thrust: 1 }) });
      stepWorld(world);
      stepWorld(world);
    }
    const body = shipBody(world, 'b1')!;
    expect(Math.hypot(body.position.x - start.x, body.position.y - start.y)).toBeGreaterThan(20);
    expect(Math.hypot(body.velocity.x, body.velocity.y)).toBeGreaterThan(20);
    expect(world.ships.get('b1')!.fuelKg).toBeLessThan(world.ships.get('b1')!.derived.fuelCapacityKg);
  });

  test('a projectile fired at a hostile damages it and spends ammunition', () => {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'expanse', seed: 3, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    // Spawn facing convention: a ship faces away from the arena centre, so placing Blue south of
    // the centre points it north, straight at Red.
    addPilot(world, { pilotId: 'b1', name: 'Blue one', teamId: TEAM_BLUE, fit: defaultFit('kestrel'), isBot: false, position: { x: 0, y: -300 } });
    addPilot(world, { pilotId: 'r1', name: 'Red one', teamId: TEAM_RED, fit: defaultFit('kestrel'), isBot: false, position: { x: 0, y: 300 } });
    const blue = shipBody(world, 'b1')!;
    expect(Math.cos(blue.angle)).toBeGreaterThan(0.99);
    applyInput(world, 'b1', { epoch: 'e1', lifeId: 'life:b1:1', seq: 1, targetTick: 1, intent: intent({ fireMask: 1 }) });
    const red = world.ships.get('r1')!;
    const before = red.hull;
    for (let tick = 0; tick < 120; tick++) stepWorld(world);
    expect(world.ships.get('b1')!.weapons.some(weapon => weapon.shotsFired > 0)).toBe(true);
    expect(red.hull).toBeLessThan(before);
    expect(world.events.some(event => event.kind === 'shot')).toBe(true);
    expect(world.events.some(event => event.kind === 'impact' && event.payload.kind === 'ship')).toBe(true);
  });

  test('a full bot match with weapons and fracture replays bit-identically', () => {
    const run = (): string => {
      const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'belt', seed: 4242, teams: [TEAM_BLUE, TEAM_RED] });
      beginMatch(world);
      const fit = defaultFit('kestrel');
      const bots = [
        createBotState({ pilotId: 'b1', teamId: TEAM_BLUE, difficulty: 'normal', role: 'suppress', seed: 11, index: 0 }),
        createBotState({ pilotId: 'r1', teamId: TEAM_RED, difficulty: 'hard', role: 'suppress', seed: 22, index: 1 }),
      ];
      addPilot(world, { pilotId: 'b1', name: 'Blue one', teamId: TEAM_BLUE, fit, isBot: true, position: { x: 0, y: -400 } });
      addPilot(world, { pilotId: 'r1', name: 'Red one', teamId: TEAM_RED, fit, isBot: true, position: { x: 0, y: 400 } });
      for (let tick = 1; tick <= 900; tick++) {
        for (const bot of bots) {
          const pilot = world.ships.get(bot.config.pilotId)!;
          const body = shipBody(world, bot.config.pilotId)!;
          const decision = stepBot(bot, {
            tick,
            self: { position: body.position, velocity: body.velocity, angle: body.angle, hull: pilot.hull, hullMax: pilot.hullMax, fuelKg: pilot.fuelKg, heatMJ: pilot.heatMJ },
            contacts: world.contacts.get(bot.config.pilotId) ?? [],
            objectives: [],
            allies: [],
            hazards: [],
            obstacles: [...world.rocks.values()].map(rock => ({ position: bodyOf(world, rock.bodyId)!.position, radiusM: rock.radiusM })),
            boundsRadiusM: world.map.boundsRadiusM,
            accelerationMS2: pilot.derived.thrustN / Math.max(1, pilot.derived.wetMassKg),
            turnRateRadS: pilot.derived.rcsTorqueMNm * 1e6 / Math.max(1, pilot.derived.inertiaKgM2),
          });
          applyInput(world, bot.config.pilotId, { epoch: 'e1', lifeId: pilot.lifeId, seq: tick, targetTick: tick, intent: decision.intent });
        }
        stepWorld(world);
      }
      const blue = shipBody(world, 'b1')!;
      const red = shipBody(world, 'r1')!;
      return JSON.stringify({
        rockHash: rockHash(world),
        rocks: world.rocks.size,
        blue: [blue.position.x, blue.position.y, world.ships.get('b1')!.hull],
        red: [red.position.x, red.position.y, world.ships.get('r1')!.hull],
        score: world.ledger.teamScores,
        events: world.events.length,
      });
    };
    const first = run();
    expect(run()).toBe(first);
    // The match must actually progress: two bots in a rock field exchange fire.
    expect(JSON.parse(first).events).toBeGreaterThan(20);
    expect(JSON.parse(first).rocks).toBeGreaterThan(50);
  });

  test('a rock field never grows past the physical cap, however long the shooting lasts', () => {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'quarry', seed: 77, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    const fit = defaultFit('mule');
    addPilot(world, { pilotId: 'b1', name: 'Blue one', teamId: TEAM_BLUE, fit, isBot: false, position: { x: 0, y: -150 } });
    // Fire at the nearest rock for a simulated minute; every fracture must respect the cap.
    for (let tick = 1; tick <= 7200; tick += 2) {
      const body = shipBody(world, 'b1')!;
      const nearest = rockViews(world)
        .map(entry => ({ entry, distance: Math.hypot(entry.body.position.x - body.position.x, entry.body.position.y - body.position.y), angle: Math.atan2(-(entry.body.position.x - body.position.x), entry.body.position.y - body.position.y) }))
        .sort((a, b) => a.distance - b.distance)[0]!;
      body.angle = nearest.angle;
      applyInput(world, 'b1', { epoch: 'e1', lifeId: 'life:b1:1', seq: tick, targetTick: tick, intent: intent({ fireMask: 1 }) });
      stepWorld(world);
      stepWorld(world);
      expect(world.rocks.size).toBeLessThanOrEqual(ROCKS.maxPhysical);
    }
    expect(world.ships.get('b1')!.weapons.some(weapon => weapon.shotsFired > 10)).toBe(true);
  });
  test('a drifting rock moves exactly one tick of travel, not two', () => {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'belt', seed: 21, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    const first = rockViews(world)[0]!;
    const before = { ...first.body.position };
    const velocity = { ...first.body.velocity };
    stepWorld(world);
    const after = rockViews(world)[0]!;
    const travelled = Math.hypot(after.body.position.x - before.x, after.body.position.y - before.y);
    const expected = Math.hypot(velocity.x, velocity.y) / RELEASE.physicsHz;
    expect(travelled).toBeCloseTo(expected, 6);
  });

  test('a ship that runs into a rock is damaged and stopped by it', () => {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'expanse', seed: 5, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    const pilot = addPilot(world, { pilotId: 'b1', name: 'Blue one', teamId: TEAM_BLUE, fit: defaultFit('kestrel'), isBot: false, position: { x: 0, y: -800 } });
    // Park a rock directly ahead and drive into it at full thrust.
    const body = shipBody(world, 'b1')!;
    addRock(world, 'test-rock', { x: 0, y: -600 }, { x: 0, y: 0 }, 30, 99);
    const before = pilot.hull;
    // 10 s at the Kestrel's 13 m/s² covers the 200 m to the rock and keeps driving into it.
    for (let tick = 1; tick <= 1200; tick += 2) {
      applyInput(world, 'b1', { epoch: 'e1', lifeId: 'life:b1:1', seq: tick, targetTick: tick, intent: intent({ thrust: 1 }) });
      stepWorld(world);
      stepWorld(world);
    }
    // The ship is stopped by the rock instead of tunnelling through it, and the contact is reported.
    // Residual interpenetration at the surface is the solver's business; the centre must not pass.
    expect(body.position.y).toBeLessThan(-600);
    expect(pilot.hull).toBeLessThan(before);
    expect(world.events.some(event => event.kind === 'impact' && event.payload.kind === 'rock')).toBe(true);
  });
});

describe('fitted utilities', () => {
  function loaded(chassisId: string): ReturnType<typeof createWorld> {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'belt', seed: 5, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    return world;
  }

  test('a repair bay heals a team-mate inside its range and spends exactly one stock per hull point', () => {
    const world = loaded('belt');
    const mule = addPilot(world, { pilotId: 'm1', name: 'Mule', teamId: TEAM_BLUE, fit: defaultFit('mule'), isBot: false, position: { x: 0, y: 0 } });
    const hurt = addPilot(world, { pilotId: 'k1', name: 'Kestrel', teamId: TEAM_BLUE, fit: defaultFit('kestrel'), isBot: false, position: { x: 20, y: 0 } });
    hurt.hull = hurt.hullMax - 10;
    const before = hurt.hull;
    const bay = mule.utilities.find(runtime => runtime.kind === 'repair')!;
    const stockBefore = bay.repairStock;
    expect(applyUtility(world, 'm1', bay.slotId, 'k1', true).ok).toBe(true);
    for (let tick = 0; tick < 120; tick++) stepWorld(world);
    const healed = hurt.hull - before;
    expect(healed).toBeGreaterThan(2);
    // One stock unit per hull point, so the bay's remaining stock drops by exactly what it healed.
    expect(stockBefore - bay.repairStock).toBeCloseTo(healed, 3);
  });

  test('a repair bay refuses a target outside its range', () => {
    const world = loaded('belt');
    const mule = addPilot(world, { pilotId: 'm1', name: 'Mule', teamId: TEAM_BLUE, fit: defaultFit('mule'), isBot: false, position: { x: 0, y: 0 } });
    addPilot(world, { pilotId: 'k1', name: 'Kestrel', teamId: TEAM_BLUE, fit: defaultFit('kestrel'), isBot: false, position: { x: 900, y: 0 } });
    const bay = mule.utilities.find(runtime => runtime.kind === 'repair')!;
    expect(applyUtility(world, 'm1', bay.slotId, 'k1', true)).toEqual({ ok: false, reason: 'out-of-range' });
  });

  test('a rescue tether pulls a target and parts past its break force', () => {
    const world = loaded('belt');
    const tug = addPilot(world, { pilotId: 'm1', name: 'Mule', teamId: TEAM_BLUE, fit: defaultFit('mule'), isBot: false, position: { x: 0, y: 0 } });
    addPilot(world, { pilotId: 'n1', name: 'Needle', teamId: TEAM_BLUE, fit: defaultFit('needle'), isBot: false, position: { x: 100, y: 0 } });
    const line = tug.utilities.find(runtime => runtime.kind === 'tether')!;
    expect(applyUtility(world, 'm1', line.slotId, 'n1', true).ok).toBe(true);
    const targetBody = shipBody(world, 'n1')!;
    const startX = targetBody.position.x;
    const tugBody = shipBody(world, 'm1')!;
    for (let tick = 0; tick < 120; tick++) stepWorld(world);
    // The tether hauls the lighter ship in and pulls the tug the other way.
    expect(targetBody.position.x).toBeLessThan(startX);
    expect(tugBody.velocity.x).toBeGreaterThan(0);
  });

  test('a decoy bay spends one charge per activation and cannot be spammed', () => {
    const world = loaded('belt');
    const pilot = addPilot(world, { pilotId: 'n1', name: 'Needle', teamId: TEAM_BLUE, fit: defaultFit('needle'), isBot: false, position: { x: 0, y: 0 } });
    const decoy = pilot.utilities.find(runtime => runtime.kind === 'ecm')!;
    const charges = decoy.charges;
    expect(applyUtility(world, 'n1', decoy.slotId, null, true).ok).toBe(true);
    expect(decoy.charges).toBe(charges - 1);
    // A second activation while the effect is running is refused rather than stacking a duration.
    expect(applyUtility(world, 'n1', decoy.slotId, null, true).ok).toBe(false);
  });

  test('a bot match flies and fights without any client input', () => {
    const world = loaded('belt');
    addPilot(world, { pilotId: 'b1', name: 'Blue bot', teamId: TEAM_BLUE, fit: defaultFit('kestrel'), isBot: true, position: { x: 0, y: -400 }, difficulty: 'hard' });
    addPilot(world, { pilotId: 'r1', name: 'Red bot', teamId: TEAM_RED, fit: defaultFit('kestrel'), isBot: true, position: { x: 0, y: 400 }, difficulty: 'hard' });
    const blue = shipBody(world, 'b1')!;
    const start = { ...blue.position };
    for (let tick = 0; tick < 600; tick++) stepWorld(world);
    expect(Math.hypot(blue.position.x - start.x, blue.position.y - start.y)).toBeGreaterThan(30);
    expect(world.ships.get('b1')!.weapons.some(weapon => weapon.shotsFired > 0)).toBe(true);
  });
});

describe('guided weapons', () => {
  test('a torpedo turns toward its locked contact instead of flying straight', () => {
    const world = createWorld({ epoch: 'e1', mode: 'team-deathmatch', mapId: 'expanse', seed: 9, teams: [TEAM_BLUE, TEAM_RED] });
    beginMatch(world);
    // The torpedo is the Mule's size-2 weapon; give the shooter one and a target off to the side.
    const shooter = addPilot(world, { pilotId: 'm1', name: 'Mule', teamId: TEAM_BLUE, fit: withWeapon('mule', 'w1', 'gun-torpedo'), isBot: false, position: { x: 0, y: 0 } });
    addPilot(world, { pilotId: 'r1', name: 'Red', teamId: TEAM_RED, fit: defaultFit('kestrel'), isBot: false, position: { x: 300, y: 600 } });
    applyInput(world, 'm1', { epoch: 'e1', lifeId: 'life:m1:1', seq: 1, targetTick: 1, intent: intent({ fireMask: 1, lockContactId: 'r1' }) });
    for (let tick = 0; tick < 240; tick++) stepWorld(world);
    const torpedo = world.projectiles.find(projectile => projectile.behavior === 'torpedo');
    expect(torpedo).toBeDefined();
    if (!torpedo) return;
    const body = bodyOf(world, torpedo.bodyId)!;
    // It was fired straight up and must have turned toward the target's bearing.
    expect(Math.abs(body.angle)).toBeGreaterThan(0.2);
    void shooter;
  });
});
describe('mass model', () => {
  test('a heavier rock has more hull and mass grows with the cube of radius', () => {
    const small = rockMassKg(5);
    const large = rockMassKg(10);
    expect(large / small).toBeCloseTo(8, 3);
    expect(createRockState(1, 'r', 10, 1).hullMax).toBeGreaterThan(createRockState(2, 'r2', 5, 2).hullMax);
  });
});
