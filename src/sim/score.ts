/**
 * PvP score ledger and result resolution (Plan B7). The ledger is append-only and independent of
 * the present roster, so a pilot who leaves still appears in the debrief with the outcome they
 * earned. Result resolution is idempotent: it happens exactly once per match.
 */

import { PVP } from '../shared/balance.ts';
import type { Id } from '../shared/contracts.ts';

export interface DamageEvent {
  attackerPilotId: Id | null;
  victimPilotId: Id;
  tick: number;
  damage: number;
}

export interface PilotTally {
  pilotId: Id;
  teamId: Id;
  name: string;
  kills: number;
  assists: number;
  deaths: number;
  departed: boolean;
  score: number;
}

export interface ScoreLedger {
  teams: Id[];
  teamScores: Record<Id, number>;
  tallies: Map<Id, PilotTally>;
  damage: DamageEvent[];
  lastHostileDamageTick: Map<Id, number>;
  /** Fitted hull maximum per pilot, used only to scale the assist damage threshold. */
  hullMaxByPilot: Map<Id, number>;
  result: MatchResult | null;
  suddenDeathUntilTick: number | null;
}

export interface MatchResult {
  outcome: 'victory' | 'defeat' | 'draw' | 'no-contest' | 'mission-complete' | 'mission-failed';
  winningTeamId: Id | null;
}

export function createLedger(teams: readonly Id[]): ScoreLedger {
  const teamScores: Record<Id, number> = {};
  for (const teamId of teams) teamScores[teamId] = 0;
  return { teams: [...teams], teamScores, tallies: new Map(), damage: [], lastHostileDamageTick: new Map(), hullMaxByPilot: new Map(), result: null, suddenDeathUntilTick: null };
}

export function tallyFor(ledger: ScoreLedger, pilotId: Id, teamId: Id, name: string): PilotTally {
  const existing = ledger.tallies.get(pilotId);
  if (existing) {
    existing.teamId = teamId;
    existing.name = name;
    return existing;
  }
  const tally: PilotTally = { pilotId, teamId, name, kills: 0, assists: 0, deaths: 0, departed: false, score: 0 };
  ledger.tallies.set(pilotId, tally);
  return tally;
}

export function recordDamage(ledger: ScoreLedger, event: DamageEvent): void {
  if (event.damage <= 0) return;
  ledger.damage.push(event);
  if (event.attackerPilotId !== null) ledger.lastHostileDamageTick.set(event.victimPilotId, event.tick);
}

export interface KillOutcome {
  killerPilotId: Id | null;
  assists: Id[];
  /** True when the kill increased a team's score. */
  scored: boolean;
}

/**
 * Attribute a death. Environment and suicide score nothing unless a hostile damaged the victim
 * inside the credit window; the most recent eligible attacker takes the kill and everyone above the
 * damage threshold in that window takes an assist.
 */
export function attributeKill(
  ledger: ScoreLedger,
  victimPilotId: Id,
  victimTeamId: Id,
  tick: number,
): KillOutcome {
  const windowTicks = PVP.killCreditWindowS * 120;
  const victimMaxHull = victimHullScale(victimPilotId, ledger);
  const window = ledger.damage.filter(event => event.victimPilotId === victimPilotId && tick - event.tick <= windowTicks);
  const hostile = window.filter(event => {
    const attackerTeam = event.attackerPilotId === null ? null : teamOf(ledger, event.attackerPilotId);
    return attackerTeam !== null && attackerTeam !== victimTeamId;
  });
  const assists = new Set<Id>();
  for (const event of hostile) {
    if (event.attackerPilotId === null) continue;
    if (event.damage >= victimMaxHull * PVP.assistDamageFraction) assists.add(event.attackerPilotId);
  }
  const eligible = [...hostile].sort((a, b) => b.tick - a.tick);
  const killerPilotId = eligible[0]?.attackerPilotId ?? null;
  const victimTally = ledger.tallies.get(victimPilotId);
  if (victimTally) {
    victimTally.deaths += 1;
    victimTally.score = victimTally.kills - victimTally.deaths;
  }
  if (killerPilotId === null) return { killerPilotId: null, assists: [], scored: false };
  const killerTally = ledger.tallies.get(killerPilotId);
  if (killerTally) {
    killerTally.kills += 1;
    killerTally.score = killerTally.kills - killerTally.deaths;
  }
  assists.delete(killerPilotId);
  for (const assistant of assists) {
    const assistantTally = ledger.tallies.get(assistant);
    if (assistantTally) assistantTally.assists += 1;
  }
  const teamId = killerTally?.teamId ?? null;
  if (teamId === null || teamId === victimTeamId) return { killerPilotId, assists: [...assists], scored: false };
  ledger.teamScores[teamId] = (ledger.teamScores[teamId] ?? 0) + 1;
  return { killerPilotId, assists: [...assists], scored: true };
}

