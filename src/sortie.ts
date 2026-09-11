import type { ShipState } from './physics';

export type CombatTarget = { state: ShipState; faction: 0 | 1 };

/** The same roster drives projectile collision for the player, enemies and escorted vessels. */
export function combatTargets(player: ShipState, hostiles: { state: ShipState }[], allies: { state: ShipState; lost: boolean }[], out: CombatTarget[] = []): CombatTarget[] {
  out.length = 0;
  if (player.hull > 0) out.push({ state: player, faction: 0 });
  for (const hostile of hostiles) if (hostile.state.hull > 0) out.push({ state: hostile.state, faction: 1 });
  for (const ally of allies) if (!ally.lost && ally.state.hull > 0) out.push({ state: ally.state, faction: 0 });
  return out;
}

/** Contract totals already contain the bonus. Split that total for the debrief without paying twice. */
export function sortieEarnings(base: number, total: number, ore: number, bounty: number) {
  return { payout: base, bonus: Math.max(0, total - base), ore, bounty };
}
