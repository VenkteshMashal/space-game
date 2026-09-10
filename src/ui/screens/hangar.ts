/**
 * Hangar (Plan A4). One chassis at a time, selectable hardpoints, paged alternatives and a
 * current→proposed comparison that is nothing but arithmetic already performed by `deriveFit`.
 * The commit carries the expected revisions; a rejection leaves the previous build and this draft
 * exactly as they were, with the reason shown instead of a silent repair.
 */

import type { Fit, Id, SlotKind } from '../../shared/contracts.ts';
import { CATALOG, slotKinds } from '../../shared/catalog.ts';
import { cta, el, esc, notice, tab } from '../dom.ts';
import { group, reading } from '../dom.ts';
import { derivationOf } from '../derivation.ts';
import { fitComparison, int, massKg, powerMW, thrustN } from '../format.ts';
import { paginate, pagerLabel } from '../pagination.ts';
import type { DerivedFit } from '../../shared/contracts.ts';

export interface PartOption {
  readonly partId: Id;
  readonly name: string;
  readonly role: string;
  readonly cost: number;
  readonly massKg: number;
  readonly valid: boolean;
  readonly reason: string | null;
}

export interface HangarProps {
  readonly chassisId: Id;
  readonly hardpoint: Id;
  readonly parts: readonly PartOption[];
  readonly page: number;
  readonly availableHeight: number;
  readonly phone: boolean;
  readonly tab: 'fit' | 'fire-groups' | 'systems' | 'paint';
  readonly currentFit: Fit;
  readonly draftFit: Fit;
  readonly selectedPartId: Id | null;
  readonly revision: number;
  readonly inventoryRevision: number;
  readonly credits: number;
  readonly errors: readonly string[];
  readonly rejection: string | null;
  readonly commitBlockers: readonly string[];
}

export interface Hardpoint {
  readonly slotId: Id;
  readonly kind: SlotKind;
  readonly size: number;
  readonly label: string;
}

/** Every hardpoint on the chassis, in canonical slot order (Plan A4). */
export function hardpoints(chassisId: Id): readonly Hardpoint[] {
  const chassis = CATALOG.chassisById.get(chassisId);
  if (!chassis) return [];
  return [...slotKinds(chassisId).values()].map(slot => ({
    slotId: slot.slotId,
    kind: slot.kind,
    size: slot.size,
    label: SLOT_LABEL[slot.kind],
  }));
}

const SLOT_LABEL: Record<SlotKind, string> = {
  weapon: 'Weapon hardpoint',
  engine: 'Main drive',
  reactor: 'Reactor',
  armor: 'Armour',
  sensor: 'Sensor mast',
  utility: 'Utility',
};

/** Ammo role of each fitted weapon, from the proposed derivation rather than a local guess. */
function ammoRoles(fit: Fit): readonly string[] {
  return derivationOf(fit).weaponSlots.map(slot => {
    const part = CATALOG.partById.get(slot.partId);
    if (slot.magazine === null) return `${part?.name ?? slot.partId}: energy`;
    const reserve = slot.reserve === null ? 'unlimited reserve' : `${int(slot.reserve)} reserve`;
    return `${part?.name ?? slot.partId}: ${int(slot.magazine)} rounds, ${reserve}`;
  });
}