function teamOf(ledger: ScoreLedger, pilotId: Id): Id | null {
  return ledger.tallies.get(pilotId)?.teamId ?? null;
}

function victimHullScale(pilotId: Id, ledger: ScoreLedger): number {
  // The victim's fitted hull maximum is carried by the caller in the sim; the ledger only needs a
  // stable scale for the assist threshold, so an unknown pilot falls back to the Kestrel baseline.
  return ledger.hullMaxByPilot?.get(pilotId) ?? 110;
}

export interface ResolveContext {
  tick: number;
  matchEndsAtTick: number;
  activeTeams: readonly Id[];
  /** Teams with at least one connected, living-or-respawning human or bot. */
  teamsWithCombatants: readonly Id[];
}

/**
 * Evaluate the match at end of tick. All hits have already been applied for this tick, so a
 * simultaneous winning kill resolves on the same evaluation rather than a race.
 */
export function evaluateResult(ledger: ScoreLedger, context: ResolveContext): MatchResult | null {
  if (ledger.result) return ledger.result;
  const occupied = context.activeTeams.filter(teamId => context.teamsWithCombatants.includes(teamId));
  if (occupied.length === 0) {
    ledger.result = { outcome: 'no-contest', winningTeamId: null };
    return ledger.result;
  }
  if (occupied.length === 1 && context.activeTeams.length > 1) {
    ledger.result = { outcome: 'victory', winningTeamId: occupied[0]! };
    return ledger.result;
  }
  const ranked = [...context.activeTeams].sort((a, b) => (ledger.teamScores[b] ?? 0) - (ledger.teamScores[a] ?? 0));
  const best = ledger.teamScores[ranked[0]!] ?? 0;
  const tied = ranked.filter(teamId => (ledger.teamScores[teamId] ?? 0) === best);
  if (best >= PVP.scoreToWin && tied.length === 1) {
    ledger.result = { outcome: 'victory', winningTeamId: ranked[0]! };
    return ledger.result;
  }
  if (context.tick >= context.matchEndsAtTick) {
    if (tied.length === 1 && best > (ledger.teamScores[ranked[1]!] ?? 0)) {
      ledger.result = { outcome: 'victory', winningTeamId: ranked[0]! };
      return ledger.result;
    }
    if (ledger.suddenDeathUntilTick === null) {
      ledger.suddenDeathUntilTick = context.tick + PVP.suddenDeathS * 120;
      return null;
    }
    if (context.tick >= ledger.suddenDeathUntilTick) {
      ledger.result = tied.length === 1
        ? { outcome: 'victory', winningTeamId: tied[0]! }
        : { outcome: 'draw', winningTeamId: null };
      return ledger.result;
    }
  }
  return null;
}

export function departure(ledger: ScoreLedger, pilotId: Id): void {
  const tally = ledger.tallies.get(pilotId);
  if (tally) tally.departed = true;
}
