/**
 * Fit derivation for the UI (Plan A4). The wire carries only the `DerivedFit` summary, so a screen
 * that needs full detail (weapon slots, sensor ranges, utilities) runs the *same* shared function
 * the authority ran and caches the result by fit hash. One derivation per fit revision, never per
 * frame, and never a second arithmetic path that could disagree with the server.
 */

import type { Fit, FitDerivation, ShipView } from '../shared/contracts.ts';
import { deriveFit, fitHash } from '../shared/catalog.ts';

/** Bounded so a long session cannot retain every build a pilot ever previewed. */
const CACHE_LIMIT = 32;
const cache = new Map<string, FitDerivation>();

export function derivationOf(fit: Fit): FitDerivation {
  const key = fitHash(fit);
  const cached = cache.get(key);
  if (cached) return cached;
  const derived = deriveFit(fit);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, derived);
  return derived;
}

export function derivationOfShip(ship: ShipView): FitDerivation {
  return derivationOf(ship.fit);
}

export function clearDerivationCache(): void {
  cache.clear();
}