export function hangarMarkup(props: HangarProps): string {
  const currentDerived = derivationOf(props.currentFit);
  const draftDerived = derivationOf(props.draftFit);
  const pageState = paginate(
    { availableHeight: props.availableHeight, fixedPx: 260, rowPx: 72, maxRows: props.phone ? 2 : 3 },
    props.parts.length,
    props.parts.findIndex(part => part.partId === props.selectedPartId),
    props.page,
  );
  const visible = props.parts.slice(pageState.firstRow, pageState.lastRow);
  const selectedPart = props.parts.find(part => part.partId === props.selectedPartId) ?? null;
  const deltas = fitComparison(currentDerived, draftDerived);

  return el('section', { class: 'screen hangar', 'data-screen': 'hangar', 'data-chassis': props.chassisId, 'data-hardpoint': props.hardpoint }, [
    el('header', { class: 'screen-heading' }, [
      el('h1', {}, [esc(CATALOG.chassisById.get(props.chassisId)?.name ?? props.chassisId), el('small', {}, esc(CATALOG.chassisById.get(props.chassisId)?.role ?? ''))]),
      el('span', { class: 'room-tag num' }, `${int(props.credits)}\u2009cr`),
    ]),
    el('nav', { class: 'hangar-tabs', 'aria-label': 'Fitting pages' }, [
      tab('hangar.tab-fit', 'Fit', props.tab === 'fit'),
      tab('hangar.tab-fire-groups', 'Fire groups', props.tab === 'fire-groups'),
      tab('hangar.tab-systems', 'Systems', props.tab === 'systems'),
      tab('hangar.tab-paint', 'Paint', props.tab === 'paint'),
    ]),
    el('div', { class: 'hangar-layout' }, [
      el('div', { class: 'hangar-ship', 'data-hangar-preview': props.hardpoint }, hardpoints(props.chassisId).map(slot => cta('hangar.hardpoint', slot.label, {
        kind: 'ghost',
        pressed: slot.slotId === props.hardpoint,
        data: { hardpoint: slot.slotId },
      })).join('')),
      el('div', { class: 'fit-panel' }, [
        el('div', { class: 'panel-heading' }, [el('h2', {}, SLOT_LABEL[hardpoints(props.chassisId).find(slot => slot.slotId === props.hardpoint)?.kind ?? 'weapon']), el('span', { class: 'num' }, pagerLabel(pageState))]),
        el('ul', { class: 'part-list' }, visible.map(part => el('li', { class: `part${part.valid ? '' : ' invalid'}${part.partId === props.selectedPartId ? ' selected' : ''}`, 'data-part': part.partId }, [
          cta('hangar.part', part.name, { kind: 'ghost', pressed: part.partId === props.selectedPartId, data: { part: part.partId, slot: props.hardpoint } }),
          el('span', { class: 'part-role' }, esc(part.role)),
          el('span', { class: 'part-facts num' }, `${massKg(part.massKg)} \u00b7 ${int(part.cost)}\u2009pt`),
          part.valid ? '' : el('span', { class: 'part-reason tone-threat' }, esc(part.reason ?? 'Not legal on this hardpoint')),
        ]))),
        el('div', { class: 'pager' }, [
          cta('hangar.page-prev', 'Previous', { disabled: pageState.page === 0, data: { page: pageState.page - 1 } }),
          el('span', { class: 'num' }, pagerLabel(pageState)),
          cta('hangar.page-next', 'Next', { disabled: pageState.page >= pageState.pages - 1, data: { page: pageState.page + 1 } }),
        ]),
        selectedPart ? cta('hangar.fit-part', `Fit ${selectedPart.name}`, {
          kind: 'primary',
          disabled: !selectedPart.valid,
          reason: selectedPart.valid ? null : selectedPart.reason,
          data: { part: selectedPart.partId, slot: props.hardpoint },
        }) : '',
        props.tab === 'fit' ? cta('hangar.clear-slot', 'Clear hardpoint', { kind: 'ghost', data: { slot: props.hardpoint } }) : '',
      ]),
    ]),
    props.tab === 'fire-groups' ? group('Fire groups', el('div', { class: 'host-row' }, derivationOf(props.draftFit).weaponSlots.map(slot => el('span', { class: 'tag' },
      `${slot.slotId} \u2192 group ${int((props.draftFit.fireGroups.findIndex(group => group.includes(slot.slotId)) ?? -1) + 1)}`)))) : '',
    props.tab === 'fire-groups' ? el('div', { class: 'host-row' }, derivationOf(props.draftFit).weaponSlots.map(slot => cta('hangar.cycle-group', `Move ${slot.slotId}`, { kind: 'ghost', data: { slot: slot.slotId } }))) : '',
    props.tab === 'systems' ? group('Power priority', el('ol', { class: 'priority' }, props.draftFit.powerPriority.map((kind, index) => el('li', { class: 'num' }, [
      `${index + 1}. ${kind}`,
      cta('hangar.power-up', 'Raise', { kind: 'ghost', disabled: index === 0, data: { kind } }),
      cta('hangar.power-down', 'Lower', { kind: 'ghost', disabled: index === props.draftFit.powerPriority.length - 1, data: { kind } }),
    ])))) : '',
    props.tab === 'systems' ? group('Modules', [
      reading('Reactor supply', powerMW(draftDerived.powerSupplyMW)),
      reading('Idle demand', powerMW(draftDerived.idleDemandMW)),
      reading('Thrust', thrustN(draftDerived.thrustN)),
      cta('hangar.repair-module', 'Repair modules', { kind: 'ghost' }),
    ].join('')) : '',
    props.tab === 'paint' ? group('Paint', el('div', { class: 'host-row' }, ['default', 'cinder', 'salvage'].map(paint => cta('hangar.paint', paint, { pressed: props.draftFit.paintId === paint, data: { paint } })))) : '',
    group('Comparison', el('ul', { class: 'fit-deltas' }, deltas.map(row => el('li', { class: row.worse ? 'tone-threat' : row.direction === 'same' ? '' : 'tone-signal' }, [
      el('span', {}, row.label),
      el('span', { class: 'num' }, `${row.before} \u2192 ${row.after}`),
      el('span', { class: 'num' }, row.delta),
    ])))),
    group('Ammo role', el('ul', { class: 'ammo-roles' }, ammoRoles(props.draftFit).map(role => el('li', {}, esc(role))))),
    props.errors.length > 0
      ? el('ul', { class: 'fit-errors', role: 'status' }, props.errors.map(error => el('li', { class: 'tone-threat' }, esc(error))))
      : el('p', { class: 'ready-note', role: 'status' }, 'This build is legal.'),
    props.rejection ? notice(props.rejection, 'error') : '',
    el('footer', { class: 'menu-footer' }, [
      cta('hangar.back', 'Back'),
      cta('hangar.revert', 'Revert draft', { disabled: props.draftFit === props.currentFit }),
      cta('hangar.loaner', 'Take loaner build'),
      cta('hangar.commit', 'Commit fit', {
        kind: 'primary',
        disabled: props.commitBlockers.length > 0,
        reason: props.commitBlockers[0] ?? null,
        data: { revision: props.revision, inventory: props.inventoryRevision },
      }),
    ]),
  ]);
}

/** Sorted summary used by the lobby's selected-pilot pane. */
export function fitSummary(derived: DerivedFit): readonly string[] {
  return [
    `Mass ${massKg(derived.dryMassKg)}`,
    `Hull ${int(derived.hullMax)}`,
    `Thrust ${thrustN(derived.thrustN)}`,
    `Power ${powerMW(derived.powerSupplyMW)}`,
    `Cooling ${powerMW(derived.coolingMW)}`,
    `Cost ${int(derived.buildCost)} pt`,
  ];
}
