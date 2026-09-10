import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
const ids = new Set();
for (const entry of [...catalog.chassis, ...catalog.parts, ...catalog.referenceFits]) {
  assert(!ids.has(entry.id), `duplicate ID ${entry.id}`); ids.add(entry.id);
  assert(/^[a-z][a-z0-9-]+$/.test(entry.id));
  for (const [key, value] of Object.entries(entry)) if (typeof value === 'number') assert(Number.isFinite(value) && value >= 0, `${entry.id}.${key}`);
}
const fits = catalog.referenceFits.map(fit => {
  const chassis = catalog.chassis.find(c => c.id === fit.chassisId); assert(chassis);
  const parts = fit.parts.map(id => { const p = catalog.parts.find(part => part.id === id); assert(p, `unknown ${id}`); return p; });
  for (const kind of ['engine', 'reactor', 'armor', 'sensor']) assert.equal(parts.filter(p => p.kind === kind).length, 1, `${fit.id} ${kind}`);
  const utilities = parts.filter(p => p.kind === 'utility'); assert(utilities.length <= chassis.utilities);
  assert.equal(new Set(utilities.map(p => p.id)).size, utilities.length);
  const weapons = parts.filter(p => p.kind === 'weapon').sort((a, b) => b.size - a.size);
  const sizes = [...chassis.weaponSizes].sort((a, b) => b - a);
  assert(weapons.length > 0 && weapons.length <= sizes.length);
  weapons.forEach((p, i) => assert(p.size <= sizes[i], `${fit.id}: ${p.id} too large`));
  const cost = chassis.cost + parts.reduce((sum, p) => sum + p.cost, 0);
  const wetMassKg = chassis.dryMassKg + chassis.fuelKg + parts.reduce((sum, p) => sum + p.massKg, 0);
  const idleMW = .5 + parts.reduce((sum, p) => sum + p.idleMW, 0);
  assert(cost <= catalog.buildBudget, `${fit.id}: cost ${cost}`);
  assert(wetMassKg <= chassis.maxWetMassKg); assert(idleMW < parts.find(p => p.kind === 'reactor').supplyMW);
  return { id: fit.id, cost, wetMassKg, idleMW, accelerationMS2: Number((parts.find(p => p.kind === 'engine').thrustN / wetMassKg).toFixed(2)) };
});
const behaviors = new Set(catalog.parts.filter(p => p.kind === 'weapon').map(p => p.behavior));
assert.equal(behaviors.size, 7);
for (const weapon of catalog.parts.filter(p => p.kind === 'weapon')) {
  if (weapon.behavior === 'beam') assert(weapon.rangeM > 0 && weapon.damageS > 0);
  else assert(weapon.speedMS > 0 && weapon.ttlS > 0 && weapon.cooldownS >= .06 && weapon.magazine > 0);
}
for (const doc of ['README.md', '../PLAN-A-SHELL.md', '../PLAN-B-MULTIPLAYER.md']) {
  const file = path.join(root, doc), body = readFileSync(file, 'utf8');
  for (const [, target] of body.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(target)) continue;
    assert(existsSync(path.resolve(path.dirname(file), target.split('#')[0])), `${doc}: missing ${target}`);
  }
}
// Budget arithmetic and a counterexample, not a performance/physics implementation benchmark.
const snapshotKiBPerSecond = 6 * 30 + 4 * 10;
const evidence = {
  catalog: { chassis: catalog.chassis.length, parts: catalog.parts.length, weaponBehaviors: behaviors.size, referenceFits: fits },
  calculations: {
    snapshotPayloadKiBPerClientSecond: snapshotKiBPerSecond,
    eightClientPayloadMiBSecond: snapshotKiBPerSecond * 8 / 1024,
    legacyReplayStepsPerSecond: 60, requiredSimulationStepsPerSecond: 120,
    legacyReplayCoverage: .5,
    bulletDistancePerTickAt700MuzzlePlus2000InheritedMS: (700 + 2000) / 120,
    note: 'A 22.5 m bullet step can cross a narrow target; endpoint checks are insufficient. These are calculations, not measured LAN results.',
  },
};
mkdirSync(path.join(root, 'evidence'), { recursive: true });
writeFileSync(path.join(root, 'evidence/catalog-check.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
