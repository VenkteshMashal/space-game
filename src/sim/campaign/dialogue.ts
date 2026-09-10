/**
 * B8 dialogue: subtitle-first lines bundled with the build and keyed by the stable subtitle IDs the
 * mission data references. Nothing here generates text or fetches anything at runtime, and no line
 * can block a LAN body — the HUD may dismiss or replay any of them (B8: "interruptible/replayable").
 *
 * The module deliberately imports nothing: dialogue must be available offline and cannot take a
 * dependency on the simulation, the network or the DOM.
 */

import type { Id } from '../../shared/contracts.ts';

export interface DialogueLine {
  /** The subtitle ID used by mission objectives and decision options. */
  id: Id;
  speaker: Id;
  text: string;
  /** Presentation hint for the subtitle tray; the player may still dismiss early. */
  holdSeconds: number;
}

export interface DialogueChannel {
  id: Id;
  interruptible: boolean;
  replayable: boolean;
  /** Bundled content only; there is no runtime generation and no network path. */
  source: 'bundled';
}

export const DIALOGUE_CHANNEL: DialogueChannel = {
  id: 'campaign-subtitles',
  interruptible: true,
  replayable: true,
  source: 'bundled',
};

export const CAMPAIGN_DIALOGUE: readonly DialogueLine[] = [
  { id: 'm1-intro', speaker: 'wayfarer-control', text: 'Belt sweep, Wayfarer. Three archive cores went dark after the last raider pass. Tag them and bring them home.', holdSeconds: 6 },
  { id: 'm1-archive-find', speaker: 'wayfarer-control', text: 'Core tagged. Beacons up on the other two.', holdSeconds: 4 },
  { id: 'm1-archive-beacon', speaker: 'wayfarer-control', text: 'Core is adrift. We painted a beacon on it — go pick it back up.', holdSeconds: 5 },
  { id: 'm1-raider-hail', speaker: 'cinder-raider', text: 'Those cores are spoken for, salvage. Turn around.', holdSeconds: 5 },
  { id: 'm1-return', speaker: 'wayfarer-control', text: 'Berth is open. Bring it in slow.', holdSeconds: 4 },
  { id: 'm1-complete', speaker: 'wayfarer-control', text: 'Archives aboard. The settlement breathes another week.', holdSeconds: 6 },
  { id: 'm1-wipe', speaker: 'wayfarer-control', text: 'Sweep is broken. Regroup at the last checkpoint.', holdSeconds: 5 },

  { id: 'm2-intro', speaker: 'wayfarer-control', text: 'Vesper is hauling fuel across the quarry and she will not make it alone.', holdSeconds: 6 },
  { id: 'm2-rendezvous', speaker: 'vesper', text: 'Wayfarer flight, good to see you. I am heavy and slow today.', holdSeconds: 5 },
  { id: 'm2-escort', speaker: 'vesper', text: 'Stay on my flank. There are pickets in these rocks.', holdSeconds: 4 },
  { id: 'm2-clear', speaker: 'vesper', text: 'Route is clear. Keep me moving.', holdSeconds: 4 },
  { id: 'm2-tow', speaker: 'wayfarer-control', text: 'Vesper has no hull left. Tug is away in forty-five. Hold the lane until it lands.', holdSeconds: 6 },
  { id: 'm2-dock', speaker: 'wayfarer-control', text: 'Berth is clear. Bring her in.', holdSeconds: 4 },
  { id: 'm2-complete', speaker: 'wayfarer-control', text: 'Fuel is ashore. The quarry run is ours again.', holdSeconds: 6 },
  { id: 'm2-wipe', speaker: 'wayfarer-control', text: 'Convoy lost. Checkpoint restored.', holdSeconds: 5 },

  { id: 'm3-intro', speaker: 'wayfarer-control', text: 'Something in the relay is still working. Scan it before the raiders find it.', holdSeconds: 6 },
  { id: 'm3-scan', speaker: 'wayfarer-control', text: 'Node is warm. Hold position and let the survey run.', holdSeconds: 4 },
  { id: 'm3-custodian-warn', speaker: 'witness-array', text: 'INTRUSION NOTED. REPAIR MANDATE ACTIVE. DESIST.', holdSeconds: 6 },
  { id: 'm3-translate', speaker: 'wayfarer-control', text: 'Protocol is not human. The Array is rebuilding what we broke.', holdSeconds: 6 },
  { id: 'm3-withdraw', speaker: 'wayfarer-control', text: 'We have what we came for. Pull back before it files us as damage.', holdSeconds: 6 },
  { id: 'm3-complete', speaker: 'wayfarer-control', text: 'Relay mapped and logged hostile. Good flying.', holdSeconds: 6 },
  { id: 'm3-wipe', speaker: 'wayfarer-control', text: 'Scan run lost. Backup nodes still hold the route — restart at the checkpoint.', holdSeconds: 6 },

  { id: 'm4-intro', speaker: 'wayfarer-control', text: 'Two pods are still signalling inside the relay shell, and Cinder is close.', holdSeconds: 6 },
  { id: 'm4-survivors', speaker: 'wayfarer-control', text: 'Pods secured. They are breathing.', holdSeconds: 5 },
  { id: 'm4-decision-shelter', speaker: 'wayfarer-control', text: 'We shelter them. The tender carries them home with us.', holdSeconds: 6 },
  { id: 'm4-decision-harvest', speaker: 'wayfarer-control', text: 'We take the vault and leave the tender. Salvage pays for both.', holdSeconds: 6 },
  { id: 'm4-ally-tender', speaker: 'wayfarer-tender', text: 'Tender is with you. I will fly the survivors out of the shell.', holdSeconds: 5 },
  { id: 'm4-ally-rig', speaker: 'wayfarer-control', text: 'No tender. The rig stays on the vault and cuts the sample free.', holdSeconds: 5 },
  { id: 'm4-defend-tender', speaker: 'wayfarer-tender', text: 'Raiders on me. Keep them off the hull.', holdSeconds: 4 },
  { id: 'm4-extract-sample', speaker: 'wayfarer-control', text: 'Sample is out of the vault. Do not touch the ribs.', holdSeconds: 5 },
  { id: 'm4-return', speaker: 'wayfarer-control', text: 'Wayfarer is holding a berth for us.', holdSeconds: 4 },
  { id: 'm4-complete', speaker: 'wayfarer-control', text: 'Relay shell cleared. The terms are ours to set.', holdSeconds: 6 },
  { id: 'm4-wipe', speaker: 'wayfarer-control', text: 'The shell won that pass. Pods are beacons now; restart the checkpoint.', holdSeconds: 6 },

  { id: 'm5-intro', speaker: 'wayfarer-control', text: 'Two conduit cells are dead. Bring replacements from the carrier and patch the junctions.', holdSeconds: 6 },
  { id: 'm5-deliver', speaker: 'wayfarer-control', text: 'Cell is at the junction. Seat it and clear the housing.', holdSeconds: 4 },
  { id: 'm5-cell-lost', speaker: 'wayfarer-control', text: 'Cell is gone. Carrier is printing another — twenty seconds.', holdSeconds: 5 },
  { id: 'm5-repair', speaker: 'wayfarer-control', text: 'Junction is hot. Patch it and back off.', holdSeconds: 4 },
  { id: 'm5-hold', speaker: 'wayfarer-control', text: 'Relay is drawing again. Hold the ring while it charges.', holdSeconds: 5 },
  { id: 'm5-extract', speaker: 'wayfarer-control', text: 'Corridor is open. Everyone out.', holdSeconds: 4 },
  { id: 'm5-complete', speaker: 'wayfarer-control', text: 'Conduits repaired. The safe corridor is charted.', holdSeconds: 6 },
  { id: 'm5-wipe', speaker: 'wayfarer-control', text: 'Ring collapsed. Checkpoint restored.', holdSeconds: 5 },

  { id: 'm6-intro', speaker: 'wayfarer-control', text: 'Cinder has a blockade on the homebound lane. The settlement is evacuating behind it.', holdSeconds: 7 },
  { id: 'm6-evacuation', speaker: 'wayfarer-control', text: 'Column is moving. Keep the transports covered.', holdSeconds: 5 },
  { id: 'm6-blockade', speaker: 'wayfarer-control', text: 'Screen is broken. The gate is next.', holdSeconds: 5 },
  { id: 'm6-decision-broadcast', speaker: 'wayfarer-control', text: 'Broadcast the protocol. Let every clan hear what the Array can do.', holdSeconds: 6 },
  { id: 'm6-decision-seal', speaker: 'wayfarer-control', text: 'Seal it. Nobody else gets the maintenance protocol.', holdSeconds: 6 },
  { id: 'm6-ally-array', speaker: 'witness-array', text: 'MANDATE ACCEPTED. COUPLERS HELD.', holdSeconds: 5 },
  { id: 'm6-ally-solo', speaker: 'wayfarer-control', text: 'No help coming. We charge the gate ourselves.', holdSeconds: 5 },
  { id: 'm6-charge', speaker: 'wayfarer-control', text: 'Gate is drawing. Couplers are repairable — keep them alive.', holdSeconds: 5 },
  { id: 'm6-pods', speaker: 'wayfarer-control', text: 'Transport is gone. Pods are away — we lose the bonus, not the crew.', holdSeconds: 6 },
  { id: 'm6-complete', speaker: 'wayfarer-control', text: 'Evacuation complete. A long way home, but home.', holdSeconds: 7 },
  { id: 'm6-wipe', speaker: 'wayfarer-control', text: 'Gate surge took the run. Checkpoint restored.', holdSeconds: 5 },
];

const BY_ID: Record<Id, DialogueLine> = {};
for (const line of CAMPAIGN_DIALOGUE) BY_ID[line.id] = line;

export function dialogueLine(id: Id): DialogueLine | null {
  return BY_ID[id] ?? null;
}

/** Subtitle IDs referenced by mission data that have no bundled line; empty in a valid build. */
export function missingDialogueIds(referenced: readonly Id[]): readonly Id[] {
  return referenced.filter(id => BY_ID[id] === undefined);
}
