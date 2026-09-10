/** Shared test fixtures for fitted ships, so suites do not each rebuild the same derivation. */

import { CATALOG, defaultFit, deriveFit, type PartSpec } from '../../src/shared/catalog.ts';
import type { Fit, FitDerivation, Id } from '../../src/shared/contracts.ts';

export function fitFor(chassisId: Id): Fit {
  return defaultFit(chassisId);
}

export function derivedFitFor(chassisId: Id): FitDerivation {
  const derived = deriveFit(fitFor(chassisId));
  if (!derived.valid) throw new Error(`test fixture fit is invalid: ${derived.errors.join(', ')}`);
  return derived;
}

/** A fit with one slot replaced, validated by the caller's expectation. */
export function fitWith(chassisId: Id, slotId: Id, partId: Id): Fit {
  const fit = defaultFit(chassisId);
  return { ...fit, slots: { ...fit.slots, [slotId]: partId } };
}

/** A reference fit with its first utility slot swapped, keeping the fit legal. */
export function withUtility(chassisId: Id, partId: Id): Fit {
  const fit = defaultFit(chassisId);
  const first = deriveFit(fit).utilities[0];
  return first ? { ...fit, slots: { ...fit.slots, [first.slotId]: partId } } : fit;
}

/** A reference fit with one weapon slot replaced, keeping the other weapons and the groups. */
export function withWeapon(chassisId: Id, slotId: Id, partId: Id): Fit {
  const fit = defaultFit(chassisId);
  return { ...fit, slots: { ...fit.slots, [slotId]: partId } };
}

export function partOf(partId: Id): PartSpec {
  const part = CATALOG.partById.get(partId);
  if (!part) throw new Error(`unknown part ${partId}`);
  return part;
}
